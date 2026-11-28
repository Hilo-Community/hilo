// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { ConversationView } from "./conversation-view.js";
import { AgentStore } from "./store.js";

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const text = (value: string) => ({
  type: "update" as const,
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } },
});
const done = {
  type: "update" as const,
  update: { sessionUpdate: "turn_complete", stopReason: "end_turn" },
};

function conversation() {
  let now = 0;
  const store = new AgentStore(
    (callback) => callback(),
    () => {
      now += 1000;
      return now;
    },
  );
  const root = document.createElement("div");
  const view = new ConversationView();
  const retry = vi.fn();
  const render = () =>
    view.render(root, store.getState(), () => document.createElement("button"), {
      openLocation: vi.fn(),
      answer: vi.fn(),
      retry,
    });
  const rows = () => [...root.querySelectorAll<HTMLElement>(".hilo-agent-response-actions")];
  return { store, root, render, retry, rows };
}

describe("actions under a finished answer", () => {
  it("appear once the turn ends, never while the agent writes", () => {
    const { store, render, rows } = conversation();
    store.enqueue({ type: "message", role: "user", text: "analyze" });
    store.enqueue(text("Looking"));
    render();
    expect(rows()).toHaveLength(0);
    store.enqueue(done);
    render();
    expect(rows()).toHaveLength(1);
    // The turn's time sits in the same footer.
    expect(rows()[0]?.querySelector(".hilo-agent-turn-time")?.textContent).toContain("Worked for");
  });

  it("copies every part of the answer, and offers Retry only on the latest one", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { store, render, rows, retry } = conversation();
    store.enqueue({ type: "message", role: "user", text: "first" });
    store.enqueue(text("Part one."));
    store.enqueue({
      type: "update",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "t",
        kind: "read",
        title: "a",
        status: "completed",
      },
    });
    store.enqueue(text("Part two."));
    store.enqueue(done);
    store.enqueue({ type: "message", role: "user", text: "second" });
    store.enqueue(text("Answer two."));
    store.enqueue(done);
    render();

    const [older, latest] = rows();
    expect(rows()).toHaveLength(2);
    const retryOf = (row?: HTMLElement) =>
      row?.querySelector<HTMLButtonElement>("[aria-label='Retry']");
    expect(retryOf(older)?.hidden).toBe(true);
    expect(retryOf(latest)?.hidden).toBe(false);
    retryOf(latest)?.click();
    expect(retry).toHaveBeenCalledOnce();

    const copy = older?.querySelector<HTMLButtonElement>("[aria-label='Copy response']");
    copy?.click();
    await settle();
    expect(writeText).toHaveBeenCalledWith("Part one.\n\nPart two.");
    expect(copy?.getAttribute("aria-label")).toBe("Copied");
  });
});
