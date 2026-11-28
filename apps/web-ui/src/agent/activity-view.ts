import { UI_STRINGS, uiText } from "../ui/ui-strings.js";
import { formatDuration } from "./duration.js";
import type { TimelineRef, ToolCard } from "./store.js";
import { CardView } from "./tool-card-view.js";

const CHANGE_KINDS = new Set(["edit", "delete", "move"]);

/** One step of the agent's work between two of its messages: a tool call or a thought. */
export type WorkItem = { type: "tool"; tool: ToolCard } | { type: "thought"; id: string };

export type ActivityEntry =
  | TimelineRef
  | { type: "work"; id: string; items: WorkItem[]; tools: ToolCard[] };

/**
 * What the agent did between two messages becomes one "work" group, in order: every tool call
 * (reads, searches, commands) and every thought. Text closes the group; the next tool opens a new
 * one. A change to a file (an edit, a deletion, a move, a proposal) stays outside, as its own card,
 * and splits the group around it.
 */
export function activityEntries(
  timeline: TimelineRef[],
  tools: Map<string, ToolCard>,
): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  const add = (item: WorkItem, id: string) => {
    const last = entries.at(-1);
    if (last?.type === "work") {
      last.items.push(item);
      if (item.type === "tool") last.tools.push(item.tool);
    } else
      entries.push({
        type: "work",
        id,
        items: [item],
        tools: item.type === "tool" ? [item.tool] : [],
      });
  };
  for (const ref of timeline) {
    if (ref.type === "thought") add({ type: "thought", id: ref.id }, ref.id);
    else if (ref.type === "tool") {
      const tool = tools.get(ref.id);
      if (!tool) continue;
      // Keep the internal review in session state, outside the visible conversation.
      if (tool.title.trim().toLowerCase() === "guardian review") continue;
      // Changes to files stay in view, as their own cards: they are what the user reviews.
      if (tool.edit || CHANGE_KINDS.has(tool.kind)) entries.push(ref);
      else add({ type: "tool", tool }, ref.id);
    } else entries.push(ref);
  }
  return entries;
}

/**
 * How long a group of work took: from its first start to its last end. Steps saved without their
 * start (older conversations) add their own duration instead. Undefined when nothing is timed.
 */
export function workDuration(
  tools: readonly ToolCard[],
  thoughts: readonly { startedAt: number; durationMs?: number | undefined }[],
): number | undefined {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  let untimed = 0;
  let known = false;
  for (const { startedAt, durationMs } of [...tools, ...thoughts]) {
    if (startedAt) {
      known = true;
      start = Math.min(start, startedAt);
      end = Math.max(end, startedAt + (durationMs ?? 0));
    } else if (durationMs !== undefined) {
      known = true;
      untimed += durationMs;
    }
  }
  if (!known) return undefined;
  return (Number.isFinite(start) ? end - start : 0) + untimed;
}

/** "1s", "10s", "1m 05s": whole seconds, as a header reads. */
function wholeDuration(ms: number): string {
  return ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : formatDuration(ms);
}

/** Reuse existing nodes so streaming does not reset disclosure focus or scroll. */
export function reconcileElements(root: HTMLElement, children: HTMLElement[]): void {
  const wanted = new Set(children);
  for (const child of Array.from(root.children)) {
    if (!wanted.has(child as HTMLElement)) child.remove();
  }
  let next = root.firstChild;
  for (const child of children) {
    if (child === next) next = next.nextSibling;
    else root.insertBefore(child, next);
  }
  while (next) {
    const following = next.nextSibling;
    root.removeChild(next);
    next = following;
  }
}

/**
 * A group of work: "Working…" and open while it is the turn's latest step, then "Worked for 10s",
 * folded, once text follows or the turn ends. Each tool keeps its own row ("Ran …") that unfolds
 * into its card; thoughts keep their row ("Thought for 3s"). A click on the header always wins.
 */
export class WorkGroupView {
  readonly card: CardView;
  constructor(doc: Document) {
    this.card = new CardView(doc);
    // `hilo-agent-exploration` keeps the compact rows and the guide line on the left.
    this.card.element.classList.add(
      "hilo-agent-activity",
      "hilo-agent-exploration",
      "hilo-agent-work",
    );
    this.card.body.setAttribute("role", "list");
  }
  update(
    tools: ToolCard[],
    children: HTMLElement[],
    active: boolean,
    durationMs: number | undefined,
  ): HTMLElement {
    const waiting = tools.some((tool) => tool.status === "pending");
    const running = tools.some((tool) => tool.status === "running");
    const status = waiting
      ? "pending"
      : active || running
        ? "running"
        : tools.some((tool) => tool.status === "failed")
          ? "failed"
          : tools.some((tool) => tool.status === "denied")
            ? "denied"
            : "done";
    const label = active
      ? UI_STRINGS.agent.working
      : durationMs === undefined
        ? UI_STRINGS.agent.worked
        : uiText.workedFor(wholeDuration(durationMs));
    for (const child of children) child.setAttribute("role", "listitem");
    reconcileElements(this.card.body, children);
    this.card.element.dataset.active = String(active);
    this.card.update("other", status, label, "", children.length > 0, active || waiting || running);
    return this.card.element;
  }
}
