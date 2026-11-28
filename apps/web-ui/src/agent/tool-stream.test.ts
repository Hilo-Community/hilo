// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { ConversationView } from "./conversation-view.js";
import { AgentStore } from "./store.js";
import { TOOL_OUTPUT_LIMIT, stripTerminalEscapes, toolDetails } from "./tool-details.js";

const call = (extra: Record<string, unknown>, kind = "tool_call_update") => ({
  type: "update" as const,
  update: { sessionUpdate: kind, toolCallId: "run", ...extra },
});
const chunk = (data: string, key = "terminal_output") => ({ _meta: { [key]: { data } } });
const start = () =>
  call(
    { kind: "execute", title: "ls", status: "in_progress", rawInput: { command: "ls" } },
    "tool_call",
  );

describe("output of a running command", () => {
  it("shows output as it arrives, chunk by chunk", () => {
    const store = new AgentStore((callback) => callback());
    store.enqueue(start());
    store.enqueue(call(chunk("one\n")));
    expect(store.getState().tools[0]?.output).toBe("one\n");
    store.enqueue(call(chunk("two\n", "terminal_output_delta")));
    store.enqueue(call(chunk("three\n")));
    expect(store.getState().tools[0]?.output).toBe("one\ntwo\nthree\n");
    expect(store.getState().tools[0]?.status).toBe("running");
  });
  it("takes the exit code, and lets a final snapshot replace the streamed text", () => {
    const store = new AgentStore((callback) => callback());
    store.enqueue(start());
    store.enqueue(call(chunk("partial")));
    store.enqueue(
      call({
        status: "completed",
        _meta: { terminal_exit: { exit_code: 2 } },
        content: [{ type: "content", content: { type: "text", text: "final output" } }],
      }),
    );
    const tool = store.getState().tools[0];
    expect(tool).toMatchObject({ output: "final output", exitCode: 2, status: "done" });
  });
  it("keeps the output within its limit and says it was cut", () => {
    const store = new AgentStore((callback) => callback());
    store.enqueue(start());
    for (let i = 0; i < 4; i++) store.enqueue(call(chunk("x".repeat(TOOL_OUTPUT_LIMIT / 2))));
    const tool = store.getState().tools[0];
    expect(tool?.output?.length).toBe(TOOL_OUTPUT_LIMIT);
    expect(tool?.truncated).toBe(true);
  });
  it("shows plain text: colors and cursor moves are removed", () => {
    expect(
      stripTerminalEscapes("\u001b[31mred\u001b[0m \u001b]0;title\u0007ok\r50%\rdone\r\n"),
    ).toBe("red ok50%done\r\n");
    expect(toolDetails(call(chunk("\u001b[1mbold\u001b[0m")).update).delta).toBe("bold");
    expect(
      toolDetails(call({ _meta: { terminal_output: { data: 5 } } }).update).delta,
    ).toBeUndefined();
  });
  it("opens the command card while it runs, follows the output, and folds when done", () => {
    const store = new AgentStore((callback) => callback());
    const view = new ConversationView();
    const button = () => document.createElement("button");
    const actions = { openLocation: () => {}, answer: () => {} };
    store.enqueue(start());
    store.enqueue(call(chunk("line\n")));
    // The command is a row of its turn's work group, and its own card opens while it runs.
    const [group] = view.elements(document, store.getState(), button, actions);
    const card = group?.querySelector(".hilo-agent-tool");
    expect(card?.getAttribute("data-open")).toBe("true");
    expect(card?.textContent).toContain("line");
    store.enqueue(call({ status: "completed", _meta: { terminal_exit: { exit_code: 0 } } }));
    view.elements(document, store.getState(), button, actions);
    expect(card?.getAttribute("data-open")).toBe("false");
  });
});

describe("an edit made by the agent", () => {
  const edit = (id: string, diffs: unknown[], extra: Record<string, unknown> = {}) => ({
    type: "update" as const,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: id,
      kind: "edit",
      title: "Edit",
      status: "completed",
      content: diffs,
      ...extra,
    },
  });
  const diff = (path: string, oldText: string | null, newText: string) => ({
    type: "diff",
    path,
    oldText,
    newText,
  });
  const show = (store: AgentStore) =>
    new ConversationView().elements(
      document,
      store.getState(),
      () => document.createElement("button"),
      { openLocation: () => {}, answer: () => {} },
    );
  it("shows the file, its counts and the diff, with the icon of its type", () => {
    const store = new AgentStore((callback) => callback());
    store.enqueue(edit("e", [diff("src/01.cpp", "a\nb\nc", "a\nB\nc\nd")]));
    const [card] = show(store);
    // The card keeps its verb and names the file.
    expect(card?.querySelector(".hilo-agent-card-verb")?.textContent).toBe("Edited");
    expect(card?.querySelector(".hilo-agent-card-target")?.textContent).toBe("01.cpp");
    expect(card?.querySelector(".hilo-agent-card-extra")?.textContent).toBe("+2−1");
    expect(card?.querySelector(".hilo-agent-card-icon svg")).not.toBeNull();
    const rows = [...(card?.querySelectorAll(".hilo-agent-diff-text") ?? [])].map(
      (row) => row.textContent,
    );
    expect(rows).toEqual(["a", "b", "B", "c", "d"]);
    const marks = [...(card?.querySelectorAll(".hilo-agent-diff-prefix") ?? [])].map(
      (mark) => mark.textContent,
    );
    expect(marks).toEqual([" ", "-", "+", " ", "+"]);
    // One number per row, the new one except on removed rows.
    const numbers = [...(card?.querySelectorAll(".hilo-agent-line-number") ?? [])].map(
      (n) => n.textContent,
    );
    expect(numbers).toEqual(["1", "2", "2", "3", "4"]);
  });
  it("shows a new file as additions only, and several files with a row each", () => {
    const store = new AgentStore((callback) => callback());
    store.enqueue(edit("e", [diff("a.ts", null, "x\ny"), diff("src/b.ts", "old", "new")]));
    const [card] = show(store);
    expect(card?.querySelector(".hilo-agent-card-verb")?.textContent).toContain("2 files");
    expect(card?.querySelectorAll(".hilo-agent-file-head")).toHaveLength(2);
    expect(card?.querySelector(".hilo-agent-diff-line[data-kind='-']")?.textContent).toContain(
      "old",
    );
    expect(card?.querySelectorAll(".hilo-agent-diff-line[data-kind='-']")).toHaveLength(1);
  });
  it("keeps a long diff short until it is opened, and remembers that it was", () => {
    const store = new AgentStore((callback) => callback());
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    store.enqueue(
      edit("e", [diff("a.ts", lines.join("\n"), lines.map((l) => `${l}!`).join("\n"))]),
    );
    const view = new ConversationView();
    const actions = { openLocation: () => {}, answer: () => {} };
    const make = () => document.createElement("button");
    const [card] = view.elements(document, store.getState(), make, actions);
    const pre = card?.querySelector(".hilo-agent-diff") as HTMLElement;
    const more = card?.querySelector(".hilo-agent-diff-more") as HTMLButtonElement;
    expect(pre.dataset.expanded).toBe("false");
    more.click();
    expect(pre.dataset.expanded).toBe("true");
    store.enqueue(edit("e", [], { status: "completed", title: "Edit again" }));
    const [again] = view.elements(document, store.getState(), make, actions);
    expect((again?.querySelector(".hilo-agent-diff") as HTMLElement).dataset.expanded).toBe("true");
  });
  it("ignores paths that leave the worktree and cuts what is too large", () => {
    const store = new AgentStore((callback) => callback());
    const big = "x".repeat(40 * 1024);
    store.enqueue(
      edit("e", [
        diff("/etc/passwd", "a", "b"),
        diff("../x", "a", "b"),
        diff("ok.ts", big, `${big}y`),
      ]),
    );
    const tool = store.getState().tools[0];
    expect(tool?.diffs?.map((d) => d.path)).toEqual(["ok.ts"]);
    expect(tool?.diffs?.[0]?.truncated).toBe(true);
    expect(tool?.diffs?.[0]?.oldText.length).toBe(32 * 1024);
  });
});
