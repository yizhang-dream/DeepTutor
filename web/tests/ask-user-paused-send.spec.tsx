import fs from "node:fs";
import path from "node:path";

import { useEffect, createRef, type ComponentProps } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import ChatComposer from "@/components/chat/home/ChatComposer";
import { AskUserOptions } from "@/components/chat/home/AskUserOptions";
import type { AskUserCardData } from "@/components/chat/home/AskUserOptions";
import {
  ChatStateAdapterProvider,
  useChatStateAdapter,
} from "@/features/chat/ChatStateAdapter";
import { getChatCapability } from "@/features/capabilities/presentation";
import { hasPendingAskUserInMessages } from "@/lib/ask-user-state";
import { subscribeNotifications } from "@/lib/notifications";
import { getSession } from "@/lib/session-api";
import { initI18n } from "@/i18n/init";

initI18n("en");

/**
 * A controllable stand-in for the unified WS client: `send` of a start_turn
 * binds a server session and pauses the turn on an ask_user card ("pause"
 * mode), or starts a plain live turn ("plain" mode). Tests feed socket
 * events through `drop()` / `exhaustWithoutTurn()` — the two routes the
 * REAL state machine distinguishes (see TurnRuntimeClient.handleClose and
 * reconnect-policy): a drop with a live turn id lands in "recovering" and
 * surfaces through the recovering report, while a turnless session burns
 * its bounded retries and rests in "idle", which is the only route to
 * onClose. Reachability of both routes is proven against the real state
 * machine in tests/turn-runtime-client.test.ts.
 */
const transport = vi.hoisted(() => {
  type MockEvent = Record<string, unknown>;
  const instances: MockUnifiedTurnClient[] = [];
  const state = { mode: "pause" as "pause" | "plain" | "reject" };

  class MockUnifiedTurnClient {
    connected = false;
    submitted: Array<Record<string, unknown>> = [];

    constructor(
      private readonly onEvent: (event: MockEvent) => void,
      private readonly onClose?: () => void,
      private readonly onRecovering?: () => void,
    ) {
      instances.push(this);
    }

    connect(): void {
      this.connected = true;
    }

    setResumeState(): void {}

    disconnect(): void {
      this.connected = false;
    }

    /** Socket dies while a turn is live → "recovering" report. */
    drop(): void {
      this.connected = false;
      this.onRecovering?.();
    }

    /** No active turn: retries exhaust → "idle" → onClose. */
    exhaustWithoutTurn(): void {
      this.connected = false;
      this.onClose?.();
    }

    send(message: MockEvent): void {
      if (message.type !== "start_turn") return;
      this.onEvent({
        type: "session",
        source: "",
        stage: "",
        content: "",
        metadata: { session_id: "sess-1", turn_id: "turn-1273" },
        session_id: "sess-1",
        turn_id: "turn-1273",
        seq: 1,
        timestamp: Date.now() / 1000,
      });
      if (state.mode === "reject") {
        // The server refuses the new turn. Shaped exactly as the real
        // UnifiedTurnClient emits it: the protocol_error frame hoisted into
        // a stream event with the verdict under metadata.
        this.onEvent({
          type: "protocol_error",
          source: "",
          stage: "",
          content: "",
          metadata: {
            error_code: "start_turn_rejected",
            message: "Session already has an active or recovering turn",
            retryable: true,
          },
          turn_id: "turn-1273",
          seq: 2,
          timestamp: Date.now() / 1000,
        });
        return;
      }
      if (state.mode !== "pause") return;
      this.onEvent({
        type: "tool_result",
        source: "chat",
        stage: "responding",
        content: "",
        metadata: {
          tool_call_id: "call-1273",
          tool_metadata: {
            ask_user: {
              questions: [{ id: "source", prompt: "Which source?" }],
            },
          },
        },
        turn_id: "turn-1273",
        seq: 2,
        timestamp: Date.now() / 1000,
      });
    }

    sendAwaitingAck(message: MockEvent): Promise<boolean> {
      this.submitted.push(message);
      return Promise.resolve(true);
    }
  }

  return { instances, state, MockUnifiedTurnClient };
});

vi.mock("@/features/chat/transport/UnifiedTurnClient", () => ({
  UnifiedTurnClient: transport.MockUnifiedTurnClient,
}));

vi.mock("@/lib/session-api", () => ({
  getSession: vi.fn(),
  getMessageTrace: vi.fn(),
  deleteMessage: vi.fn(),
  updateBranchSelection: vi.fn(),
  updateSessionTitle: vi.fn(),
}));

function Harness() {
  const chat = useChatStateAdapter();

  useEffect(() => {
    chat.newSession();
    // Only initialize the draft once; the provider owns subsequent state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pending = hasPendingAskUserInMessages(
    chat.state.messages,
    chat.state.activeTurnId,
  );
  return (
    <div>
      <span data-testid="streaming">{String(chat.state.isStreaming)}</span>
      <span data-testid="active-turn">{String(chat.state.activeTurnId)}</span>
      <span data-testid="pending">{String(pending)}</span>
      <span data-testid="messages">{String(chat.state.messages.length)}</span>
      <button
        type="button"
        onClick={() => chat.sendMessage("walk me through it")}
      >
        Start turn
      </button>
      <button type="button" onClick={() => void chat.loadSession("sess-1")}>
        Reload session
      </button>
    </div>
  );
}

describe("a socket dropped while a turn is paused on a question", () => {
  afterEach(() => {
    vi.useRealTimers();
    transport.instances.length = 0;
    transport.state.mode = "pause";
  });

  it("keeps the pause alive, says it is reconnecting, then re-pulls the turn", async () => {
    vi.useFakeTimers();
    vi.mocked(getSession).mockResolvedValue({
      session_id: "sess-1",
      title: "",
      status: "completed",
      active_turns: [],
      messages: [],
      preferences: {},
      updated_at: 1,
    } as never);

    const toasts: string[] = [];
    const unsubscribe = subscribeNotifications((n) => toasts.push(n.message));

    render(
      <ChatStateAdapterProvider>
        <Harness />
      </ChatStateAdapterProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Start turn" }));
    expect(screen.getByTestId("streaming")).toHaveTextContent("true");
    expect(screen.getByTestId("pending")).toHaveTextContent("true");
    // The turn id rides on the public state now, so composers can scope
    // "is this card a pause of the current turn?" without re-deriving it.
    expect(screen.getByTestId("active-turn")).toHaveTextContent("turn-1273");

    // The remote end vanishes mid-turn — a socket event, routed through
    // the recovering report exactly as the real runtime routes it.
    const client = transport.instances.at(-1);
    expect(client).toBeTruthy();
    act(() => {
      client?.drop();
    });

    // The pause card must survive the drop: no STREAM_END may fire here.
    expect(screen.getByTestId("streaming")).toHaveTextContent("true");
    expect(screen.getByTestId("pending")).toHaveTextContent("true");
    // …but silence is not the answer either — the user is told.
    expect(toasts.some((m) => m.startsWith("Reconnecting"))).toBe(true);

    // A beat later the deferred re-pull runs over HTTP (a different
    // connection than the WS) — but a live pause card must never be
    // swapped for the server snapshot: the card is not a persisted row
    // yet, so the swap would erase the user's only way to answer. The
    // fetch happens; its result is discarded while the card lives.
    await act(async () => {
      vi.advanceTimersByTime(4_100);
    });
    expect(getSession).toHaveBeenCalledWith("sess-1", undefined);
    // Nothing was clobbered: the turn is still paused, the card still
    // on screen, still answerable.
    expect(screen.getByTestId("streaming")).toHaveTextContent("true");
    expect(screen.getByTestId("pending")).toHaveTextContent("true");

    unsubscribe();
  });

  it("still settles a streaming turn as failed when retries exhaust into idle", () => {
    vi.useFakeTimers();
    transport.state.mode = "plain";

    const toasts: string[] = [];
    const unsubscribe = subscribeNotifications((n) => toasts.push(n.message));

    render(
      <ChatStateAdapterProvider>
        <Harness />
      </ChatStateAdapterProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Start turn" }));
    expect(screen.getByTestId("streaming")).toHaveTextContent("true");
    expect(screen.getByTestId("pending")).toHaveTextContent("false");

    // No active turn: the bounded retry budget burns down, the machine
    // rests in "idle", and only then does the adapter mark the turn failed.
    act(() => {
      transport.instances.at(-1)?.exhaustWithoutTurn();
    });

    expect(screen.getByTestId("streaming")).toHaveTextContent("false");
    expect(
      toasts.some((m) => m.startsWith("Connection lost while generating")),
    ).toBe(true);

    unsubscribe();
  });

  it("a start_turn rejection unlocks the composer instead of hanging forever", () => {
    vi.useFakeTimers();
    transport.state.mode = "reject";

    const toasts: string[] = [];
    const unsubscribe = subscribeNotifications((n) => toasts.push(n.message));

    render(
      <ChatStateAdapterProvider>
        <Harness />
      </ChatStateAdapterProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Start turn" }));

    // The server bounced the start ("Session already has an active or
    // recovering turn"). The socket is fine, so the send "succeeded" — but
    // leaving isStreaming up would freeze the composer on a turn that does
    // not exist. The rejection frame settles the turn synchronously.
    expect(screen.getByTestId("streaming")).toHaveTextContent("false");
    expect(toasts.some((m) => m.startsWith("DeepTutor could not start"))).toBe(
      true,
    );

    unsubscribe();
  });

  it("a snapshot reload never erases a live pause card", async () => {
    vi.useFakeTimers();
    vi.mocked(getSession).mockResolvedValue({
      session_id: "sess-1",
      title: "",
      status: "completed",
      active_turns: [],
      // The server's message list holds no card row while the turn is
      // paused — exactly what a naive LOAD_SESSION would clobber.
      messages: [],
      preferences: {},
      updated_at: 1,
    } as never);

    render(
      <ChatStateAdapterProvider>
        <Harness />
      </ChatStateAdapterProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Start turn" }));
    const messagesBefore = screen.getByTestId("messages").textContent;
    expect(screen.getByTestId("pending")).toHaveTextContent("true");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reload session" }));
    });

    // The card — and the turn it belongs to — survived the reload.
    expect(screen.getByTestId("pending")).toHaveTextContent("true");
    expect(screen.getByTestId("streaming")).toHaveTextContent("true");
    expect(screen.getByTestId("messages").textContent).toBe(messagesBefore);
  });
});

/* ─── Composer affordances while the turn is paused ─────────────────── */

type ComposerProps = ComponentProps<typeof ChatComposer>;

function composerProps(
  overrides: Partial<ComposerProps> = {},
): ComposerProps {
  const cap = getChatCapability(null);
  const noop = () => undefined;
  return {
    composerRef: createRef<HTMLDivElement>(),
    capMenuRef: createRef<HTMLDivElement>(),
    capBtnRef: createRef<HTMLButtonElement>(),
    spaceMenuRef: createRef<HTMLDivElement>(),
    spaceBtnRef: createRef<HTMLButtonElement>(),
    dragCounter: { current: 0 },
    dragging: false,
    capMenuOpen: false,
    spaceMenuOpen: false,
    hasMessages: true,
    attachments: [],
    attachmentError: null,
    activeCap: cap,
    knowledgeBases: [],
    llmOptions: [],
    activeLLMDefault: null,
    llmSelection: null,
    llmOptionsLoading: false,
    llmOptionsError: false,
    selectedNotebookRecords: [],
    selectedBookReferences: [],
    selectedHistorySessions: [],
    selectedAgentSessions: [],
    selectedQuestionEntries: [],
    notebookReferenceGroups: [],
    selectedPersona: null,
    selectedMemoryFiles: [],
    selectedKnowledgeBases: [],
    isStreaming: false,
    isVisualizeMode: false,
    capabilityNeedsConfig: false,
    capabilityConfigConfirmed: true,
    onRequestConfigConfirm: noop,
    capabilities: [cap],
    onSetCapMenuOpen: noop,
    onSetSpaceMenuOpen: noop,
    onToggleKB: noop,
    onSelectLLM: noop,
    onSelectNotebookPicker: noop,
    onSelectBookPicker: noop,
    onSelectHistoryPicker: noop,
    onSelectAgentsPicker: noop,
    onSelectQuestionBankPicker: noop,
    onSelectPersonaPicker: noop,
    onSelectMemoryPicker: noop,
    onClearPersona: noop,
    onToggleMemoryFile: noop,
    onSend: noop,
    onRemoveAttachment: noop,
    onRemoveHistory: noop,
    onRemoveAgent: noop,
    onRemoveBookReference: noop,
    onRemoveNotebook: noop,
    onRemoveQuestion: noop,
    onDragEnter: noop,
    onDragLeave: noop,
    onDragOver: noop,
    onDrop: noop,
    onPaste: noop,
    onAddFiles: noop,
    onSelectCapability: noop,
    onCancelStreaming: noop,
    ...overrides,
  };
}

function typeIntoComposer(text: string) {
  const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.keyDown(textarea, { key: "Enter" });
}

describe("composer affordances on a turn paused by a question", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("offers Send (not Stop), and Enter routes the answer through onSend", () => {
    const onSend = vi.fn();
    const onCancelStreaming = vi.fn();
    render(
      <ChatComposer
        {...composerProps({
          isStreaming: true,
          awaitingUserReply: true,
          onSend,
          onCancelStreaming,
        })}
      />,
    );

    // The paused turn is technically streaming; the button must read as the
    // way to answer it, never as the way to cancel it.
    expect(
      screen.getByRole("button", { name: "Send answer" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Stop generating" }),
    ).toBeNull();

    typeIntoComposer("Knowledge center");
    expect(onSend).toHaveBeenCalledWith("Knowledge center");
    expect(onCancelStreaming).not.toHaveBeenCalled();

    // Clicking the same button sends rather than cancels. (Enter cleared
    // the box, so type the answer again first.)
    typeIntoComposer("Knowledge center");
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onCancelStreaming).not.toHaveBeenCalled();
  });

  it("keeps Stop semantics for a turn that is running without a pause", () => {
    const onSend = vi.fn();
    const onCancelStreaming = vi.fn();
    render(
      <ChatComposer
        {...composerProps({
          isStreaming: true,
          onSend,
          onCancelStreaming,
        })}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Stop generating" }),
    ).toBeInTheDocument();

    // Enter must not inject a message into a running turn…
    typeIntoComposer("hello?");
    expect(onSend).not.toHaveBeenCalled();
    // …and the button cancels.
    fireEvent.click(screen.getByRole("button", { name: "Stop generating" }));
    expect(onCancelStreaming).toHaveBeenCalledTimes(1);
  });
});

/* ─── Workspace fallback wiring (source contract) ────────────────────── */

describe("chat workspace reply-fallback wiring", () => {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), "features/chat/components/ChatWorkspace.tsx"),
    "utf8",
  );

  it("notifies, then falls through past the streaming guard", () => {
    const notifyAt = source.indexOf("notify(t(REPLY_SENT_AS_NEW_MESSAGE))");
    const flagAt = source.indexOf("replyFallback = true");
    const guardAt = source.indexOf("(state.isStreaming && !replyFallback)");
    expect(notifyAt).toBeGreaterThan(-1);
    expect(flagAt).toBeGreaterThan(notifyAt);
    // The guard itself must let the fallback through, or the text the
    // composer already cleared dies right here.
    expect(guardAt).toBeGreaterThan(flagAt);
  });

  it("restores the composer text when the fallback never reaches a socket", () => {
    const deliveredAt = source.indexOf("const delivered = await sendMessage(");
    const restoreAt = source.indexOf("handlePrefillComposer(content)");
    expect(deliveredAt).toBeGreaterThan(-1);
    expect(restoreAt).toBeGreaterThan(deliveredAt);
  });

  it("decides awaitingUserReply from the current turn, and only while it is live", () => {
    // Turn-scoped while a turn is live…
    expect(source).toMatch(
      /hasPendingAskUserInMessages\(\s*state\.messages,\s*state\.activeTurnId\s*\)/,
    );
    // …and inert without one: a card left behind by a cancelled/failed turn
    // (activeTurnId already cleared) must not route the next message
    // through submit_user_reply and pop the "sent as a new message" toast.
    expect(source).toMatch(
      /awaitingUserReply\s*=\s*state\.activeTurnId\s*\?\s*hasPendingAskUserInMessages/,
    );
    expect(source).toMatch(/:\s*false;\s*$/m);
  });
});

/* ─── The card must reopen after a failed delivery ──────────────────────
   A not-delivered answer means the turn is very likely still waiting: the
   card is the user's only way back into that turn, so an explicit failure
   must unlock it for a retry instead of bricking it behind the streaming
   lock. */
const card = (): AskUserCardData => ({
  payload: {
    intro: "Which chapter?",
    questions: [
      {
        id: "chapter",
        prompt: "Which chapter first?",
        header: null,
        multi_select: false,
        options: [{ label: "第二章", description: null }],
        allow_free_text: true,
        placeholder: null,
      },
    ],
  },
  answers: null,
  resolved: false,
  // The question finished streaming long ago — the user is answering a
  // fully-rendered card of a turn that is paused server-side.
  streaming: false,
});

describe("a card whose answer was not delivered", () => {
  it("reopens after the failure so the user can answer again", async () => {
    const user = userEvent.setup();
    // The first submit times out: useCardSubmission flips the card to
    // "not delivered" (submit resolves false).
    let verdict: boolean | undefined = false;
    const onSubmit = vi.fn(async () => verdict);
    const { container } = render(
      <AskUserOptions data={card()} onSubmit={onSubmit} />,
    );

    await user.click(screen.getByRole("button", { name: /第二章/ }));
    await user.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() =>
      expect(screen.getByText(/no longer active/i)).toBeInTheDocument(),
    );
    expect(onSubmit).toHaveBeenCalledTimes(1);

    // Still "streaming", but explicitly failed: the card must be clickable
    // again — this is the user's way back into the paused turn.
    const optionButtons = [
      ...container.querySelectorAll("button"),
    ] as HTMLButtonElement[];
    const retryOption = optionButtons.find((b) => /第二章/.test(b.textContent ?? ""));
    expect(retryOption).toBeTruthy();
    expect(retryOption!.disabled).toBe(false);

    // The retry goes out once the (mocked) transport would accept it.
    verdict = true;
    await user.click(retryOption!);
    await user.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
  });
});
