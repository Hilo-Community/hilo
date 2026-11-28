import type { ConfidenceLevel, ExcerptFreshness, HiloValidationState } from "@hilo/protocol-types";
import type { AreaSize, SplitDirection, SplitPosition } from "../layout/layout-tree.js";
import type { AtomicStore } from "../state/atomic-store.js";
import type {
  WorkspaceNavigationActions,
  WorkspaceNavigationState,
} from "../state/workspace-navigation.js";

export type CockpitPersonaMode = "Create" | "Learn" | "Develop" | "Infrastructure" | "Data";

export type ActivityBarSection = "sessions" | "search" | "git" | "debug" | "mcp";

/** Sections a saved session may name; anything else (e.g. the removed "files") falls back. */
export const ACTIVITY_BAR_SECTIONS: readonly ActivityBarSection[] = [
  "sessions",
  "search",
  "git",
  "debug",
  "mcp",
];

export type InspectorTab = "preview" | "code-diff";

export interface Zone1ActivityState {
  readonly activeSection: ActivityBarSection;
  readonly activePersona: CockpitPersonaMode;
  readonly sidebarOpen: boolean;
  /** Right inspector (Zone 4) and its header. Hidden by collapsing, never unmounted. */
  readonly inspectorOpen: boolean;
  readonly fileTreeAccessible: true;
  readonly uiZoomPercent: number;
  readonly permissionsLevel: "standard-enforced";
}

export interface CockpitFileTreeNode {
  readonly path: string;
  readonly name: string;
  readonly depth: number;
  readonly isDirectory: boolean;
  readonly validationState: HiloValidationState;
}

export interface CockpitSessionSummary {
  readonly kind: "agent";
  readonly chatId: string;
  readonly title: string;
  readonly modelName: string;
  readonly validationState: HiloValidationState;
  readonly targetDocumentId: string;
}

export interface CockpitAstSymbolItem {
  readonly name: string;
  readonly kind: "function" | "component" | "class" | "interface" | "type" | "const";
  readonly line: number;
  readonly exported: boolean;
  readonly confidence: ConfidenceLevel;
}

export interface CockpitImpactedTestItem {
  readonly testFilePath: string;
  readonly coveredSymbol: string;
  readonly confidence: ConfidenceLevel;
}

export interface CockpitSearchResultItem {
  readonly filePath: string;
  readonly line: number;
  readonly snippet: string;
  readonly freshness: ExcerptFreshness;
  readonly score: number;
  readonly secretsRedacted: number;
}

export interface Zone2SidebarState {
  readonly sessions: readonly CockpitSessionSummary[];
  readonly fileTree: readonly CockpitFileTreeNode[];
  readonly fileTreeScrollTop: number;
  readonly fileTreeViewportHeight: number;
  readonly focusedFileIndex: number;
  readonly searchQuery: string;
  readonly searchResults: readonly CockpitSearchResultItem[];
  readonly astSymbols: readonly CockpitAstSymbolItem[];
  readonly impactedTests: readonly CockpitImpactedTestItem[];
}

export interface CockpitChatMessage {
  readonly messageId: string;
  readonly chatId: string;
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
  readonly renderedHtmlBlocks: readonly string[];
  readonly streaming: boolean;
}

/** What a Zone 3 panel holds. Legacy caches are normalized at the desktop boundary. */
export type CockpitChatKind = "agent" | "terminal";

interface SessionBase {
  readonly chatId: string;
  readonly title: string;
  readonly validationState: HiloValidationState;
  readonly targetDocumentId?: string;
  readonly targetDocumentContent?: string;
  readonly previewUrl?: string;
  /** Creation or most recent session activity, in milliseconds since the Unix epoch. */
  readonly lastActiveAt?: number;
}
export interface CockpitAgentSession extends SessionBase {
  readonly kind: "agent";
  readonly agentId?: string;
  readonly agentName?: string;
  readonly modelName: string;
  readonly agentExecutionStatus?: "Idle" | "Running" | "QueuedSequential";
  /** Derived from the panel's `AgentStore`: a turn is running, a permission is pending, it errored, or it just finished. */
  readonly statusBadge?: "running" | "waiting" | "done" | "error" | undefined;
}
export interface CockpitTerminalSession extends SessionBase {
  readonly kind: "terminal";
  readonly modelName?: never;
  readonly agentExecutionStatus?: never;
  /** Whether the shell process is currently alive, mirroring `TerminalPane.isRunning()`. */
  readonly running?: boolean;
  /** A recognized agent CLI (e.g. "codex") typed by hand into this shell, or `undefined`. */
  readonly detectedAgentId?: string | undefined;
  /** Whether `detectedAgentId` looks busy right now. Meaningless while `detectedAgentId` is unset. */
  readonly detectedAgentBusy?: boolean;
  /**
   * `detectedAgentId` finished a turn (busy → idle) and the session hasn't been selected since —
   * the terminal counterpart of an agent session's "done" `statusBadge`.
   */
  readonly detectedAgentFinished?: boolean;
}
export type CockpitChatTab = CockpitAgentSession | CockpitTerminalSession;

export interface Zone3MultiChatState {
  readonly activeChatId: string;
  readonly chats: readonly CockpitChatTab[];
  readonly messagesByChatId: Readonly<Record<string, readonly CockpitChatMessage[]>>;
  readonly terminalLogsByChatId: Readonly<Record<string, readonly string[]>>;
  readonly activeRunningAgentChatId: string | null;
  readonly sequentialAgentQueue: readonly string[];
}

export interface Zone4InspectorState {
  readonly activeInspectorTab: InspectorTab;
  readonly syncedChatId: string;
  readonly activeDocumentId: string;
  readonly activeValidationState: HiloValidationState;
  readonly previewUrl: string;
  readonly lastSyncDurationMs: number;
  readonly hasUnsavedChanges: boolean;
  readonly recoveredFromWal: boolean;
}

interface CreatePanelOptions {
  /** Tab that receives the session. Defaults to the active one. */
  readonly groupId?: string;
  /** Existing panel to split. Without it the new panel goes where there is the most room. */
  readonly from?: string;
  readonly direction?: SplitDirection;
  readonly position?: SplitPosition;
  readonly title?: string;
  /**
   * Opens the panel to the right of the active one, so panels follow the order of the tabs.
   * When that leaves no room it is placed wherever it fits.
   */
  readonly nextToActive?: boolean;
}

export type CreateChatOptions = CreatePanelOptions &
  (
    | {
        readonly kind?: "agent";
        readonly modelName?: string;
        readonly agentId?: string;
        readonly agentName?: string;
      }
    | {
        readonly kind: "terminal";
        readonly modelName?: never;
        readonly agentId?: never;
        readonly agentName?: never;
      }
  );

export interface CockpitStoreBundle extends WorkspaceNavigationActions {
  renameChat(id: string, title: string): void;
  /**
   * Creates a session and places it in the layout of a tab. Returns its id, or null when the
   * tab does not exist or the panel would drop below the minimum size in the measured area.
   */
  createChat(options?: CreateChatOptions): string | null;
  /**
   * Shows a session alone in its tab, or, when it already is, goes back to the tiled panels.
   * While one is maximized the header tabs switch which one is shown.
   */
  toggleMaximizeChat(chatId: string): void;
  /** Same check as `createChat`, without creating anything. */
  canCreateChat(options?: CreateChatOptions): boolean;
  /** Size in pixels of the area holding the panels; unknown (null) means no size limit. */
  setPanelArea(area: AreaSize | null): void;
  getPanelArea(): AreaSize | null;
  readonly zone1: AtomicStore<Zone1ActivityState>;
  readonly zone2: AtomicStore<Zone2SidebarState>;
  readonly zone3: AtomicStore<Zone3MultiChatState>;
  readonly zone4: AtomicStore<Zone4InspectorState>;
  setActivitySection(section: ActivityBarSection): void;
  handleActivityBarShortcut(key: string, metaOrCtrlKey: boolean): boolean;
  setPersona(persona: CockpitPersonaMode, duringActiveTask?: boolean): void;
  toggleSidebar(open?: boolean): void;
  toggleInspector(open?: boolean): void;
  setUiZoomPercent(zoomPercent: number): void;
  setInspectorTab(tab: InspectorTab): void;
  selectChat(chatId: string): number;
  closeChat(chatId: string): void;
  setFileTree(fileTree: readonly CockpitFileTreeNode[]): void;
  selectFileFromTree(filePath: string, contentOverride?: string): number;
  getDocumentContent(filePath: string): string | undefined;
  updateInMemoryDocumentContent(
    filePath: string,
    content: string,
    hasUnsavedChanges?: boolean,
  ): void;
  markDocumentSaved(filePath: string): void;
  /** True while the in-memory buffer of `filePath` differs from what was last saved. */
  isDocumentUnsaved(filePath: string): boolean;
  /** Every document of the open project whose buffer holds edits that are not on disk. */
  getUnsavedDocumentIds(): string[];
  /** Forgets the in-memory buffer so the next open reads the file from disk again. */
  discardDocumentBuffer(filePath: string): void;
  runGlobalSearch(query: string): readonly CockpitSearchResultItem[];
  setGlobalSearchResults(query: string, results: readonly CockpitSearchResultItem[]): void;
  setAstAnalysis(
    symbols: readonly CockpitAstSymbolItem[],
    impactedTests: readonly CockpitImpactedTestItem[],
  ): void;
  refreshAstAndImpactedTests(filePath: string, content: string): void;
  startAgentTaskOnChat(chatId: string): "Running" | "QueuedSequential";
  completeAgentTaskOnChat(chatId: string): void;
  /** Sets the sidebar/header/grid badge for an agent chat: a pending permission, done, or errored. */
  setChatStatusBadge(
    chatId: string,
    badge: "running" | "waiting" | "done" | "error" | undefined,
  ): void;
  /** Clears an agent chat's status badge, e.g. once the user opens/focuses it. */
  clearChatStatusBadge(chatId: string): void;
  /** Mirrors `TerminalPane.isRunning()` onto the shared session so chrome can show it. */
  setTerminalRunning(chatId: string, running: boolean): void;
  /** Mirrors a terminal's `TerminalAgentStatus` (a recognized agent CLI typed into its shell). */
  setTerminalAgentStatus(chatId: string, agentId: string | null, busy: boolean): void;
}

export interface CockpitStoreOptions {
  initialNavigation?: WorkspaceNavigationState | undefined;
  initialPersona?: CockpitPersonaMode | undefined;
  initialInspectorTab?: InspectorTab | undefined;
  initialActiveSection?: ActivityBarSection | undefined;
  initialActiveChatId?: string | undefined;
  initialActiveDocumentId?: string | undefined;
  initialChats?: readonly CockpitChatTab[] | undefined;
  initialFileTree?: readonly CockpitFileTreeNode[] | undefined;
  initialUiZoomPercent?: number | undefined;
  initialRecoveredFromWal?: boolean | undefined;
}
