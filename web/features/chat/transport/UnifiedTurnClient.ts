import type {
  ClientCommand,
  ServerEvent,
} from "@/contracts/generated/turn-protocol";

import type {
  ChatMessage,
  StreamEvent,
  StreamEventType,
} from "../model/protocol";
import {
  TurnRuntimeClient,
  type RuntimeConnectionState,
  type TurnRuntimeClientOptions,
} from "./TurnRuntimeClient";

const STREAM_TYPES = new Set<StreamEventType>([
  "stage_start",
  "stage_end",
  "thinking",
  "observation",
  "content",
  "tool_call",
  "tool_result",
  "progress",
  "sources",
  "result",
  "error",
  "session",
  "session_meta",
  "wait_for_input",
  "done",
  // The server's rejection of a client command (notably start_turn on a
  // session that still holds a live or recovering turn) rides a
  // protocol_error frame. UI state needs the verdict to stop claiming a
  // turn is running that the server refused to start.
  "protocol_error",
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function toStreamEvent(event: ServerEvent): StreamEvent | null {
  const raw = event as unknown as Record<string, unknown>;
  const type = raw.type;
  if (typeof type !== "string" || !STREAM_TYPES.has(type as StreamEventType))
    return null;
  return {
    type: type as StreamEventType,
    source: typeof raw.source === "string" ? raw.source : "",
    stage: typeof raw.stage === "string" ? raw.stage : "",
    content: typeof raw.content === "string" ? raw.content : "",
    metadata:
      type === "protocol_error"
        ? // The rejection verdict lives at the top level of the frame, not
          // under a metadata key — hoist it so the UI can branch on it.
          {
            error_code: raw.error_code ?? "",
            message: raw.message ?? "",
            retryable: raw.retryable ?? false,
          }
        : asRecord(raw.metadata),
    session_id: typeof raw.session_id === "string" ? raw.session_id : undefined,
    turn_id: typeof raw.turn_id === "string" ? raw.turn_id : undefined,
    seq: typeof raw.seq === "number" ? raw.seq : undefined,
    timestamp:
      typeof raw.timestamp === "number" ? raw.timestamp : Date.now() / 1000,
  };
}

type OutboundTurnCommand = ChatMessage | ClientCommand;

function command(message: OutboundTurnCommand): ClientCommand {
  if ("protocol_version" in message && message.protocol_version === "2.0") {
    return message as ClientCommand;
  }
  return { ...message, protocol_version: "2.0" } as ClientCommand;
}

/** Transitional surface API backed entirely by the validated v2 runtime. */
export class UnifiedTurnClient {
  private readonly runtime: TurnRuntimeClient;
  private connectionState: RuntimeConnectionState = "idle";
  private closeNotified = false;

  constructor(
    onEvent: (event: StreamEvent) => void,
    onClose?: () => void,
    onRecovering?: () => void,
    /** Test seam: lets the transport-level suite drive this wrapper over a
     *  fake socket/scheduler and observe the runtime's state transitions. */
    options?: Pick<
      TurnRuntimeClientOptions,
      "socketFactory" | "scheduler" | "onStateChange"
    >,
  ) {
    this.runtime = new TurnRuntimeClient({
      onEvent(event) {
        const streamEvent = toStreamEvent(event);
        if (streamEvent) onEvent(streamEvent);
      },
      // Spread first: the state handler below must own this key — it routes
      // onClose/onRecovering and then mirrors the transition to the
      // observer.
      ...options,
      onStateChange: (state) => {
        this.connectionState = state;
        // A turn that is still live keeps the runtime reconnecting forever
        // (``shouldReconnect`` is unconditional while an active turn id is
        // set), so "idle" — and with it ``onClose`` — is unreachable for
        // exactly the turns that most need a disconnect signal. "recovering"
        // is the state every socket drop lands in first, so it is surfaced
        // as its own callback. The state machine itself stays in the
        // runtime; this only reports it.
        if (state === "recovering") onRecovering?.();
        if (state === "idle" && !this.closeNotified) {
          this.closeNotified = true;
          onClose?.();
        }
        if (state === "connected") this.closeNotified = false;
        options?.onStateChange?.(state);
      },
    });
  }

  get connected(): boolean {
    return this.connectionState === "connected";
  }

  setResumeState(turnId: string | null, seq: number): void {
    this.runtime.setResumeCursor(turnId, seq);
  }

  connect(): void {
    this.runtime.connect();
  }

  send(message: OutboundTurnCommand): void {
    this.runtime.send(command(message));
  }

  /** Send, and resolve with whether the server accepted the command. */
  sendAwaitingAck(message: OutboundTurnCommand): Promise<boolean> {
    return this.runtime.sendAwaitingAck(command(message));
  }

  disconnect(): void {
    this.runtime.stop();
    this.runtime.setResumeCursor(null, 0);
    this.connectionState = "stopped";
  }
}
