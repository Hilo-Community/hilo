// @vitest-environment happy-dom
import { promptInputOf } from "@hilo/editor-cm6";
import { describe, expect, it, vi } from "vitest";
import { AgentPanel } from "./panel.js";
import { type AcpEvent, type AgentHost, type AgentState, AgentStore } from "./store.js";
import { parseTranscript, serializeTranscript } from "./transcript.js";

const event = (update: Record<string, unknown>) => ({ type: "update" as const, update });
const chunk = (text: string) =>
  event({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
function conversation(): AgentStore {
  const store = new AgentStore((callback) => callback());
  store.enqueue({ type: "message", role: "user", text: "analyze" });
  store.enqueue(chunk("First "));
  store.enqueue(chunk("part."));
  store.enqueue(
    event({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      kind: "execute",
      title: "ls",
      status: "completed",
      rawInput: { command: "ls -la" },
      content: [{ type: "content", content: { type: "text", text: "a.txt" } }],
    }),
  );
  store.enqueue(
    event({
      sessionUpdate: "tool_call",
      toolCallId: "t2",
      kind: "read",
      title: "Read",
      status: "in_progress",
    }),
  );
  store.enqueue(chunk("Second."));
  return store;
}

describe("saved conversations", () => {
  it("round-trips a conversation in order, with tools and text intact", () => {
    const state = conversation().getState();
    const json = serializeTranscript(state, "codex");
    expect(json).not.toBeNull();
    const snapshot = parseTranscript(json as string, "codex");
    expect(snapshot?.timeline.map((ref) => ref.type)).toEqual([
      "message",
      "message",
      "tool",
      "tool",
      "message",
    ]);
    expect(snapshot?.messages.map((m) => m.text)).toEqual(["analyze", "First part.", "Second."]);
    expect(snapshot?.tools[0]).toMatchObject({
      command: "ls -la",
      output: "a.txt",
      status: "done",
    });
    expect(json).not.toContain("<p>");
  });
  it("keeps when each tool and thought started, so a restored group says how long it worked", () => {
    const store = new AgentStore(
      (callback) => callback(),
      () => 5_000,
    );
    store.enqueue({ type: "message", role: "user", text: "go" });
    store.enqueue(chunk("Looking"));
    store.enqueue(
      event({
        sessionUpdate: "tool_call",
        toolCallId: "r",
        kind: "execute",
        title: "ls",
        status: "completed",
      }),
    );
    const saved = parseTranscript(serializeTranscript(store.getState(), "codex") ?? "", "codex");
    expect(saved?.tools[0]?.startedAt).toBe(5_000);
    const hostile = JSON.parse(serializeTranscript(store.getState(), "codex") ?? "{}");
    hostile.tools[0].startedAt = "soon";
    expect(parseTranscript(JSON.stringify(hostile), "codex")?.tools[0]?.startedAt).toBeUndefined();
  });
  it("keeps nothing for an empty panel, and nothing of another agent", () => {
    expect(serializeTranscript(new AgentStore().getState(), "codex")).toBeNull();
    const json = serializeTranscript(conversation().getState(), "codex") as string;
    expect(parseTranscript(json, "claude")).toBeNull();
  });
  it("refuses damaged or hostile files, and drops what is not valid", () => {
    expect(parseTranscript("not json", "codex")).toBeNull();
    expect(parseTranscript(JSON.stringify({ version: 9, agentId: "codex" }), "codex")).toBeNull();
    const hostile = {
      version: 1,
      agentId: "codex",
      messages: [
        { id: "message-0", role: "assistant", text: "<img src=x onerror=alert(1)>" },
        { id: "message-1", role: "system", text: "bad role" },
        { id: 5, role: "user", text: "bad id" },
      ],
      tools: [
        {
          id: "a",
          kind: "read",
          title: "ok",
          status: "done",
          locations: [
            { path: "/etc/passwd", line: 1 },
            { path: "../x", line: 1 },
            { path: "src/a.ts", line: 3 },
          ],
        },
        { id: "b", kind: "read", title: "bad status", status: "weird" },
      ],
      timeline: [
        { type: "message", id: "message-0" },
        { type: "message", id: "message-1" },
        { type: "tool", id: "a" },
        { type: "tool", id: "b" },
        { type: "tool", id: "missing" },
      ],
    };
    const snapshot = parseTranscript(JSON.stringify(hostile), "codex");
    expect(snapshot?.messages.map((m) => m.id)).toEqual(["message-0"]);
    expect(snapshot?.tools.map((t) => t.id)).toEqual(["a"]);
    expect(snapshot?.tools[0]?.locations).toEqual([{ path: "src/a.ts", line: 3 }]);
    expect(snapshot?.timeline).toEqual([
      { type: "message", id: "message-0" },
      { type: "tool", id: "a" },
    ]);
    const store = new AgentStore(() => {});
    store.restore(snapshot as NonNullable<typeof snapshot>);
    expect(store.getState().messages[0]?.html.join("")).not.toContain("<img");
  });
  it("shows a restored conversation with unfinished tools marked as cut off", () => {
    const json = serializeTranscript(conversation().getState(), "codex") as string;
    const store = new AgentStore((callback) => callback());
    store.restore(
      parseTranscript(json, "codex") as NonNullable<ReturnType<typeof parseTranscript>>,
    );
    const state: AgentState = store.getState();
    expect(state.restored).toBe(true);
    expect(state.tools.find((t) => t.id === "t2")?.status).toBe("denied");
    expect(state.tools.find((t) => t.id === "t1")?.status).toBe("done");
    // New text after a restore opens a new message, with a fresh id.
    store.enqueue(chunk("later"));
    expect(new Set(store.getState().messages.map((m) => m.id)).size).toBe(4);
  });
});

describe("a panel and its saved conversation", () => {
  function setup(saved: string | null) {
    const transcripts = {
      load: vi.fn(async (_chatId: string) => saved),
      save: vi.fn(async (_chatId: string, _json: string) => undefined),
      remove: vi.fn(async (_chatId: string) => undefined),
    };
    const host: AgentHost = {
      transcripts,
      start: vi.fn(async () => ({
        prompt: vi.fn(),
        cancel: vi.fn(),
        stop: vi.fn(async () => undefined),
        answer: vi.fn(),
      })),
    };
    return { transcripts, host };
  }
  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  it("loads the conversation of a restored panel and keeps it when connecting", async () => {
    const json = serializeTranscript(conversation().getState(), "codex") as string;
    const { host, transcripts } = setup(json);
    const panel = new AgentPanel(
      document,
      host,
      async () => undefined,
      { agentId: "codex", name: "Codex" },
      false,
      new AgentStore((c) => c()),
      { chatId: "chat-1", restore: true },
    );
    await settle();
    expect(transcripts.load).toHaveBeenCalledWith("chat-1");
    expect(panel.store.getState().messages).toHaveLength(3);
    expect(panel.element.textContent).toContain("gets a summary of it");
    panel.activate();
    await settle();
    expect(panel.store.getState().messages).toHaveLength(3);
    panel.destroy();
  });
  it("restores Copilot's session ID from disk before starting the connection", async () => {
    const original = conversation();
    original.enqueue({ type: "ready", sessionId: "saved-copilot-session" });
    original.enqueue({
      type: "options",
      options: [
        {
          id: "model",
          name: "Model",
          category: "model",
          current: "fast",
          choices: [{ name: "Fast", value: "fast" }],
        },
      ],
    });
    const json = serializeTranscript(original.getState(), "github-copilot-cli");
    const { host } = setup(json);
    const panel = new AgentPanel(
      document,
      host,
      async () => undefined,
      { agentId: "github-copilot-cli", name: "Copilot" },
      true,
      new AgentStore((callback) => callback()),
      { chatId: "copilot-chat", restore: true, cwd: "/projects/copilot" },
    );
    await settle();
    expect(panel.store.getState().messages).toHaveLength(3);
    expect(panel.element.textContent).not.toContain("gets a summary of it");
    expect(host.start).toHaveBeenCalledExactlyOnceWith(
      {
        installedAgentId: "github-copilot-cli",
        conversationId: "copilot-chat",
        expectedWorkspace: "/projects/copilot",
        resumeSessionId: "saved-copilot-session",
        preferredOptions: [{ id: "model", value: "fast" }],
      },
      expect.any(Function),
    );
    panel.destroy();
  });

  it("opens a saved chat without connecting and supplies history only to the first fallback prompt", async () => {
    const original = conversation();
    original.enqueue({ type: "ready", sessionId: "old-session" });
    const { host } = setup(serializeTranscript(original.getState(), "codex"));
    const store = new AgentStore((callback) => callback());
    const panel = new AgentPanel(
      document,
      host,
      async () => undefined,
      { agentId: "codex", name: "Codex" },
      false,
      store,
      { chatId: "chat-1", restore: true },
    );
    await settle();
    expect(store.getState().messages).toHaveLength(3);
    expect(host.start).not.toHaveBeenCalled();
    const send = (text: string) => {
      promptInputOf(panel.element.querySelector(".hilo-agent-composer .cm-editor"))?.setText(text);
      panel.element.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
    };
    send("continue");
    await settle();
    const handle = await vi.mocked(host.start).mock.results[0]?.value;
    expect(handle?.prompt).not.toHaveBeenCalled();
    store.enqueue({ type: "ready", sessionId: "replacement" });
    await settle();
    expect(handle?.prompt).toHaveBeenCalledExactlyOnceWith(
      "continue",
      expect.stringContaining("analyze"),
    );
    store.setState((state) => ({ ...state, busy: false }));
    send("next");
    await settle();
    expect(handle?.prompt).toHaveBeenLastCalledWith("next");
    panel.destroy();
  });

  /** A restored chat whose agent start is observable: every connection's event callback. */
  function liveRestore(sessionId: string) {
    const original = conversation();
    original.enqueue({ type: "ready", sessionId });
    const { host } = setup(serializeTranscript(original.getState(), "codex"));
    const connections: Array<{
      emit: (event: AcpEvent) => void;
      prompt: ReturnType<typeof vi.fn>;
    }> = [];
    host.start = vi.fn(async (_config, onEvent) => {
      const prompt = vi.fn(async () => undefined);
      connections.push({ emit: onEvent, prompt });
      return { prompt, cancel: vi.fn(), stop: vi.fn(async () => undefined), answer: vi.fn() };
    });
    const store = new AgentStore((callback) => callback());
    const panel = new AgentPanel(
      document,
      host,
      async () => undefined,
      { agentId: "codex", name: "Codex" },
      false,
      store,
      { chatId: "chat-1", restore: true, cwd: "/projects/app" },
    );
    const send = (text: string) => {
      promptInputOf(panel.element.querySelector(".hilo-agent-composer .cm-editor"))?.setText(text);
      panel.element.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
    };
    const retry = () => panel.element.querySelector<HTMLButtonElement>(".hilo-agent-connect");
    return { host, store, panel, connections, send, retry };
  }

  it("shows a restored chat like a live one and connects in the background on focus", async () => {
    const { host, panel, connections, retry } = liveRestore("old-session");
    await settle();
    expect(host.start).not.toHaveBeenCalled();
    expect(retry()?.hidden).toBe(true);
    expect(panel.element.textContent).not.toContain("Connect");
    panel.element
      .querySelector(".hilo-agent-composer .cm-content")
      ?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    await settle();
    expect(host.start).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ conversationId: "chat-1", resumeSessionId: "old-session" }),
      expect.any(Function),
    );
    connections[0]?.emit({ type: "ready", sessionId: "old-session" });
    await settle();
    expect(retry()?.hidden).toBe(true);
    panel.destroy();
  });

  it("reconnects silently after an ordinary exit and keeps the same ACP session", async () => {
    const { host, store, panel, connections, send, retry } = liveRestore("old-session");
    await settle();
    send("first");
    await settle();
    connections[0]?.emit({ type: "ready", sessionId: "old-session" });
    await settle();
    // The saved session was resumed: the agent already has the history, none is attached.
    expect(connections[0]?.prompt).toHaveBeenCalledExactlyOnceWith("first");
    store.setState((state) => ({ ...state, busy: false }));
    connections[0]?.emit({ type: "stopped", reason: "Agent exited", failed: false });
    await settle();
    expect(store.getState().error).toBe("");
    expect(retry()?.hidden).toBe(true);

    send("second");
    await settle();
    expect(host.start).toHaveBeenCalledTimes(2);
    expect(vi.mocked(host.start).mock.calls[1]?.[0]).toMatchObject({
      resumeSessionId: "old-session",
    });
    connections[1]?.emit({ type: "ready", sessionId: "old-session" });
    await settle();
    expect(connections[1]?.prompt).toHaveBeenCalledExactlyOnceWith("second");
    expect(store.getState().messages.some((m) => m.text === "analyze")).toBe(true);
    panel.destroy();
  });

  it("shows a failed session with Retry instead of reconnecting by itself", async () => {
    const { host, store, panel, connections, retry } = liveRestore("old-session");
    await settle();
    panel.activate();
    await settle();
    connections[0]?.emit({ type: "stopped", reason: "handshake timeout", failed: true });
    await settle();
    expect(store.getState().error).toBe("handshake timeout");
    expect(retry()?.hidden).toBe(false);
    expect(retry()?.textContent).toBe("Retry");
    panel.activate();
    await settle();
    expect(host.start).toHaveBeenCalledTimes(1);
    panel.destroy();
  });

  it("flushes assistant chunks waiting for the next animation frame before exit", async () => {
    const { host, transcripts } = setup(null);
    const store = new AgentStore(() => {});
    const panel = new AgentPanel(
      document,
      host,
      async () => undefined,
      { agentId: "codex", name: "Codex" },
      false,
      store,
      { chatId: "chat-1", restore: false },
    );
    store.enqueue(chunk("chunk received just before exit"));
    expect(store.getState().messages).toHaveLength(0);
    await panel.flushTranscript();
    const json = transcripts.save.mock.calls.at(-1)?.[1];
    expect(parseTranscript(json ?? "", "codex")?.messages[0]?.text).toBe(
      "chunk received just before exit",
    );
    panel.destroy();
  });

  it("restores an unsent draft in an empty chat without starting ACP", async () => {
    const { host, transcripts } = setup(null);
    const create = (restore: boolean) =>
      new AgentPanel(
        document,
        host,
        async () => undefined,
        { agentId: "codex", name: "Codex" },
        false,
        new AgentStore((callback) => callback()),
        { chatId: "chat-1", restore },
      );
    const input = (panel: AgentPanel) =>
      promptInputOf(panel.element.querySelector(".hilo-agent-composer .cm-editor"));
    const first = create(false);
    input(first)?.setText("¿Qué cambia en @src/main.ts?");
    await first.flushTranscript();
    const json = transcripts.save.mock.calls.at(-1)?.[1] ?? null;
    expect(json).not.toBeNull();
    first.destroy();
    transcripts.load.mockResolvedValueOnce(json);
    const restored = create(true);
    await settle();
    expect(input(restored)?.getText()).toBe("¿Qué cambia en @src/main.ts?");
    expect(restored.store.getState().messages).toHaveLength(0);
    expect(host.start).not.toHaveBeenCalled();
    restored.destroy();
  });

  it("does not load anything for a new panel, and saves what it shows", async () => {
    vi.useFakeTimers();
    const { host, transcripts } = setup("{}");
    const store = new AgentStore((c) => c());
    const panel = new AgentPanel(
      document,
      host,
      async () => undefined,
      { agentId: "codex", name: "Codex" },
      false,
      store,
      { chatId: "chat-2", restore: false },
    );
    expect(transcripts.load).not.toHaveBeenCalled();
    store.enqueue(chunk("hello"));
    expect(transcripts.save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(700);
    expect(transcripts.save).toHaveBeenCalledTimes(1);
    expect(transcripts.save.mock.calls[0]?.[0]).toBe("chat-2");
    vi.useRealTimers();
    panel.discard();
    await settle();
    expect(transcripts.remove).toHaveBeenCalledWith("chat-2");
    store.enqueue(chunk(" more"));
    panel.destroy();
    expect(transcripts.save).toHaveBeenCalledTimes(1);
  });
  it("ignores a saved file that is not valid, and one of another agent", async () => {
    const { host } = setup("garbage");
    const panel = new AgentPanel(
      document,
      host,
      async () => undefined,
      { agentId: "codex", name: "Codex" },
      false,
      new AgentStore((c) => c()),
      { chatId: "chat-3", restore: true },
    );
    await settle();
    expect(panel.store.getState().restored).toBe(false);
    panel.destroy();
  });
});
