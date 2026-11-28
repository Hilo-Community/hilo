import { expect, it } from "vitest";
import { createCockpitStoreBundle } from "../stores/index.js";
import { restoreCachedSession } from "./session-cache.js";
const base = { chatId: "legacy", title: "My session", validationState: "UnchangedBlue" };
it("persists the installed agent identity and inherits it when splitting", () => {
  const stores = createCockpitStoreBundle();
  const id = stores.createChat({
    agentId: "claude-acp",
    agentName: "Claude Agent",
    modelName: "Claude Agent",
  });
  const chat = stores.zone3.getState().chats.find((item) => item.chatId === id);
  const restored = restoreCachedSession(JSON.parse(JSON.stringify(chat)));
  expect(restored).toMatchObject({
    kind: "agent",
    agentId: "claude-acp",
    agentName: "Claude Agent",
    title: "Claude Agent",
  });
  const split = stores.createChat({ from: id as string });
  expect(stores.zone3.getState().chats.find((item) => item.chatId === split)).toMatchObject({
    agentId: "claude-acp",
    agentName: "Claude Agent",
  });
});
it("normalizes legacy agents and shells, and strips model/execution state from terminals", () => {
  expect(restoreCachedSession({ ...base, modelName: "Codex" })).toMatchObject({
    kind: "agent",
    modelName: "Codex",
  });
  expect(restoreCachedSession({ ...base, modelName: "Shell" })).toEqual({
    ...base,
    kind: "terminal",
  });
  expect(
    restoreCachedSession({
      ...base,
      kind: "terminal",
      modelName: "Codex",
      agentExecutionStatus: "Running",
    }),
  ).toEqual({ ...base, kind: "terminal" });
  expect(() => restoreCachedSession({ ...base, kind: "unexpected" })).toThrow();
  expect(() => restoreCachedSession({ ...base, kind: "agent" })).toThrow();
});
it("creates explicit sessions, excludes terminals from the agent list and refuses terminal agent tasks", () => {
  const stores = createCockpitStoreBundle();
  const terminal = stores.createChat({ kind: "terminal" });
  const chat = stores.zone3.getState().chats.find((c) => c.chatId === terminal);
  expect(chat).toMatchObject({ kind: "terminal" });
  expect(chat).not.toHaveProperty("modelName");
  expect(stores.zone2.getState().sessions.some((c) => c.chatId === terminal)).toBe(false);
  expect(() => stores.startAgentTaskOnChat(terminal as string)).toThrow("Only agent sessions");
  const agent = stores.createChat();
  expect(stores.zone3.getState().chats.find((c) => c.chatId === agent)).toMatchObject({
    kind: "agent",
    modelName: "Codex",
  });
});

it("keeps a session's last activity time and drops an invalid one", () => {
  const base = { chatId: "a", title: "A", validationState: "UnchangedBlue", kind: "terminal" };
  expect(restoreCachedSession({ ...base, lastActiveAt: 1_700_000_000_000 }).lastActiveAt).toBe(
    1_700_000_000_000,
  );
  expect(restoreCachedSession({ ...base, lastActiveAt: "yesterday" }).lastActiveAt).toBeUndefined();
});

it("keeps the creation date and workspace of saved chat threads", () => {
  expect(
    restoreCachedSession({
      chatId: "copilot-chat",
      title: "Copilot",
      kind: "agent",
      agentId: "github-copilot-cli",
      modelName: "Copilot",
      validationState: "UnchangedBlue",
      createdAt: 42,
      cwd: "/projects/a",
    }),
  ).toMatchObject({ createdAt: 42, cwd: "/projects/a" });
});
