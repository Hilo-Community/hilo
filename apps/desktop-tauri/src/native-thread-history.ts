import type {
  AgentHost,
  CockpitChatTab,
  SavedChatMessages,
  Zone3MultiChatState,
} from "@hilo/web-ui";

export function collectNativeThreadMessages(state: Zone3MultiChatState): SavedChatMessages {
  return Object.fromEntries(
    state.chats.flatMap((chat) => {
      const messages = state.messagesByChatId[chat.chatId];
      if (chat.kind !== "agent" || chat.agentId || !messages?.length) return [];
      return [
        [
          chat.chatId,
          messages.map(({ messageId, role, content }) => ({
            messageId,
            role,
            content,
          })),
        ],
      ];
    }),
  );
}

/** Saves native history in the same per-thread file store that serves ACP. */
export class NativeThreadHistory {
  private readonly written = new Map<string, string>();

  constructor(private readonly files: NonNullable<AgentHost["transcripts"]>) {}

  async load(
    chats: readonly CockpitChatTab[],
    legacy?: SavedChatMessages,
  ): Promise<SavedChatMessages> {
    const found = await Promise.all(
      chats.map(async (chat) => {
        if (chat.kind !== "agent" || chat.agentId) return [];
        const fallback = legacy?.[chat.chatId];
        try {
          const json = await this.files.load(chat.chatId);
          if (json) {
            const saved: unknown = JSON.parse(json);
            if (
              saved &&
              typeof saved === "object" &&
              "providerType" in saved &&
              saved.providerType === "native-llm" &&
              "messages" in saved &&
              Array.isArray(saved.messages)
            ) {
              this.written.set(chat.chatId, json);
              return [[chat.chatId, saved.messages]];
            }
          }
        } catch {
          // A missing or unreadable new file can still have a legacy history.
        }
        return fallback ? [[chat.chatId, fallback]] : [];
      }),
    );
    return Object.fromEntries(found.flat());
  }

  async save(state: Zone3MultiChatState): Promise<void> {
    const histories = collectNativeThreadMessages(state);
    for (const [id, messages] of Object.entries(histories)) {
      const json = JSON.stringify({ providerType: "native-llm", messages });
      if (this.written.get(id) === json) continue;
      await this.files.save(id, json);
      this.written.set(id, json);
    }
    for (const id of this.written.keys()) {
      if (Object.hasOwn(histories, id)) continue;
      await this.files.remove(id);
      this.written.delete(id);
    }
  }
}
