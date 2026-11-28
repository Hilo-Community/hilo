import { enhanceCodeBlocks } from "../ui/code-blocks.js";
import { IncrementalMarkdownCache, renderChatMessage } from "../ui/stream-renderer.js";
import { UI_STRINGS, uiText } from "../ui/ui-strings.js";
import {
  type ActivityEntry,
  WorkGroupView,
  activityEntries,
  reconcileElements,
  workDuration,
} from "./activity-view.js";
import { ChangesView, fileChanges } from "./changes-view.js";
import { formatDuration } from "./duration.js";
import { ResponseActionsView } from "./response-actions.js";
import type { AgentState, Thought } from "./store.js";
import { CardView, ToolCardView } from "./tool-card-view.js";

export type ButtonFactory = (label: string, click: () => void) => HTMLButtonElement;
type Actions = {
  openLocation: (path: string, line: number) => void;
  answer: (permissionId: string, choice: boolean | string) => void;
  /** Sends the last request again; offered under the latest finished answer. */
  retry?: () => void;
};

/** How long a thought that has just finished stays open before it folds. */
const THOUGHT_LINGER_MS = 1000;

/** One cache per panel, pruned on removal/reset. Streaming preserves disclosure DOM and focus. */
export class ConversationView {
  private readonly messages = new Map<
    string,
    { article: HTMLElement; message: AgentState["messages"][number] }
  >();
  private readonly tools = new Map<string, ToolCardView>();
  private readonly groups = new Map<string, WorkGroupView>();
  /** "Thinking…" or "Exploring…" under the latest step while a turn runs. */
  private live: { element: HTMLElement; label: HTMLElement } | undefined;
  private readonly changes = new Map<string, ChangesView>();
  /** The Copy / Retry row of each finished answer, by the id of the answer's first message. */
  private readonly responses = new Map<string, ResponseActionsView>();
  private note: HTMLElement | undefined;
  private turnTime: HTMLElement | undefined;
  private readonly thoughts = new Map<string, CardView>();
  /** A finished thought stays open a moment so its last words can be read, then folds. */
  private readonly lingering = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly wasRunning = new Map<string, boolean>();
  /** Each thought's Markdown, kept so a growing thought re-reads only its last block. */
  private readonly thoughtText = new Map<
    string,
    { source: string; cache: IncrementalMarkdownCache }
  >();
  private readonly permissions = new Map<string, { view: CardView; reason: string }>();
  elements(
    doc: Document,
    state: AgentState,
    button: ButtonFactory,
    actions: Actions,
  ): HTMLElement[] {
    const content: HTMLElement[] = [];
    if (state.restored && state.timeline.length) {
      if (!this.note) {
        this.note = doc.createElement("p");
        this.note.className = "hilo-agent-restored-note";
        this.note.textContent = UI_STRINGS.agent.restoredNote;
      }
      content.push(this.note);
    }
    const messages = new Map(state.messages.map((message) => [message.id, message]));
    for (const id of this.messages.keys()) {
      if (!messages.has(id)) this.messages.delete(id);
    }
    const thoughts = new Map(state.thoughts.map((thought) => [thought.id, thought]));
    const tools = new Map(state.tools.map((tool) => [tool.id, tool]));
    // Everything is drawn in the order it happened: text, then the tool it announced, then more.
    const entries = activityEntries(state.timeline, tools);
    // The last tool waiting for an answer: its permission card is drawn right under it.
    let waiting: HTMLElement | null = null;
    // Tools of the turn in progress; a turn that edited several files ends with a summary.
    let turn: AgentState["tools"] = [];
    const usedChanges = new Set<string>();
    // The agent's text of the turn being drawn: a finished turn ends with its actions row.
    let answer: { id: string; texts: string[] } | null = null;
    const usedResponses = new Set<string>();
    const closeAnswer = (latest: boolean): HTMLElement | undefined => {
      const current = answer;
      answer = null;
      if (!current) return undefined;
      usedResponses.add(current.id);
      let view = this.responses.get(current.id);
      if (!view) {
        view = new ResponseActionsView(doc);
        this.responses.set(current.id, view);
      }
      const element = view.update(
        current.texts.join("\n\n").trim(),
        latest ? actions.retry : undefined,
      );
      content.push(element);
      return element;
    };
    const endTurn = () => {
      const first = turn[0];
      const files = fileChanges(turn);
      turn = [];
      if (!first || files.length < 2) return;
      usedChanges.add(first.id);
      let view = this.changes.get(first.id);
      if (!view) {
        view = new ChangesView(doc);
        this.changes.set(first.id, view);
      }
      content.push(view.update(files, actions.openLocation));
    };
    const toolElement = (tool: AgentState["tools"][number]) => {
      turn.push(tool);
      let view = this.tools.get(tool.id);
      if (!view) {
        view = new ToolCardView(doc);
        this.tools.set(tool.id, view);
      }
      const element = view.update(tool, actions.openLocation);
      element.removeAttribute("role");
      if (tool.status === "pending") waiting = element;
      return element;
    };
    for (const ref of entries) {
      if (ref.type === "message") {
        const message = messages.get(ref.id);
        if (!message) continue;
        if (message.role === "user") {
          endTurn();
          closeAnswer(false);
        } else if (message.text.trim()) {
          answer ??= { id: ref.id, texts: [] };
          answer.texts.push(message.text);
        }
        const cached = this.messages.get(ref.id);
        const article = cached?.article ?? doc.createElement("article");
        if (
          cached?.message.role !== message.role ||
          cached.message.text !== message.text ||
          cached.message.html !== message.html
        ) {
          renderChatMessage(article, message.role, message.text, message.html);
          this.messages.set(ref.id, { article, message });
        }
        content.push(article);
      } else if (ref.type === "thought") {
        const thought = thoughts.get(ref.id);
        if (thought) content.push(this.thought(doc, thought));
      } else if (ref.type === "work") {
        const children = ref.items.flatMap((item) => {
          if (item.type === "tool") return [toolElement(item.tool)];
          const thought = thoughts.get(item.id);
          return thought ? [this.thought(doc, thought)] : [];
        });
        // Thinking alone, with no tool, stays a plain "Thought for 3s" row.
        if (!ref.tools.length) {
          content.push(...children);
          continue;
        }
        let view = this.groups.get(ref.id);
        if (!view) {
          view = new WorkGroupView(doc);
          this.groups.set(ref.id, view);
        }
        const groupThoughts = ref.items.flatMap((item) => {
          const thought = item.type === "thought" ? thoughts.get(item.id) : undefined;
          return thought ? [thought] : [];
        });
        const active = state.busy && ref === entries.at(-1);
        const element = view.update(
          ref.tools,
          children,
          active,
          workDuration(ref.tools, groupThoughts),
        );
        if (ref.tools.some((tool) => tool.status === "pending")) waiting = element;
        content.push(element);
      } else {
        const tool = tools.get(ref.id);
        if (!tool) continue;
        content.push(toolElement(tool));
      }
    }
    let actionsRow: HTMLElement | undefined;
    if (!state.busy) {
      endTurn();
      actionsRow = closeAnswer(true);
    } else answer = null;
    for (const [key, view] of this.responses)
      if (!usedResponses.has(key)) {
        view.dispose();
        this.responses.delete(key);
      }
    for (const key of this.changes.keys()) if (!usedChanges.has(key)) this.changes.delete(key);
    if (state.plan.length) content.push(planList(doc, state.plan));
    if (state.busy && !state.permissions.length) content.push(this.liveLine(doc, entries.at(-1)));
    // How long the turn took, once it is over: where the time went is worth knowing.
    const timing = state.turn;
    if (timing?.endedAt !== undefined && !state.busy && state.timeline.length) {
      this.turnTime ??= doc.createElement("p");
      this.turnTime.className = "hilo-agent-turn-time";
      const waiting = timing.waitingMs >= 1000 ? formatDuration(timing.waitingMs) : undefined;
      this.turnTime.textContent = uiText.workedFor(
        formatDuration(timing.endedAt - timing.startedAt),
        waiting,
      );
      // Beside the latest answer's actions, as one quiet footer; on its own otherwise.
      if (actionsRow) actionsRow.append(this.turnTime);
      else content.push(this.turnTime);
    }
    const groupIds = new Set(entries.filter((ref) => ref.type === "work").map((ref) => ref.id));
    for (const key of this.groups.keys()) if (!groupIds.has(key)) this.groups.delete(key);
    for (const key of this.tools.keys())
      if (!state.tools.some((tool) => tool.id === key)) this.tools.delete(key);
    for (const key of this.thoughts.keys())
      if (!state.thoughts.some((thought) => thought.id === key)) {
        this.thoughts.delete(key);
        this.thoughtText.delete(key);
        this.wasRunning.delete(key);
        clearTimeout(this.lingering.get(key));
        this.lingering.delete(key);
      }
    for (const key of this.permissions.keys()) {
      if (!state.permissions.some((permission) => permission.id === key))
        this.permissions.delete(key);
    }
    for (const permission of state.permissions) {
      let cached = this.permissions.get(permission.id);
      if (!cached || cached.reason !== permission.reason) {
        const view = new CardView(doc);
        view.element.classList.add("hilo-agent-permission");
        const reason = doc.createElement("p");
        reason.className = "hilo-agent-card-note";
        reason.textContent = permission.reason;
        const choices = doc.createElement("div");
        choices.className = "hilo-agent-permission-actions";
        const options: unknown[] = Array.isArray(permission.options) ? permission.options : [];
        for (const value of options) {
          if (typeof value !== "object" || value === null) continue;
          const { optionId, name, hostConfirmation } = value as Record<string, unknown>;
          if (
            typeof optionId !== "string" ||
            !optionId ||
            optionId.length > 256 ||
            typeof name !== "string" ||
            !name ||
            hostConfirmation === true
          )
            continue;
          choices.append(button(name, () => actions.answer(permission.id, optionId)));
        }
        if (!choices.childElementCount) {
          choices.append(
            button(UI_STRINGS.agent.allow, () => actions.answer(permission.id, true)),
            button(UI_STRINGS.agent.reject, () => actions.answer(permission.id, false)),
          );
        }
        view.body.append(reason, choices);
        view.update("permission", "pending", UI_STRINGS.agent.waitingPermission, "", true, true);
        cached = { view, reason: permission.reason };
        this.permissions.set(permission.id, cached);
      }
      const at = waiting ? content.indexOf(waiting) : -1;
      cached.view.element.toggleAttribute("data-attached", at >= 0);
      if (at >= 0) content.splice(at + 1, 0, cached.view.element);
      else content.push(cached.view.element);
      // A second permission goes under the first one, not between the tool and its card.
      waiting = at >= 0 ? cached.view.element : null;
    }
    return content;
  }
  /**
   * Where the turn is now, under everything it has written: "Exploring…" while a tool of the
   * latest step runs, otherwise "Thinking…" (before the first word, between tools, while text
   * streams). One element, so changing phase never moves the text above it.
   */
  private liveLine(doc: Document, last: ActivityEntry | undefined): HTMLElement {
    if (!this.live) {
      const element = doc.createElement("div");
      element.className = "hilo-agent-live";
      element.setAttribute("role", "status");
      const label = doc.createElement("span");
      label.className = "hilo-agent-live-label";
      element.append(label);
      this.live = { element, label };
    }
    const step = last?.type === "work" ? last.items.at(-1) : undefined;
    const exploring =
      step?.type === "tool" &&
      step.tool.kind !== "think" &&
      (step.tool.status === "running" || step.tool.status === "pending");
    const text = exploring ? UI_STRINGS.agent.exploring : UI_STRINGS.agent.thinking;
    if (this.live.label.textContent !== text) this.live.label.textContent = text;
    this.live.element.dataset.phase = exploring ? "exploring" : "thinking";
    return this.live.element;
  }
  private thought(doc: Document, thought: Thought): HTMLElement {
    let view = this.thoughts.get(thought.id);
    if (!view) {
      view = new CardView(doc);
      view.element.classList.add("hilo-agent-activity", "hilo-agent-thinking");
      this.thoughts.set(thought.id, view);
    }
    // A thought is written in Markdown (`**Plan the check**`), and starts with blank lines.
    const source = thought.text.trim();
    const kept = this.thoughtText.get(thought.id) ?? {
      source: "",
      cache: new IncrementalMarkdownCache(),
    };
    this.thoughtText.set(thought.id, kept);
    if (kept.source !== source || !view.body.firstChild) {
      kept.source = source;
      view.body.innerHTML = kept.cache.update(source).join("");
      enhanceCodeBlocks(view.body);
    }
    const label = thought.running
      ? UI_STRINGS.agent.thinking
      : thought.durationMs === undefined
        ? UI_STRINGS.agent.thought
        : thought.durationMs < 1000
          ? UI_STRINGS.agent.thoughtBriefly
          : uiText.thoughtDuration(Math.round(thought.durationMs / 1000));
    const apply = (open: boolean) =>
      view.update(
        "think",
        thought.running ? "running" : "done",
        label,
        "",
        source.length > 0,
        open,
      );
    // The reader chose by clicking, or the panel chooses: open while it thinks, fold a moment
    // after it stops. A click always wins (the card remembers it).
    if (this.wasRunning.get(thought.id) && !thought.running && !this.lingering.has(thought.id)) {
      this.lingering.set(
        thought.id,
        setTimeout(() => {
          this.lingering.delete(thought.id);
          apply(false);
        }, THOUGHT_LINGER_MS),
      );
    }
    this.wasRunning.set(thought.id, thought.running);
    apply(thought.running || this.lingering.has(thought.id));
    return view.element;
  }
  /** Stops the timers that fold finished thoughts. */
  dispose(): void {
    for (const view of this.responses.values()) view.dispose();
    for (const timer of this.lingering.values()) clearTimeout(timer);
    this.lingering.clear();
  }
  render(root: HTMLElement, state: AgentState, button: ButtonFactory, actions: Actions): void {
    const children = this.elements(root.ownerDocument, state, button, actions);
    reconcileElements(root, children);
  }
}

/** Stateless rendering for isolated previews; mounted panels own a ConversationView. */
export function conversationElements(
  doc: Document,
  state: AgentState,
  button: ButtonFactory,
  actions: Actions,
): HTMLElement[] {
  return new ConversationView().elements(doc, state, button, actions);
}

export function planList(doc: Document, plan: AgentState["plan"]): HTMLElement {
  const list = doc.createElement("ol");
  list.className = "hilo-agent-plan";
  list.setAttribute("aria-label", UI_STRINGS.agent.plan);
  for (const entry of plan) {
    const item = doc.createElement("li");
    const status =
      entry.status === "completed" || entry.status === "in_progress" ? entry.status : "pending";
    item.dataset.status = status;
    if (status === "in_progress") item.setAttribute("aria-current", "step");
    const mark = doc.createElement("span");
    mark.className = "hilo-agent-plan-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = status === "completed" ? "✓" : status === "in_progress" ? "◐" : "○";
    const text = doc.createElement("span");
    text.textContent = entry.content;
    const state = doc.createElement("span");
    state.className = "hilo-agent-plan-state";
    state.textContent = UI_STRINGS.agent.planStates[status];
    item.append(mark, text, state);
    list.append(item);
  }
  return list;
}
