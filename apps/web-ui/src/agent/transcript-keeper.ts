import type { AgentStore } from "./store.js";
import { type AgentTranscripts, parseTranscript, serializeTranscript } from "./transcript.js";

/** Coalesce streaming changes into at most one scheduled write at a time. */
const SAVE_DELAY_MS = 600;

/**
 * Keeps one panel's conversation on disk: loads it when the panel comes back from a previous run,
 * saves it as it changes, and deletes it when the chat is deleted. What is saved is
 * always what the panel shows, so emptying the panel empties the file.
 */
export class TranscriptKeeper {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saved = "";
  private onDisk = false;
  private wasBusy = false;
  private done = false;
  private writes = Promise.resolve();
  private restoring: Promise<void> | undefined;
  private draft = "";
  private draftEdited = false;
  constructor(
    private readonly store: AgentStore,
    private readonly transcripts: AgentTranscripts,
    private readonly chatId: string,
    private readonly agentId: string,
  ) {}

  /** Show the conversation of the previous run, unless the panel already has one. */
  restore(showDraft: (text: string) => void): Promise<void> {
    this.restoring = this.transcripts
      .load(this.chatId)
      .then((json) => {
        if (this.done || !json || this.store.getState().timeline.length > 0) return;
        const snapshot = parseTranscript(json, this.agentId);
        if (!snapshot) return;
        this.onDisk = true;
        this.saved = json;
        if (!this.draftEdited && snapshot.draft) {
          this.draft = snapshot.draft;
          showDraft(this.draft);
        }
        this.store.restore(snapshot);
      })
      .catch(() => undefined)
      .finally(() => {
        this.restoring = undefined;
        this.changed();
      });
    return this.restoring;
  }

  changeDraft(text: string): void {
    if (this.draft === text) return;
    this.draft = text;
    this.draftEdited = true;
    this.changed();
  }

  /** The panel's state changed: save soon, or at once when a turn has just ended. */
  changed(): void {
    if (this.done || this.restoring) return;
    const state = this.store.getState();
    if (!this.draft && !state.timeline.length && !state.sessionId && !state.savedOptions?.length) {
      clearTimeout(this.timer);
      this.timer = undefined;
      if (this.onDisk) this.erase();
      return;
    }
    const turnEnded = this.wasBusy && !state.busy;
    this.wasBusy = state.busy;
    if (turnEnded) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
  }

  /** Save now what has not been saved yet. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.done) return this.writes;
    if (this.restoring) return this.restoring.then(() => this.flush());
    const json = serializeTranscript(this.store.getState(), this.agentId, this.draft);
    if (!json || json === this.saved) return this.writes;
    this.saved = json;
    this.onDisk = true;
    this.writes = this.writes
      .then(() => this.transcripts.save(this.chatId, json))
      .catch(() => {
        if (this.saved === json) this.saved = "";
      });
    return this.writes;
  }

  /** The chat was deleted: remove its conversation after any pending writes. */
  discard(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.done = true;
    this.erase();
  }

  private erase(): void {
    this.onDisk = false;
    this.saved = "";
    this.writes = this.writes
      .then(() => this.transcripts.remove(this.chatId))
      .catch(() => undefined);
  }
}
