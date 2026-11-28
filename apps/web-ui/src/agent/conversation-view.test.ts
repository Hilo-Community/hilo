// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { ConversationView, conversationElements, planList } from "./conversation-view.js";
import { diffLines } from "./diff.js";
import { AgentStore, type ToolCard } from "./store.js";
import { ToolCardView, diffView, toolLabel, toolVariant } from "./tool-card-view.js";

const makeTool = (patch: Partial<ToolCard> = {}): ToolCard => ({
  id: "tool",
  kind: "read",
  title: "Read file",
  status: "done",
  locations: [],
  ...patch,
});
const button = (label: string, click: () => void) => {
  const node = document.createElement("button");
  node.textContent = label;
  node.addEventListener("click", click);
  return node;
};
const actions = () => ({ openLocation: vi.fn(), answer: vi.fn() });

describe("tool card presentation", () => {
  it.each([
    ["read", "simple"],
    ["search", "simple"],
    ["fetch", "simple"],
    ["move", "simple"],
    ["execute", "command"],
    ["edit", "diff"],
    ["delete", "diff"],
    ["mcp:server", "simple"],
  ])("maps %s to the %s variant", (kind, variant) => expect(toolVariant(kind)).toBe(variant));
  it("uses lifecycle tenses and prefers the file target", () => {
    const tool = makeTool({
      kind: "edit",
      status: "running",
      locations: [{ path: "src/a.ts", line: 1 }],
    });
    // A file card names its file, not its folder.
    expect(toolLabel(tool)).toEqual({ verb: "Editing", target: "a.ts" });
    expect(toolLabel({ ...tool, status: "done" }).verb).toBe("Edited");
    expect(toolLabel(makeTool({ kind: "__proto__" })).verb).toBe("Called");
  });
  it("disables empty headers and keeps simple reads without a disclosure body", () => {
    const view = new ToolCardView(document);
    const open = vi.fn();
    const element = view.update(makeTool({ locations: [{ path: "src/a.ts", line: 8 }] }), open);
    expect(view.card.header.disabled).toBe(true);
    expect(view.card.header.getAttribute("aria-expanded")).toBe("false");
    expect(view.card.body.childElementCount).toBe(0);
    (element.querySelector(".hilo-agent-location") as HTMLButtonElement).click();
    expect(open).toHaveBeenCalledWith("src/a.ts", 8);
    expect(element.querySelector("svg")).not.toBeNull();
  });
  it("opens commands while they run, keeps failures open, preserves focus, scroll and manual disclosure", () => {
    const view = new ToolCardView(document);
    let tool = makeTool({
      kind: "execute",
      status: "running",
      command: "pnpm test",
      output: "first\nsecond",
    });
    const element = view.update(tool, vi.fn());
    document.body.append(element);
    expect(view.card.header.getAttribute("aria-expanded")).toBe("true");
    view.update({ ...tool, status: "done", exitCode: 0 }, vi.fn());
    expect(view.card.header.getAttribute("aria-expanded")).toBe("false");
    tool = { ...tool, status: "failed", exitCode: 2 };
    view.update(tool, vi.fn());
    expect(view.card.header.getAttribute("aria-expanded")).toBe("true");
    expect(element.textContent).toContain("Exit code 2");
    view.card.header.focus();
    view.card.header.click();
    view.update({ ...tool, output: "updated" }, vi.fn());
    expect(document.activeElement).toBe(view.card.header);
    expect(view.card.header.getAttribute("aria-expanded")).toBe("false");
    expect(view.card.body.parentElement?.parentElement?.inert).toBe(true);
    view.card.header.click();
    const output = element.querySelector(".hilo-agent-command-output") as HTMLElement;
    output.scrollTop = 24;
    view.update({ ...tool, output: "more" }, vi.fn());
    expect(element.querySelector(".hilo-agent-command-output")?.scrollTop).toBe(24);
    view.update({ ...tool, status: "denied" }, vi.fn());
    expect(element.textContent).toContain("Stopped");
    element.remove();
  });
  it("renders safe key/value arguments and a short search list", () => {
    const view = new ToolCardView(document);
    const element = view.update(
      makeTool({
        kind: "mcp",
        title: "<script>bad()</script>",
        arguments: [["query", "<img src=x onerror=bad()>"]],
      }),
      vi.fn(),
    );
    expect(element.querySelector("dt")?.textContent).toBe("query");
    expect(element.querySelector("dd")?.textContent).toContain("<img");
    expect(element.querySelector("img, script")).toBeNull();
    view.update(makeTool({ kind: "search", output: "src/a.ts\nsrc/b.ts" }), vi.fn());
    expect(element.querySelector(".hilo-agent-list")?.textContent).toContain("src/b.ts");
  });
  it("renders read-only colored proposals with counters and accurate numbers after gaps", () => {
    const oldText = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const newText = oldText.replace("line 12", "changed\nadded");
    const edit = { id: "e", path: "src/a.ts", baseContentHash: "abc", oldText, newText };
    const view = new ToolCardView(document);
    const element = view.update(makeTool({ kind: "edit", edit }), vi.fn());
    expect(view.card.extra.textContent).toBe("+2−1");
    expect(element.textContent).toContain("proposal only");
    const removed = element.querySelector('[data-kind="-"]');
    expect(removed?.querySelector(".hilo-agent-line-number")?.textContent).toBe("12");
    expect(element.querySelector("[contenteditable]")).toBeNull();
    expect(diffView(document, diffLines("same", "same"), "a").textContent).toBe("No changes");
  });
});

describe("conversation order", () => {
  const chunk = (text: string) => ({
    type: "update" as const,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  });
  const toolCall = (id: string) => ({
    type: "update" as const,
    update: { sessionUpdate: "tool_call", toolCallId: id, kind: "execute", title: id },
  });
  it("keeps text and tools in the order they arrived, as separate messages", () => {
    const store = new AgentStore((callback) => callback());
    store.enqueue(chunk("First. "));
    store.enqueue(chunk("Still first."));
    store.enqueue(toolCall("one"));
    store.enqueue(chunk("Second."));
    store.enqueue(toolCall("two"));
    const state = store.getState();
    expect(state.messages.map((m) => m.text)).toEqual(["First. Still first.", "Second."]);
    expect(state.timeline.map((ref) => ref.type)).toEqual(["message", "tool", "message", "tool"]);
    // The finished answer's Copy / Retry row is not part of the order being checked.
    const shown = new ConversationView()
      .elements(document, state, button, actions())
      .filter((el) => !el.classList.contains("hilo-agent-response-actions"));
    expect(shown.map((el) => el.tagName)).toEqual(["ARTICLE", "ARTICLE", "ARTICLE", "ARTICLE"]);
    expect(shown[0]?.textContent).toBe("First. Still first.");
    expect(shown[2]?.textContent).toBe("Second.");
  });
  it("starts the numbering over when the session is reset", () => {
    const store = new AgentStore((callback) => callback());
    store.enqueue(chunk("a"));
    store.reset();
    store.enqueue(chunk("b"));
    expect(store.getState().timeline).toEqual([{ type: "message", id: "message-0" }]);
  });
});

describe("conversation extras", () => {
  it("retains tool DOM and focus while assistant messages stream", () => {
    const store = new AgentStore(() => {});
    const tool = makeTool({ kind: "execute", command: "ls" });
    const state = {
      ...store.getState(),
      tools: [tool],
      timeline: [{ type: "tool" as const, id: tool.id }],
    };
    const root = document.createElement("div");
    document.body.append(root);
    const view = new ConversationView();
    const callbacks = actions();
    view.render(root, state, button, callbacks);
    const header = root.querySelector("button") as HTMLButtonElement;
    header.click();
    header.focus();
    const withMessage = {
      ...state,
      messages: [{ id: "m", role: "assistant", text: "hello", html: ["<p>hello</p>"] }],
      timeline: [...state.timeline, { type: "message" as const, id: "m" }],
    };
    view.render(root, withMessage, button, callbacks);
    const article = root.querySelector("article[data-role='assistant']");
    view.render(
      root,
      { ...withMessage, messages: [{ id: "m", role: "assistant", text: "hello world", html: [] }] },
      button,
      callbacks,
    );
    expect(root.querySelector("article[data-role='assistant']")).toBe(article);
    expect(article?.textContent).toBe("hello world");
    expect(root.querySelector("button")).toBe(header);
    expect(document.activeElement).toBe(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    view.render(root, store.getState(), button, callbacks);
    expect(root.children).toHaveLength(0);
    view.render(root, state, button, callbacks);
    expect(root.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
    root.remove();
  });
  it("opens thinking while streaming, folds a moment after it ends unless the user toggled", () => {
    vi.useFakeTimers();
    const store = new AgentStore(() => {});
    const state = store.getState();
    const thought = { id: "thought", text: "Checking the changes", startedAt: 0, running: true };
    const view = new ConversationView();
    const render = (running: boolean) =>
      view.elements(
        document,
        {
          ...state,
          thoughts: [{ ...thought, running, durationMs: 8000 }],
          timeline: [{ type: "thought", id: "thought" }],
        },
        button,
        actions(),
      )[0];
    const element = render(true);
    const header = element?.querySelector("button");
    expect(header?.getAttribute("aria-expanded")).toBe("true");
    render(false);
    expect(header?.textContent).toContain("Thought for 8s");
    // It stays open a moment so the last words can be read, then folds by itself.
    expect(header?.getAttribute("aria-expanded")).toBe("true");
    vi.advanceTimersByTime(1100);
    expect(header?.getAttribute("aria-expanded")).toBe("false");
    header?.click();
    render(false);
    expect(header?.getAttribute("aria-expanded")).toBe("true");
    view.dispose();
    vi.useRealTimers();
  });
  it("preserves permission disclosure and action focus while other content streams", () => {
    const store = new AgentStore(() => {});
    const state = { ...store.getState(), permissions: [{ id: "p", reason: "Review" }] };
    const root = document.createElement("div");
    document.body.append(root);
    const view = new ConversationView();
    view.render(root, state, button, actions());
    const header = root.querySelector(".hilo-agent-card-header") as HTMLButtonElement;
    const allow = root.querySelector(".hilo-agent-permission-actions button") as HTMLButtonElement;
    allow.focus();
    view.render(
      root,
      {
        ...state,
        messages: [{ id: "m", role: "assistant", text: "x", html: ["<p>x</p>"] }],
        timeline: [{ type: "message", id: "m" }],
      },
      button,
      actions(),
    );
    expect(document.activeElement).toBe(allow);
    header.click();
    view.render(root, state, button, actions());
    expect(header.getAttribute("aria-expanded")).toBe("false");
    root.remove();
  });
  it("shows textual plan states and routes permission choices", () => {
    const list = planList(document, [
      { content: "Design", status: "completed" },
      { content: "Build", status: "in_progress" },
      { content: "Test", status: "pending" },
    ]);
    expect(list.querySelector('[aria-current="step"]')?.textContent).toContain("In progress");
    expect(list.textContent).toContain("Completed");
    expect(list.textContent).toContain("Pending");
    const store = new AgentStore(() => {});
    const callbacks = actions();
    const [permission] = conversationElements(
      document,
      { ...store.getState(), permissions: [{ id: "p", reason: "Review this call" }] },
      button,
      callbacks,
    );
    expect(permission?.dataset.status).toBe("pending");
    const choices = permission?.querySelectorAll<HTMLButtonElement>(
      ".hilo-agent-permission-actions button",
    );
    choices?.[0]?.click();
    choices?.[1]?.click();
    expect(callbacks.answer.mock.calls).toEqual([
      ["p", true],
      ["p", false],
    ]);
  });
});

describe("turn summary and permissions", () => {
  const edit = (id: string, path: string, newText: string): ToolCard =>
    makeTool({
      id,
      kind: "edit",
      locations: [{ path, line: 1 }],
      edit: { id, path, baseContentHash: "h", oldText: "a", newText },
    });
  const stateOf = (tools: ToolCard[], patch: object = {}) => ({
    ...new AgentStore(() => {}).getState(),
    tools,
    timeline: tools.map((tool) => ({ type: "tool" as const, id: tool.id })),
    ...patch,
  });
  it("ends a turn that edited several files with a summary, but not while it runs", () => {
    const tools = [
      edit("e1", "src/a.ts", "a\nb"),
      edit("e2", "src/b.ts", "x"),
      edit("e3", "src/a.ts", "a\nb\nc"),
    ];
    const view = new ConversationView();
    const running = view.elements(document, stateOf(tools, { busy: true }), button, actions());
    expect(running.some((el) => el.classList.contains("hilo-agent-changes"))).toBe(false);
    const done = view.elements(document, stateOf(tools, { busy: false }), button, actions());
    const summary = done.at(-1) as HTMLElement;
    expect(summary.classList.contains("hilo-agent-changes")).toBe(true);
    expect(summary.textContent).toContain("2 files changed");
    expect(summary.querySelectorAll(".hilo-agent-change-file")).toHaveLength(2);
    const open = actions();
    const again = new ConversationView().elements(document, stateOf(tools), button, open);
    (again.at(-1)?.querySelector(".hilo-agent-change-file") as HTMLButtonElement).click();
    expect(open.openLocation).toHaveBeenCalledWith("src/a.ts", 1);
  });
  it("does not summarize a single file", () => {
    const shown = new ConversationView().elements(
      document,
      stateOf([edit("e1", "src/a.ts", "b")]),
      button,
      actions(),
    );
    expect(shown.some((el) => el.classList.contains("hilo-agent-changes"))).toBe(false);
  });
  it("draws a permission right under the tool that waits for it", () => {
    const waiting = makeTool({ id: "run", kind: "execute", status: "pending", command: "ls" });
    const later = makeTool({ id: "later", kind: "execute", status: "done", command: "pwd" });
    const state = stateOf([waiting, later], { permissions: [{ id: "p", reason: "Run ls" }] });
    const shown = new ConversationView().elements(document, state, button, actions());
    expect(shown[1]?.classList.contains("hilo-agent-permission")).toBe(true);
    expect(shown[1]?.hasAttribute("data-attached")).toBe(true);
    const alone = new ConversationView().elements(
      document,
      stateOf([later], { permissions: [{ id: "p", reason: "x" }] }),
      button,
      actions(),
    );
    expect(alone.at(-1)?.hasAttribute("data-attached")).toBe(false);
  });
});
