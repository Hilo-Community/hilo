// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { activityEntries, workDuration } from "./activity-view.js";
import { ConversationView } from "./conversation-view.js";
import { type AgentState, AgentStore, type ToolCard } from "./store.js";
import { ToolCardView, toolLabel } from "./tool-card-view.js";

const tool = (id: string, kind: string, status: ToolCard["status"] = "done"): ToolCard => ({
  id,
  kind,
  status,
  title: `${kind} target`,
  locations: [],
});
const button = (label: string, click: () => void) => {
  const node = document.createElement("button");
  node.textContent = label;
  node.onclick = click;
  return node;
};
const actions = { openLocation: vi.fn(), answer: vi.fn() };
const timeline = (tools: ToolCard[]) => tools.map(({ id }) => ({ type: "tool" as const, id }));

function setup(tools: ToolCard[]) {
  const root = document.createElement("div");
  document.body.append(root);
  const view = new ConversationView();
  const state: AgentState = {
    ...new AgentStore(() => {}).getState(),
    tools,
    timeline: timeline(tools),
  };
  const render = (next: AgentState = state) => view.render(root, next, button, actions);
  render();
  return { root, state, render, view };
}

describe("work groups", () => {
  const header = (root: HTMLElement) =>
    root.querySelector(".hilo-agent-work > button") as HTMLButtonElement;

  it("groups every tool and thought between two messages, and keeps file changes apart", () => {
    const tools = [
      tool("a", "read"),
      tool("b", "execute"),
      tool("c", "edit"),
      tool("d", "search"),
      tool("e", "fetch"),
    ];
    const entries = activityEntries(
      [
        { type: "thought", id: "t0" },
        ...timeline(tools.slice(0, 3)),
        { type: "message", id: "m" },
        ...timeline(tools.slice(3, 4)),
        { type: "thought", id: "t" },
        ...timeline(tools.slice(4)),
      ],
      new Map(tools.map((tool) => [tool.id, tool])),
    );
    expect(entries.map((entry) => entry.type)).toEqual(["work", "tool", "message", "work"]);
    expect(entries[0]).toMatchObject({
      id: "t0",
      items: [{ type: "thought" }, { tool: { id: "a" } }, { tool: { id: "b" } }],
    });
    expect(entries[3]).toMatchObject({
      items: [{ tool: { id: "d" } }, { type: "thought", id: "t" }, { tool: { id: "e" } }],
    });
    // An edit proposal keeps its own review card, even if an agent changes its reported kind.
    const edit = {
      ...tool("edit", "read"),
      edit: { id: "edit", path: "a", baseContentHash: "h", oldText: "a", newText: "b" },
    };
    expect(activityEntries(timeline([edit]), new Map([[edit.id, edit]]))[0]?.type).toBe("tool");
  });

  it("says Working… and stays open while it is the turn's latest step, then Worked for", () => {
    const timed = (id: string, kind: string, startedAt: number, durationMs: number) => ({
      ...tool(id, kind),
      startedAt,
      durationMs,
    });
    const { root, state, render } = setup([
      timed("a", "read", 1_000, 500),
      { ...timed("b", "execute", 2_000, 0), status: "running" as const },
    ]);
    render({ ...state, busy: true });
    expect(header(root).textContent).toContain("Working…");
    expect(header(root).getAttribute("aria-expanded")).toBe("true");
    expect(root.querySelectorAll(".hilo-agent-work [role=listitem]")).toHaveLength(2);
    render({
      ...state,
      busy: false,
      tools: [timed("a", "read", 1_000, 500), timed("b", "execute", 2_000, 9_200)],
    });
    expect(header(root).textContent).toContain("Worked for 10s");
    expect(header(root).getAttribute("aria-expanded")).toBe("false");
    root.remove();
  });

  it("follows a turn: Thinking…, text, Exploring… with the tools under it, closed by text", () => {
    const store = new AgentStore(
      (callback) => callback(),
      () => 0,
    );
    const root = document.createElement("div");
    const view = new ConversationView();
    const render = () => view.render(root, store.getState(), button, actions);
    const live = () => root.querySelector(".hilo-agent-live")?.textContent;
    const update = (u: Record<string, unknown>) => store.enqueue({ type: "update", update: u });

    store.enqueue({ type: "message", role: "user", text: "check the logs" });
    render();
    expect(live()).toBe("Thinking…");

    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Looking" } });
    render();
    // The text streams above; the live line stays under it.
    expect(root.lastElementChild?.className).toBe("hilo-agent-live");
    expect(live()).toBe("Thinking…");

    update({
      sessionUpdate: "tool_call",
      toolCallId: "r1",
      kind: "execute",
      title: "cat a.txt",
      status: "in_progress",
    });
    render();
    expect(live()).toBe("Exploring…");
    expect(header(root).textContent).toContain("Working…");
    expect(root.querySelector(".hilo-agent-work .hilo-agent-tool")).not.toBeNull();

    update({ sessionUpdate: "tool_call_update", toolCallId: "r1", status: "completed" });
    render();
    expect(live()).toBe("Thinking…");

    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Found it" } });
    render();
    expect(header(root).textContent).toContain("Worked");
    expect(header(root).getAttribute("aria-expanded")).toBe("false");

    update({
      sessionUpdate: "tool_call",
      toolCallId: "r2",
      kind: "search",
      title: "grep",
      status: "in_progress",
    });
    render();
    expect(root.querySelectorAll(".hilo-agent-work")).toHaveLength(2);
    expect(live()).toBe("Exploring…");

    store.enqueue({
      type: "update",
      update: { sessionUpdate: "turn_complete", stopReason: "end_turn" },
    });
    render();
    expect(root.querySelector(".hilo-agent-live")).toBeNull();
  });

  it("times a group from its first start to its last end, and adds steps saved without a start", () => {
    const timed = { ...tool("a", "read"), startedAt: 1_000, durationMs: 400 };
    const later = { ...tool("b", "execute"), startedAt: 3_000, durationMs: 2_000 };
    expect(workDuration([timed, later], [])).toBe(4_000);
    // An older saved conversation kept durations only.
    const old = { ...tool("c", "execute"), durationMs: 1_500 };
    expect(workDuration([old], [{ startedAt: 0, durationMs: 500 }])).toBe(2_000);
    expect(workDuration([tool("d", "read")], [])).toBeUndefined();
  });

  it("keeps a lone thought as its own row, without a group", () => {
    const { root, state, render } = setup([]);
    render({
      ...state,
      thoughts: [{ id: "t", text: "plan", startedAt: 0, durationMs: 3000, running: false }],
      timeline: [{ type: "thought", id: "t" }],
    });
    expect(root.querySelector(".hilo-agent-work")).toBeNull();
    expect(root.querySelector(".hilo-agent-thinking")?.textContent).toContain("Thought for 3s");
    root.remove();
  });

  it("preserves manual disclosure and nested tool focus as a group grows", () => {
    const { root, state, render } = setup([tool("a", "search", "running")]);
    render({ ...state, busy: true });
    header(root).click();
    expect(header(root).getAttribute("aria-expanded")).toBe("false");
    header(root).click();
    const nested = root.querySelector(".hilo-agent-tool > button") as HTMLButtonElement;
    render({ ...state, busy: true, tools: [{ ...tool("a", "search"), output: "one\ntwo" }] });
    nested.focus();
    nested.click();
    const read = tool("b", "read");
    render({
      ...state,
      busy: false,
      tools: [{ ...tool("a", "search"), output: "one\ntwo\nthree" }, read],
      timeline: [...state.timeline, ...timeline([read])],
    });
    expect(root.querySelector(".hilo-agent-tool > button")).toBe(nested);
    expect(document.activeElement).toBe(nested);
    expect(nested.getAttribute("aria-expanded")).toBe("true");
    // The reader opened it: it stays open after the turn, a click always wins.
    expect(header(root).getAttribute("aria-expanded")).toBe("true");
    root.remove();
  });

  it("stays open while a tool waits for permission, and keeps a failure visible in its row", () => {
    const { root } = setup([tool("a", "read", "pending")]);
    expect(root.querySelector(".hilo-agent-work")?.getAttribute("data-status")).toBe("pending");
    expect(header(root).getAttribute("aria-expanded")).toBe("true");
    root.remove();
    const failed = setup([tool("b", "execute", "failed")]);
    expect(failed.root.querySelector(".hilo-agent-work")?.getAttribute("data-status")).toBe(
      "failed",
    );
    expect(failed.root.querySelector(".hilo-agent-tool")?.getAttribute("data-status")).toBe(
      "failed",
    );
    failed.root.remove();
  });

  it("does not merge across messages and clears group disclosures on reset", () => {
    const { root, state, view } = setup([tool("a", "read"), tool("b", "search")]);
    view.render(
      root,
      {
        ...state,
        messages: [{ id: "m", role: "assistant", text: "Next", html: ["Next"] }],
        timeline: [
          { type: "tool", id: "a" },
          { type: "message", id: "m" },
          { type: "tool", id: "b" },
        ],
      },
      button,
      actions,
    );
    const shown = [...root.children].filter(
      (el) => !el.classList.contains("hilo-agent-response-actions"),
    );
    expect(shown).toHaveLength(3);
    expect(shown[1]?.textContent).toBe("Next");
    (root.querySelector("button") as HTMLButtonElement).click();
    view.render(root, { ...state, tools: [], timeline: [] }, button, actions);
    view.render(root, state, button, actions);
    expect(root.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
    root.remove();
  });
});

describe("ACP thinking tools", () => {
  it("uses Thinking/Thought with the real title and bounded summary, without Calling", () => {
    const view = new ToolCardView(document);
    const thinking = {
      ...tool("think", "think", "running"),
      title: "Guardian Review",
      output: "<script>Review the proposal</script>",
    };
    const element = view.update(thinking, vi.fn());
    expect(toolLabel(thinking)).toEqual({ verb: "Thinking…", target: "Guardian Review" });
    expect(element.classList.contains("hilo-agent-activity")).toBe(true);
    expect(element.textContent).not.toContain("Calling");
    expect(element.querySelector("script")).toBeNull();
    expect(view.card.header.getAttribute("aria-expanded")).toBe("true");
    view.update({ ...thinking, status: "done" }, vi.fn());
    expect(view.card.header.textContent).toContain("Thought");
    expect(view.card.header.getAttribute("aria-expanded")).toBe("false");
    view.card.header.click();
    view.update({ ...thinking, status: "done", output: "Final summary" }, vi.fn());
    expect(view.card.header.getAttribute("aria-expanded")).toBe("true");
  });
  it("disables an empty reasoning disclosure instead of inventing a summary or duration", () => {
    const view = new ToolCardView(document);
    view.update({ ...tool("think", "think"), title: "Review" }, vi.fn());
    expect(view.card.header.disabled).toBe(true);
    expect(view.card.header.textContent).not.toContain("for");
  });
});
