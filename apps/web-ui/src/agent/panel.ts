import { SPINNER_ICON } from "../settings/agent-marks.js";
import { ChatComposer } from "../ui/chat-composer.js";
import { UI_STRINGS } from "../ui/ui-strings.js";
import { authChoiceCard, authenticationCards } from "./auth-panel.js";
import { ConversationView } from "./conversation-view.js";
import { formatDuration } from "./duration.js";
import { OptionBar } from "./option-bar.js";
import { type AgentHandle, type AgentHost, type AgentState, AgentStore } from "./store.js";
import { TerminalLoginView } from "./terminal-login-view.js";
import { isWorktreePath } from "./tool-details.js";
import { TranscriptKeeper } from "./transcript-keeper.js";

const SVG =
  'xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const SANDBOX_ICON = `<svg ${SVG}><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`;
/** Generic ACP panel. Its DOM and subscriptions never own or replace the CodeMirror view. */
export class AgentPanel {
  readonly element: HTMLElement;
  readonly store: AgentStore;
  private handle: AgentHandle | null = null;
  private generation = 0;
  private disposed = false;
  private starting = false;
  /**
   * The agent process of `handle` ended without a failure (it exited between turns, its lease
   * ran out). The chat keeps looking connected; the next message or focus starts it again and
   * picks the same ACP session back up.
   */
  private lost = false;
  private pendingPrompt: string | null = null;
  private priorSessionId: string | undefined;
  private priorMessages: AgentState["messages"] = [];
  private restoring: Promise<void> | undefined;
  /** Sign-in requests already opened, so each page opens once per session. */
  private readonly signInOpened = new Set<string>();
  private readonly unsubscribe: () => void;
  private readonly keeper: TranscriptKeeper | null;
  private readonly composer: ChatComposer;
  private readonly start: HTMLButtonElement;
  private readonly output: HTMLElement;
  private readonly conversation = new ConversationView();
  private readonly error: HTMLElement;
  private readonly status: HTMLElement;
  private readonly busyMark: HTMLElement;
  private readonly busyTime: HTMLElement;
  private readonly options: OptionBar;
  private tick: ReturnType<typeof setInterval> | undefined;
  private readonly login: TerminalLoginView;
  private readonly signInBar: HTMLElement;
  constructor(
    doc: Document,
    private readonly host: AgentHost,
    private readonly openLocation: (path: string, line: number) => Promise<void>,
    private readonly identity: { agentId: string; name: string },
    autoStart = true,
    store = new AgentStore(),
    /** `restore`: the panel comes from a previous run, so its saved conversation is shown. */
    private readonly history?: { chatId: string; restore: boolean; cwd?: string },
    mentionPaths?: (query: string) => readonly string[],
  ) {
    this.store = store;
    this.keeper =
      history && host.transcripts
        ? new TranscriptKeeper(store, host.transcripts, history.chatId, identity.agentId)
        : null;
    this.login = new TerminalLoginView(
      doc,
      () => this.handle,
      (action) => this.run(action),
    );
    this.element = doc.createElement("section");
    this.element.className = "hilo-agent-panel";
    this.element.setAttribute("aria-label", identity.name);
    this.start = this.button(UI_STRINGS.agent.retry, () => void this.begin());
    this.start.className = "hilo-agent-connect";
    this.output = doc.createElement("div");
    this.output.className = "hilo-agent-output";
    // A file the agent mentions (`[App.jsx](<src/App.jsx:6>)`) opens in the editor at that line.
    const openReference = (event: Event) => {
      const ref = (event.target as Element | null)?.closest<HTMLElement>(".hilo-agent-ref");
      const path = ref?.dataset.path;
      const line = Number(ref?.dataset.line);
      if (path && isWorktreePath(path) && Number.isSafeInteger(line) && line > 0) {
        event.preventDefault();
        this.run(() => this.openLocation(path, line));
      }
    };
    this.output.addEventListener("click", openReference);
    // Text that acts as a link opens with Enter, as a link does.
    this.output.addEventListener("keydown", (event) => {
      if (event.key === "Enter") openReference(event);
    });
    this.error = doc.createElement("p");
    this.error.setAttribute("role", "status");
    this.status = doc.createElement("div");
    this.status.className = "hilo-agent-status";
    this.status.append(this.error, this.start);
    this.composer = new ChatComposer(
      doc,
      (text) => this.submit(text),
      () => this.run(() => this.handle?.cancel()),
      mentionPaths,
      (text) => this.keeper?.changeDraft(text),
    );
    // The sandbox the agent runs in, and a spinner while it connects or works.
    const meta = doc.createElement("div");
    meta.className = "hilo-agent-meta";
    const sandbox = doc.createElement("span");
    sandbox.className = "hilo-agent-sandbox";
    sandbox.title = UI_STRINGS.agent.sandboxHint;
    sandbox.insertAdjacentHTML("afterbegin", SANDBOX_ICON);
    sandbox.append(UI_STRINGS.agent.sandbox);
    this.busyMark = doc.createElement("span");
    this.busyMark.className = "hilo-agent-busy";
    this.busyMark.setAttribute("aria-hidden", "true");
    this.busyMark.innerHTML = SPINNER_ICON;
    this.busyTime = doc.createElement("span");
    this.busyTime.className = "hilo-agent-busy-time";
    this.options = new OptionBar(doc, this.element, (optionId, value) =>
      this.run(async () => {
        await this.handle?.setOption?.(optionId, value);
      }),
    );
    const end = doc.createElement("span");
    end.className = "hilo-agent-meta-end";
    end.append(this.options.element, this.busyTime, this.busyMark);
    meta.append(sandbox, end);
    this.signInBar = doc.createElement("div");
    this.signInBar.className = "hilo-agent-auth-bar";
    this.signInBar.hidden = true;
    this.element.append(this.output, this.signInBar, this.status, this.composer.element, meta);
    // Getting ready to type is the user's signal: connect in the background meanwhile, so a
    // restored chat answers its first message as fast as a live one.
    this.composer.element.addEventListener("focusin", () => this.activate());
    this.unsubscribe = store.subscribe(() => {
      this.keeper?.changed();
      this.sendPending();
      this.render();
    });
    this.render();
    if (history?.restore) {
      this.restoring = this.keeper?.restore((text) => {
        if (!this.disposed) this.composer.restoreDraft(text);
      });
    }
    if (autoStart) void this.begin();
  }
  /** Sends `text` as the next prompt, connecting (or reconnecting) first when needed. */
  private submit(text: string): void {
    if (this.pendingPrompt || this.store.getState().busy) return;
    this.pendingPrompt = text;
    if (this.store.getState().error || this.lost) void this.begin();
    else this.activate();
    this.sendPending();
    this.renderControls(this.store.getState());
  }
  /** Sends the user's last request again, as a new turn: the answer below it stays readable. */
  private retry(): void {
    const last = [...this.store.getState().messages]
      .reverse()
      .find((message) => message.role === "user" && message.text.trim());
    if (last) this.submit(last.text);
  }
  /**
   * Restored or ended sessions stay dormant until the user interacts (focus or a message); the
   * chat itself always looks like a normal, connected one.
   */
  activate(): void {
    if ((!this.handle || this.lost) && !this.store.getState().error) void this.begin();
  }
  /** Whether the Host can sign this agent out (the panel's menu offers it only then). */
  canSignOut(): boolean {
    return this.host.signOut !== undefined;
  }
  /** Stops the session and starts the agent again. */
  reload(): void {
    void this.begin();
  }
  /** Signs the agent out; the next message reconnects, which asks how to sign in. */
  logOut(): void {
    this.run(async () => {
      await this.host.signOut?.(this.identity.agentId);
    });
  }
  /** Signs the agent out and connects again, which asks how to sign in. */
  reauthenticate(): void {
    this.run(async () => {
      await this.host.signOut?.(this.identity.agentId);
      await this.begin();
    });
  }
  private button(label: string, click: () => void, className = ""): HTMLButtonElement {
    const button = this.element.ownerDocument.createElement("button");
    button.type = "button";
    if (className) button.className = className;
    button.textContent = label;
    button.addEventListener("click", click);
    return button;
  }
  private run(action: () => Promise<void> | undefined): void {
    void Promise.resolve()
      .then(action)
      .catch((error: unknown) =>
        this.store.setState((s) => ({ ...s, busy: false, error: String(error) })),
      );
  }
  private async begin(): Promise<void> {
    if (this.starting) return;
    const generation = ++this.generation;
    this.signInOpened.clear();
    this.starting = true;
    this.render();
    try {
      await this.restoring;
      await this.handle?.stop();
      if (generation !== this.generation) return;
      this.handle = null;
      this.lost = false;
      // A new connection starts a new agent session; the conversation on screen stays.
      this.store.reconnect();
      const { sessionId: resumeSessionId, messages, savedOptions } = this.store.getState();
      this.priorSessionId = resumeSessionId;
      this.priorMessages = this.history ? messages.slice(-8) : [];
      const config = {
        installedAgentId: this.identity.agentId,
        ...(this.history
          ? {
              conversationId: this.history.chatId,
              ...(this.history.cwd ? { expectedWorkspace: this.history.cwd } : {}),
              ...(resumeSessionId ? { resumeSessionId } : {}),
              ...(savedOptions?.length ? { preferredOptions: savedOptions } : {}),
            }
          : {}),
      };
      const handle = await this.host.start(config, (event) => {
        if (generation === this.generation) {
          if (event.type === "stopped") this.lost = true;
          if (event.type === "terminalAuthOutput") this.login.write(event.data);
          else this.store.enqueue(event);
        }
      });
      if (generation !== this.generation) await handle.stop();
      else this.handle = handle;
    } catch (error) {
      if (generation === this.generation)
        this.store.setState((s) => ({ ...s, error: String(error) }));
    } finally {
      this.starting = false;
      if (generation === this.generation) {
        this.sendPending();
        this.render();
      }
    }
  }
  private sendPending(): void {
    const state = this.store.getState();
    if (state.error && !this.starting) {
      this.pendingPrompt = null;
      return;
    }
    const text = this.pendingPrompt;
    const handle = this.handle;
    if (this.starting || !text || !handle || !state.ready || state.busy) return;
    this.pendingPrompt = null;
    this.store.setState((current) => ({ ...current, busy: true }));
    this.run(async () => {
      const previous = this.priorMessages;
      if (previous.length && state.sessionId !== this.priorSessionId) {
        const context = JSON.stringify(
          previous.map(({ role, text }) => ({ role, text: text.slice(-400) })),
        );
        await handle.prompt(text, context);
      } else {
        await handle.prompt(text);
      }
      if (this.handle === handle) this.priorMessages = [];
      if (this.handle === handle) this.composer.clearSent(text);
    });
  }
  private render(): void {
    const s = this.store.getState();
    this.renderControls(s);
    this.conversation.render(this.output, s, (label, click) => this.button(label, click), {
      openLocation: (path, line) => this.run(() => this.openLocation(path, line)),
      answer: (id, allow) =>
        this.run(async () => {
          await this.handle?.answer(id, allow);
          this.store.answered(id);
        }),
      retry: () => this.retry(),
    });
    this.renderSignIn(s);
    this.login.fit();
    this.openSignInPages();
  }
  /** The status line, the connect button, the composer and the busy mark. */
  private renderControls(s: AgentState): void {
    // No Connect step: a dormant chat reconnects by itself. Only a failure offers Retry.
    this.error.textContent = s.error || (this.pendingPrompt ? UI_STRINGS.agent.pendingPrompt : "");
    this.start.textContent = UI_STRINGS.agent.retry;
    this.start.disabled = this.starting;
    this.start.hidden = this.starting || !s.error;
    this.status.hidden = !this.error.textContent;
    this.busyMark.hidden = !s.busy && !this.pendingPrompt;
    this.options.update(s.options, !s.ready || s.busy || !this.handle?.setOption);
    this.showElapsed(s);
    // Nothing said yet: a roomy composer in the middle; afterwards a compact one at the bottom.
    const started =
      s.messages.length +
        s.plan.length +
        s.tools.length +
        s.permissions.length +
        s.elicitations.length >
        0 || s.terminalAuth !== null;
    this.element.dataset.mode = started ? "chat" : "empty";
    this.composer.update({
      started,
      busy: s.busy,
      canCancel: s.ready,
      pendingLabel: this.pendingPrompt ? UI_STRINGS.agent.pendingPrompt : "",
    });
  }
  /** While the agent works, how long it has been at it; it ticks once a second. */
  private showElapsed(s: AgentState): void {
    const turn = s.turn;
    if (!s.busy || !turn || turn.endedAt !== undefined) {
      clearInterval(this.tick);
      this.tick = undefined;
      this.busyTime.textContent = "";
      return;
    }
    const show = () => {
      this.busyTime.textContent = formatDuration(Date.now() - turn.startedAt);
    };
    show();
    this.tick ??= setInterval(show, 1000);
  }
  /**
   * Signing in, at the bottom above the composer, not in the conversation: the choice of method,
   * the agent's prompts (a code to type, the wait) and the terminal login. While it shows, the
   * status line and the busy mark make way.
   */
  private renderSignIn(s: AgentState): void {
    const doc = this.element.ownerDocument;
    const prompts = authenticationCards(doc, this.store, this.handle, (action) => this.run(action));
    const choice =
      s.authChoice && !s.ready
        ? authChoiceCard(doc, this.identity.name, s.authChoice, (methodId) => {
            this.store.chose();
            this.run(async () => {
              await this.handle?.chooseAuth?.(methodId);
            });
          })
        : null;
    const bar = [
      ...(choice ? [choice] : []),
      ...prompts,
      ...(s.terminalAuth ? [this.login.element] : []),
    ];
    const same =
      bar.length === this.signInBar.children.length &&
      bar.every((node, index) => this.signInBar.children[index] === node);
    if (!same) this.signInBar.replaceChildren(...bar);
    this.signInBar.hidden = bar.length === 0;
    if (bar.length > 0) {
      this.status.hidden = true;
      this.busyMark.hidden = true;
    }
    this.login.render(s.terminalAuth);
  }
  /**
   * Opens the sign-in page of each new request by itself: the user chose to connect, and the Host
   * opens only the address it kept for that request, on a host it approved. A failure leaves the
   * card with its button.
   */
  private openSignInPages(): void {
    const handle = this.handle;
    if (!handle?.elicit) return;
    for (const request of this.store.getState().elicitations) {
      if (request.accepted || this.signInOpened.has(request.id)) continue;
      this.signInOpened.add(request.id);
      const elicit = handle.elicit(request.id, "accept");
      void elicit
        .then(() => this.store.answeredElicitation(request.id, "accept"))
        .catch(() => undefined);
    }
  }
  /** The panel was closed for good: its saved conversation is deleted too. */
  discard(): void {
    this.keeper?.discard();
  }
  flushTranscript(): Promise<void> | undefined {
    if (!this.keeper) return;
    this.store.flush();
    return this.keeper.flush();
  }
  destroy(): void {
    this.disposed = true;
    void this.flushTranscript();
    clearInterval(this.tick);
    this.conversation.dispose();
    this.options.close();
    this.login.dispose();
    this.generation += 1;
    this.pendingPrompt = null;
    this.unsubscribe();
    this.composer.destroy();
    this.store.dispose();
    void this.handle?.stop().catch(() => undefined);
    this.element.remove();
  }
}
