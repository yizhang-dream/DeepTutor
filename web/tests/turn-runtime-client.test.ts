import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCancelTurn,
  buildSubmitUserReply,
} from "../contracts/parse/turn-command";
import {
  TurnRuntimeClient,
  type RuntimeConnectionState,
  type RuntimeScheduler,
} from "../features/chat/transport/TurnRuntimeClient";
import { UnifiedTurnClient } from "../features/chat/transport/UnifiedTurnClient";
import {
  SOCKET_CONNECTING,
  SOCKET_OPEN,
  type TurnSocket,
} from "../features/chat/transport/socket";

class FakeSocket implements TurnSocket {
  readyState = SOCKET_CONNECTING;
  sent: Record<string, unknown>[] = [];
  private listeners = new Map<
    string,
    Array<(event: { data: unknown }) => void>
  >();

  addEventListener(
    type: string,
    listener: (event: { data: unknown }) => void,
  ): void {
    const rows = this.listeners.get(type) ?? [];
    rows.push(listener);
    this.listeners.set(type, rows);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close");
  }

  open(): void {
    this.readyState = SOCKET_OPEN;
    this.emit("open");
  }

  message(value: unknown): void {
    this.emit("message", {
      data: typeof value === "string" ? value : JSON.stringify(value),
    });
  }

  private emit(
    type: string,
    event: { data: unknown } = { data: undefined },
  ): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

interface ScheduledTask {
  callback: () => void;
  delay: number;
}

class FakeScheduler implements RuntimeScheduler {
  tasks: ScheduledTask[] = [];
  setTimeout(callback: () => void, delay = 0): unknown {
    const task: ScheduledTask = { callback, delay };
    this.tasks.push(task);
    return task;
  }
  clearTimeout(handle: unknown): void {
    this.tasks = this.tasks.filter((task) => task !== handle);
  }
  /** Run the pending callback scheduled for the earliest delay (FIFO ties). */
  runNext(): void {
    if (this.tasks.length === 0) return;
    let earliest = this.tasks[0];
    for (const task of this.tasks) {
      if (task.delay < earliest.delay) earliest = task;
    }
    this.tasks.splice(this.tasks.indexOf(earliest), 1);
    earliest.callback();
  }
  /** Delays of the still-pending timers, in scheduling order. */
  delays(): number[] {
    return this.tasks.map((task) => task.delay);
  }
}

function stream(seq: number, type = "content"): Record<string, unknown> {
  return {
    type,
    turn_id: "turn-1",
    session_id: "session-1",
    seq,
    timestamp: seq,
    content: `token-${seq}`,
    metadata: {},
    protocol_version: "2.0",
  };
}

function harness() {
  const sockets: FakeSocket[] = [];
  const scheduler = new FakeScheduler();
  const events: Array<{ type?: string; seq?: number }> = [];
  const states: string[] = [];
  const diagnostics: string[] = [];
  const reconciliations: unknown[] = [];
  const client = new TurnRuntimeClient({
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    scheduler,
    random: () => 0.5,
    maxBufferedGap: 3,
    replayProbeDelayMs: 5_000,
    onEvent: (event) => events.push(event),
    onStateChange: (state) => states.push(state),
    onDiagnostic: (value) => diagnostics.push(value),
    onReconcile: (cursor) => reconciliations.push(cursor),
  });
  return {
    client,
    diagnostics,
    events,
    reconciliations,
    scheduler,
    sockets,
    states,
  };
}

test("reconnect resumes from the persisted cursor through a different worker", () => {
  const { client, scheduler, sockets, states } = harness();
  client.setResumeCursor("turn-1", 8);
  client.connect();
  sockets[0].open();
  assert.equal(sockets[0].sent[0].type, "resume_from");
  assert.equal(sockets[0].sent[0].seq, 8);

  sockets[0].close();
  assert.equal(states.at(-1), "recovering");
  scheduler.runNext();
  sockets[1].open();
  assert.equal(sockets[1].sent[0].seq, 8);
});

test("duplicates are dropped and bounded out-of-order events are restored", () => {
  const { client, events, scheduler, sockets } = harness();
  client.connect();
  sockets[0].open();
  sockets[0].message(stream(2));
  sockets[0].message(stream(1));
  sockets[0].message(stream(1));
  assert.deepEqual(
    events.map((event) => event.seq),
    [1, 2],
  );
  // Heartbeat ping plus the replay probe (re-armed at its default delay
  // once the gap was restored in order).
  assert.deepEqual(scheduler.delays(), [15_000, 5_000]);
});

test("large sequence gaps request reconciliation instead of emitting", () => {
  const { client, events, reconciliations, sockets } = harness();
  client.setResumeCursor("turn-1", 1);
  client.connect();
  sockets[0].open();
  sockets[0].message(stream(8));
  assert.equal(events.length, 0);
  assert.deepEqual(reconciliations, [{ turnId: "turn-1", afterSeq: 1 }]);
  assert.deepEqual(sockets[0].sent.at(-1), {
    type: "resume_from",
    turn_id: "turn-1",
    seq: 1,
    protocol_version: "2.0",
  });
});

test("a bounded missing frame triggers durable replay and releases buffered done", () => {
  const { client, events, reconciliations, scheduler, sockets } = harness();
  client.connect();
  sockets[0].open();
  sockets[0].message(stream(1));
  sockets[0].message(stream(3, "done"));

  assert.deepEqual(
    events.map((event) => event.seq),
    [1],
  );
  scheduler.runNext();
  assert.deepEqual(reconciliations, [{ turnId: "turn-1", afterSeq: 1 }]);
  assert.equal(sockets[0].sent.at(-1)?.type, "resume_from");
  assert.equal(sockets[0].sent.at(-1)?.seq, 1);

  sockets[0].message(stream(2, "stage_end"));
  assert.deepEqual(
    events.map((event) => event.seq),
    [1, 2, 3],
  );
  assert.equal(events.at(-1)?.type, "done");
  // Done released the replay probe; only the heartbeat ping remains.
  assert.deepEqual(scheduler.delays(), [15_000]);
});

test("an idle non-terminal stream probes durable replay for a missed done", () => {
  const { client, events, reconciliations, scheduler, sockets } = harness();
  client.connect();
  sockets[0].open();
  sockets[0].message(stream(1));

  // Heartbeat ping plus the replay probe that watches for the missed done.
  assert.deepEqual(scheduler.delays(), [15_000, 5_000]);
  scheduler.runNext();
  assert.deepEqual(reconciliations, [{ turnId: "turn-1", afterSeq: 1 }]);
  assert.equal(sockets[0].sent.at(-1)?.type, "resume_from");

  sockets[0].message(stream(2, "done"));
  assert.deepEqual(
    events.map((event) => event.type),
    ["content", "done"],
  );
  // Done released the replay probe; only the heartbeat ping remains.
  assert.deepEqual(scheduler.delays(), [15_000]);
});

test("a stale React resume cursor cannot rewind the live transport", () => {
  const { client } = harness();
  client.setResumeCursor("turn-1", 8);
  client.setResumeCursor("turn-1", 3);
  assert.deepEqual(client.cursor, { turnId: "turn-1", afterSeq: 8 });

  client.setResumeCursor("turn-2", 0);
  assert.deepEqual(client.cursor, { turnId: "turn-2", afterSeq: 0 });
});

test("heartbeats and invalid or future frames never become chat events", () => {
  const { client, diagnostics, events, sockets } = harness();
  client.connect();
  sockets[0].open();
  sockets[0].message({ type: "pong", protocol_version: "2.0" });
  sockets[0].message({ type: "future", content: "private" });
  sockets[0].message("not json");
  assert.equal(events.length, 0);
  assert.equal(diagnostics.length, 2);
  assert.doesNotMatch(diagnostics.join(" "), /private/);
});

test("mutations survive unrelated events and reconnects until their matching acknowledgement", () => {
  const { client, scheduler, sockets } = harness();
  client.setResumeCursor("turn-1", 2);
  client.connect();
  sockets[0].open();
  client.cancel(buildCancelTurn("turn-1", "cancel-1"));
  client.send(
    buildSubmitUserReply({
      turnId: "turn-1",
      text: "continue",
      commandId: "reply-1",
    }),
  );
  assert.equal(sockets[0].readyState, SOCKET_OPEN);

  sockets[0].close();
  scheduler.runNext();
  sockets[1].open();
  assert.equal(
    sockets[1].sent.filter((item) => item.type === "submit_user_reply").length,
    1,
  );
  sockets[1].message(stream(3));

  sockets[1].close();
  scheduler.runNext();
  sockets[2].open();
  assert.equal(
    sockets[2].sent.filter((item) => item.type === "submit_user_reply").length,
    1,
  );
  sockets[2].message({
    type: "command_ack",
    command_id: "reply-1",
    command_type: "submit_user_reply",
    accepted: true,
    turn_id: "turn-1",
    error_code: "",
    message: "",
    protocol_version: "2.0",
  });

  sockets[2].close();
  scheduler.runNext();
  sockets[3].open();
  assert.equal(
    sockets[3].sent.filter((item) => item.type === "submit_user_reply").length,
    0,
  );
  assert.equal(
    sockets[3].sent.filter((item) => item.type === "cancel_turn").length,
    1,
  );
  sockets[3].message({
    type: "command_ack",
    command_id: "cancel-1",
    command_type: "cancel_turn",
    accepted: false,
    turn_id: "turn-1",
    error_code: "turn_not_active",
    message: "already terminal",
    protocol_version: "2.0",
  });

  sockets[3].close();
  scheduler.runNext();
  sockets[4].open();
  assert.equal(
    sockets[4].sent.filter((item) => item.type === "cancel_turn").length,
    0,
  );
});

test("stopping cancels retries and idle hidden sessions do not reconnect", () => {
  const { client, scheduler, sockets } = harness();
  client.connect();
  sockets[0].open();
  client.setPageVisible(false);
  sockets[0].close();
  assert.equal(scheduler.tasks.length, 0);

  client.setPageVisible(true);
  assert.equal(sockets.length, 2);
  client.stop();
  assert.equal(client.state, "stopped");
  assert.equal(scheduler.tasks.length, 0);
});

test("a rejected reply resolves its waiter instead of leaving the card pending", async () => {
  const { client, sockets } = harness();
  client.connect();
  sockets[0].open();

  const verdict = client.sendAwaitingAck(
    buildSubmitUserReply({
      turnId: "turn-1",
      text: "B",
      commandId: "reply-1",
    }),
  );
  sockets[0].message({
    type: "command_ack",
    command_id: "reply-1",
    command_type: "submit_user_reply",
    accepted: false,
    turn_id: "turn-1",
    error_code: "turn_not_waiting_input",
    message: "not awaiting",
    protocol_version: "2.0",
  });

  assert.equal(await verdict, false);
});

test("an accepted reply resolves true", async () => {
  const { client, sockets } = harness();
  client.connect();
  sockets[0].open();

  const verdict = client.sendAwaitingAck(
    buildSubmitUserReply({
      turnId: "turn-1",
      text: "B",
      commandId: "reply-2",
    }),
  );
  sockets[0].message({
    type: "command_ack",
    command_id: "reply-2",
    command_type: "submit_user_reply",
    accepted: true,
    turn_id: "turn-1",
    error_code: "",
    message: "",
    protocol_version: "2.0",
  });

  assert.equal(await verdict, true);
});

test("stopping releases waiters that will never be acknowledged", async () => {
  const { client, sockets } = harness();
  client.connect();
  sockets[0].open();

  const verdict = client.sendAwaitingAck(
    buildSubmitUserReply({
      turnId: "turn-1",
      text: "B",
      commandId: "reply-3",
    }),
  );
  client.stop();

  assert.equal(await verdict, false);
});

/* ── Half-open connections ──────────────────────────────────────────────
   A locked phone or an expired NAT mapping keeps the socket "open" while
   nothing will ever arrive again: the ask-user card froze on "Sending your
   answers…" and the composer hung on a send whose ack could never come. */

function ackFor(
  commandId: string,
  accepted: boolean,
): Record<string, unknown> {
  return {
    type: "command_ack",
    command_id: commandId,
    command_type: "submit_user_reply",
    accepted,
    turn_id: "turn-1",
    error_code: "",
    message: "",
    protocol_version: "2.0",
  };
}

test("an acknowledgement that never lands times out and releases the waiter", async () => {
  const warns: string[] = [];
  const originalWarn = console.warn;
  console.warn = (value: unknown) => {
    warns.push(String(value));
  };
  try {
    const { client, scheduler, sockets } = harness();
    client.setResumeCursor("turn-1", 2);
    client.connect();
    sockets[0].open();

    const verdict = client.sendAwaitingAck(
      buildSubmitUserReply({
        turnId: "turn-1",
        text: "B",
        commandId: "reply-9",
      }),
    );
    assert.ok(scheduler.delays().includes(8_000));
    scheduler.runNext(); // the 8s ack timeout beats the 15s heartbeat ping

    assert.equal(await verdict, false);
    // Same verdict shape as stop(): one warn, timer gone. The reply itself
    // is NOT dropped any more — it is parked for a re-send on the next
    // healthy connection (see the deferred-reply tests below), because a
    // half-open socket means the server never saw it and the paused turn
    // would wait forever.
    assert.equal(warns.length, 1);
    assert.match(warns[0], /reply-9/);
    assert.match(warns[0], /turn-1/);
    assert.ok(!scheduler.delays().includes(8_000));

    sockets[0].close();
    scheduler.runNext(); // reconnect
    sockets[1].open();
    const resent = sockets[1].sent.find(
      (item) => item.type === "submit_user_reply",
    );
    assert.ok(resent, "the timed-out reply must be re-sent after reconnect");
    assert.equal(resent.command_id, "reply-9");
  } finally {
    console.warn = originalWarn;
  }
});

test("an acknowledgement that lands in time clears its timeout", async () => {
  const { client, scheduler, sockets } = harness();
  client.connect();
  sockets[0].open();

  const verdict = client.sendAwaitingAck(
    buildSubmitUserReply({
      turnId: "turn-1",
      text: "B",
      commandId: "reply-10",
    }),
  );
  assert.ok(scheduler.delays().includes(8_000));
  sockets[0].message(ackFor("reply-10", true));

  assert.equal(await verdict, true);
  assert.ok(!scheduler.delays().includes(8_000));
});

test("a late acknowledgement after the timeout never settles twice", async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const { client, scheduler, sockets } = harness();
    client.connect();
    sockets[0].open();

    let settles = 0;
    const verdict = client
      .sendAwaitingAck(
        buildSubmitUserReply({
          turnId: "turn-1",
          text: "B",
          commandId: "reply-11",
        }),
      )
      .then((accepted) => {
        settles += 1;
        return accepted;
      });
    scheduler.runNext(); // ack timeout
    sockets[0].message(ackFor("reply-11", true)); // ack arrives too late

    assert.equal(await verdict, false);
    assert.equal(settles, 1);
  } finally {
    console.warn = originalWarn;
  }
});

test("a socket silent after its ping is closed and the reconnect takes over", () => {
  const warns: string[] = [];
  const originalWarn = console.warn;
  console.warn = (value: unknown) => {
    warns.push(String(value));
  };
  try {
    const { client, scheduler, sockets, states } = harness();
    client.setResumeCursor("turn-1", 0);
    client.connect();
    sockets[0].open();
    scheduler.runNext(); // heartbeat ping fires
    assert.equal(sockets[0].sent.at(-1)?.type, "ping");
    assert.deepEqual(scheduler.delays(), [10_000]);

    scheduler.runNext(); // liveness watchdog: no inbound frame since the ping
    assert.equal(sockets[0].readyState, 3); // killed through socket.close()
    assert.equal(states.at(-1), "recovering"); // normal close path
    scheduler.runNext(); // scheduled reconnect ran
    assert.equal(sockets.length, 2);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /heartbeat timeout/);
    assert.match(warns[0], /turn-1/);
    // Heartbeat timers did not survive the close.
    assert.ok(!scheduler.delays().includes(10_000));
  } finally {
    console.warn = originalWarn;
  }
});

test("a pong inside the liveness window keeps the socket and re-arms the ping", () => {
  const { client, scheduler, sockets } = harness();
  client.connect();
  sockets[0].open();
  scheduler.runNext(); // ping
  assert.equal(sockets[0].sent.at(-1)?.type, "ping");

  sockets[0].message({ type: "pong", protocol_version: "2.0" });
  scheduler.runNext(); // watchdog
  assert.equal(sockets[0].readyState, SOCKET_OPEN);
  assert.deepEqual(scheduler.delays(), [15_000]); // next cycle armed
});

test("any inbound frame counts as liveness after a ping", () => {
  const { client, scheduler, sockets } = harness();
  client.connect();
  sockets[0].open();
  scheduler.runNext(); // ping

  sockets[0].message(stream(1));
  scheduler.runNext(); // replay probe (re-armed at 5s once the frame set the turn)
  scheduler.runNext(); // watchdog: the stream frame already proved liveness
  assert.equal(sockets[0].readyState, SOCKET_OPEN);
  assert.ok(scheduler.delays().includes(15_000)); // ping cycle resumed
});

const realDateNow = Date.now;

test("a watchdog firing late after a frozen tab grants a grace pass first", () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const { client, scheduler, sockets } = harness();
    client.connect();
    sockets[0].open();
    scheduler.runNext(); // ping sent while the tab was still live

    // Simulate a throttled tab: the watchdog runs minutes late.
    const base = Date.now();
    Date.now = () => base + 60_000;
    scheduler.runNext();
    assert.equal(sockets[0].readyState, SOCKET_OPEN); // not killed
    assert.deepEqual(scheduler.delays(), [1_000]); // grace pass armed

    Date.now = () => base + 60_001;
    sockets[0].message({ type: "pong", protocol_version: "2.0" }); // queued frame lands
    scheduler.runNext(); // grace re-check
    assert.equal(sockets[0].readyState, SOCKET_OPEN);
    assert.ok(scheduler.delays().includes(15_000)); // cycle resumed, no reconnect

    // And silence is still punished: a fresh ping cycle resets the grace,
    // its late watchdog arms a second grace pass, and a silent re-check
    // finally kills the socket.
    Date.now = () => base + 60_002;
    scheduler.runNext(); // next ping
    Date.now = () => base + 120_000;
    scheduler.runNext(); // late watchdog → second grace pass
    assert.equal(sockets[0].readyState, SOCKET_OPEN);
    assert.deepEqual(scheduler.delays(), [1_000]);
    Date.now = () => base + 120_001;
    scheduler.runNext(); // grace re-check, still silent → dead
    assert.equal(sockets[0].readyState, 3);
  } finally {
    Date.now = realDateNow;
    console.warn = originalWarn;
  }
});

test("stopping while connected clears the heartbeat timers", () => {
  const { client, scheduler, sockets } = harness();
  client.connect();
  sockets[0].open();
  assert.deepEqual(scheduler.delays(), [15_000]);

  client.stop();
  assert.deepEqual(scheduler.delays(), []);
});

/* ── UnifiedTurnClient reporting over the REAL state machine ───────────
   These drive the production wrapper (UnifiedTurnClient) over the real
   TurnRuntimeClient through socket events only — no callback is invoked by
   hand. They are the reachability proof for the paused-turn recovery path
   in ChatStateAdapter: with an active turn id a drop lands in
   "recovering", and "idle"/onClose — the signal that path used to hang on
   — is unreachable. */
test("a live turn's socket drop reports recovering and never reaches idle", () => {
  const sockets: FakeSocket[] = [];
  const scheduler = new FakeScheduler();
  const states: RuntimeConnectionState[] = [];
  let recoveringReports = 0;
  let closeCalls = 0;
  const client = new UnifiedTurnClient(
    () => undefined,
    () => {
      closeCalls += 1;
    },
    () => {
      recoveringReports += 1;
    },
    {
      onStateChange: (state) => {
        states.push(state);
      },
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      scheduler,
    },
  );

  client.setResumeState("turn-1", 4);
  client.connect();
  // With a persisted turn the runtime opens straight into "recovering"
  // (resuming counts as recovering) — report #1.
  assert.equal(recoveringReports, 1);
  sockets[0].open();
  assert.ok(client.connected);
  assert.equal(states.at(-1), "connected");

  // The remote end vanishes mid-turn: the runtime must report the drop as
  // "recovering" — report #2, the signal ChatStateAdapter's paused-turn
  // recovery hangs on.
  sockets[0].close();
  assert.ok(states.includes("recovering"), `states=${states.join(",")}`);
  assert.equal(recoveringReports, 2);
  assert.ok(!client.connected);

  // …and keep reconnecting: with a live turn id "idle" is unreachable
  // (shouldReconnect never exhausts), so onClose — the signal the previous
  // paused-turn recovery hung on — cannot fire. The reconnect instead
  // lands back in "connected".
  scheduler.runNext();
  sockets[1].open();
  assert.equal(states.at(-1), "connected");
  assert.ok(!states.includes("idle"), `states=${states.join(",")}`);
  assert.equal(closeCalls, 0);
  assert.equal(recoveringReports, 2);

  client.disconnect();
});

test("an idle session's exhausted retries reach onClose with no recovering report", () => {
  const sockets: FakeSocket[] = [];
  const scheduler = new FakeScheduler();
  const states: RuntimeConnectionState[] = [];
  let recoverings = 0;
  let closeCalls = 0;
  const client = new UnifiedTurnClient(
    () => undefined,
    () => {
      closeCalls += 1;
    },
    () => {
      recoverings += 1;
    },
    {
      onStateChange: (state) => {
        states.push(state);
      },
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      scheduler,
    },
  );

  client.connect();
  // Five doomed attempts (IDLE_ATTEMPT_LIMIT) with no active turn id, then
  // the machine rests in "idle" and onClose fires exactly once.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    sockets.at(-1)!.close();
    assert.equal(states.at(-1), "connecting");
    scheduler.runNext();
  }
  sockets.at(-1)!.close();
  assert.equal(states.at(-1), "idle");
  assert.equal(closeCalls, 1);
  assert.equal(recoverings, 0);
});

/* ── Deferred reply re-send (ADR-0003 at-least-once) ────────────────────
   A reply whose ack times out on a half-open socket left the paused turn
   waiting forever: nothing re-sent it, so every later start_turn bounced
   off "already has an active turn". The timeout must park the reply for a
   re-send on the next healthy connection — same command_id, so the server
   de-duplicates. */
test("a timed-out reply is re-sent with its command_id after reconnect", async () => {
  const warns: string[] = [];
  const originalWarn = console.warn;
  console.warn = (value: unknown) => {
    warns.push(String(value));
  };
  try {
    const { client, scheduler, sockets } = harness();
    client.setResumeCursor("turn-1", 2);
    client.connect();
    sockets[0].open();

    const verdict = client.sendAwaitingAck(
      buildSubmitUserReply({
        turnId: "turn-1",
        text: "第二章",
        commandId: "reply-77",
      }),
    );
    scheduler.runNext(); // the 8s ack timeout fires against the dead link
    assert.equal(await verdict, false);

    // The drop + reconnect: the deferred reply must ride out on the fresh
    // socket, carrying the SAME command_id (that is what makes the re-send
    // safe per ADR-0003).
    sockets[0].close();
    scheduler.runNext(); // reconnect
    sockets[1].open();
    const resent = sockets[1].sent.find(
      (item) => item.type === "submit_user_reply",
    );
    assert.ok(resent, "deferred reply was not re-sent after reconnect");
    assert.equal(resent.command_id, "reply-77");
    assert.equal(resent.text, "第二章");

    // The server's verdict settles it: one ack retires the reply for good.
    sockets[1].message(ackFor("reply-77", true));
    sockets[1].close();
    scheduler.runNext(); // another reconnect
    sockets[2].open();
    assert.equal(
      sockets[2].sent.filter((item) => item.type === "submit_user_reply")
        .length,
      0,
      "a reply must not be re-sent again after its acknowledgement",
    );
  } finally {
    console.warn = originalWarn;
  }
});

test("a deferred reply that is rejected still counts as processed", async () => {
  const { client, scheduler, sockets } = harness();
  client.setResumeCursor("turn-1", 2);
  client.connect();
  sockets[0].open();

  const verdict = client.sendAwaitingAck(
    buildSubmitUserReply({
      turnId: "turn-1",
      text: "第二章",
      commandId: "reply-78",
    }),
  );
  scheduler.runNext(); // timeout → deferred
  assert.equal(await verdict, false);

  sockets[0].close();
  scheduler.runNext();
  sockets[1].open();
  // The turn already moved on (say the user answered from another path):
  // the server refuses the stale reply, and that refusal must retire it —
  // re-sending a processed answer forever would be worse than losing one.
  sockets[1].message(ackFor("reply-78", false));
  sockets[1].close();
  scheduler.runNext();
  sockets[2].open();
  assert.equal(
    sockets[2].sent.filter((item) => item.type === "submit_user_reply").length,
    0,
    "a rejected reply must not be re-sent again",
  );
});

/* ── Command rejections reach the UI ────────────────────────────────────
   The server refuses start_turn on a session that still holds a live or
   recovering turn via a protocol_error frame. The wrapper must surface it
   as a stream event, or the composer keeps claiming a turn is running that
   the server declined to start. */
test("a start_turn rejection surfaces as a protocol_error stream event", () => {
  const seen: Array<Record<string, unknown>> = [];
  const sockets: FakeSocket[] = [];
  const scheduler = new FakeScheduler();
  const client = new UnifiedTurnClient(
    (event) => seen.push(event as unknown as Record<string, unknown>),
    undefined,
    undefined,
    {
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      scheduler,
    },
  );

  client.connect();
  sockets[0].open();
  sockets[0].message({
    type: "protocol_error",
    error_code: "start_turn_rejected",
    message: "Session already has an active or recovering turn",
    retryable: true,
    protocol_version: "2.0",
  });

  const rejection = seen.find((event) => event.type === "protocol_error");
  assert.ok(rejection, "protocol_error never reached the UI stream");
  const metadata = rejection.metadata as Record<string, unknown>;
  assert.equal(metadata.error_code, "start_turn_rejected");
  assert.equal(metadata.retryable, true);
  client.disconnect();
});
