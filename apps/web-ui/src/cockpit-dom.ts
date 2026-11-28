import type { HiloEditorView } from "@hilo/editor-cm6";
import type { AgentHost } from "./agent/store.js";
import { type AgentCompletionAlert, watchAgentCompletions } from "./cockpit/agent-completions.js";
import { askUnsavedPrompt } from "./cockpit/dialogs/unsaved-dialog.js";
import {
  WorkspaceTrust,
  type WorkspaceTrustHost,
  type WorkspaceTrustReport,
} from "./cockpit/dialogs/workspace-trust.js";
import { type DebugHost, DebugPanel } from "./cockpit/inspector/debug-panel.js";
import { Inspector } from "./cockpit/inspector/inspector.js";
import { ChatGrid } from "./cockpit/panels/chat-grid.js";
import { ActivityBar } from "./cockpit/shell/activity-bar.js";
import { ShellLayout } from "./cockpit/shell/shell-layout.js";
import { bindShellShortcuts } from "./cockpit/shell/shell-shortcuts.js";
import { SidebarPanels } from "./cockpit/shell/sidebar-panels.js";
import { TitleBar } from "./cockpit/shell/title-bar.js";
import type { TerminalHost, TerminalViewFactory } from "./cockpit/terminal/terminal-pane.js";
import { createXtermView } from "./cockpit/terminal/xterm-view.js";
import { JudgeController } from "./judge/controller.js";
import type { JudgeHost } from "./judge/types.js";
import { OnboardingModalController, createInitialOnboardingState } from "./onboarding/index.js";
import { type AgentRegistryHost, SettingsPage } from "./settings/index.js";
import { UiPreferences, browserStorage, watchTheme } from "./state/ui-preferences.js";
import type {
  CockpitAstSymbolItem,
  CockpitFileTreeNode,
  CockpitImpactedTestItem,
  CockpitSearchResultItem,
  CockpitStoreBundle,
  Zone4InspectorState,
} from "./stores/index.js";
import type { NativeChatHost } from "./ui/chat-composer.js";
import { UI_STRINGS, uiText } from "./ui/ui-strings.js";

export type {
  DebugCommandMessage,
  DebugEventMessage,
  DebugHost,
} from "./cockpit/inspector/debug-panel.js";
export type {
  TerminalAgentStatus,
  TerminalHandle,
  TerminalHost,
  TerminalView,
  TerminalViewFactory,
} from "./cockpit/terminal/terminal-pane.js";
export type { AgentCompletion, AgentCompletionAlert } from "./cockpit/agent-completions.js";
export { createXtermView } from "./cockpit/terminal/xterm-view.js";
export type {
  WorkspaceTrustHost,
  WorkspaceTrustReport,
  WorkspaceTrustState,
} from "./cockpit/dialogs/workspace-trust.js";

export interface CockpitDomControllerOptions {
  readonly rootContainer: HTMLElement;
  readonly stores: CockpitStoreBundle;
  readonly editorView: HiloEditorView;
  readonly onboardingController?: OnboardingModalController;
  readonly openWorkspace?: () => Promise<readonly CockpitFileTreeNode[] | null>;
  readonly switchWorkspace?: (path: string) => Promise<readonly CockpitFileTreeNode[] | null>;
  /**
   * Told whenever an agent finishes its turn (an agent panel, or a recognized agent CLI running in
   * a terminal), with whether the user was looking at that session: the host plays a sound and,
   * for a session nobody was watching, shows a notification.
   */
  readonly onAgentFinished?: (completion: AgentCompletionAlert) => void;
  /**
   * Ends the agents and terminals that keep running for a project while another one is shown.
   * Called when the user removes that project from the sidebar.
   */
  readonly closeWorkspaceSessions?: (path: string) => Promise<void>;
  readonly readWorkspaceFile?: (path: string) => Promise<string>;
  /**
   * Called with how many files have unsaved changes whenever that number changes, so the host
   * can hold back closing the window while it is above zero.
   */
  readonly onUnsavedCountChange?: (count: number) => void;
  /**
   * Workspace Trust decision kept by the host. Without it there is no host able to run anything
   * from the folder, so no restricted-mode notice is shown.
   */
  readonly workspaceTrust?: WorkspaceTrustHost;
  /** Shells for the integrated terminal (Ctrl+`). Without it the terminal is not offered. */
  readonly terminalHost?: TerminalHost;
  /** JavaScript debugging (F5). Without it the debugger is not offered. */
  readonly debugHost?: DebugHost;
  readonly agentHost?: AgentHost;
  readonly nativeChat?: NativeChatHost;
  /** The Judge (`LOT-015`): reviews of agent changes. Without it agent changes are never applied. */
  readonly judgeHost?: JudgeHost;
  /** The ACP agent registry of the Settings screen. Without it there is no Settings button. */
  readonly agentRegistryHost?: AgentRegistryHost;
  /** The desktop host opens a separate native Settings window. */
  readonly openSettingsWindow?: () => Promise<void>;
  /** The terminal emulator; xterm.js by default. */
  readonly createTerminalView?: TerminalViewFactory;
  readonly searchWorkspace?: (query: string) => Promise<readonly CockpitSearchResultItem[]>;
  readonly analyzeDocument?: (
    documentId: string,
    sessionGeneration: number,
  ) => Promise<{
    readonly symbols: readonly CockpitAstSymbolItem[];
    readonly impactedTests: readonly CockpitImpactedTestItem[];
  }>;
}

/**
 * 4-Zone Multi-Chat Cockpit: builds the shell, mounts one component per zone and routes store
 * changes to them. The zones live in `./cockpit/`:
 * Zone 1 `ActivityBar`, Zone 2 `SidebarPanels`, Zone 3 `ChatGrid`, Zone 4 `Inspector`, plus the
 * `TitleBar` that holds the Zone 3 and Zone 4 headers.
 * The singleton `HiloEditorView` is mounted once in Zone 4 and never re-mounted.
 */
export class CockpitDomController {
  private readonly stores: CockpitStoreBundle;
  private readonly editorView: HiloEditorView;
  private readonly onboardingController: OnboardingModalController;
  private readonly ownsOnboardingController: boolean;
  private readonly analyzeDocument?: CockpitDomControllerOptions["analyzeDocument"];
  private readonly unsubscribers: Array<() => void> = [];
  private readonly shell: HTMLElement;
  private readonly titleBar: TitleBar;
  private readonly activityBar: ActivityBar;
  private readonly settings: SettingsPage | null;
  private readonly openSettingsWindow: (() => Promise<void>) | undefined;
  private settingsOpen = false;
  private settingsActive = false;
  private readonly sidebar: SidebarPanels;
  private readonly chatGrid: ChatGrid;
  private readonly inspector: Inspector;
  private readonly workspaceTrust: WorkspaceTrust | null;
  private readonly terminalAvailable: boolean;
  private readonly layout: ShellLayout;
  private readonly debugPanel: DebugPanel | null;
  private readonly judge: JudgeController | null;
  /** Breakpoints of every file, keyed by project and document id. */
  private readonly breakpoints = new Map<string, readonly number[]>();
  /** Set while the editor switches file: its breakpoint changes then are not the user's. */
  private switchingDocument = false;
  private zone4RenderCount = 0;
  private analysisRequestSequence = 0;
  private readonly onUnsavedCountChange: ((count: number) => void) | undefined;
  private lastUnsavedCount = 0;
  private closePrompt: Promise<boolean> | null = null;
  /** Project whose file the editor holds (document ids alone do not say which). */
  private editorProjectPath: string;

  constructor(options: CockpitDomControllerOptions) {
    const { rootContainer, stores, editorView } = options;
    this.stores = stores;
    this.editorView = editorView;
    this.editorProjectPath = stores.navigation.getState().projectPath;
    this.analyzeDocument = options.analyzeDocument;
    this.onUnsavedCountChange = options.onUnsavedCountChange;
    this.openSettingsWindow = options.openSettingsWindow;
    this.ownsOnboardingController = !options.onboardingController;
    this.onboardingController =
      options.onboardingController ??
      new OnboardingModalController(editorView, {
        ...createInitialOnboardingState(),
        modalOpen: false,
      });

    // Seed initial editor content into the store's UnsavedBufferOverlay
    stores.updateInMemoryDocumentContent(
      editorView.getStoreSnapshot().documentId,
      editorView.getDocumentText(),
      false,
    );

    const doc = rootContainer.ownerDocument;
    const preferences = new UiPreferences(browserStorage(doc));
    this.unsubscribers.push(watchTheme(doc, preferences));
    rootContainer.replaceChildren();
    this.titleBar = new TitleBar(doc, rootContainer, stores);
    this.settings = options.agentRegistryHost
      ? new SettingsPage(doc, { agentRegistry: options.agentRegistryHost, preferences })
      : null;
    this.activityBar = new ActivityBar(
      doc,
      stores,
      this.settings ? () => this.openSettings() : undefined,
    );
    this.inspector = new Inspector(doc, {
      stores,
      editorView,
      preferences,
      header: this.titleBar.zone4Header,
      saveActiveDocument: () => this.saveActiveDocument(),
      onFileShown: (path) => {
        this.requestNativeAnalysis(path);
        void this.judge?.refreshStates();
      },
      onReviewLeft: () => this.judge?.reviewLeft(),
      onUnsavedChange: () => this.reportUnsaved(),
      onTreeScroll: (scrollTopPx, viewportHeightPx) =>
        this.storeFileTreeScroll(scrollTopPx, viewportHeightPx),
      ...(options.readWorkspaceFile ? { readWorkspaceFile: options.readWorkspaceFile } : {}),
      ...(options.openWorkspace ? { openWorkspace: options.openWorkspace } : {}),
    });
    this.sidebar = new SidebarPanels(doc, {
      stores,
      onboarding: this.onboardingController,
      openFile: (path, onError) => {
        // A file opened from the sidebar (search results) is shown in Zone 4, which starts closed.
        stores.toggleInspector(true);
        void this.inspector.openFile(path, onError);
      },
      ...(options.openWorkspace ? { openWorkspace: options.openWorkspace } : {}),
      ...(options.switchWorkspace ? { switchWorkspace: options.switchWorkspace } : {}),
      ...(options.closeWorkspaceSessions
        ? { closeWorkspaceSessions: options.closeWorkspaceSessions }
        : {}),
      ...(options.searchWorkspace ? { searchWorkspace: options.searchWorkspace } : {}),
      // With a terminal host, "New session" opens a terminal, where the user can run an agent.
      newSessionKind: options.terminalHost ? "terminal" : "agent",
      ...(options.agentRegistryHost ? { agentRegistryHost: options.agentRegistryHost } : {}),
      openSettings: () => this.openSettings(),
    });
    // A folder starts restricted and shows no notice about it: the host's native trust prompt is
    // asked for when the user first tries to use the folder, i.e. starts a terminal or an agent.
    this.workspaceTrust = options.workspaceTrust
      ? new WorkspaceTrust(options.workspaceTrust)
      : null;
    const trust = this.workspaceTrust;
    const baseTerminalHost = options.terminalHost;
    const terminalHost: TerminalHost | undefined =
      baseTerminalHost && trust
        ? {
            ...baseTerminalHost,
            open: async (size, onOutput, onExit, onAgentStatus) => {
              await trust.ensureTrusted();
              return baseTerminalHost.open(size, onOutput, onExit, onAgentStatus);
            },
          }
        : baseTerminalHost;
    const baseAgentHost = options.agentHost;
    const agentHost: AgentHost | undefined =
      baseAgentHost && trust
        ? {
            ...baseAgentHost,
            start: async (config, onEvent) => {
              await trust.ensureTrusted();
              return baseAgentHost.start(config, onEvent);
            },
          }
        : baseAgentHost;
    this.chatGrid = new ChatGrid(
      doc,
      stores,
      this.titleBar.zone3Header,
      terminalHost
        ? {
            host: terminalHost,
            createView: options.createTerminalView ?? createXtermView,
          }
        : null,
      agentHost
        ? {
            host: agentHost,
            openLocation: async (path, line) => {
              await this.openWorkspaceFile(path);
              const view = editorView.getEditorView();
              const position = view.state.doc.line(
                Math.min(Math.max(1, line), view.state.doc.lines),
              ).from;
              view.dispatch({ selection: { anchor: position }, scrollIntoView: true });
              view.focus();
            },
          }
        : null,
      this.settings
        ? {
            select: () => this.openSettings(),
            close: () => this.closeSettings(),
            selectWorkspace: () => this.showWorkspace(),
          }
        : undefined,
      options.agentRegistryHost,
      options.openWorkspace ? () => void this.sidebar.openProject() : undefined,
      options.nativeChat,
    );

    this.shell = doc.createElement("div");
    this.shell.className = "hilo-cockpit-shell";
    this.shell.setAttribute("role", "application");
    this.shell.setAttribute("aria-label", UI_STRINGS.shell.cockpit);
    this.shell.style.display = "grid";
    this.shell.style.width = "100%";
    this.shell.style.height = "100vh";
    this.shell.style.overflow = "hidden";
    this.shell.append(
      this.activityBar.element,
      this.sidebar.element,
      this.chatGrid.element,
      this.inspector.element,
    );
    this.layout = new ShellLayout(
      doc,
      this.shell,
      this.sidebar.element,
      this.inspector.element,
      preferences,
    );
    if (this.settings) this.shell.append(this.settings.element);
    this.activityBar.element.addEventListener("click", (event) => {
      if (!(event.target as HTMLElement).closest(".hilo-settings-btn")) this.showWorkspace();
    });
    rootContainer.append(this.shell);
    this.terminalAvailable = options.terminalHost !== undefined;
    this.debugPanel = options.debugHost
      ? new DebugPanel(doc, options.debugHost, {
          currentFile: () =>
            this.inspector.isShowingFile() ? editorView.getStoreSnapshot().documentId : null,
          breakpoints: () => this.projectBreakpoints(),
          projectPath: () => stores.navigation.getState().projectPath,
        })
      : null;
    if (this.debugPanel) this.sidebar.debugSection.prepend(this.debugPanel.element);
    this.judge = options.judgeHost
      ? new JudgeController(doc, {
          host: options.judgeHost,
          editorView,
          banner: this.inspector.judgeBanner,
          showReview: (element) => this.inspector.showReview(element),
          closeReview: () => this.inspector.closeReview(),
          openFile: (path) => this.openWorkspaceFile(path),
        })
      : null;
    void this.workspaceTrust?.refresh();

    this.onboardingController.mountModal(this.shell);
    this.renderLayout();
    this.sidebar.update();
    this.chatGrid.update();
    this.inspector.update();
    this.titleBar.recordChatVisit(stores.zone3.getState().activeChatId);
    this.inspector.mountEditor();
    void this.judge?.start();

    if (options.onAgentFinished) {
      this.unsubscribers.push(
        watchAgentCompletions(stores, options.onAgentFinished, (chatId) => {
          return doc.hasFocus() && stores.zone3.getState().activeChatId === chatId;
        }),
      );
    }
    this.unsubscribers.push(
      bindShellShortcuts(doc, {
        stores,
        debug: this.debugPanel,
        terminalAvailable: this.terminalAvailable,
        openTerminal: () => this.openTerminal(),
        ...(this.settings ? { openSettings: () => this.openSettings() } : {}),
        toggleTree: () => this.inspector.toggleTree(),
        save: () => this.saveActiveDocument(),
        reportError: (message) => this.inspector.reportError(message),
      }),
      preferences.subscribe(() => this.renderLayout()),
      // Each folder has its own trust decision: ask again whenever another one is opened.
      stores.navigation.subscribeSelector(
        (state) => state.projectPath,
        () => void this.workspaceTrust?.refresh(),
      ),
      stores.navigation.subscribeSelector(
        (state) => [state.projectPath, state.activeGroupId] as const,
        ([projectPath, groupId]) => this.inspector.changeScope(projectPath, groupId),
        (a, b) => a[0] === b[0] && a[1] === b[1],
      ),
      // What Zone 3 shows: the active group's sessions and layout. The project matters too, since
      // every project has a group "Workspace" with the same id but its own sessions.
      stores.navigation.subscribeSelector(
        (state) =>
          [
            state.projectPath,
            state.activeGroupId,
            state.groups
              .map((group) => `${group.id}:${group.title}:${group.chatIds.join(",")}`)
              .join("|"),
            state.groups.find((group) => group.id === state.activeGroupId)?.layout,
            state.groups.find((group) => group.id === state.activeGroupId)?.maximizedChatId,
          ] as const,
        () => this.chatGrid.update(),
        (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3] && a[4] === b[4],
      ),
      stores.zone1.subscribe(() => {
        this.renderLayout();
        this.sidebar.update();
      }),
      stores.zone2.subscribe(() => {
        this.sidebar.update();
        this.inspector.updateTree();
      }),
      stores.zone3.subscribe((next, prev) => {
        this.chatGrid.update();
        if (next.activeChatId !== prev.activeChatId) {
          this.showWorkspace();
          this.titleBar.recordChatVisit(next.activeChatId);
        } else if (next.chats !== prev.chats) {
          this.titleBar.refreshHistory();
        }
      }),
      stores.zone4.subscribe((next, prev) => {
        this.zone4RenderCount += 1;
        this.inspector.update();
        // Document ids are paths relative to the project, so the same id in another project is
        // another file: once one is shown there, the editor must load it too.
        const projectPath = stores.navigation.getState().projectPath;
        const otherProjectsFile =
          this.editorProjectPath !== projectPath && this.inspector.isShowingFile();
        if (next.activeDocumentId !== prev.activeDocumentId || otherProjectsFile) {
          this.editorProjectPath = projectPath;
          this.syncEditorDocument(next);
        }
      }),
      editorView.subscribe(() => {
        const snap = editorView.getStoreSnapshot();
        // Until host-core acknowledges the shown document (just after a switch), keep the flag the
        // buffer already had: a file reopened with unsaved edits must not look saved.
        const hasUnsaved = snap.lastAckSnapshot
          ? snap.lastAckSnapshot.has_unsaved_changes
          : stores.isDocumentUnsaved(snap.documentId);
        stores.updateInMemoryDocumentContent(
          snap.documentId,
          editorView.getDocumentText(),
          hasUnsaved,
        );
        this.inspector.setUnsaved(hasUnsaved);
        this.reportUnsaved();
        if (snap.lastIpcError) this.inspector.reportError(snap.lastIpcError);
        if (snap.lastAckSnapshot) this.requestNativeAnalysis(snap.documentId);
      }),
      editorView.onBreakpointsChange((lines) => {
        if (this.switchingDocument || !this.inspector.isShowingFile()) return;
        const documentId = editorView.getStoreSnapshot().documentId;
        this.breakpoints.set(this.breakpointKey(documentId), lines);
        this.debugPanel?.breakpointsChanged(documentId, lines);
      }),
      this.onboardingController.store.subscribe(() => {
        if (stores.zone1.getState().activeSection === "mcp") this.sidebar.update();
      }),
    );
  }

  getOnboardingController(): OnboardingModalController {
    return this.onboardingController;
  }

  /** Trust decision last reported by the host; null when the cockpit has no trust host. */
  getWorkspaceTrust(): WorkspaceTrustReport | null {
    return this.workspaceTrust?.getReport() ?? null;
  }

  /** Re-reads the trust decision from the host (after it changed outside the banner). */
  async refreshWorkspaceTrust(): Promise<void> {
    await this.workspaceTrust?.refresh();
  }

  /** Shows a project file in Zone 4 (opened from "go to definition", for example). */
  async openWorkspaceFile(path: string): Promise<void> {
    this.stores.toggleInspector(true);
    await this.inspector.openFile(path);
  }

  async saveActiveDocument(): Promise<void> {
    // With no file shown the editor may still hold another group's or project's document.
    if (!this.inspector.isShowingFile()) return;
    const snap = await this.editorView.requestSave();
    this.stores.markDocumentSaved(snap.document_id);
    this.inspector.setUnsaved(false);
    this.reportUnsaved();
  }

  /** Files with unsaved changes: the open project's buffers and the ones kept aside for others. */
  unsavedCount(): number {
    return this.stores.getUnsavedDocumentIds().length + this.inspector.stashedUnsavedCount();
  }

  private reportUnsaved(): void {
    const count = this.unsavedCount();
    if (count === this.lastUnsavedCount) return;
    this.lastUnsavedCount = count;
    this.onUnsavedCountChange?.(count);
  }

  /**
   * Decides whether the window may close: true when nothing is unsaved, or once the user chose
   * to save (everything that can be saved from here) or not to. Asked while another prompt is
   * still open, it shares that prompt's answer.
   */
  confirmClose(): Promise<boolean> {
    this.closePrompt ??= this.askBeforeClosing()
      .then(async (allowed) => {
        if (allowed) await this.chatGrid.flushTranscripts();
        return allowed;
      })
      .finally(() => {
        this.closePrompt = null;
      });
    return this.closePrompt;
  }

  private async askBeforeClosing(): Promise<boolean> {
    const total = this.unsavedCount();
    if (total === 0) return true;
    const choice = await askUnsavedPrompt(this.shell, {
      message: uiText.unsavedCloseAll(total),
      saveLabel: UI_STRINGS.editor.saveAll,
    });
    if (choice === "cancel") return false;
    if (choice === "discard") return true;
    try {
      await this.inspector.saveAllUnsaved();
    } catch (error: unknown) {
      this.inspector.reportError(
        error instanceof Error ? error.message : UI_STRINGS.editor.saveFailed,
      );
      return false;
    }
    // What is left (other projects' edits) cannot be saved from here: let the user decide.
    const remaining = this.unsavedCount();
    if (remaining === 0) return true;
    const rest = await askUnsavedPrompt(this.shell, {
      message: uiText.unsavedElsewhere(remaining),
      saveLabel: null,
      discardLabel: UI_STRINGS.editor.closeWithoutSaving,
    });
    return rest === "discard";
  }

  getZoneElements(): {
    readonly shell: HTMLElement;
    readonly zone1: HTMLElement;
    readonly zone2: HTMLElement;
    readonly zone3: HTMLElement;
    readonly zone4: HTMLElement;
    readonly zone4EditorHost: HTMLElement;
  } {
    return {
      shell: this.shell,
      zone1: this.activityBar.element,
      zone2: this.sidebar.element,
      zone3: this.chatGrid.element,
      zone4: this.inspector.element,
      zone4EditorHost: this.inspector.editorHost,
    };
  }

  getZone4RenderCount(): number {
    return this.zone4RenderCount;
  }

  /** Scrolls the sidebar file tree (programmatic; also records the position for the session). */
  scrollFileTree(scrollTopPx: number, viewportHeightPx = 600): void {
    this.storeFileTreeScroll(scrollTopPx, viewportHeightPx);
    this.inspector.tree.scrollTo(scrollTopPx, viewportHeightPx);
  }

  destroy(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
    this.judge?.dispose();
    this.settings?.destroy();
    this.workspaceTrust?.destroy();
    this.chatGrid.destroy();
    this.inspector.destroy();
    this.sidebar.destroy();
    if (this.ownsOnboardingController) this.onboardingController.destroy();
  }

  private openSettings(): void {
    if (this.openSettingsWindow) {
      void this.openSettingsWindow().catch((error: unknown) =>
        this.inspector.reportError(
          error instanceof Error ? error.message : "Could not open Settings.",
        ),
      );
      return;
    }
    if (!this.settings) return;
    this.settingsOpen = true;
    this.settingsActive = true;
    this.settings.showExternalAgents();
    this.chatGrid.setSettingsTab(true, true);
    this.renderLayout();
  }

  private showWorkspace(): void {
    if (!this.settingsActive) return;
    this.settingsActive = false;
    this.settings?.hide();
    this.chatGrid.setSettingsTab(this.settingsOpen, false);
    this.renderLayout();
  }

  private closeSettings(): void {
    this.settingsOpen = false;
    this.showWorkspace();
    this.chatGrid.setSettingsTab(false, false);
    this.titleBar.zone3Header
      .querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      ?.focus();
  }

  private renderLayout(): void {
    const z1 = this.stores.zone1.getState();
    const columns = this.layout.update(z1);
    this.shell.dataset.settingsActive = String(this.settingsActive);
    this.titleBar.element.dataset.settingsActive = String(this.settingsActive);
    this.shell.dataset.uiZoomPercent = String(z1.uiZoomPercent);
    this.shell.dataset.activePersona = z1.activePersona;
    this.shell.dataset.sidebarOpen = String(z1.sidebarOpen);
    this.shell.dataset.inspectorOpen = String(z1.inspectorOpen);
    this.shell.style.fontSize = `${(z1.uiZoomPercent / 100).toFixed(2)}rem`;
    this.shell.style.gridTemplateColumns = columns;
    this.titleBar.update(z1, this.settingsActive ? "48px 228px minmax(0, 1fr) 0px" : columns);
    this.activityBar.update(z1);
    this.inspector.setOpen(z1.inspectorOpen);
  }

  private storeFileTreeScroll(scrollTopPx: number, viewportHeightPx: number): void {
    this.stores.zone2.setState((prev) => ({
      ...prev,
      fileTreeScrollTop: scrollTopPx,
      fileTreeViewportHeight: viewportHeightPx,
    }));
  }

  private syncEditorDocument(z4: Zone4InspectorState): void {
    const storedContent = this.stores.getDocumentContent(z4.activeDocumentId);
    const targetChat = this.stores.zone3
      .getState()
      .chats.find((chat) => chat.chatId === z4.syncedChatId);
    const content =
      storedContent ?? targetChat?.targetDocumentContent ?? this.editorView.getDocumentText();
    // Read before switching: the switch clears the editor's breakpoints.
    const breakpoints = this.breakpoints.get(this.breakpointKey(z4.activeDocumentId)) ?? [];
    this.switchingDocument = true;
    try {
      this.editorView.switchDocument(z4.activeDocumentId, content, [
        {
          fromLine: 1,
          toLine: 1,
          state: z4.activeValidationState,
          snapshotHash: `sync-${z4.syncedChatId}`,
        },
      ]);
      if (breakpoints.length > 0) this.editorView.setBreakpointLines(breakpoints);
    } finally {
      this.switchingDocument = false;
    }
  }

  private breakpointKey(documentId: string): string {
    return `${this.stores.navigation.getState().projectPath}\n${documentId}`;
  }

  /** The open project's breakpoints, by document id. */
  private projectBreakpoints(): Map<string, readonly number[]> {
    const prefix = `${this.stores.navigation.getState().projectPath}\n`;
    const result = new Map<string, readonly number[]>();
    for (const [key, lines] of this.breakpoints) {
      if (key.startsWith(prefix) && lines.length > 0) result.set(key.slice(prefix.length), lines);
    }
    return result;
  }

  /** The debugger panel; null when the host offers none. */
  getDebugPanel(): DebugPanel | null {
    return this.debugPanel;
  }

  /** Shows the shell panel, creating it the first time (Ctrl+` / Ctrl+J). */
  openTerminal(): void {
    const existing = this.stores.zone3.getState().chats.find((chat) => chat.kind === "terminal");
    if (existing) this.stores.selectChat(existing.chatId);
    else this.stores.createChat({ kind: "terminal", nextToActive: true });
  }

  private requestNativeAnalysis(documentId: string): void {
    if (!this.analyzeDocument) return;
    const snapshot = this.editorView.getStoreSnapshot();
    if (snapshot.documentId !== documentId) return;
    const requestId = ++this.analysisRequestSequence;
    void this.analyzeDocument(documentId, snapshot.sessionGeneration)
      .then((analysis) => {
        if (requestId !== this.analysisRequestSequence) return;
        if (this.editorView.getStoreSnapshot().documentId !== documentId) return;
        this.stores.setAstAnalysis(analysis.symbols, analysis.impactedTests);
      })
      .catch(() => {
        // A newer document switch or edit may invalidate this request; the next host snapshot retries.
      });
  }
}
