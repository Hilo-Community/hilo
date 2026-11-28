// @vitest-environment happy-dom
import { HiloEditorView, InMemoryBinaryHostBridge, promptInputOf } from "@hilo/editor-cm6";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CockpitDomController, createCockpitStoreBundle } from "../index.js";
import type { AgentRegistryHost, InstalledAgent } from "../settings/agent-registry.js";
import { AgentPanel } from "./panel.js";
import { type AcpEvent, type AgentHandle, type AgentHost, AgentStore } from "./store.js";

afterEach(() => vi.unstubAllGlobals());
const chunk = (text: string): AcpEvent => ({
  type: "update",
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
});
const button = (root: HTMLElement, label: string) =>
  [...root.querySelectorAll("button")].find(
    (b) => b.textContent === label || b.getAttribute("aria-label") === label,
  ) as HTMLButtonElement;
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
function host() {
  let receive: (event: AcpEvent) => void = () => undefined;
  const handle: AgentHandle = {
    prompt: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    answer: vi.fn(async () => undefined),
  };
  const host: AgentHost = {
    start: vi.fn(async (_, onEvent) => {
      receive = onEvent;
      return handle;
    }),
  };
  return { host, handle, emit: (event: AcpEvent) => receive(event) };
}
describe("LOT-014 agent panel", () => {
  it("opens a named panel from a Settings event and starts it while preserving the editor", async () => {
    const fake = host();
    let open = (_agent: InstalledAgent) => {};
    const stop = vi.fn();
    const registry: AgentRegistryHost = {
      list: async () => ({ agents: [], installed: [], origin: "saved", refreshError: null }),
      install: async () => null,
      uninstall: async () => {},
      onOpenRequested: (listener) => {
        open = listener;
        return stop;
      },
    };
    const root = document.createElement("div");
    document.body.replaceChildren(root);
    const stores = createCockpitStoreBundle();
    const editor = new HiloEditorView({
      initialDocumentId: "file.ts",
      initialContent: "",
      ipcChannel: new InMemoryBinaryHostBridge(),
    });
    const cockpit = new CockpitDomController({
      rootContainer: root,
      stores,
      editorView: editor,
      agentHost: fake.host,
      agentRegistryHost: registry,
    });
    const view = editor.getEditorView();
    const parent = view.dom.parentElement;
    open({
      id: "claude-acp@1",
      agentId: "claude-acp",
      name: "Claude Agent",
      version: "1",
      distribution: "npm",
    });
    await settle();
    expect(fake.host.start).toHaveBeenCalledWith(
      { installedAgentId: "claude-acp", conversationId: stores.zone3.getState().activeChatId },
      expect.any(Function),
    );
    expect(stores.zone3.getState().chats.at(-1)).toMatchObject({
      agentId: "claude-acp",
      agentName: "Claude Agent",
      title: "Claude Agent",
    });
    const tab = [...root.querySelectorAll<HTMLElement>(".hilo-header-tab")].find((tab) =>
      tab.textContent?.includes("Claude Agent"),
    );
    expect(tab?.querySelector(".hilo-registry-mark svg")).not.toBeNull();
    const chatId = stores.zone3.getState().activeChatId;
    const agentPanel = root.querySelector(".hilo-agent-panel");
    tab?.querySelector<HTMLButtonElement>(".hilo-header-tab-close")?.click();
    expect(root.querySelector(".hilo-agent-panel")).toBeNull();
    expect(stores.zone3.getState().chats.find((chat) => chat.chatId === chatId)).toMatchObject({
      panelHidden: true,
    });
    stores.selectChat(chatId);
    expect(root.querySelector(".hilo-agent-panel")).toBe(agentPanel);
    expect(fake.host.start).toHaveBeenCalledOnce();
    expect(fake.handle.stop).not.toHaveBeenCalled();
    expect(editor.getEditorView()).toBe(view);
    expect(view.dom.parentElement).toBe(parent);
    cockpit.destroy();
    editor.destroy();
    root.remove();
    expect(stop).toHaveBeenCalledOnce();
  });
  it.each(["Agent missing", "Node missing", "Sandbox unavailable", "Agent launch cancelled"])(
    "shows %s and retries by installed id without a setup form",
    async (reason) => {
      const fake = host();
      vi.mocked(fake.host.start).mockRejectedValueOnce(new Error(reason));
      const panel = new AgentPanel(document, fake.host, async () => {}, {
        agentId: "codex",
        name: "Codex",
      });
      expect(panel.element.textContent).not.toContain("Connecting…");
      await settle();
      expect(panel.element.textContent).toContain(reason);
      expect(panel.element.querySelector("input, details")).toBeNull();
      button(panel.element, "Retry").click();
      await settle();
      expect(fake.host.start).toHaveBeenCalledTimes(2);
      expect(fake.host.start).toHaveBeenLastCalledWith(
        { installedAgentId: "codex" },
        expect.any(Function),
      );
      panel.destroy();
    },
  );
  it("logs out through the Host, and reauthenticates by connecting again after it", async () => {
    const fake = host();
    const order: string[] = [];
    fake.host.signOut = vi.fn(async (id: string) => {
      order.push(`signOut:${id}`);
    });
    vi.mocked(fake.host.start).mockImplementation(async () => {
      order.push("start");
      return fake.handle;
    });
    const panel = new AgentPanel(document, fake.host, async () => {}, {
      agentId: "codex",
      name: "Codex",
    });
    await settle();
    expect(panel.canSignOut()).toBe(true);
    order.length = 0;
    panel.logOut();
    await settle();
    expect(order).toEqual(["signOut:codex"]);
    order.length = 0;
    panel.reauthenticate();
    await settle();
    expect(order).toEqual(["signOut:codex", "start"]);
    order.length = 0;
    panel.reload();
    await settle();
    expect(order).toEqual(["start"]);
    expect(
      new AgentPanel(
        document,
        host().host,
        async () => {},
        { agentId: "x", name: "X" },
        false,
      ).canSignOut(),
    ).toBe(false);
  });
  it("restores a panel dormant until the user uses it", async () => {
    const fake = host();
    const panel = new AgentPanel(
      document,
      fake.host,
      async () => {},
      { agentId: "codex", name: "Codex" },
      false,
    );
    await settle();
    expect(fake.host.start).not.toHaveBeenCalled();
    panel.activate();
    await settle();
    expect(fake.host.start).toHaveBeenCalledOnce();
    panel.destroy();
  });
  it("batches tokens into one independent atomic update and escapes hostile Markdown", () => {
    const frames: (() => void)[] = [];
    const store = new AgentStore((cb) => frames.push(cb));
    for (let i = 0; i < 150; i++) store.enqueue(chunk(i === 0 ? "<script>attack()</script>" : "x"));
    expect(store.getUpdateCount()).toBe(0);
    expect(frames).toHaveLength(1);
    frames[0]?.();
    expect(store.getUpdateCount()).toBe(1);
    expect(store.getState().messages).toHaveLength(1);
    expect(store.getState().messages[0]?.html.join("")).toContain("&lt;script&gt;");
    store.dispose();
    store.enqueue(chunk("late"));
    expect(store.getUpdateCount()).toBe(1);
  });
  it("bounds tool previews without charging discarded output against the display budget", () => {
    const frames: Array<() => void> = [];
    const store = new AgentStore((cb) => frames.push(cb));
    const image = "A".repeat(3 * 1024 * 1024);
    for (const id of ["a", "b"]) {
      store.enqueue({
        type: "update",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: id,
          title: "Read a.png",
          kind: "read",
          status: "completed",
          content: [{ type: "content", content: { type: "image", data: image } }],
          rawOutput: image,
        },
      });
      for (const run of frames.splice(0)) run();
    }
    expect(store.getState().error).toBe("");
    expect(store.getState().tools.map((tool) => tool.status)).toEqual(["done", "done"]);
    // Retained text still has a bound.
    store.enqueue({ type: "message", role: "assistant", text: "x".repeat(3 * 1024 * 1024) });
    expect(store.getState().error).toContain("display limit");
  });
  it("merges plans, tools and proposals, filters unsafe locations, clears permissions on stop", () => {
    const store = new AgentStore(() => undefined);
    store.enqueue({
      type: "update",
      update: { sessionUpdate: "plan", entries: [{ content: "Test", status: "completed" }] },
    });
    store.enqueue({
      type: "update",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "t",
        title: "Read",
        kind: "read",
        status: "pending",
        locations: [{ path: "../.env" }, { path: "src/file.ts", line: 8 }],
      },
    });
    store.enqueue({
      type: "update",
      update: { sessionUpdate: "tool_call_update", toolCallId: "t", status: "completed" },
    });
    store.enqueue({ type: "permission", id: "p", reason: "Approval required", options: [] });
    store.flush();
    expect(store.getState().tools[0]).toMatchObject({
      title: "Read",
      status: "done",
      locations: [{ path: "src/file.ts", line: 8 }],
    });
    expect(store.getState().plan[0]?.status).toBe("completed");
    store.enqueue({ type: "stopped", reason: "Cancelled" });
    store.flush();
    expect(store.getState().permissions).toEqual([]);
    expect(store.getState().ready).toBe(false);
  });
  it("sends prompts, shows a read-only diff, opens a location, answers once and cancels", async () => {
    const fake = host();
    const open = vi.fn(async () => undefined);
    const store = new AgentStore(() => undefined);
    const panel = new AgentPanel(
      document,
      fake.host,
      open,
      { agentId: "codex", name: "Codex" },
      true,
      store,
    );
    document.body.append(panel.element);
    expect(panel.element.querySelector("details")).toBeNull();
    await settle();
    expect(fake.host.start).toHaveBeenCalledWith(
      { installedAgentId: "codex" },
      expect.any(Function),
    );
    expect(panel.element.querySelector("textarea")).toBeNull();
    expect(panel.element.querySelector(".cm-content")?.getAttribute("spellcheck")).toBe("false");
    promptInputOf(panel.element.querySelector(".hilo-agent-composer .cm-editor"))?.setText(
      "Repair tests",
    );
    panel.element.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
    await settle();
    expect(fake.handle.prompt).not.toHaveBeenCalled();
    expect(panel.element.textContent).toContain("Reconnecting to the agent…");
    fake.emit({ type: "ready", sessionId: "s" });
    store.flush();
    await settle();
    expect(fake.handle.prompt).toHaveBeenCalledExactlyOnceWith("Repair tests");
    fake.emit({
      type: "proposedEdit",
      edit: {
        id: "e",
        path: "src/file.ts",
        baseContentHash: "abc",
        oldText: "old 🦀",
        newText: "new 🦀",
      },
    });
    fake.emit({ type: "permission", id: "p", reason: "Review exact call", options: [] });
    store.flush();
    expect(
      [...panel.element.querySelectorAll(".hilo-agent-diff-text")].map((line) => line.textContent),
    ).toEqual(["old 🦀", "new 🦀"]);
    expect(
      [...panel.element.querySelectorAll(".hilo-agent-diff-prefix")].map(
        (mark) => mark.textContent,
      ),
    ).toEqual(["-", "+"]);
    // The proposal is read-only; only the prompt (a CodeMirror field) is editable.
    expect(panel.element.querySelector(".hilo-agent-output [contenteditable]")).toBeNull();
    // The link shows the file's name; its full place is the tooltip.
    panel.element.querySelector<HTMLButtonElement>('button[title="src/file.ts:1"]')?.click();
    await settle();
    expect(open).toHaveBeenCalledWith("src/file.ts", 1);
    button(panel.element, "Allow once").click();
    await settle();
    expect(fake.handle.answer).toHaveBeenCalledWith("p", true);
    fake.emit({
      type: "permission",
      id: "agent-choice",
      reason: "Choose the agent policy",
      options: [
        { optionId: "once-id", name: "Allow once", kind: "allow_once" },
        { optionId: "always-id", name: "Allow for this session", kind: "allow_always" },
      ],
    });
    store.flush();
    button(panel.element, "Allow for this session").click();
    await settle();
    expect(fake.handle.answer).toHaveBeenCalledWith("agent-choice", "always-id");
    button(panel.element, "Cancel").click();
    await settle();
    expect(fake.handle.cancel).toHaveBeenCalledOnce();
    panel.destroy();
    expect(fake.handle.stop).toHaveBeenCalledOnce();
  });
  it("streaming in the mounted cockpit preserves the exact EditorView and mount container", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    const fake = host();
    const root = document.createElement("div");
    document.body.append(root);
    const stores = createCockpitStoreBundle({
      initialChats: [
        {
          kind: "agent",
          chatId: "installed",
          title: "Codex",
          modelName: "Codex",
          agentId: "codex",
          agentName: "Codex",
          validationState: "UnchangedBlue",
        },
      ],
    });
    const editor = new HiloEditorView({
      initialDocumentId: "src/file.ts",
      initialContent: "const a = 1;",
      ipcChannel: new InMemoryBinaryHostBridge(),
    });
    const cockpit = new CockpitDomController({
      rootContainer: root,
      stores,
      editorView: editor,
      agentHost: fake.host,
    });
    const instance = editor.getEditorView();
    const parent = instance.dom.parentElement;
    const zone4Updates = stores.zone4.getUpdateCount();
    // A restored chat has no Connect step: getting ready to type connects it.
    expect(button(root, "Connect")).toBeUndefined();
    root
      .querySelector(".hilo-agent-composer .cm-content")
      ?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    await settle();
    expect(fake.host.start).toHaveBeenCalled();
    for (let i = 0; i < 150; i++) fake.emit(chunk("token "));
    for (const frame of frames.splice(0)) frame(16);
    expect(root.querySelector(".hilo-agent-output")?.textContent).toContain("token");
    expect(editor.getEditorView()).toBe(instance);
    expect(instance.dom.parentElement).toBe(parent);
    expect(editor.getStoreSnapshot().mountCount).toBe(1);
    expect(stores.zone4.getUpdateCount()).toBe(zone4Updates);
    cockpit.destroy();
    editor.destroy();
    root.remove();
  });
});
