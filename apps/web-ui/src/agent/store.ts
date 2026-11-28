import { AtomicStore } from "../state/atomic-store.js";
import { IncrementalMarkdownCache } from "../ui/stream-renderer.js";
import { UI_STRINGS } from "../ui/ui-strings.js";
import {
  TOOL_DETAILS_BUDGET,
  TOOL_OUTPUT_LIMIT,
  type ToolDetails,
  type ToolUpdate,
  detailsSize,
  fitDetails,
  toolDetails,
} from "./tool-details.js";
import type { AgentTranscripts, Snapshot } from "./transcript.js";

export interface ProposedEdit {
  id: string;
  path: string;
  baseContentHash: string;
  oldText: string;
  newText: string;
}
export type AcpEvent =
  | { type: "terminalAuth"; name: string; args: string[]; env: Record<string, string> }
  | { type: "terminalAuthOutput"; data: number[] }
  | { type: "terminalAuthComplete"; success: boolean }
  | { type: "authMethods"; methods: unknown[] }
  | { type: "authChoice"; methods: unknown[] }
  | { type: "authenticated" }
  | { type: "elicitation"; id: string; url: string; message: string }
  | { type: "elicitationComplete"; id: string }
  | { type: "ready"; sessionId: string }
  | { type: "options"; options: unknown[] }
  | { type: "update"; update: Record<string, unknown>; preview?: ToolUpdate }
  | { type: "proposedEdit"; edit: ProposedEdit }
  | { type: "permission"; id: string; reason: string; options: unknown }
  | {
      type: "tool";
      id: string;
      kind: string;
      status: string;
      locations: unknown;
      reason: string | null;
    }
  | { type: "message"; role: string; text: string }
  | { type: "error"; reason: string }
  /**
   * The session ended. `failed: false` is an ordinary end (the agent exited, its lease ran out,
   * it was stopped): the chat keeps looking connected and reconnects on the next message.
   */
  | { type: "stopped"; reason: string; failed?: boolean };
export interface AgentHandle {
  startLogin?(): Promise<void>;
  /** Opens the sign-in page again, when the browser did not open or was closed. */
  openLogin?(): Promise<void>;
  /** The user's pick among the sign-in methods the agent offered. */
  chooseAuth?(methodId: string): Promise<void>;
  /** The user's pick for a model, mode or effort the agent offered. */
  setOption?(optionId: string, value: string): Promise<void>;
  writeLogin?(data: string): Promise<void>;
  resizeLogin?(cols: number, rows: number): Promise<void>;
  prompt(text: string, previousTurns?: string): Promise<void>;
  cancel(): Promise<void>;
  stop(): Promise<void>;
  answer(id: string, choice: boolean | string): Promise<void>;
  /** `open` shows the sign-in page again without answering the agent. */
  elicit?(id: string, action: "accept" | "decline" | "cancel" | "open"): Promise<void>;
}
export interface AgentHost {
  start(
    config: {
      installedAgentId: string;
      conversationId?: string;
      resumeSessionId?: string;
      expectedWorkspace?: string;
      preferredOptions?: readonly SavedAgentOption[];
    },
    onEvent: (event: AcpEvent) => void,
  ): Promise<AgentHandle>;
  /**
   * Signs the agent out: the Host stops its sessions first, then removes its saved sign-in, so
   * the next connection asks how to sign in again.
   */
  signOut?(installedAgentId: string): Promise<void>;
  /** Keeps each panel's conversation between runs. Without it, a conversation lives one run. */
  transcripts?: AgentTranscripts;
}
export interface SavedAgentOption {
  id: string;
  value: string;
}

/** A choice the agent offers for its session: a model, a mode, an effort. */
export interface AgentOption {
  id: string;
  name: string;
  category: string;
  current: string;
  choices: { value: string; name: string; description?: string }[];
}
/** How long the current (or last) turn took, and how much of it was spent waiting for the user. */
export interface Turn {
  startedAt: number;
  endedAt?: number;
  waitingMs: number;
}
export interface ToolCard extends ToolDetails {
  id: string;
  /** When the tool first appeared and how long it took; shown once it is done. */
  startedAt?: number;
  durationMs?: number;
  kind: string;
  title: string;
  status: "pending" | "running" | "done" | "denied" | "failed";
  locations: { path: string; line: number }[];
  reason?: string | undefined;
  edit?: ProposedEdit | undefined;
}
export interface Thought {
  id: string;
  text: string;
  startedAt: number;
  durationMs?: number;
  running: boolean;
}
/** One entry of the conversation, in the order it happened. The details live in the lists. */
export interface TimelineRef {
  type: "message" | "thought" | "tool";
  id: string;
}
export interface AgentState {
  terminalAuth: { name: string; args: string[]; env: Record<string, string> } | null;
  /** The sign-in methods to choose from, while the Host waits for the user's pick. */
  authChoice: { id: string; name: string; type?: string }[] | null;
  ready: boolean;
  sessionId?: string | undefined;
  busy: boolean;
  /** Loaded from a previous run without an ACP session to resume: the agent gets a summary. */
  restored: boolean;
  /** What the agent lets the user choose for this session. Empty if it offers nothing. */
  options: AgentOption[];
  savedOptions?: readonly SavedAgentOption[];
  turn: Turn | null;
  messages: { id: string; role: string; text: string; html: readonly string[] }[];
  /** Messages, thoughts and tool calls interleaved as they arrived: the panel draws this order. */
  timeline: TimelineRef[];
  plan: { content: string; status: string }[];
  tools: ToolCard[];
  thoughts: Thought[];
  permissions: { id: string; reason: string; options?: unknown }[];
  elicitations: { id: string; url: string; message: string; accepted: boolean }[];
  error: string;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
function locations(value: unknown): ToolCard["locations"] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 128).flatMap((v) => {
    const item = record(v);
    const path = typeof item.path === "string" ? item.path : "";
    if (
      !path ||
      path.startsWith("/") ||
      path.includes("\\") ||
      path.includes(":") ||
      path.split("/").includes("..")
    )
      return [];
    return [
      {
        path,
        line:
          typeof item.line === "number" && Number.isSafeInteger(item.line) && item.line > 0
            ? item.line
            : 1,
      },
    ];
  });
}
function status(value: unknown): ToolCard["status"] {
  if (value === "completed" || value === "done") return "done";
  if (value === "in_progress" || value === "running") return "running";
  if (value === "denied" || value === "failed") return value;
  return "pending";
}

/** Metadata and message budget; bounded tool previews have a separate shared allowance. */
function retainedSize(event: AcpEvent): number {
  switch (event.type) {
    case "message":
      return event.text.length;
    case "terminalAuthOutput":
    case "options":
    case "authMethods":
    case "authChoice":
    case "authenticated":
      return 0;
    case "update": {
      const u = event.update;
      if (u.sessionUpdate === "agent_message_chunk" || u.sessionUpdate === "agent_thought_chunk") {
        const content = record(u.content);
        return typeof content.text === "string" ? content.text.length : 0;
      }
      if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
        const title = typeof u.title === "string" ? u.title.length : 0;
        const where = Array.isArray(u.locations) ? JSON.stringify(u.locations).length : 0;
        return 64 + title + where;
      }
      if (u.sessionUpdate === "plan") return JSON.stringify(u.entries ?? []).length;
      return 64;
    }
    default:
      return JSON.stringify(event).length;
  }
}

/** Own subscription domain: streaming never updates Zone 4 or the editor's mount container. */
export class AgentStore extends AtomicStore<AgentState> {
  private queue: AcpEvent[] = [];
  private queuedBytes = 0;
  private retainedBytes = 0;
  private retainedToolBytes = 0;
  private messageCount = 0;
  /** When each permission was asked, to tell how long a turn waited for the user. */
  private readonly waitingSince = new Map<string, number>();
  /** After a restore or a reconnect, new text opens a message instead of continuing the last. */
  private sealed = false;
  private scheduled = false;
  private disposed = false;
  private readonly markdown = new IncrementalMarkdownCache();
  constructor(
    private readonly frame: (callback: () => void) => void = (callback) =>
      requestAnimationFrame(callback),
    private readonly now: () => number = () => Date.now(),
  ) {
    super({
      ready: false,
      busy: false,
      restored: false,
      options: [],
      turn: null,
      messages: [],
      timeline: [],
      plan: [],
      tools: [],
      thoughts: [],
      permissions: [],
      elicitations: [],
      terminalAuth: null,
      authChoice: null,
      error: "",
    });
  }
  enqueue(incoming: AcpEvent): void {
    let event = incoming;
    if (this.disposed) return;
    // Bound before queueing: even one giant command output must not sit in the frame queue.
    if (
      event.type === "update" &&
      (event.update.sessionUpdate === "tool_call" ||
        event.update.sessionUpdate === "tool_call_update")
    ) {
      const u = event.update;
      event = {
        type: "update",
        preview: toolDetails(u),
        update: {
          sessionUpdate: u.sessionUpdate,
          toolCallId: u.toolCallId,
          kind: u.kind,
          title: u.title,
          status: u.status,
          locations: u.locations,
        },
      };
    }
    const bytes = retainedSize(event);
    const queuedSize =
      bytes +
      (event.type === "update" && event.preview
        ? detailsSize(event.preview) + (event.preview.delta?.length ?? 0)
        : 0);
    if (
      event.type !== "stopped" &&
      (this.queuedBytes + queuedSize > 512 * 1024 ||
        this.retainedBytes + bytes > 2 * 1024 * 1024 - TOOL_DETAILS_BUDGET)
    ) {
      this.setState((s) => ({
        ...s,
        error: "Agent display limit reached. Cancel or start a new session.",
      }));
      return;
    }
    this.queue.push(event);
    this.queuedBytes += queuedSize;
    this.retainedBytes += bytes;
    if (!this.scheduled) {
      this.scheduled = true;
      this.frame(() => this.flush());
    }
  }
  flush(): void {
    this.scheduled = false;
    if (this.disposed || !this.queue.length) return;
    const queue = this.queue;
    this.queue = [];
    this.queuedBytes = 0;
    this.setState((previous) => {
      const s = {
        ...previous,
        messages: [...previous.messages],
        timeline: [...previous.timeline],
        tools: [...previous.tools],
        thoughts: [...previous.thoughts],
        permissions: [...previous.permissions],
        elicitations: [...previous.elicitations],
      };
      const tool = (id: string, patch: Partial<ToolCard>) => {
        const index = s.tools.findIndex((t) => t.id === id);
        const old = s.tools[index];
        const next: ToolCard = {
          id,
          kind: "other",
          title: UI_STRINGS.agent.toolCall,
          status: "pending",
          locations: [],
          ...old,
          ...patch,
        };
        // How long a tool took: from the first time it was seen to the moment it finished.
        next.startedAt ??= this.now();
        if (
          next.durationMs === undefined &&
          (next.status === "done" || next.status === "failed" || next.status === "denied")
        )
          next.durationMs = Math.max(0, this.now() - next.startedAt);
        const before = old ? detailsSize(old) : 0;
        const bounded = fitDetails(next, TOOL_DETAILS_BUDGET - this.retainedToolBytes + before);
        if (index >= 0) s.tools[index] = bounded;
        else if (s.tools.length < 512) {
          s.tools.push(bounded);
          s.timeline.push({ type: "tool", id });
        } else return;
        this.retainedToolBytes += detailsSize(bounded) - before;
      };
      const endTurn = () => {
        if (s.turn && s.turn.endedAt === undefined) s.turn = { ...s.turn, endedAt: this.now() };
      };
      const finishThought = () => {
        const thought = s.thoughts.at(-1);
        if (thought?.running)
          s.thoughts[s.thoughts.length - 1] = {
            ...thought,
            running: false,
            durationMs: Math.max(0, this.now() - thought.startedAt),
          };
      };
      const message = (role: string, text: string, append: boolean) => {
        const old = s.messages.at(-1);
        const last = s.timeline.at(-1);
        // A chunk continues the message only if nothing (a tool, a thought) came in between;
        // otherwise it opens a new message after that item.
        const combine =
          !this.sealed &&
          append &&
          old?.role === role &&
          last?.type === "message" &&
          last.id === old.id;
        this.sealed = false;
        const full = combine ? old.text + text : text;
        const html = this.markdown.update(full);
        if (combine) s.messages[s.messages.length - 1] = { id: old.id, role, text: full, html };
        else if (s.messages.length < 512) {
          const id = `message-${this.messageCount++}`;
          s.messages.push({ id, role, text: full, html });
          s.timeline.push({ type: "message", id });
        }
      };
      for (const event of queue) {
        switch (event.type) {
          case "terminalAuth":
            s.terminalAuth = event;
            break;
          case "terminalAuthOutput":
            // Routed directly to the login terminal; never retained in chat/model context.
            break;
          case "terminalAuthComplete":
            s.terminalAuth = null;
            break;
          case "authMethods":
          case "authenticated":
            break;
          case "authChoice":
            s.authChoice = event.methods.flatMap((item) => {
              const method = record(item);
              const meta = record(method._meta);
              const kind =
                typeof method.type === "string"
                  ? method.type
                  : typeof meta.type === "string"
                    ? meta.type
                    : meta["terminal-auth"] !== undefined
                      ? "terminal"
                      : undefined;
              return typeof method.id === "string" && typeof method.name === "string"
                ? [{ id: method.id, name: method.name, ...(kind ? { type: kind } : {}) }]
                : [];
            });
            break;
          case "elicitation":
            if (!s.elicitations.some((item) => item.id === event.id) && s.elicitations.length < 32)
              s.elicitations.push({ ...event, accepted: false });
            break;
          case "elicitationComplete":
            s.elicitations = s.elicitations.filter((item) => item.id !== event.id);
            break;
          case "ready":
            s.ready = true;
            s.sessionId = event.sessionId;
            s.authChoice = null;
            s.error = "";
            break;
          case "message":
            finishThought();
            message(event.role, event.text, false);
            s.busy = true;
            if (event.role === "user") s.turn = { startedAt: this.now(), waitingMs: 0 };
            break;
          case "options":
            s.options = event.options.flatMap((item) => {
              const option = record(item);
              const choices = Array.isArray(option.choices)
                ? option.choices.slice(0, 64).flatMap((choice) => {
                    const entry = record(choice);
                    return typeof entry.value === "string" && typeof entry.name === "string"
                      ? [{ value: entry.value, name: entry.name }]
                      : [];
                  })
                : [];
              return typeof option.id === "string" &&
                typeof option.name === "string" &&
                typeof option.current === "string" &&
                choices.length > 0
                ? [
                    {
                      id: option.id,
                      name: option.name,
                      category: typeof option.category === "string" ? option.category : "other",
                      current: option.current,
                      choices,
                    },
                  ]
                : [];
            });
            s.savedOptions = s.options
              .filter(({ category }) => category === "model" || category === "mode")
              .map(({ id, current }) => ({ id, value: current }));
            break;
          case "proposedEdit":
            tool(event.edit.id, {
              edit: event.edit,
              kind: "edit",
              title: UI_STRINGS.agent.proposedEdit,
              locations: [{ path: event.edit.path, line: 1 }],
            });
            break;
          case "permission":
            if (!s.permissions.some((p) => p.id === event.id) && s.permissions.length < 32) {
              s.permissions.push(event);
              this.waitingSince.set(event.id, this.now());
            }
            break;
          case "tool":
            tool(event.id, {
              kind: event.kind,
              status: status(event.status),
              locations: locations(event.locations),
              reason: event.reason ?? undefined,
            });
            break;
          case "error":
            finishThought();
            endTurn();
            s.error = event.reason;
            s.busy = false;
            break;
          case "stopped":
            finishThought();
            endTurn();
            s.ready = false;
            s.busy = false;
            s.permissions = [];
            s.elicitations = [];
            s.terminalAuth = null;
            s.authChoice = null;
            // Only a failure is shown; an ordinary end leaves the chat as it was.
            s.error = event.failed === false ? "" : event.reason;
            s.tools = s.tools.map((t) =>
              t.status === "pending" || t.status === "running"
                ? { ...t, status: "denied", reason: event.reason }
                : t,
            );
            break;
          case "update": {
            const u = event.update;
            if (u.sessionUpdate === "agent_thought_chunk") {
              const content = record(u.content);
              if (content.type === "text" && typeof content.text === "string") {
                const last = s.thoughts.at(-1);
                if (last?.running) {
                  // Models send their reasoning in parts, each opening with a bold title. Parts of
                  // one thought read as one block, as paragraphs, not run into each other.
                  const apart =
                    last.text !== "" && !last.text.endsWith("\n") && content.text.startsWith("**")
                      ? "\n\n"
                      : "";
                  s.thoughts[s.thoughts.length - 1] = {
                    ...last,
                    text: (last.text + apart + content.text.slice(0, TOOL_OUTPUT_LIMIT)).slice(
                      0,
                      TOOL_OUTPUT_LIMIT,
                    ),
                  };
                } else if (s.thoughts.length < 32) {
                  const id = `thought-${s.thoughts.length}`;
                  s.thoughts.push({
                    id,
                    text: content.text.slice(0, TOOL_OUTPUT_LIMIT),
                    startedAt: this.now(),
                    running: true,
                  });
                  s.timeline.push({ type: "thought", id });
                }
              }
            } else if (u.sessionUpdate === "agent_message_chunk") {
              finishThought();
              const content = record(u.content);
              if (content.type === "text" && typeof content.text === "string")
                message("assistant", content.text, true);
            } else if (u.sessionUpdate === "plan" && Array.isArray(u.entries)) {
              s.plan = u.entries.slice(0, 128).map((v) => {
                const p = record(v);
                return { content: String(p.content ?? ""), status: String(p.status ?? "pending") };
              });
            } else if (
              (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") &&
              typeof u.toolCallId === "string"
            ) {
              finishThought();
              const { delta, ...preview } = event.preview ?? {};
              const patch: Partial<ToolCard> = preview;
              if (delta) {
                // More output of a running command: it is added to what is already shown.
                const shown = s.tools.find((t) => t.id === u.toolCallId)?.output ?? "";
                const room = Math.max(0, TOOL_OUTPUT_LIMIT - shown.length);
                patch.output = shown + delta.slice(0, room);
                if (delta.length > room) patch.truncated = true;
              }
              if (typeof u.kind === "string") patch.kind = u.kind;
              if (typeof u.title === "string") patch.title = u.title;
              if (u.status !== undefined) patch.status = status(u.status);
              if (u.locations !== undefined) patch.locations = locations(u.locations);
              tool(u.toolCallId, patch);
            } else if (u.sessionUpdate === "turn_complete") {
              finishThought();
              endTurn();
              s.busy = false;
            }
            break;
          }
        }
      }
      return s;
    });
  }
  /** Show a saved conversation. Anything that was still running when it was saved was cut off. */
  restore(snapshot: Snapshot): void {
    if (this.disposed) return;
    const messages = snapshot.messages.map((message) => ({
      ...message,
      html: this.markdown.update(message.text),
    }));
    const numbers = messages.map((m) => Number(/^message-(\d+)$/.exec(m.id)?.[1] ?? -1));
    this.messageCount = Math.max(messages.length - 1, ...numbers) + 1;
    this.retainedBytes = messages.reduce((sum, message) => sum + message.text.length, 0);
    const cut = "Interrupted";
    const tools = snapshot.tools.map((t) =>
      t.status === "pending" || t.status === "running"
        ? { ...t, status: "denied" as const, reason: t.reason ?? cut }
        : t,
    );
    this.retainedToolBytes = tools.reduce((sum, t) => sum + detailsSize(t), 0);
    this.sealed = true;
    this.setState((s) => ({
      ...s,
      restored: !snapshot.sessionId,
      sessionId: snapshot.sessionId,
      savedOptions: snapshot.savedOptions ?? [],
      messages,
      timeline: snapshot.timeline,
      tools,
      thoughts: snapshot.thoughts,
      plan: snapshot.plan,
    }));
  }
  /** Start a new connection and keep the conversation on screen. */
  reconnect(): void {
    this.queue = [];
    this.queuedBytes = 0;
    this.sealed = true;
    this.waitingSince.clear();
    this.setState((s) => ({
      ...s,
      ready: false,
      busy: false,
      options: [],
      turn: s.turn && s.turn.endedAt === undefined ? { ...s.turn, endedAt: this.now() } : s.turn,
      permissions: [],
      elicitations: [],
      terminalAuth: null,
      authChoice: null,
      error: "",
      tools: s.tools.map((t) =>
        t.status === "pending" || t.status === "running"
          ? { ...t, status: "denied" as const, reason: t.reason ?? "Interrupted" }
          : t,
      ),
      thoughts: s.thoughts.map((t) => (t.running ? { ...t, running: false } : t)),
    }));
  }
  answered(id: string): void {
    const since = this.waitingSince.get(id);
    this.waitingSince.delete(id);
    this.setState((s) => ({
      ...s,
      permissions: s.permissions.filter((p) => p.id !== id),
      // The time the agent spent waiting for the user's answer is not the agent's own.
      turn:
        s.turn && since !== undefined
          ? { ...s.turn, waitingMs: s.turn.waitingMs + Math.max(0, this.now() - since) }
          : s.turn,
    }));
  }
  /** The user picked a method: the card goes away while the agent signs in. */
  chose(): void {
    this.setState((s) => ({ ...s, authChoice: null }));
  }
  answeredElicitation(id: string, action: "accept" | "decline" | "cancel"): void {
    this.setState((s) => ({
      ...s,
      elicitations:
        action === "accept"
          ? s.elicitations.map((item) => (item.id === id ? { ...item, accepted: true } : item))
          : s.elicitations.filter((item) => item.id !== id),
    }));
  }
  dispose(): void {
    this.disposed = true;
    this.queue = [];
  }
  reset(): void {
    this.queue = [];
    this.queuedBytes = 0;
    this.retainedBytes = 0;
    this.retainedToolBytes = 0;
    this.messageCount = 0;
    this.sealed = false;
    this.waitingSince.clear();
    this.setState(() => ({
      ready: false,
      busy: false,
      restored: false,
      options: [],
      turn: null,
      messages: [],
      timeline: [],
      tools: [],
      thoughts: [],
      plan: [],
      permissions: [],
      elicitations: [],
      terminalAuth: null,
      authChoice: null,
      error: "",
    }));
  }
}
