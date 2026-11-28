import { AgentPanel } from "../../agent/panel.js";
import type { AgentHost, AgentState } from "../../agent/store.js";
import { type LayoutNode, panel, panelIds, reconcileLayout } from "../../layout/layout-tree.js";
import { SPINNER_ICON } from "../../settings/agent-marks.js";
import type { AgentRegistryHost, InstalledAgent } from "../../settings/agent-registry.js";
import { MORE_ICON, PLUS_ICON } from "../../sidebar/icons.js";
import { SidebarMenu, type SidebarMenuAction } from "../../sidebar/sidebar-menu.js";
import { sessionDisplayTitle } from "../../sidebar/sidebar-row.js";
import {
  type CockpitChatMessage,
  type CockpitChatTab,
  type CockpitStoreBundle,
  HILO_DESIGN_TOKENS,
  resolveGroupLayout,
  resolveGroupMaximized,
} from "../../stores/index.js";
import { type AgentBadgeInputs, nextAgentBadge } from "../../stores/session-status.js";
import { SETTINGS_ICON } from "../../theme/icons.js";
import { ChatComposer, type NativeChatHost } from "../../ui/chat-composer.js";
import { reconcile } from "../../ui/dom-utils.js";
import { IncrementalMarkdownCache, renderChatMessage } from "../../ui/stream-renderer.js";
import { UI_STRINGS, uiText } from "../../ui/ui-strings.js";
import { VirtualChatMessageListRenderer } from "../../ui/virtualizer.js";
import {
  type TerminalHost,
  TerminalPane,
  type TerminalViewFactory,
} from "../terminal/terminal-pane.js";
import { type HeaderTabSpec, HeaderTabs } from "./header-tabs.js";
import {
  type LayoutHandleHost,
  applySizes,
  createSeparator,
  layoutShape,
} from "./layout-handles.js";
import { NewPanelMenu } from "./new-panel-menu.js";
import { PanelDrag } from "./panel-drag.js";
import { MAXIMIZE_ICON, SPLIT_DOWN_ICON, SPLIT_RIGHT_ICON } from "./panel-icons.js";
import {
  type PanelShortcutAction,
  panelShortcutAction,
  settingsShortcutLabel,
  shortcutLabel,
} from "./panel-shortcuts.js";
import { sessionIcon, sessionStatusDot } from "./session-presentation.js";

/** The part of an agent panel's state its sidebar/tab badge follows. */
function badgeInputs(state: AgentState): AgentBadgeInputs {
  return {
    busy: state.busy,
    pendingPermissions: state.permissions.length,
    error: state.error,
  };
}

/** The icon of a session's header tab: the terminal glyph, the Codex mark, or its state glyph. */
function tabIcon(chat: CockpitChatTab, stateGlyph: string): { svg: string } | { text: string } {
  const icon = sessionIcon(chat);
  if (icon) return { svg: icon };
  return { text: stateGlyph };
}

/** What shells need: the host that starts them and the emulator that draws them. */
export interface ChatGridTerminals {
  readonly host: TerminalHost;
  readonly createView: TerminalViewFactory;
}

/** An entry of a panel's menu; `id` when a keyboard shortcut also runs it. */
type PanelMenuAction = SidebarMenuAction & { readonly id?: PanelShortcutAction };

interface ChatCellNodes {
  readonly el: HTMLElement;
  readonly header: HTMLElement;
  readonly title: HTMLElement;
  /** The mark of the agent (Codex) before the title, and the text after it. */
  readonly titleIcon: HTMLElement;
  readonly titleStatusDot: HTMLElement;
  readonly titleText: HTMLElement;
  readonly splitRight: HTMLButtonElement;
  readonly splitDown: HTMLButtonElement;
  readonly maximize: HTMLButtonElement;
  /** The three-dots button of the panel's menu (reload, sign-in, settings, close). */
  readonly more: HTMLButtonElement;
  readonly messages: HTMLElement;
  readonly logs: HTMLElement;
  readonly kind: "agent" | "terminal";
}

/**
 * Zone 3: a header tab per session of the active group, and the panels of that group arranged
 * by its layout tree (any number of panels). Tabs and cells are keyed (by group and chat id) and updated in
 * place, so token streaming does not rebuild anything. The split containers are only rebuilt
 * when the shape of the layout changes; a resize just updates the sizes.
 */
export class ChatGrid {
  readonly element: HTMLElement;
  private readonly grid: HTMLElement;
  private settingsOpen = false;
  private settingsActive = false;
  private readonly tabs: HeaderTabs;
  private readonly cells = new Map<string, ChatCellNodes>();
  private readonly empty: HTMLElement;
  private readonly addButton: HTMLButtonElement;
  private readonly emptyAdd: HTMLButtonElement;
  private readonly emptyOpenProject: HTMLButtonElement;
  private readonly emptyText: HTMLElement;
  private layoutRoot: HTMLElement | null = null;
  private layoutShape = "";
  /** The layout on screen and the group it belongs to (what a drag starts from and saves into). */
  private shownLayout: LayoutNode | null = null;
  private shownGroupId: string | null = null;
  /** The session shown alone in the active tab, if any. */
  private maximizedId: string | null = null;
  /** Scroll of every panel, kept while a rebuild or a maximize takes it out of the page. */
  private readonly savedScrolls = new Map<string, number>();
  /** What the enabled/disabled state of the creation buttons was computed for. */
  private actionsKey = "";
  private readonly resizeObserver: ResizeObserver | null;
  private readonly messageRenderer = new VirtualChatMessageListRenderer();
  /** One pane per terminal session, alive for as long as the session exists (any group). */
  private readonly panes = new Map<string, TerminalPane>();
  private readonly agentPanes = new Map<string, AgentPanel>();
  private readonly nativePanes = new Map<
    string,
    {
      wrapper: HTMLElement;
      composer: ChatComposer;
      status: HTMLElement;
      requestId: string | undefined;
    }
  >();
  private readonly newPanelMenu: NewPanelMenu;
  private readonly restoredChats: Set<string>;
  private readonly stopOpenRequests: (() => void) | undefined;
  private readonly stopPanelShortcuts: () => void;
  private focusedTerminalId: string | null = null;
  /** Moves a panel by its header. */
  private readonly panelDrag: PanelDrag;
  /** What the resize bars read from, and where they save. */
  private readonly handleHost: LayoutHandleHost;

  constructor(
    doc: Document,
    private readonly stores: CockpitStoreBundle,
    header: HTMLElement,
    private readonly terminals: ChatGridTerminals | null = null,
    private readonly agents: {
      host: AgentHost;
      openLocation: (path: string, line: number) => Promise<void>;
    } | null = null,
    private readonly settings?: { select(): void; close(): void; selectWorkspace(): void },
    registry?: AgentRegistryHost,
    /** Opens the project picker; the empty state offers it when no project is open. */
    private readonly openProject?: () => void,
    private readonly nativeChat?: NativeChatHost,
  ) {
    this.restoredChats = new Set(
      stores.zone3
        .getState()
        .chats.filter((chat) => chat.kind === "agent" && chat.agentId)
        .map((chat) => chat.chatId),
    );
    this.newPanelMenu = new NewPanelMenu(doc, registry);
    this.stopOpenRequests = registry?.onOpenRequested?.((agent) => this.openAgent(agent));
    const onPanelShortcut = (event: KeyboardEvent) => this.runPanelShortcut(event);
    doc.addEventListener("keydown", onPanelShortcut);
    this.stopPanelShortcuts = () => doc.removeEventListener("keydown", onPanelShortcut);
    this.element = doc.createElement("main");
    this.element.className =
      "hilo-zone-3-multichat bg-main border-t border-b border-l border-divider flex flex-col h-full";
    this.element.setAttribute("aria-label", UI_STRINGS.shell.chatGrid);
    this.element.style.minWidth = "0";
    this.element.style.overflow = "hidden";

    this.grid = doc.createElement("section");
    this.grid.className = "hilo-zone-3-grid flex-1 overflow-hidden";
    this.grid.style.display = "flex";
    this.element.append(this.grid);

    const save = (layout: LayoutNode | null) => {
      if (layout && this.shownGroupId) this.stores.setWorkGroupLayout(this.shownGroupId, layout);
    };
    this.handleHost = {
      grid: this.grid,
      layoutRoot: () => this.layoutRoot,
      shownLayout: () => this.shownLayout,
      save,
    };
    this.panelDrag = new PanelDrag({
      grid: this.grid,
      cell: (chatId) => this.cells.get(chatId)?.el,
      shownLayout: () => this.shownLayout,
      maximized: () => this.maximizedId !== null,
      save,
    });

    this.empty = doc.createElement("div");
    this.empty.className = "hilo-group-empty";
    const emptyText = doc.createElement("p");
    emptyText.textContent = UI_STRINGS.chat.emptyGroup;
    this.emptyText = emptyText;
    this.emptyAdd = this.createAddButton(
      doc,
      "hilo-group-empty-add",
      UI_STRINGS.chat.newSession,
      () => this.stores.createChat(this.terminals ? { kind: "terminal" } : undefined),
    );
    this.emptyOpenProject = this.createAddButton(
      doc,
      "hilo-group-empty-add",
      UI_STRINGS.sidebar.openProject,
      () => this.openProject?.(),
    );
    this.emptyOpenProject.title = UI_STRINGS.sidebar.openProjectHint;
    this.empty.append(emptyText, this.emptyAdd, this.emptyOpenProject);
    this.updateEmptyState();

    this.addButton = this.createAddButton(doc, "hilo-header-tab-add", "", () =>
      this.newPanelMenu.toggle(this.addButton, {
        ...(this.terminals
          ? {
              openTerminal: () => this.stores.createChat({ kind: "terminal", nextToActive: true }),
            }
          : {}),
        ...(this.nativeChat
          ? {
              openLocalChat: () =>
                this.stores.createChat({
                  kind: "agent",
                  native: true,
                  title: UI_STRINGS.chat.localChat,
                  modelName: UI_STRINGS.chat.localChat,
                  nextToActive: true,
                }),
            }
          : {}),
        openAgentInterface: (agent) => this.openAgent(agent),
        installAgents: () => this.settings?.select(),
      }),
    );
    this.addButton.setAttribute("aria-label", UI_STRINGS.chat.newMenu);
    this.addButton.setAttribute("aria-haspopup", "menu");
    this.addButton.setAttribute("aria-expanded", "false");
    this.addButton.innerHTML = PLUS_ICON;
    this.tabs = new HeaderTabs(doc, header, {
      ariaLabel: UI_STRINGS.shell.openSessions,
      dataKey: "chatId",
      closeLabel: (label) =>
        label === "Settings" ? UI_STRINGS.settings.close : UI_STRINGS.chat.closePanel,
      unsavedLabel: UI_STRINGS.editor.unsaved,
      onSelect: (chatId) => {
        if (chatId === "hilo:settings") this.settings?.select();
        else {
          this.settings?.selectWorkspace();
          this.stores.selectChat(chatId);
        }
      },
      onClose: (chatId) => {
        if (chatId === "hilo:settings") this.settings?.close();
        else this.closePanel(chatId);
      },
      trailing: [this.addButton],
    });

    // The panel area drives how many panels fit; it is unknown (no limit) without layout.
    this.resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            this.reportArea();
            this.updateActions();
          });
    this.resizeObserver?.observe(this.grid);
  }

  private createAddButton(
    doc: Document,
    className: string,
    label: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = className;
    if (label) btn.textContent = label;
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      onClick();
    });
    return btn;
  }

  /** With no project open, sessions cannot start: the empty group offers to open one instead. */
  private updateEmptyState(): void {
    // Only a host that can open a project offers it (otherwise sessions work without one).
    const noProject =
      this.openProject !== undefined && this.stores.navigation.getState().projectPath === "";
    this.emptyAdd.hidden = noProject;
    this.emptyOpenProject.hidden = !noProject;
    this.emptyText.textContent = noProject ? UI_STRINGS.chat.noProject : UI_STRINGS.chat.emptyGroup;
  }

  private reportArea(): void {
    this.stores.setPanelArea({ widthPx: this.grid.clientWidth, heightPx: this.grid.clientHeight });
  }

  /** Enables the buttons that create or close panels depending on room and running agents. */
  private updateActions(force = false): void {
    const z3 = this.stores.zone3.getState();
    const { navigation } = this.stores;
    const nav = navigation.getState();
    const area = this.stores.getPanelArea();
    const key = `${nav.activeGroupId}|${this.layoutShape}|${z3.chats.length}|${area?.widthPx}x${area?.heightPx}|${z3.activeRunningAgentChatId}|${z3.sequentialAgentQueue.join(",")}|${this.maximizedId}`;
    if (!force && key === this.actionsKey) return;
    this.actionsKey = key;
    const noRoom = UI_STRINGS.chat.noRoom;
    const panelCount = panelIds(this.shownLayout).length;
    const canAny = this.stores.canCreateChat();
    for (const btn of [this.addButton, this.emptyAdd]) {
      btn.disabled = !canAny;
      btn.title = canAny ? UI_STRINGS.chat.newSession : noRoom;
    }
    for (const [chatId, cell] of this.cells) {
      const right = this.stores.canCreateChat({ from: chatId, direction: "row" });
      const down = this.stores.canCreateChat({ from: chatId, direction: "column" });
      cell.splitRight.disabled = !right;
      cell.splitRight.title = right ? UI_STRINGS.chat.splitRight : noRoom;
      cell.splitDown.disabled = !down;
      cell.splitDown.title = down ? UI_STRINGS.chat.splitDown : noRoom;
      // Showing one panel alone only makes sense when there are others.
      const alone = this.maximizedId === chatId;
      cell.maximize.hidden = panelCount <= 1;
      cell.maximize.innerHTML = MAXIMIZE_ICON;
      const label = alone ? UI_STRINGS.chat.restorePanels : UI_STRINGS.chat.maximizePanel;
      cell.maximize.setAttribute("aria-label", label);
      cell.maximize.title = label;
      cell.maximize.setAttribute("aria-pressed", String(alone));
    }
  }

  setSettingsTab(open: boolean, active: boolean): void {
    this.settingsOpen = open;
    this.settingsActive = active;
    this.updateTabs();
  }

  update(): void {
    this.updateTabs();
    this.updateGrid();
    this.updateActions();
  }

  async flushTranscripts(): Promise<void> {
    await Promise.all(Array.from(this.agentPanes.values(), (pane) => pane.flushTranscript()));
  }

  destroy(): void {
    this.panelDrag.cancel();
    this.resizeObserver?.disconnect();
    this.newPanelMenu.destroy();
    this.stopOpenRequests?.();
    this.stopPanelShortcuts();
    for (const pane of this.panes.values()) pane.destroy();
    this.panes.clear();
    for (const pane of this.agentPanes.values()) pane.destroy();
    this.agentPanes.clear();
    for (const id of this.nativePanes.keys()) this.removeNativePane(id);
    this.tabs.destroy();
  }

  /** One header tab per session of the active group; selecting one focuses its panel. */
  private updateTabs(): void {
    const z3 = this.stores.zone3.getState();
    const navigation = this.stores.navigation.getState();
    const activeGroup = navigation.groups.find((group) => group.id === navigation.activeGroupId);
    const chatsById = new Map(z3.chats.map((chat) => [chat.chatId, chat]));
    for (const id of this.nativePanes.keys()) {
      if (!chatsById.has(id)) this.removeNativePane(id);
    }
    for (const id of this.restoredChats) {
      if (chatsById.has(id)) continue;
      this.restoredChats.delete(id);
      if (!this.agentPanes.has(id))
        void this.agents?.host.transcripts?.remove(id).catch(() => undefined);
    }
    for (const [id, pane] of this.agentPanes) {
      if (!chatsById.has(id)) {
        // The session was closed: its saved conversation goes with it.
        pane.discard();
        pane.destroy();
        this.agentPanes.delete(id);
      }
    }
    const chats = (activeGroup?.chatIds ?? [])
      .flatMap((id) => chatsById.get(id) ?? [])
      .filter((chat) => chat.kind === "terminal" || !chat.panelHidden);
    const specs = chats.map((chat): HeaderTabSpec => {
      const token = HILO_DESIGN_TOKENS[chat.validationState];
      return {
        key: chat.chatId,
        label: sessionDisplayTitle(chat.title),
        title: chat.kind === "terminal" ? chat.title : `${chat.title} · ${chat.modelName}`,
        icon: tabIcon(chat, token.icon),
        statusDot: sessionStatusDot(chat),
        selected: !this.settingsActive && chat.chatId === z3.activeChatId,
        closable: this.canCloseSession(chat.chatId),
        data: { validationState: chat.validationState },
      };
    });
    if (this.settingsOpen)
      specs.push({
        key: "hilo:settings",
        label: "Settings",
        icon: { svg: SETTINGS_ICON },
        selected: this.settingsActive,
        data: { view: "settings" },
      });
    this.tabs.update(specs);
  }

  /**
   * The entries of a panel's menu. An agent panel can be reloaded and signed out (or in again);
   * every panel can open Settings and be closed, except the last one or one whose agent runs.
   */
  private panelActions(chatId: string): PanelMenuAction[] {
    const text = UI_STRINGS.chat;
    const doc = this.element.ownerDocument;
    const keyed = (id: PanelShortcutAction, entry: SidebarMenuAction): PanelMenuAction => {
      const hint = shortcutLabel(doc, id);
      return { ...entry, id, ...(hint ? { hint } : {}) };
    };
    const actions: PanelMenuAction[] = [];
    const pane = this.agentPanes.get(chatId);
    if (pane) {
      actions.push(keyed("reload", { label: text.reloadAgent, run: () => pane.reload() }));
      if (pane.canSignOut())
        actions.push(
          keyed("reauthenticate", { label: text.reauthenticate, run: () => pane.reauthenticate() }),
          keyed("logOut", { label: text.logOut, run: () => pane.logOut() }),
        );
    }
    if (this.settings) {
      const settings = this.settings;
      actions.push({
        label: UI_STRINGS.settings.title,
        run: () => settings.select(),
        hint: settingsShortcutLabel(doc),
        separatorBefore: actions.length > 0,
      });
    }
    const closable = this.canCloseSession(chatId);
    actions.push(
      keyed("close", {
        label: text.closePanel,
        run: () => this.closePanel(chatId),
        disabled: !closable,
        ...(closable ? {} : { reason: text.cannotClose }),
        separatorBefore: actions.length > 0,
      }),
    );
    return actions;
  }

  /** A panel shortcut acts on the active panel, as its menu entry would. */
  private runPanelShortcut(event: KeyboardEvent): void {
    const id = panelShortcutAction(this.element.ownerDocument, event);
    const chatId = this.stores.zone3.getState().activeChatId;
    if (!id || !chatId) return;
    const entry = this.panelActions(chatId).find((action) => action.id === id);
    if (!entry || entry.disabled) return;
    event.preventDefault();
    entry.run();
  }

  private closePanel(chatId: string): void {
    const chat = this.stores.zone3.getState().chats.find((item) => item.chatId === chatId);
    if (chat?.kind === "agent" && chat.agentId) this.stores.hideChatPanel(chatId);
    else this.stores.closeChat(chatId);
  }

  /** A session with a running or queued agent cannot be closed. */
  private canCloseSession(chatId: string): boolean {
    const z3 = this.stores.zone3.getState();
    return !(z3.activeRunningAgentChatId === chatId || z3.sequentialAgentQueue.includes(chatId));
  }

  private updateGrid(): void {
    const z3 = this.stores.zone3.getState();
    const navigation = this.stores.navigation.getState();
    const activeGroup = navigation.groups.find((group) => group.id === navigation.activeGroupId);
    const chatsById = new Map(
      z3.chats
        .filter((chat) => chat.kind === "terminal" || !chat.panelHidden)
        .map((chat) => [chat.chatId, chat]),
    );
    let layout = activeGroup ? resolveGroupLayout(activeGroup) : null;
    // A group can still list a chat that no longer exists.
    if (layout && panelIds(layout).some((id) => !chatsById.has(id))) {
      layout = reconcileLayout(
        layout,
        panelIds(layout).filter((id) => chatsById.has(id)),
      );
    }

    // A shell ends with its session, wherever the session was shown.
    for (const [id, pane] of this.panes) {
      if (!chatsById.has(id)) {
        pane.destroy();
        this.panes.delete(id);
      }
    }
    this.shownLayout = layout;
    this.shownGroupId = activeGroup?.id ?? null;
    const maximized = activeGroup ? resolveGroupMaximized(activeGroup) : null;
    this.maximizedId = maximized && chatsById.has(maximized) ? maximized : null;
    const shownIds = new Set(panelIds(layout));
    for (const id of this.cells.keys()) if (!shownIds.has(id)) this.cells.delete(id);
    if (!layout) {
      this.layoutRoot = null;
      this.layoutShape = "";
      this.updateEmptyState();
      reconcile(this.grid, [this.empty]);
      return;
    }
    for (const id of shownIds) {
      const chat = chatsById.get(id);
      if (chat) this.updateCell(chat, z3.activeChatId === id);
    }

    // A session shown alone is the whole layout; the other panels stay out of the page (their
    // cells are kept, so they come back as they were) and need no separators.
    const displayed = this.maximizedId ? panel(this.maximizedId) : layout;
    const shape = layoutShape(displayed);
    if (this.layoutRoot?.isConnected && shape === this.layoutShape) {
      applySizes(displayed, this.layoutRoot, true);
      this.startVisibleTerminals(z3.activeChatId);
      return;
    }
    // Moving a cell in the DOM resets its scroll position: put it back after the rebuild. The
    // ones out of the page keep what they had before they left.
    for (const [id, cell] of this.cells) {
      if (cell.el.isConnected) this.savedScrolls.set(id, cell.messages.scrollTop);
    }
    this.layoutRoot = this.buildLayout(displayed, true, []);
    this.layoutShape = shape;
    reconcile(this.grid, [this.layoutRoot]);
    for (const [id, cell] of this.cells) {
      if (cell.el.isConnected) cell.messages.scrollTop = this.savedScrolls.get(id) ?? 0;
    }
    this.startVisibleTerminals(z3.activeChatId);
  }

  /** Starts the shells that are on screen and gives the keyboard to a newly selected one. */
  private startVisibleTerminals(activeChatId: string): void {
    for (const [id, pane] of this.panes) {
      if (!pane.element.isConnected) continue;
      void pane.ensureStarted().then(() => {
        if (this.focusedTerminalId !== activeChatId && id === activeChatId) {
          this.focusedTerminalId = activeChatId;
          pane.focus();
        }
      });
    }
    if (!this.panes.has(activeChatId)) this.focusedTerminalId = null;
  }

  /** `path` is the child indices from the root to `node`; separators remember it. */
  private buildLayout(node: LayoutNode, isRoot: boolean, path: readonly number[]): HTMLElement {
    let el: HTMLElement;
    if (node.kind === "panel") {
      el = (this.cells.get(node.id) as ChatCellNodes).el;
    } else {
      el = this.grid.ownerDocument.createElement("div");
      el.className = "hilo-layout-split";
      el.dataset.direction = node.direction;
      el.append(
        ...node.children.map((child, index) => this.buildLayout(child, false, [...path, index])),
      );
      // After the children, so `children[i]` stays the i-th child; they are positioned by sizes.
      for (let boundary = 0; boundary < node.children.length - 1; boundary += 1) {
        el.append(createSeparator(this.handleHost, node.direction, path, boundary));
      }
    }
    el.classList.toggle("hilo-layout-root", isRoot);
    applySizes(node, el, isRoot);
    return el;
  }

  private updateCell(chat: CockpitChatTab, active: boolean): HTMLElement {
    const z3 = this.stores.zone3.getState();
    let cell = this.cells.get(chat.chatId);
    if (!cell) {
      cell = this.createCell(chat.chatId, chat.kind === "terminal" ? "terminal" : "agent");
      this.cells.set(chat.chatId, cell);
    }
    if (chat.kind === "terminal") {
      let pane = this.panes.get(chat.chatId);
      if (!pane && this.terminals) {
        pane = new TerminalPane(
          this.grid.ownerDocument,
          this.terminals.host,
          this.terminals.createView,
          (running) => this.stores.setTerminalRunning(chat.chatId, running),
          (status) => this.stores.setTerminalAgentStatus(chat.chatId, status.agentId, status.busy),
        );
        this.panes.set(chat.chatId, pane);
      }
      if (pane && pane.element.parentElement !== cell.el) cell.el.append(pane.element);
      cell.el.dataset.kind = "terminal";
      cell.el.dataset.active = String(active);
      cell.el.setAttribute("aria-label", chat.title);
      if (cell.titleText.textContent !== chat.title) cell.titleText.textContent = chat.title;
      return cell.el;
    }
    const token = HILO_DESIGN_TOKENS[chat.validationState];
    if (this.agents && chat.agentId) {
      let pane = this.agentPanes.get(chat.chatId);
      if (!pane) {
        const cwd = chat.cwd ?? this.stores.navigation.getState().projectPath;
        pane = new AgentPanel(
          this.grid.ownerDocument,
          this.agents.host,
          this.agents.openLocation,
          { agentId: chat.agentId, name: chat.agentName ?? chat.title },
          !this.restoredChats.has(chat.chatId),
          undefined,
          {
            chatId: chat.chatId,
            restore: this.restoredChats.has(chat.chatId),
            ...(cwd ? { cwd } : {}),
          },
          (query) => this.mentionPaths(cwd, query),
        );
        this.agentPanes.set(chat.chatId, pane);
        pane.store.subscribe((state, prevState) => {
          const tab = this.stores.zone3.getState().chats.find((c) => c.chatId === chat.chatId);
          const current = tab?.kind === "agent" ? tab.statusBadge : undefined;
          const badge = nextAgentBadge(badgeInputs(prevState), badgeInputs(state), current);
          if (badge !== current) this.stores.setChatStatusBadge(chat.chatId, badge);
        });
      }
      if (pane.element.parentElement !== cell.el) cell.el.append(pane.element);
      cell.messages.hidden = true;
      cell.logs.hidden = true;
    }
    cell.el.dataset.validationState = chat.validationState;
    cell.el.dataset.active = String(active);
    cell.el.setAttribute("aria-label", uiText.chatCell(chat.title, token.labelEn));
    // Exact 2px Hilo state border from DESIGN_SYSTEM.md §2
    const isLight = cell.el.ownerDocument.documentElement.dataset.theme === "light";
    cell.el.style.border = `2px solid ${isLight ? token.lightBorder : token.darkBorder}`;
    cell.el.style.backgroundColor = isLight ? token.lightBg : token.darkBg;
    cell.el.style.color = isLight ? token.lightText : token.darkText;
    const headerText = uiText.chatCellHeader(token.icon, chat.title, chat.modelName, token.labelEn);
    // The title is just the session's name ("New session #8"); the model and the validation
    // state stay available as its tooltip.
    const plainTitle = sessionDisplayTitle(chat.title);
    if (cell.titleText.textContent !== plainTitle) cell.titleText.textContent = plainTitle;
    cell.titleText.title = headerText;
    const mark = sessionIcon(chat) ?? "";
    if (cell.titleIcon.innerHTML !== mark) cell.titleIcon.innerHTML = mark;
    cell.titleIcon.hidden = mark === "";
    const statusDot = sessionStatusDot(chat);
    cell.titleStatusDot.hidden = !statusDot;
    if (statusDot) {
      cell.titleStatusDot.dataset.status = statusDot;
      cell.titleStatusDot.innerHTML = statusDot === "running" ? SPINNER_ICON : "";
    } else {
      delete cell.titleStatusDot.dataset.status;
      cell.titleStatusDot.innerHTML = "";
    }
    const messages = z3.messagesByChatId[chat.chatId] ?? [];
    if (!chat.agentId && this.nativeChat) {
      const pane = this.nativePanes.get(chat.chatId) ?? this.createNativePane(chat.chatId);
      if (pane.wrapper.parentElement !== cell.el) cell.el.append(pane.wrapper);
      if (cell.messages.parentElement !== pane.wrapper) pane.wrapper.prepend(cell.messages);
      this.renderNativeMessages(cell.messages, messages);
      this.updateNativeComposer(chat.chatId);
    } else {
      this.messageRenderer.renderInto(cell.messages, messages, 0, 400);
    }
    const logs = z3.terminalLogsByChatId[chat.chatId] ?? [];
    cell.logs.dataset.logCount = String(logs.length);
    cell.logs.textContent = logs.slice(-5).join("\n");
    return cell.el;
  }

  private readonly renderedNativeMessages = new WeakMap<
    HTMLElement,
    readonly CockpitChatMessage[]
  >();

  private renderNativeMessages(
    container: HTMLElement,
    messages: readonly CockpitChatMessage[],
  ): void {
    if (this.renderedNativeMessages.get(container) === messages) return;
    this.renderedNativeMessages.set(container, messages);
    container.classList.add("hilo-agent-output");
    container.setAttribute("role", "log");
    container.setAttribute("aria-live", "polite");
    container.replaceChildren(
      ...messages.map((message) => {
        const article = container.ownerDocument.createElement("article");
        renderChatMessage(article, message.role, message.content, message.renderedHtmlBlocks);
        return article;
      }),
    );
    container.scrollTop = container.scrollHeight;
  }

  private createNativePane(chatId: string) {
    const doc = this.grid.ownerDocument;
    const wrapper = doc.createElement("div");
    wrapper.className = "hilo-agent-panel hilo-native-chat-composer";
    const status = doc.createElement("p");
    status.className = "hilo-agent-status";
    status.setAttribute("role", "status");
    status.hidden = true;
    const composer = new ChatComposer(
      doc,
      (text) => void this.sendNativePrompt(chatId, text),
      () => this.cancelNativePrompt(chatId),
      (query) => this.mentionPaths(this.stores.navigation.getState().projectPath, query),
    );
    wrapper.append(status, composer.element);
    const pane = { wrapper, status, composer, requestId: undefined };
    this.nativePanes.set(chatId, pane);
    return pane;
  }

  private updateNativeComposer(chatId: string): void {
    const pane = this.nativePanes.get(chatId);
    if (!pane) return;
    pane.composer.update({
      started: Boolean(this.stores.zone3.getState().messagesByChatId[chatId]?.length),
      busy: Boolean(pane.requestId),
      canCancel: Boolean(pane.requestId),
      pendingLabel: "",
    });
  }

  private async sendNativePrompt(chatId: string, text: string): Promise<void> {
    const pane = this.nativePanes.get(chatId);
    const host = this.nativeChat;
    if (!host || !pane || pane.requestId) return;
    const requestId = crypto.randomUUID();
    pane.requestId = requestId;
    pane.status.hidden = true;
    this.appendNativeMessage(chatId, "user", text);
    pane.composer.clearSent(text);
    this.updateNativeComposer(chatId);
    const history = (this.stores.zone3.getState().messagesByChatId[chatId] ?? [])
      .filter(
        (item): item is typeof item & { role: "user" | "assistant" } => item.role !== "system",
      )
      .slice(-12)
      .map(({ role, content }, index, items) => ({
        role,
        content: index === items.length - 1 ? content : content.slice(-4000),
      }));
    try {
      const reply = await host.send(requestId, history);
      if (pane.requestId === requestId && reply)
        this.appendNativeMessage(chatId, "assistant", reply);
    } catch (error) {
      if (pane.requestId === requestId) {
        pane.status.textContent = String(error);
        pane.status.hidden = false;
      }
    } finally {
      if (pane.requestId === requestId) {
        pane.requestId = undefined;
        this.updateNativeComposer(chatId);
      }
    }
  }

  private appendNativeMessage(chatId: string, role: "user" | "assistant", content: string): void {
    const message = {
      chatId,
      messageId: crypto.randomUUID(),
      role,
      content,
      streaming: false,
      renderedHtmlBlocks: new IncrementalMarkdownCache().update(content),
    };
    this.stores.zone3.setState((state) => ({
      ...state,
      messagesByChatId: {
        ...state.messagesByChatId,
        [chatId]: [...(state.messagesByChatId[chatId] ?? []), message],
      },
    }));
  }

  private cancelNativePrompt(chatId: string): void {
    const pane = this.nativePanes.get(chatId);
    if (!pane?.requestId) return;
    const requestId = pane.requestId;
    pane.requestId = undefined;
    this.updateNativeComposer(chatId);
    void this.nativeChat?.cancel(requestId).catch(() => undefined);
  }

  private removeNativePane(chatId: string): void {
    this.cancelNativePrompt(chatId);
    this.nativePanes.get(chatId)?.composer.destroy();
    this.nativePanes.delete(chatId);
  }

  private mentionPaths(cwd: string, query: string): readonly string[] {
    if (cwd !== this.stores.navigation.getState().projectPath) return [];
    const needle = query.toLowerCase();
    const matches: string[] = [];
    for (const file of this.stores.zone2.getState().fileTree) {
      if (!file.isDirectory && file.path.toLowerCase().includes(needle)) {
        matches.push(file.path);
        if (matches.length === 12) break;
      }
    }
    return matches;
  }

  private openAgent(agent: InstalledAgent): void {
    this.settings?.selectWorkspace();
    this.stores.createChat({
      kind: "agent",
      agentId: agent.agentId,
      agentName: agent.name,
      title: agent.name,
      modelName: agent.name,
      nextToActive: true,
    });
  }

  private createCell(chatId: string, kind: "agent" | "terminal"): ChatCellNodes {
    const doc = this.grid.ownerDocument;
    const el = doc.createElement("section");
    el.className = "hilo-chat-cell";
    el.dataset.chatId = chatId;
    // Working inside a panel (clicking its body, or focusing its terminal) selects it, so the
    // header tab and the active panel follow where the user is.
    const selectFromInside = () => {
      if (this.stores.zone3.getState().activeChatId !== chatId) this.stores.selectChat(chatId);
    };
    el.addEventListener("pointerdown", selectFromInside);
    el.addEventListener("focusin", selectFromInside);
    const header = doc.createElement("div");
    header.className = "hilo-chat-cell-header";
    header.title = UI_STRINGS.chat.movePanel;
    header.addEventListener("click", () => this.stores.selectChat(chatId));
    header.addEventListener("pointerdown", (event) => this.panelDrag.begin(chatId, header, event));
    header.addEventListener("pointermove", (event) => this.panelDrag.move(event));
    header.addEventListener("pointerup", (event) => this.panelDrag.end(event));
    header.addEventListener("pointercancel", () => this.panelDrag.cancel());
    const title = doc.createElement("span");
    title.className = "hilo-chat-cell-title";
    const titleIconWrap = doc.createElement("span");
    titleIconWrap.className = "hilo-chat-cell-title-icon-wrap";
    const titleIcon = doc.createElement("span");
    titleIcon.className = "hilo-chat-cell-title-icon";
    titleIcon.setAttribute("aria-hidden", "true");
    titleIcon.hidden = true;
    const titleStatusDot = doc.createElement("span");
    titleStatusDot.className = "hilo-chat-cell-status-dot";
    titleStatusDot.setAttribute("aria-hidden", "true");
    titleStatusDot.hidden = true;
    titleIconWrap.append(titleIcon, titleStatusDot);
    const titleText = doc.createElement("span");
    title.append(titleIconWrap, titleText);
    const actions = doc.createElement("div");
    actions.className = "hilo-chat-cell-actions";
    const action = (className: string, icon: string, label: string, run: () => void) => {
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = `hilo-chat-cell-action ${className}`;
      btn.innerHTML = icon;
      btn.setAttribute("aria-label", label);
      btn.title = label;
      // The header selects the chat on click: acting on a panel must not also do that.
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!btn.disabled) run();
      });
      return btn;
    };
    const splitRight = action(
      "hilo-split-right",
      SPLIT_RIGHT_ICON,
      UI_STRINGS.chat.splitRight,
      () =>
        this.stores.createChat({
          from: chatId,
          direction: "row",
          ...(kind === "terminal" ? { kind } : {}),
        }),
    );
    const splitDown = action("hilo-split-down", SPLIT_DOWN_ICON, UI_STRINGS.chat.splitDown, () =>
      this.stores.createChat({
        from: chatId,
        direction: "column",
        ...(kind === "terminal" ? { kind } : {}),
      }),
    );
    const maximize = action(
      "hilo-maximize-panel",
      MAXIMIZE_ICON,
      UI_STRINGS.chat.maximizePanel,
      () => this.stores.toggleMaximizeChat(chatId),
    );
    // Double click on the title shows the panel alone, like the maximize button.
    header.addEventListener("dblclick", (event) => {
      if ((event.target as HTMLElement).closest("button")) return;
      this.stores.toggleMaximizeChat(chatId);
    });
    // The panel's menu: closing it, and for an agent reloading and signing in again.
    const menu = new SidebarMenu(el);
    const more = action("hilo-panel-menu", MORE_ICON, UI_STRINGS.chat.panelMenu, () =>
      menu.open(more, this.panelActions(chatId)),
    );
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-expanded", "false");
    actions.append(splitRight, splitDown, maximize, more);
    header.append(title, actions);
    const messages = doc.createElement("div");
    messages.className = "hilo-chat-cell-messages";
    const logs = doc.createElement("div");
    logs.className = "hilo-chat-cell-logs";
    // A shell shows its pane instead of messages and logs.
    if (kind === "terminal") {
      messages.hidden = true;
      logs.hidden = true;
    }
    el.append(header, messages, logs);
    return {
      el,
      header,
      title,
      titleIcon,
      titleStatusDot,
      titleText,
      splitRight,
      splitDown,
      maximize,
      more,
      messages,
      logs,
      kind,
    };
  }
}
