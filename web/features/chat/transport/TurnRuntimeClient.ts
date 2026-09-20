import type {
  ClientCommand,
  ServerEvent,
  StreamEvent,
} from "@/contracts/generated/turn-protocol";
import { buildPing, buildResumeTurn } from "@/contracts/parse/turn-command";
import { parseTurnEvent } from "@/contracts/parse/turn-event";

import {
  browserSocketFactory,
  SOCKET_CONNECTING,
  SOCKET_OPEN,
  type TurnSocket,
  type TurnSocketFactory,
} from "./socket";
import { reconnectDelay, shouldReconnect } from "./reconnect-policy";

export type RuntimeConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "recovering"
  | "stopped";

export interface RuntimeScheduler {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface TurnRuntimeClientOptions {
  url?: string;
  socketFactory?: TurnSocketFactory;
  scheduler?: RuntimeScheduler;
  random?: () => number;
  maxBufferedGap?: number;
  replayProbeDelayMs?: number;
  /** How long to wait for a ``command_ack`` before giving up on the command. */
  ackTimeoutMs?: number;
  /** How often to probe a live socket with a ``ping`` command. */
  heartbeatIntervalMs?: number;
  /** Inbound-frame silence after a ping that counts as a dead connection. */
  heartbeatTimeoutMs?: number;
  onEvent: (event: ServerEvent) => void;
  onStateChange?: (state: RuntimeConnectionState) => void;
  onDiagnostic?: (diagnostic: string) => void;
  onReconcile?: (cursor: { turnId: string; afterSeq: number }) => void;
}

interface PendingCommand {
  command: ClientCommand;
  commandId: string | null;
  requiresAck: boolean;
  acknowledgedAfter: number;
  sentGeneration: number;
  /** Settled with the server's verdict, for callers that await one. */
  settle?: (accepted: boolean) => void;
  /** Armed until the matching ack (or the ack timeout) settles this entry. */
  ackTimeoutHandle: unknown;
  /** Guards against a late ack settling an entry twice. */
  settled: boolean;
}

const ACKNOWLEDGED_COMMAND_TYPES = new Set([
  "cancel_turn",
  "submit_user_reply",
  "user_input",
]);

/**
 * A half-open TCP connection (locked phone, NAT timeout) never raises a
 * ``close`` event, so waiters on ``sendAwaitingAck`` would pend forever and
 * freeze the ask-user card on "Sending your answers…". Give every
 * acknowledged command a bounded wait: past it, the entry is dropped and its
 * waiter resolves ``false`` — the same verdict as ``stop()`` — letting the
 * caller fall back to a fresh send.
 */
const DEFAULT_ACK_TIMEOUT_MS = 8_000;
/**
 * Heartbeat cadence. The server answers every ``ping`` with a ``pong``
 * (deeptutor/api/routers/unified_ws.py), so the interval doubles as a
 * liveness probe on connections that no longer carry any traffic.
 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
/** Silence after a sent ping that is long enough to declare the socket dead. */
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10_000;
/**
 * A watchdog firing grossly late means the tab was throttled or frozen, so
 * queued inbound frames may simply not have been dispatched yet. One short
 * grace pass lets them land before the socket is killed, so returning to a
 * backgrounded tab never murders a healthy connection.
 */
const HEARTBEAT_GRACE_MS = 1_000;

function prepareCommand(command: ClientCommand): {
  command: ClientCommand;
  commandId: string | null;
  requiresAck: boolean;
} {
  const requiresAck =
    typeof command.type === "string" &&
    ACKNOWLEDGED_COMMAND_TYPES.has(command.type);
  if (!requiresAck) return { command, commandId: null, requiresAck: false };
  const record = command as unknown as Record<string, unknown>;
  const existing =
    typeof record.command_id === "string" ? record.command_id.trim() : "";
  const commandId = existing || globalThis.crypto.randomUUID();
  return {
    command: { ...command, command_id: commandId } as ClientCommand,
    commandId,
    requiresAck: true,
  };
}

const defaultScheduler: RuntimeScheduler = {
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class TurnRuntimeClient {
  private readonly options: Required<
    Pick<
      TurnRuntimeClientOptions,
      | "url"
      | "socketFactory"
      | "scheduler"
      | "random"
      | "maxBufferedGap"
      | "replayProbeDelayMs"
      | "ackTimeoutMs"
      | "heartbeatIntervalMs"
      | "heartbeatTimeoutMs"
    >
  > &
    Omit<
      TurnRuntimeClientOptions,
      | "url"
      | "socketFactory"
      | "scheduler"
      | "random"
      | "maxBufferedGap"
      | "replayProbeDelayMs"
      | "ackTimeoutMs"
      | "heartbeatIntervalMs"
      | "heartbeatTimeoutMs"
    >;
  private socket: TurnSocket | null = null;
  private reconnectHandle: unknown = null;
  private replayProbeHandle: unknown = null;
  /** Timer that fires the next ``ping`` on the open socket. */
  private heartbeatHandle: unknown = null;
  /** Timer that judges the connection dead if no inbound frame lands. */
  private livenessHandle: unknown = null;
  private awaitingPong = false;
  private pingSentAt = 0;
  private livenessGraceUsed = false;
  private reconnectAttempt = 0;
  private generation = 0;
  private stopped = false;
  private pageVisible = true;
  private turnId: string | null = null;
  private lastSeq = 0;
  private buffered = new Map<number, StreamEvent>();
  private pending: PendingCommand[] = [];
  /**
   * Replies whose ack timed out (so they left ``pending``) but that the
   * server may never have received — the half-open-socket signature. Per
   * ADR-0003 the server de-duplicates by ``command_id``, so re-sending the
   * SAME command after the link recovers is safe even if the original did
   * land: the worst case is a duplicate the server refuses. Keyed by
   * ``command_id`` so a re-sent command can never queue twice.
   */
  private deferredReplies = new Map<string, ClientCommand>();
  private connectionState: RuntimeConnectionState = "idle";
  private terminalObserved = false;

  constructor(options: TurnRuntimeClientOptions) {
    this.options = {
      url: "/ws",
      socketFactory: browserSocketFactory,
      scheduler: defaultScheduler,
      random: Math.random,
      maxBufferedGap: 32,
      replayProbeDelayMs: 5_000,
      ackTimeoutMs: DEFAULT_ACK_TIMEOUT_MS,
      heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
      heartbeatTimeoutMs: DEFAULT_HEARTBEAT_TIMEOUT_MS,
      ...options,
    };
  }

  get state(): RuntimeConnectionState {
    return this.connectionState;
  }

  get cursor(): { turnId: string | null; afterSeq: number } {
    return { turnId: this.turnId, afterSeq: this.lastSeq };
  }

  connect(): void {
    if (this.stopped) this.stopped = false;
    if (this.socket && this.socket.readyState <= SOCKET_OPEN) return;
    this.clearReconnect();
    this.setState(this.turnId ? "recovering" : "connecting");
    const socket = this.options.socketFactory(this.options.url);
    this.socket = socket;

    socket.addEventListener("open", () => this.handleOpen(socket));
    socket.addEventListener("message", (event) =>
      this.handleMessage(socket, event.data),
    );
    socket.addEventListener("close", () => this.handleClose(socket));
    socket.addEventListener("error", () => {
      if (socket === this.socket)
        this.options.onDiagnostic?.("turn socket error; awaiting close");
    });
  }

  setResumeCursor(turnId: string | null, afterSeq: number): void {
    if (!Number.isInteger(afterSeq) || afterSeq < 0)
      throw new TypeError("afterSeq is invalid");
    const nextTurnId = turnId?.trim() || null;
    if (nextTurnId !== this.turnId) {
      this.clearReplayProbe();
      this.turnId = nextTurnId;
      this.lastSeq = afterSeq;
      this.buffered.clear();
      this.terminalObserved = false;
      return;
    }
    // React state can trail the socket by one render. Never rewind a live
    // transport cursor from that stale snapshot or already-consumed events
    // (including DONE) can be replayed into a new UI state.
    if (afterSeq <= this.lastSeq) return;
    this.lastSeq = afterSeq;
    for (const seq of this.buffered.keys()) {
      if (seq <= afterSeq) this.buffered.delete(seq);
    }
  }

  /**
   * Report whether the page is visible and retry while it just came back.
   *
   * KNOWN BYPASS: nothing in production calls this — ``pageVisible`` stays
   * ``true`` for the page's lifetime, so the reconnect policy never sees a
   * hidden page and keeps retrying even in background tabs. That is
   * deliberate: wiring this to ``visibilitychange`` would let a locked
   * phone (visible=false, no active turn) give up reconnecting outright,
   * trading a battery nicety for dropped sessions. Revisit only with a
   * policy that keeps live turns reconnecting while hidden.
   */
  setPageVisible(visible: boolean): void {
    this.pageVisible = visible;
    if (visible && !this.stopped && !this.socket) this.manualRetry();
  }

  send(command: ClientCommand, options: { durable?: boolean } = {}): void {
    const durable = options.durable ?? command.type !== "ping";
    if (!durable) {
      this.sendNow(command);
      return;
    }
    this.enqueue(command);
  }

  /**
   * Send a command and resolve with the server's verdict on it.
   *
   * A command the server declines — a reply for a turn that is no longer
   * waiting, most often because the backend restarted since the question was
   * asked — is otherwise only a console diagnostic, which leaves whatever UI
   * is waiting on it pending forever. Resolves ``false`` for a rejection,
   * for a client that stops before the acknowledgement arrives, and when no
   * acknowledgement lands within ``ackTimeoutMs`` (a half-open socket never
   * produces one); a command type the protocol never acknowledges resolves
   * ``true`` on dispatch.
   */
  sendAwaitingAck(command: ClientCommand): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      // The resolver rides into ``enqueue`` so it is registered on the
      // pending entry *before* the ack timeout is armed — a scheduler that
      // fires synchronously (delay 0) would otherwise resolve into a
      // ``settle`` that is not assigned yet and leave the waiter dangling.
      const pending = this.enqueue(command, resolve);
      if (!pending.requiresAck) {
        resolve(true);
      }
    });
  }

  private enqueue(
    command: ClientCommand,
    settle?: (accepted: boolean) => void,
  ): PendingCommand {
    const prepared = prepareCommand(command);
    const pending: PendingCommand = {
      ...prepared,
      acknowledgedAfter: this.lastSeq,
      sentGeneration: -1,
      ackTimeoutHandle: null,
      settled: false,
      // Only ack-carrying commands ever have a waiter to release; a null
      // ``command_id`` (non-ack types) can never match a ``command_ack``.
      ...(prepared.requiresAck ? { settle } : {}),
    };
    this.pending.push(pending);
    this.flushPending();
    this.armAckTimeout(pending);
    return pending;
  }

  /**
   * Bound the wait for a ``command_ack``. The clock runs from enqueue — the
   * budget covers reconnects and resends alike, because the caller's UI is
   * frozen for exactly this long. On expiry the entry is dropped (so a late
   * ack finds nothing to settle) and waiters get ``false``, the same verdict
   * they would receive from ``stop()``.
   *
   * Known trade-off: after the page returns to the foreground (or the
   * network resuscitates) a genuinely-late ack can race this timeout and
   * lose — the caller is told ``false`` even though the server accepted.
   * Worst case the paused card re-arms and the user answers twice; the
   * server de-duplicates by ``command_id``, so the second answer is a no-op
   * rather than a double submit.
   */
  private armAckTimeout(pending: PendingCommand): void {
    if (!pending.requiresAck) return;
    pending.ackTimeoutHandle = this.options.scheduler.setTimeout(() => {
      pending.ackTimeoutHandle = null;
      if (pending.settled) return;
      this.pending = this.pending.filter((item) => item !== pending);
      // A timed-out reply goes into the deferred queue instead of being
      // dropped: with a half-open socket the server never saw it, and if
      // the paused turn is left waiting the whole session wedges behind it
      // (every later start_turn bounces off "already has an active turn").
      // Re-sending after reconnect is safe per ADR-0003 (command_id
      // de-duplication) and bounded to one attempt per connection.
      if (pending.command.type === "submit_user_reply" && pending.commandId) {
        this.deferredReplies.set(pending.commandId, pending.command);
      }
      console.warn(
        `[TurnRuntimeClient] command acknowledgement timed out after ${this.options.ackTimeoutMs}ms; ` +
          `type=${String(pending.command.type)}; command_id=${pending.commandId ?? "none"}; ` +
          `turn=${this.turnId ?? "none"}`,
      );
      this.settlePending(pending, false);
    }, this.options.ackTimeoutMs);
  }

  /**
   * Re-send the replies whose acknowledgements timed out on the dead
   * connection. Runs right after a reconnect handshake so the paused turn
   * resumes before anything else races it. Each re-send re-enters the
   * normal pending/ack pipeline (same ``command_id``), so another blackout
   * simply defers it again — at-least-once delivery, deduplicated by the
   * server. An acknowledgement of any verdict removes the entry: the
   * command has been conclusively processed.
   */
  private requeueDeferredReplies(): void {
    if (this.deferredReplies.size === 0) return;
    const entries = [...this.deferredReplies.values()];
    this.deferredReplies.clear();
    for (const command of entries) {
      const prepared = prepareCommand(command);
      const pending: PendingCommand = {
        ...prepared,
        acknowledgedAfter: this.lastSeq,
        sentGeneration: this.generation,
        ackTimeoutHandle: null,
        settled: false,
      };
      this.pending.push(pending);
      this.sendNow(pending.command);
      this.armAckTimeout(pending);
      this.options.onDiagnostic?.(
        `re-sent deferred reply; command_id=${pending.commandId ?? "none"}`,
      );
    }
  }

  private settlePending(pending: PendingCommand, accepted: boolean): void {
    if (pending.settled) return;
    pending.settled = true;
    if (pending.ackTimeoutHandle !== null) {
      this.options.scheduler.clearTimeout(pending.ackTimeoutHandle);
      pending.ackTimeoutHandle = null;
    }
    pending.settle?.(accepted);
  }

  cancel(command: ClientCommand): void {
    this.send(command);
  }

  ping(): void {
    this.send(buildPing(), { durable: false });
  }

  manualRetry(): void {
    if (this.stopped) return;
    this.reconnectAttempt = 0;
    this.stopHeartbeat();
    if (this.socket?.readyState === SOCKET_CONNECTING) return;
    this.socket?.close();
    this.socket = null;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearReconnect();
    this.clearReplayProbe();
    this.stopHeartbeat();
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, "client stopped");
    // Nobody is left to acknowledge these, so release their waiters rather
    // than leaving the UI that sent them pending forever.
    for (const pending of this.pending) this.settlePending(pending, false);
    this.pending = [];
    // The session is being torn down; nothing is left for a re-send to save.
    this.deferredReplies.clear();
    this.buffered.clear();
    this.setState("stopped");
  }

  private handleOpen(socket: TurnSocket): void {
    if (socket !== this.socket || this.stopped) return;
    this.generation += 1;
    this.reconnectAttempt = 0;
    this.setState("connected");
    this.startHeartbeat();
    if (this.turnId) {
      this.sendNow(
        buildResumeTurn({ turnId: this.turnId, afterSeq: this.lastSeq }),
      );
    }
    this.flushPending();
    // The resume replay above re-anchors the event stream; the replies the
    // dead connection swallowed must go out before anything else assumes
    // the turn is still waiting on the user.
    this.requeueDeferredReplies();
  }

  private handleMessage(socket: TurnSocket, raw: unknown): void {
    if (socket !== this.socket || this.stopped) return;
    // Any inbound frame — pong, stream event, even a malformed one — is
    // proof the connection still carries traffic.
    this.awaitingPong = false;
    const parsed = parseTurnEvent(raw);
    if (!parsed.ok) {
      if (parsed.reason !== "heartbeat")
        this.options.onDiagnostic?.(parsed.diagnostic);
      return;
    }
    const event = parsed.value;
    if (event.type === "command_ack") {
      const remaining: PendingCommand[] = [];
      for (const item of this.pending) {
        if (item.commandId === event.command_id)
          this.settlePending(item, event.accepted);
        else remaining.push(item);
      }
      this.pending = remaining;
      // Any verdict proves the command was processed — a deferred re-send
      // with this id has nothing left to accomplish.
      if (event.command_id) this.deferredReplies.delete(event.command_id);
      if (!event.accepted) {
        this.options.onDiagnostic?.(
          `turn command rejected; type=${event.command_type}; code=${event.error_code || "rejected"}`,
        );
      }
      this.options.onEvent(event);
      return;
    }
    if (event.type === "protocol_error") {
      this.options.onDiagnostic?.(
        `turn protocol error; code=${event.error_code}; retryable=${String(event.retryable)}`,
      );
      this.options.onEvent(event);
      return;
    }
    if (event.type === "active_turn_info") {
      if (event.turn_id) this.turnId = event.turn_id;
      this.options.onEvent(event);
      return;
    }
    if (event.type === "pong") return;
    this.acceptStreamEvent(event as StreamEvent);
  }

  private acceptStreamEvent(event: StreamEvent): void {
    const eventTurnId = event.turn_id?.trim() || null;
    if (eventTurnId && eventTurnId !== this.turnId) {
      this.clearReplayProbe();
      this.turnId = eventTurnId;
      this.lastSeq = 0;
      this.buffered.clear();
      this.terminalObserved = false;
    }
    const seq = event.seq ?? 0;
    if (seq <= this.lastSeq) return;
    const gap = seq - this.lastSeq;
    if (gap > 1) {
      if (gap <= this.options.maxBufferedGap) {
        this.buffered.set(seq, event);
        // WebSockets preserve frame order, so a bounded gap is normally a
        // dropped/rejected frame rather than harmless reordering. Give an
        // in-flight predecessor one tick to arrive, then replay the durable
        // suffix instead of buffering DONE forever.
        this.scheduleReplayProbe(
          Math.min(250, this.options.replayProbeDelayMs),
        );
      } else if (this.turnId) {
        this.options.onDiagnostic?.(
          `turn event gap exceeded buffer; after_seq=${this.lastSeq}`,
        );
        this.requestReplay();
      }
      return;
    }

    this.emitInOrder(event);
    let next = this.buffered.get(this.lastSeq + 1);
    while (next) {
      this.buffered.delete(this.lastSeq + 1);
      this.emitInOrder(next);
      next = this.buffered.get(this.lastSeq + 1);
    }
  }

  private emitInOrder(event: StreamEvent): void {
    this.lastSeq = event.seq ?? this.lastSeq;
    this.pending = this.pending.filter(
      (item) => item.requiresAck || this.lastSeq <= item.acknowledgedAfter,
    );
    if (event.type === "done") {
      this.terminalObserved = true;
      this.clearReplayProbe();
    }
    this.options.onEvent(event);
    if (event.type === "done") return;
    if (!this.terminalObserved) this.scheduleReplayProbe();
  }

  private handleClose(socket: TurnSocket): void {
    if (socket !== this.socket) return;
    this.socket = null;
    this.clearReplayProbe();
    this.stopHeartbeat();
    if (this.stopped) return;
    this.setState(this.turnId ? "recovering" : "connecting");
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (
      !shouldReconnect({
        attempt: this.reconnectAttempt,
        activeTurnId: this.turnId,
        pageVisible: this.pageVisible,
      })
    ) {
      this.setState("idle");
      return;
    }
    const delay = reconnectDelay(this.reconnectAttempt, this.options.random);
    this.reconnectAttempt += 1;
    this.reconnectHandle = this.options.scheduler.setTimeout(() => {
      this.reconnectHandle = null;
      this.connect();
    }, delay);
  }

  private flushPending(): void {
    if (!this.socket || this.socket.readyState !== SOCKET_OPEN) return;
    for (const pending of this.pending) {
      if (pending.sentGeneration === this.generation) continue;
      this.sendNow(pending.command);
      pending.sentGeneration = this.generation;
    }
  }

  private sendNow(command: ClientCommand): void {
    if (!this.socket || this.socket.readyState !== SOCKET_OPEN) return;
    this.socket.send(JSON.stringify(command));
  }

  private clearReconnect(): void {
    if (this.reconnectHandle === null) return;
    this.options.scheduler.clearTimeout(this.reconnectHandle);
    this.reconnectHandle = null;
  }

  /**
   * Dead-connection detection for half-open TCP: a locked phone or expired
   * NAT mapping keeps the socket "open" while nothing will ever arrive. The
   * server answers every ``ping`` with a ``pong``, so once a ping has been
   * sent, any inbound frame within ``heartbeatTimeoutMs`` proves the link;
   * total silence means the socket is killed and the normal close/reconnect
   * path takes over. Timers are throttled in background tabs, so a watchdog
   * that fires grossly late first yields a short grace pass — arriving back
   * at a frozen tab must not kill a connection whose pong was still queued.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.schedulePing();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatHandle !== null) {
      this.options.scheduler.clearTimeout(this.heartbeatHandle);
      this.heartbeatHandle = null;
    }
    if (this.livenessHandle !== null) {
      this.options.scheduler.clearTimeout(this.livenessHandle);
      this.livenessHandle = null;
    }
    this.awaitingPong = false;
  }

  private schedulePing(): void {
    if (this.stopped || !this.socket) return;
    this.heartbeatHandle = this.options.scheduler.setTimeout(() => {
      this.heartbeatHandle = null;
      if (
        this.stopped ||
        !this.socket ||
        this.socket.readyState !== SOCKET_OPEN
      )
        return;
      this.awaitingPong = true;
      this.livenessGraceUsed = false;
      this.pingSentAt = Date.now();
      this.sendNow(buildPing());
      this.livenessHandle = this.options.scheduler.setTimeout(() => {
        this.livenessHandle = null;
        this.checkLiveness();
      }, this.options.heartbeatTimeoutMs);
    }, this.options.heartbeatIntervalMs);
  }

  private checkLiveness(): void {
    if (this.stopped || !this.socket) return;
    if (!this.awaitingPong) {
      // Traffic arrived since the ping: alive, start the next cycle.
      this.schedulePing();
      return;
    }
    const elapsed = Date.now() - this.pingSentAt;
    if (elapsed > this.options.heartbeatTimeoutMs * 2 && !this.livenessGraceUsed) {
      this.livenessGraceUsed = true;
      this.livenessHandle = this.options.scheduler.setTimeout(() => {
        this.livenessHandle = null;
        this.checkLiveness();
      }, HEARTBEAT_GRACE_MS);
      return;
    }
    this.declareConnectionDead();
  }

  private declareConnectionDead(): void {
    const socket = this.socket;
    if (!socket) return;
    console.warn(
      `[TurnRuntimeClient] heartbeat timeout; closing unresponsive socket ` +
        `(no inbound frames ${this.options.heartbeatTimeoutMs}ms after ping); ` +
        `turn=${this.turnId ?? "none"}`,
    );
    this.stopHeartbeat();
    // Route through close — handleClose clears state and schedules the
    // reconnect; queued commands ride the normal resend path.
    socket.close(4000, "heartbeat timeout");
  }

  private scheduleReplayProbe(delay = this.options.replayProbeDelayMs): void {
    if (!this.turnId || this.terminalObserved || this.stopped) return;
    this.clearReplayProbe();
    this.replayProbeHandle = this.options.scheduler.setTimeout(() => {
      this.replayProbeHandle = null;
      this.requestReplay();
    }, delay);
  }

  private requestReplay(): void {
    if (!this.turnId || this.terminalObserved || this.stopped) return;
    const cursor = { turnId: this.turnId, afterSeq: this.lastSeq };
    this.options.onReconcile?.(cursor);
    this.sendNow(buildResumeTurn(cursor));
  }

  private clearReplayProbe(): void {
    if (this.replayProbeHandle === null) return;
    this.options.scheduler.clearTimeout(this.replayProbeHandle);
    this.replayProbeHandle = null;
  }

  private setState(state: RuntimeConnectionState): void {
    if (this.connectionState === state) return;
    this.connectionState = state;
    this.options.onStateChange?.(state);
  }
}
