import type {
  AgentState,
  ProposedEdit,
  SavedAgentOption,
  Thought,
  TimelineRef,
  ToolCard,
} from "./store.js";
import {
  type FileDiff,
  TOOL_DIFF_FILES,
  TOOL_DIFF_TEXT,
  TOOL_OUTPUT_LIMIT,
  type ToolDetails,
  isWorktreePath,
  record,
} from "./tool-details.js";

/** Where a panel's conversation is kept between runs (the Host writes it to the app's folder). */
export interface AgentTranscripts {
  load(chatId: string): Promise<string | null>;
  save(chatId: string, json: string): Promise<void>;
  remove(chatId: string): Promise<void>;
}

/** What is saved of a conversation. The same shape the panel shows, with no HTML in it. */
export interface Snapshot {
  agentId: string;
  sessionId?: string;
  draft?: string;
  savedOptions?: readonly SavedAgentOption[];
  messages: { id: string; role: string; text: string }[];
  timeline: TimelineRef[];
  tools: ToolCard[];
  thoughts: Thought[];
  plan: { content: string; status: string }[];
}

const VERSION = 1;
const MAX_MESSAGES = 512;
const MAX_TOOLS = 512;
const MAX_THOUGHTS = 32;
const MAX_PLAN = 128;
const MAX_TEXT = 256 * 1024;
const MAX_SAVED = 2.5 * 1024 * 1024;
const STATUSES = ["pending", "running", "done", "denied", "failed"];

/** The text to save, or null when there is nothing to keep (or it cannot be kept in full). */
export function serializeTranscript(state: AgentState, agentId: string, draft = ""): string | null {
  if (!draft && !state.timeline.length && !state.sessionId && !state.savedOptions?.length)
    return null;
  const build = (withOutput: boolean) =>
    JSON.stringify({
      version: VERSION,
      agentId,
      ...(draft ? { draft } : {}),
      ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      ...(state.savedOptions?.length ? { savedOptions: state.savedOptions } : {}),
      messages: state.messages.map(({ id, role, text }) => ({ id, role, text })),
      timeline: state.timeline,
      tools: withOutput
        ? state.tools
        : state.tools.map(({ output: _output, ...tool }) => ({ ...tool, truncated: true })),
      thoughts: state.thoughts,
      plan: state.plan,
    });
  const full = build(true);
  if (full.length <= MAX_SAVED) return full;
  // Command output is the bulk of a long conversation: drop it before giving up on the rest.
  const slim = build(false);
  return slim.length <= MAX_SAVED ? slim : null;
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length <= max ? value : null;
}
/** A saved moment (ms since the epoch), or undefined. */
function time(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function list(value: unknown, max: number): unknown[] {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

function tool(value: unknown): ToolCard | null {
  const item = record(value);
  const id = text(item.id, 128);
  const kind = text(item.kind, 128);
  const title = text(item.title, 4096);
  if (!id || !kind || title === null) return null;
  if (typeof item.status !== "string" || !STATUSES.includes(item.status)) return null;
  const card: ToolCard = {
    id,
    kind,
    title,
    status: item.status as ToolCard["status"],
    locations: list(item.locations, 128).flatMap((entry) => {
      const location = record(entry);
      const path = text(location.path, 4096);
      const line = location.line;
      // Same rule as live updates: only paths inside the worktree can be opened.
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
          line: typeof line === "number" && Number.isSafeInteger(line) && line > 0 ? line : 1,
        },
      ];
    }),
  };
  const reason = text(item.reason, 4096);
  if (reason) card.reason = reason;
  if (typeof item.durationMs === "number" && Number.isFinite(item.durationMs))
    card.durationMs = Math.max(0, item.durationMs);
  const startedAt = time(item.startedAt);
  if (startedAt !== undefined) card.startedAt = startedAt;
  const details: ToolDetails = card;
  const command = text(item.command, TOOL_OUTPUT_LIMIT);
  if (command !== null) details.command = command;
  const output = text(item.output, TOOL_OUTPUT_LIMIT);
  if (output !== null) details.output = output;
  if (typeof item.exitCode === "number" && Number.isSafeInteger(item.exitCode))
    details.exitCode = item.exitCode;
  if (item.truncated === true) details.truncated = true;
  if (Array.isArray(item.arguments)) {
    details.arguments = list(item.arguments, 24).flatMap((pair) =>
      Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string"
        ? [[pair[0].slice(0, 128), pair[1].slice(0, 4096)] as [string, string]]
        : [],
    );
  }
  const diffs = list(item.diffs, TOOL_DIFF_FILES).flatMap((entry) => {
    const file = record(entry);
    const path = text(file.path, 4096);
    const oldText = text(file.oldText, TOOL_DIFF_TEXT);
    const newText = text(file.newText, TOOL_DIFF_TEXT);
    if (!path || !isWorktreePath(path) || oldText === null || newText === null) return [];
    const diff: FileDiff = { path, oldText, newText };
    if (file.truncated === true) diff.truncated = true;
    return [diff];
  });
  if (diffs.length) details.diffs = diffs;
  const edit = record(item.edit);
  const path = text(edit.path, 4096);
  const oldText = text(edit.oldText, MAX_TEXT);
  const newText = text(edit.newText, MAX_TEXT);
  const hash = text(edit.baseContentHash, 256);
  const editId = text(edit.id, 128);
  if (path && oldText !== null && newText !== null && hash !== null && editId) {
    const proposed: ProposedEdit = { id: editId, path, baseContentHash: hash, oldText, newText };
    card.edit = proposed;
  }
  return card;
}

/** The conversation in a saved text, or null if it is not a valid one for this agent. */
export function parseTranscript(json: string, agentId: string): Snapshot | null {
  let data: Record<string, unknown>;
  try {
    data = record(JSON.parse(json));
  } catch {
    return null;
  }
  if (data.version !== VERSION || data.agentId !== agentId) return null;
  const messages = list(data.messages, MAX_MESSAGES).flatMap((entry) => {
    const item = record(entry);
    const id = text(item.id, 64);
    const body = text(item.text, MAX_TEXT);
    if (!id || body === null || (item.role !== "user" && item.role !== "assistant")) return [];
    return [{ id, role: item.role as string, text: body }];
  });
  const tools = list(data.tools, MAX_TOOLS).flatMap((entry) => tool(entry) ?? []);
  const thoughts = list(data.thoughts, MAX_THOUGHTS).flatMap((entry) => {
    const item = record(entry);
    const id = text(item.id, 64);
    const body = text(item.text, TOOL_OUTPUT_LIMIT);
    if (!id || body === null) return [];
    const thought: Thought = {
      id,
      text: body,
      startedAt: time(item.startedAt) ?? 0,
      running: false,
    };
    if (typeof item.durationMs === "number" && Number.isFinite(item.durationMs))
      thought.durationMs = Math.max(0, item.durationMs);
    return [thought];
  });
  const known = {
    message: new Set(messages.map((m) => m.id)),
    thought: new Set(thoughts.map((t) => t.id)),
    tool: new Set(tools.map((t) => t.id)),
  };
  const timeline = list(data.timeline, MAX_MESSAGES + MAX_TOOLS + MAX_THOUGHTS).flatMap((entry) => {
    const ref = record(entry);
    const type = ref.type;
    if ((type !== "message" && type !== "thought" && type !== "tool") || typeof ref.id !== "string")
      return [];
    return known[type].has(ref.id) ? [{ type, id: ref.id } as TimelineRef] : [];
  });
  const plan = list(data.plan, MAX_PLAN).flatMap((entry) => {
    const item = record(entry);
    const content = text(item.content, 4096);
    return content === null
      ? []
      : [{ content, status: String(item.status ?? "pending").slice(0, 32) }];
  });
  const sessionId = text(data.sessionId, 255);
  const savedOptions = list(data.savedOptions, 8).flatMap((entry) => {
    const option = record(entry);
    const id = text(option.id, 256);
    const value = text(option.value, 256);
    return id && value ? [{ id, value }] : [];
  });
  const draft = text(data.draft, 24 * 1024);
  if (!draft && !timeline.length && !sessionId && !savedOptions.length) return null;
  return {
    agentId,
    ...(sessionId ? { sessionId } : {}),
    ...(draft ? { draft } : {}),
    ...(savedOptions.length ? { savedOptions } : {}),
    messages,
    timeline,
    tools,
    thoughts,
    plan,
  };
}
