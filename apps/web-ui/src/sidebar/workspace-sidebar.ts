import { type PromptInput, createPromptInput } from "@hilo/editor-cm6";
import { NewPanelMenu } from "../cockpit/panels/new-panel-menu.js";
import { sessionIcon, sessionStatusDot } from "../cockpit/panels/session-presentation.js";
import type { AgentRegistryHost } from "../settings/agent-registry.js";
import { type WorkGroup, listProjects } from "../state/workspace-navigation.js";
import type {
  CockpitChatTab,
  CockpitFileTreeNode,
  CockpitStoreBundle,
  CreateChatOptions,
} from "../stores/index.js";
import { attribute, button, reconcile, visibility } from "../ui/dom-utils.js";
import { Toast } from "../ui/toast.js";
import { UI_STRINGS } from "../ui/ui-strings.js";
import { FILTER_ICON, FOLDER_ICON, GROUP_ICON, SEARCH_ICON, WORKSPACE_MORE_ICON } from "./icons.js";
import {
  MENU_CALENDAR_ICON,
  MENU_CHEVRONS_DOWN_ICON,
  MENU_CHEVRONS_UP_ICON,
  MENU_CHEVRON_DOWN_ICON,
  MENU_CHEVRON_UP_ICON,
  MENU_CLOCK_ICON,
  MENU_CLOSE_ICON,
  MENU_CLOSE_MANY_ICON,
  MENU_COPY_ICON,
  MENU_FILTER_ICON,
  MENU_FOLDER_ICON,
  MENU_FOLDER_MINUS_ICON,
  MENU_MAXIMIZE_ICON,
  MENU_RENAME_ICON,
  MENU_RESTORE_ICON,
  MENU_SORT_ICON,
  MENU_STATUS_ICON,
  MENU_TRASH_ICON,
} from "./menu-icons.js";
import { type MenuEntry, SidebarMenu } from "./sidebar-menu.js";
import { SidebarRow } from "./sidebar-row.js";

type SessionFilter = "workspace" | "status" | "updated";

interface GroupNodes {
  readonly el: HTMLElement;
  readonly row: SidebarRow;
  readonly sessions: HTMLElement;
  readonly chats: Map<string, SidebarRow>;
}

interface ProjectNodes {
  readonly el: HTMLElement;
  readonly folder: SidebarRow;
  readonly tree: HTMLElement;
  readonly groups: Map<string, GroupNodes>;
}

export interface WorkspaceSidebarOptions {
  readonly controlsHost: HTMLElement;
  readonly treeHost: HTMLElement;
  readonly stores: CockpitStoreBundle;
  readonly openWorkspace?: () => Promise<readonly CockpitFileTreeNode[] | null>;
  /**
   * Makes another already-listed project the active one (host root, file tree).
   * Without it the sidebar only switches the navigation state.
   */
  readonly switchWorkspace?: (path: string) => Promise<readonly CockpitFileTreeNode[] | null>;
  /**
   * Ends the agents and terminals still running for a project (they survive switching to
   * another one), once the user removes it.
   */
  readonly closeWorkspaceSessions?: (path: string) => Promise<void>;
  /** What the "+" of a group opens: a terminal panel, or an agent session (the default). */
  readonly newSessionKind?: "terminal" | "agent";
  readonly agentRegistryHost?: AgentRegistryHost;
  readonly openSettings?: () => void;
}

/** Owns sidebar navigation DOM and subscriptions, independent of the editor and streaming. */
export class WorkspaceSidebar {
  private readonly projects = new Map<string, ProjectNodes>();
  private readonly projectsEl: HTMLElement;
  private readonly workspaceLabel: HTMLElement;
  private readonly searchToggleButton: HTMLButtonElement;
  private readonly filterButton: HTMLButtonElement;
  private readonly moreButton: HTMLButtonElement;
  private readonly searchField: HTMLElement;
  private readonly searchPrompt: PromptInput;
  private readonly openProjectButton: HTMLButtonElement;
  private readonly error: HTMLElement;
  private readonly menu: SidebarMenu;
  private readonly headerMenu: SidebarMenu;
  private readonly newPanelMenu: NewPanelMenu;
  private readonly notice: Toast;
  private readonly unsubscribers: Array<() => void> = [];
  private opening = false;
  private switching = false;
  private destroyed = false;
  private searchQuery = "";
  private readonly sessionFilters = new Map<SessionFilter, Set<string>>();
  private sessionSort: "updated" | "created" = "created";

  constructor(private readonly options: WorkspaceSidebarOptions) {
    const { controlsHost, treeHost, stores } = options;
    const doc = treeHost.ownerDocument;
    controlsHost.className = "sidebar-project-controls";
    treeHost.className = "sidebar-navigation";
    treeHost.setAttribute("aria-label", UI_STRINGS.sidebar.navigation);
    this.menu = new SidebarMenu(treeHost);
    this.headerMenu = new SidebarMenu(controlsHost.parentElement ?? controlsHost);
    this.newPanelMenu = new NewPanelMenu(treeHost.ownerDocument, options.agentRegistryHost);
    this.notice = new Toast(doc);
    this.workspaceLabel = doc.createElement("div");
    this.workspaceLabel.className = "sidebar-section-label";
    this.workspaceLabel.textContent = UI_STRINGS.sidebar.workspaceLabel;

    this.searchToggleButton = button(
      doc,
      "sidebar-icon-button",
      UI_STRINGS.sidebar.searchWorkspaces,
    );
    this.searchToggleButton.innerHTML = SEARCH_ICON;
    this.searchToggleButton.title = UI_STRINGS.sidebar.searchWorkspaces;
    this.searchToggleButton.setAttribute("aria-expanded", "false");
    this.searchToggleButton.addEventListener("click", () => this.toggleSearch());

    this.filterButton = button(doc, "sidebar-icon-button", UI_STRINGS.sidebar.workspaceProperties);
    this.filterButton.innerHTML = FILTER_ICON;
    this.filterButton.title = UI_STRINGS.sidebar.workspaceProperties;
    this.filterButton.addEventListener("click", () => this.openPropertiesMenu());

    this.moreButton = button(doc, "sidebar-icon-button", UI_STRINGS.sidebar.moreWorkspaceActions);
    this.moreButton.innerHTML = WORKSPACE_MORE_ICON;
    this.moreButton.title = UI_STRINGS.sidebar.moreWorkspaceActions;
    this.moreButton.addEventListener("click", () => {
      const projectPath = stores.navigation.getState().projectPath;
      this.headerMenu.open(this.moreButton, [
        {
          label: UI_STRINGS.sidebar.newGroup,
          icon: MENU_FOLDER_ICON,
          run: () => this.addGroup(projectPath),
        },
        {
          label: UI_STRINGS.sidebar.openProjectMenu,
          icon: MENU_FOLDER_ICON,
          disabled: !options.openWorkspace || this.opening,
          run: () => {
            void this.openProject();
          },
        },
      ]);
    });

    const sectionHeader = doc.createElement("div");
    sectionHeader.className = "sidebar-section-header";
    const sectionActions = doc.createElement("div");
    sectionActions.className = "sidebar-section-actions";
    sectionActions.append(this.searchToggleButton, this.filterButton, this.moreButton);
    sectionHeader.append(this.workspaceLabel, sectionActions);

    const searchField = doc.createElement("div");
    searchField.className = "sidebar-search";
    searchField.hidden = true;
    this.searchPrompt = createPromptInput(searchField, {
      placeholder: UI_STRINGS.sidebar.searchWorkspacesPlaceholder,
      ariaLabel: UI_STRINGS.sidebar.searchWorkspaces,
      maxLength: 200,
      maxHeight: 24,
      onSubmit: () => {},
      onChange: (text) => {
        this.searchQuery = text;
        this.update();
      },
      onEscape: () => this.toggleSearch(false),
    });
    this.searchField = searchField;

    this.openProjectButton = button(
      doc,
      "sidebar-row sidebar-open-project sidebar-open-project-label",
      UI_STRINGS.sidebar.openProject,
    );
    this.openProjectButton.innerHTML = `<span class="sidebar-open-project-icon" aria-hidden="true">${FOLDER_ICON}</span><span>${UI_STRINGS.sidebar.openProject}</span>`;
    this.openProjectButton.disabled = !options.openWorkspace;
    this.openProjectButton.title = UI_STRINGS.sidebar.openProjectHint;
    this.openProjectButton.addEventListener("click", () => {
      void this.openProject();
    });
    this.error = doc.createElement("p");
    this.error.className = "sidebar-error";
    this.error.setAttribute("role", "alert");
    this.error.hidden = true;
    controlsHost.append(this.openProjectButton, this.error, sectionHeader, searchField);

    this.projectsEl = doc.createElement("div");
    this.projectsEl.className = "sidebar-projects";
    treeHost.append(this.projectsEl);
    this.update();
    this.unsubscribers.push(
      stores.navigation.subscribe(() => this.update()),
      stores.zone3.subscribe((next, prev) => {
        if (next.activeChatId !== prev.activeChatId || next.chats !== prev.chats) this.update();
      }),
    );
    // Relative date filters age without any store change.
    const view = doc.defaultView;
    const timer = view?.setInterval(() => {
      if (this.sessionFilters.has("updated")) this.update();
    }, 60_000);
    if (timer !== undefined) this.unsubscribers.push(() => view?.clearInterval(timer));
  }

  /** A session can be closed unless an agent is running in it or waiting its turn. */
  private canClose(chatId: string): boolean {
    const state = this.options.stores.zone3.getState();
    return (
      state.activeRunningAgentChatId !== chatId && !state.sequentialAgentQueue.includes(chatId)
    );
  }

  /** Closes sessions one by one. */
  private closeSessions(chatIds: readonly string[]): void {
    for (const id of chatIds) this.options.stores.closeChat(id);
  }

  /** A new session (or terminal) in a group, next to `from` when given. */
  private addSession(projectPath: string, groupId: string, options: CreateChatOptions = {}): void {
    const { stores } = this.options;
    this.withProject(projectPath, () => {
      const created = stores.createChat({
        ...options,
        groupId,
      });
      if (created === null) {
        this.notice.show(UI_STRINGS.sidebar.noRoom);
        return;
      }
      this.notice.hide();
      this.error.hidden = true;
      stores.setWorkGroupExpanded(groupId, true);
    });
  }

  private copyPath(path: string): void {
    const doc = this.options.treeHost.ownerDocument;
    void doc.defaultView?.navigator.clipboard?.writeText(path).catch(() => {
      // The clipboard can be refused (no permission or focus): there is nothing to recover.
    });
  }

  private expandAll(expanded: boolean): void {
    this.options.stores.setAllWorkGroupsExpanded(expanded);
  }

  /** Shows or hides the search input; closing it without `force` clears an active query. */
  private toggleSearch(force?: boolean): void {
    const next = force ?? this.searchField.hidden;
    this.searchField.hidden = !next;
    attribute(this.searchToggleButton, "aria-expanded", String(next));
    if (next) {
      this.searchPrompt.focus();
    } else if (this.searchQuery) {
      // `setText` fires `onChange`, which clears `searchQuery` and re-renders.
      this.searchPrompt.setText("");
    }
  }

  private showError(error: unknown, fallback: string): void {
    if (this.destroyed) return;
    this.error.textContent = error instanceof Error ? error.message : fallback;
    this.error.hidden = false;
  }

  /** Switches the active project, then runs `run` against it. Runs synchronously when already active. */
  private withProject(path: string, run: () => void): void {
    const { stores } = this.options;
    if (stores.navigation.getState().projectPath === path) {
      run();
      return;
    }
    void this.switchTo(path).then((switched) => {
      if (switched && !this.destroyed) run();
    });
  }

  private async switchTo(path: string): Promise<boolean> {
    const { stores, switchWorkspace } = this.options;
    if (this.switching || this.destroyed) return false;
    this.switching = true;
    this.error.hidden = true;
    try {
      if (switchWorkspace) {
        const nodes = await switchWorkspace(path);
        if (!nodes) return false;
        if (!this.destroyed) stores.setFileTree(nodes);
        // The host callback normally activates the project; make sure navigation agrees.
        stores.setProjectPath(path);
      } else {
        stores.setProjectPath(path);
      }
      return true;
    } catch (error: unknown) {
      this.showError(error, UI_STRINGS.sidebar.switchFailed);
      return false;
    } finally {
      this.switching = false;
    }
  }

  private async removeProject(path: string): Promise<void> {
    const { stores } = this.options;
    const navigation = stores.navigation.getState();
    if (navigation.projectPath === path) {
      const next = listProjects(navigation).find((entry) => entry.path !== path);
      if (next && !(await this.switchTo(next.path))) return;
    }
    try {
      await this.options.closeWorkspaceSessions?.(path);
    } catch (error: unknown) {
      this.showError(error, UI_STRINGS.sidebar.switchFailed);
    }
    if (!this.destroyed) stores.removeProject(path);
  }

  /** Asks the host for a project folder (the same as the "Open project" button). */
  async openProject(): Promise<void> {
    if (!this.options.openWorkspace || this.opening || this.destroyed) return;
    this.opening = true;
    this.openProjectButton.disabled = true;
    this.openProjectButton.setAttribute("aria-busy", "true");
    this.openProjectButton.title = UI_STRINGS.sidebar.opening;
    this.error.hidden = true;
    try {
      const nodes = await this.options.openWorkspace();
      if (!this.destroyed && nodes) this.options.stores.setFileTree(nodes);
    } catch (error: unknown) {
      if (!this.destroyed) {
        this.error.textContent =
          error instanceof Error ? error.message : UI_STRINGS.sidebar.openFailed;
        this.error.hidden = false;
      }
    } finally {
      this.opening = false;
      if (!this.destroyed) {
        this.openProjectButton.disabled = false;
        this.openProjectButton.setAttribute("aria-busy", "false");
        this.openProjectButton.title = UI_STRINGS.sidebar.openProjectHint;
      }
    }
  }

  private createGroup(projectPath: string, group: WorkGroup): GroupNodes {
    const { treeHost, stores } = this.options;
    const doc = treeHost.ownerDocument;
    const el = doc.createElement("section");
    el.className = "sidebar-group";
    el.dataset.groupId = group.id;
    const sessions = doc.createElement("div");
    sessions.className = "sidebar-sessions";
    const row = new SidebarRow(doc, {
      kind: "group",
      icon: GROUP_ICON,
      onSelect: () => this.withProject(projectPath, () => stores.selectWorkGroup(group.id)),
      onAdd: (anchor) => {
        // With terminals available the "+" offers the same choices as the one of the panels.
        if (this.options.newSessionKind === "terminal") {
          this.newPanelMenu.toggle(anchor, {
            openTerminal: () => this.addSession(projectPath, group.id, { kind: "terminal" }),
            openAgentInterface: (agent) =>
              this.addSession(projectPath, group.id, {
                kind: "agent",
                agentId: agent.agentId,
                agentName: agent.name,
                title: agent.name,
                modelName: agent.name,
              }),
            installAgents: () => this.options.openSettings?.(),
          });
        } else this.addSession(projectPath, group.id);
      },
      onToggle: () =>
        this.withProject(projectPath, () => {
          const latest = stores.navigation.getState().groups.find((item) => item.id === group.id);
          if (latest) stores.setWorkGroupExpanded(group.id, !(latest.expanded ?? true));
        }),
      onMore: (anchor) => {
        const state = stores.navigation.getState();
        const entry = listProjects(state).find((item) => item.path === projectPath);
        const latest = entry?.groups.find((item) => item.id === group.id);
        if (!entry || !latest) return;
        const closable = latest.chatIds.filter((id) => this.canClose(id));
        this.menu.open(anchor, [
          {
            label: UI_STRINGS.sidebar.renameGroup,
            icon: MENU_RENAME_ICON,
            run: () =>
              this.withProject(projectPath, () =>
                row.rename(latest.title, (name) => stores.renameWorkGroup(group.id, name)),
              ),
          },
          {
            label: UI_STRINGS.sidebar.closeAllSessions,
            icon: MENU_CLOSE_MANY_ICON,
            separatorBefore: true,
            danger: true,
            disabled: closable.length === 0,
            ...(closable.length === 0 ? { reason: UI_STRINGS.sidebar.noSessionToClose } : {}),
            run: () => this.closeSessions(closable),
          },
          {
            label: UI_STRINGS.sidebar.deleteGroup,
            icon: MENU_TRASH_ICON,
            danger: true,
            disabled: latest.chatIds.length > 0 || entry.groups.length <= 1,
            reason:
              entry.groups.length <= 1
                ? UI_STRINGS.sidebar.deleteLastGroup
                : UI_STRINGS.sidebar.deleteGroupNeedsEmpty,
            run: () => this.withProject(projectPath, () => stores.removeWorkGroup(group.id)),
          },
        ]);
      },
    });
    row.select.dataset.groupId = group.id;
    row.toggle?.setAttribute("aria-controls", `sidebar-sessions-${group.id}`);
    sessions.id = `sidebar-sessions-${group.id}`;
    el.append(row.el, sessions);
    return { el, row, sessions, chats: new Map() };
  }

  /**
   * Adds a group to a project and leaves its name ready to type: the group is created with a
   * default name, selected, and its row goes straight into rename (Escape keeps the default).
   */
  private addGroup(projectPath: string): void {
    const { stores } = this.options;
    this.withProject(projectPath, () => {
      this.error.hidden = true;
      stores.setProjectExpanded(true, projectPath);
      const taken = new Set(stores.navigation.getState().groups.map((group) => group.title));
      const base = UI_STRINGS.sidebar.newGroup;
      let title: string = base;
      for (let n = 2; taken.has(title); n += 1) title = `${base} ${n}`;
      stores.createWorkGroup(title);
      // The navigation subscription has already rendered the new row.
      const id = stores.navigation.getState().activeGroupId;
      this.projects
        .get(projectPath)
        ?.groups.get(id)
        ?.row.rename(title, (name) => stores.renameWorkGroup(id, name));
    });
  }

  private createSession(projectPath: string, groupId: string, chat: CockpitChatTab): SidebarRow {
    const { stores, treeHost } = this.options;
    const row = new SidebarRow(treeHost.ownerDocument, {
      kind: "session",
      onSelect: () => {
        this.withProject(projectPath, () => stores.selectChat(chat.chatId));
      },
      onMore: (anchor) => {
        const state = stores.zone3.getState();
        const latest = state.chats.find((item) => item.chatId === chat.chatId);
        if (!latest) return;
        const group = stores.navigation.getState().groups.find((item) => item.id === groupId);
        const alone = group?.maximizedChatId === chat.chatId;
        const others = (group?.chatIds ?? []).filter(
          (id) => id !== chat.chatId && this.canClose(id),
        );
        this.menu.open(anchor, [
          {
            label: UI_STRINGS.sidebar.renameSession,
            icon: MENU_RENAME_ICON,
            run: () => row.rename(latest.title, (name) => stores.renameChat(chat.chatId, name)),
          },
          {
            label: UI_STRINGS.sidebar.duplicateSession,
            icon: MENU_COPY_ICON,
            run: () =>
              this.addSession(projectPath, groupId, {
                ...(latest.kind === "terminal" ? { kind: "terminal" } : {}),
                from: chat.chatId,
              }),
          },
          {
            label: alone ? UI_STRINGS.sidebar.restoreSession : UI_STRINGS.sidebar.maximizeSession,
            icon: alone ? MENU_RESTORE_ICON : MENU_MAXIMIZE_ICON,
            run: () => this.withProject(projectPath, () => stores.toggleMaximizeChat(chat.chatId)),
          },
          {
            label: UI_STRINGS.sidebar.closeSession,
            icon: MENU_CLOSE_ICON,
            separatorBefore: true,
            danger: true,
            disabled: !this.canClose(chat.chatId),
            ...(this.canClose(chat.chatId) ? {} : { reason: UI_STRINGS.sidebar.noSessionToClose }),
            run: () => stores.closeChat(chat.chatId),
          },
          {
            label: UI_STRINGS.sidebar.closeOtherSessions,
            icon: MENU_CLOSE_MANY_ICON,
            danger: true,
            disabled: others.length === 0,
            ...(others.length === 0 ? { reason: UI_STRINGS.sidebar.noSessionToClose } : {}),
            run: () => this.closeSessions(others),
          },
        ]);
      },
    });
    row.el.dataset.chatId = chat.chatId;
    row.el.dataset.groupId = groupId;
    row.select.dataset.chatId = chat.chatId;
    return row;
  }

  private createProject(path: string): ProjectNodes {
    const { treeHost, stores, openWorkspace } = this.options;
    const doc = treeHost.ownerDocument;
    const el = doc.createElement("section");
    el.className = "sidebar-project";
    el.dataset.projectPath = path;
    const tree = doc.createElement("div");
    tree.className = "sidebar-group-tree";
    const folder = new SidebarRow(doc, {
      kind: "folder",
      onAdd: () => this.addGroup(path),
      addLabel: { aria: UI_STRINGS.sidebar.newGroupIn, title: UI_STRINGS.sidebar.newGroup },
      onSelect: () => {
        const entry = listProjects(stores.navigation.getState()).find((item) => item.path === path);
        stores.setProjectExpanded(!(entry?.expanded ?? true), path);
      },
      onMore: (anchor) => {
        const entry = listProjects(stores.navigation.getState()).find((item) => item.path === path);
        const expanded = entry?.expanded ?? true;
        this.menu.open(anchor, [
          {
            label: expanded ? UI_STRINGS.sidebar.collapseProject : UI_STRINGS.sidebar.expandProject,
            icon: expanded ? MENU_CHEVRON_UP_ICON : MENU_CHEVRON_DOWN_ICON,
            run: () => stores.setProjectExpanded(!expanded, path),
          },
          {
            label: UI_STRINGS.sidebar.expandAll,
            icon: MENU_CHEVRONS_DOWN_ICON,
            run: () => this.withProject(path, () => this.expandAll(true)),
          },
          {
            label: UI_STRINGS.sidebar.collapseAll,
            icon: MENU_CHEVRONS_UP_ICON,
            run: () => this.withProject(path, () => this.expandAll(false)),
          },
          {
            label: UI_STRINGS.sidebar.copyPath,
            icon: MENU_COPY_ICON,
            separatorBefore: true,
            disabled: path === "",
            run: () => this.copyPath(path),
          },
          {
            label: UI_STRINGS.sidebar.openProjectMenu,
            icon: MENU_FOLDER_ICON,
            disabled: !openWorkspace || this.opening,
            run: () => {
              void this.openProject();
            },
          },
          {
            label: UI_STRINGS.sidebar.removeProject,
            icon: MENU_FOLDER_MINUS_ICON,
            separatorBefore: true,
            danger: true,
            disabled: path === "",
            run: () => {
              void this.removeProject(path);
            },
          },
        ]);
      },
    });
    el.append(folder.el, tree);
    return { el, folder, tree, groups: new Map() };
  }

  private filterOptions(): MenuEntry[] {
    const strings = UI_STRINGS.sidebar;
    const choices = (
      key: "workspace" | "status",
      label: string,
      options: readonly (readonly [string, string])[],
      icon: string,
    ): MenuEntry => ({
      label,
      icon,
      highlighted: this.sessionFilters.has(key),
      showTitle: true,
      ...(key === "workspace" ? { searchLabel: strings.searchWorkspaces } : {}),
      submenu: () =>
        options.map(([value, name]) => ({
          label: name,
          checkbox: true,
          checked: this.sessionFilters.get(key)?.has(value) ?? false,
          run: () => {
            const selected = this.sessionFilters.get(key) ?? new Set<string>();
            if (selected.has(value)) selected.delete(value);
            else selected.add(value);
            if (selected.size) this.sessionFilters.set(key, selected);
            else this.sessionFilters.delete(key);
            this.update();
            const count = this.sessionFilters.size;
            this.headerMenu.setEntryHighlight(label, selected.size > 0);
            this.headerMenu.setEntryHighlight(
              strings.filter,
              count > 0,
              count ? String(count) : "",
            );
            this.headerMenu.setResetVisible(count > 0 || this.sessionSort === "updated");
          },
        })),
    });
    const updatedOptions = [
      ["today", strings.filterToday],
      ["7", strings.filterLastWeek],
      ["14", strings.filterLastTwoWeeks],
      ["30", strings.filterLastMonth],
    ] as const;
    return [
      choices(
        "workspace",
        strings.filterWorkspace,
        listProjects(this.options.stores.navigation.getState())
          .filter(({ path }) => path !== "")
          .map(({ path }) => [path, path.split(/[\\/]/).filter(Boolean).pop() ?? path]),
        MENU_FOLDER_ICON,
      ),
      choices(
        "status",
        strings.filterStatus,
        [
          ["running", strings.filterRunning],
          ["inactive", strings.filterInactive],
        ],
        MENU_STATUS_ICON,
      ),
      {
        label: strings.filterUpdatedTime,
        icon: MENU_CALENDAR_ICON,
        highlighted: this.sessionFilters.has("updated"),
        showTitle: true,
        submenu: updatedOptions.map(([value, label]) => ({
          label,
          checked: this.sessionFilters.get("updated")?.has(value) ?? false,
          run: () => {
            if (this.sessionFilters.get("updated")?.has(value))
              this.sessionFilters.delete("updated");
            else this.sessionFilters.set("updated", new Set([value]));
            this.refreshProperties();
          },
        })),
      },
    ];
  }

  private openPropertiesMenu(): void {
    const updated = this.sessionSort === "updated";
    this.headerMenu.open(
      this.filterButton,
      [
        {
          label: UI_STRINGS.sidebar.sort,
          icon: MENU_SORT_ICON,
          highlighted: updated,
          value: updated ? UI_STRINGS.sidebar.sortUpdated : UI_STRINGS.sidebar.sortCreated,
          submenu: [
            {
              label: UI_STRINGS.sidebar.sortUpdated,
              icon: MENU_CLOCK_ICON,
              checked: updated,
              highlighted: updated,
              run: () => this.sortSessions("updated"),
            },
            {
              label: UI_STRINGS.sidebar.sortCreated,
              icon: MENU_CLOCK_ICON,
              checked: !updated,
              run: () => this.sortSessions("created"),
            },
          ],
        },
        {
          label: UI_STRINGS.sidebar.filter,
          icon: MENU_FILTER_ICON,
          highlighted: this.sessionFilters.size > 0,
          value: this.sessionFilters.size ? String(this.sessionFilters.size) : "",
          searchLabel: UI_STRINGS.sidebar.searchFilters,
          submenu: () => this.filterOptions(),
        },
      ],
      UI_STRINGS.sidebar.workspaceProperties,
      {
        reset: {
          label: UI_STRINGS.sidebar.resetProperties,
          hidden: !updated && this.sessionFilters.size === 0,
          run: () => {
            this.sessionFilters.clear();
            this.sortSessions("created");
          },
        },
      },
    );
  }

  private sortSessions(sort: "updated" | "created"): void {
    this.sessionSort = sort;
    this.refreshProperties();
  }

  private refreshProperties(): void {
    this.update();
    this.openPropertiesMenu();
  }

  private update(): void {
    const { stores } = this.options;
    const focused = this.options.treeHost.ownerDocument.activeElement as HTMLElement | null;
    const hadFocus = focused !== null && this.options.treeHost.contains(focused);
    const navigation = stores.navigation.getState();
    const chatState = stores.zone3.getState();
    const chats = new Map(chatState.chats.map((chat) => [chat.chatId, chat]));
    // With no project open there is nothing to list: `listProjects` still returns the empty
    // workspace so the navigation state has an active entry, but an empty one is not shown.
    const entries = listProjects(navigation).filter(
      (entry) => entry.path !== "" || entry.groups.some((group) => group.chatIds.length > 0),
    );
    const retainedProjects = new Set(entries.map((entry) => entry.path));
    for (const [path] of this.projects) {
      if (!retainedProjects.has(path)) {
        this.menu.close(false);
        this.projects.delete(path);
      }
    }
    const query = this.searchQuery.trim().toLowerCase();
    const now = Date.now();
    const workspaces = this.sessionFilters.get("workspace");
    const statuses = this.sessionFilters.get("status");
    const [updatedSince] = this.sessionFilters.get("updated") ?? [];
    const cutoff =
      updatedSince === "today"
        ? new Date(now).setHours(0, 0, 0, 0)
        : updatedSince
          ? now - Number(updatedSince) * 86_400_000
          : undefined;
    const filtering = this.sessionFilters.size > 0;
    const searching = query !== "" || filtering;
    const nextProjects: HTMLElement[] = [];
    for (const entry of entries) {
      let project = this.projects.get(entry.path);
      if (!project) {
        project = this.createProject(entry.path);
        this.projects.set(entry.path, project);
      }
      const name = entry.path.split(/[\\/]/).filter(Boolean).pop() ?? UI_STRINGS.sidebar.noProject;
      project.folder.update(name, false, entry.expanded ?? true);
      attribute(project.folder.select, "title", entry.path || name);
      attribute(project.el, "data-active", String(entry.active));
      const nextGroups: HTMLElement[] = [];
      const retained = new Set(entry.groups.map((group) => group.id));
      for (const [id] of project.groups) if (!retained.has(id)) project.groups.delete(id);
      let anyGroupVisible = false;
      for (const group of entry.groups) {
        let nodes = project.groups.get(group.id);
        if (!nodes) {
          nodes = this.createGroup(entry.path, group);
          project.groups.set(group.id, nodes);
        }
        const groupActive = entry.active && entry.activeGroupId === group.id;
        nodes.row.update(group.title, groupActive, group.expanded ?? true);
        const nextSessions: HTMLElement[] = [];
        const retainedSessions = new Set(group.chatIds);
        for (const [id] of nodes.chats)
          if (!retainedSessions.has(id) || !chats.has(id)) nodes.chats.delete(id);
        let anySessionMatches = false;
        // Groups append each new session to their stored order.
        const sortedIds = [...group.chatIds].reverse();
        if (this.sessionSort === "updated") {
          sortedIds.sort(
            (a, b) => (chats.get(b)?.lastActiveAt ?? 0) - (chats.get(a)?.lastActiveAt ?? 0),
          );
        }
        for (const id of sortedIds) {
          const chat = chats.get(id);
          if (!chat) continue;
          let row = nodes.chats.get(id);
          if (!row) {
            row = this.createSession(entry.path, group.id, chat);
            nodes.chats.set(id, row);
          }
          row.setIcon(sessionIcon(chat));
          row.setStatusDot(sessionStatusDot(chat));
          row.update(chat.title, groupActive && chatState.activeChatId === id);
          const running =
            sessionStatusDot(chat) === "running" ||
            (chat.kind === "terminal" &&
              chat.detectedAgentId === undefined &&
              chat.running === true);
          const sessionMatches =
            (query === "" || chat.title.toLowerCase().includes(query)) &&
            (!workspaces || workspaces.has(entry.path)) &&
            (!statuses || statuses.has(running ? "running" : "inactive")) &&
            (cutoff === undefined || (chat.lastActiveAt ?? 0) >= cutoff);
          if (sessionMatches) anySessionMatches = true;
          row.el.hidden = !sessionMatches;
          nextSessions.push(row.el);
        }
        reconcile(nodes.sessions, nextSessions);
        const groupTitleMatches = query === "" || group.title.toLowerCase().includes(query);
        const groupVisible = anySessionMatches || (!filtering && groupTitleMatches);
        nodes.el.hidden = searching && !groupVisible;
        visibility(nodes.sessions, searching ? groupVisible : (group.expanded ?? true));
        if (groupVisible) anyGroupVisible = true;
        nextGroups.push(nodes.el);
      }
      reconcile(project.tree, nextGroups);
      const projectNameMatches = query === "" || name.toLowerCase().includes(query);
      const projectVisible = anyGroupVisible || (!filtering && projectNameMatches);
      project.el.hidden = searching && !projectVisible;
      visibility(project.tree, searching ? projectVisible : (entry.expanded ?? true));
      nextProjects.push(project.el);
    }
    reconcile(this.projectsEl, nextProjects);
    this.menu.closeIfDetached();
    if (hadFocus && !focused?.isConnected) {
      const active = this.projects.get(navigation.projectPath);
      const group = active?.groups.get(navigation.activeGroupId);
      (
        group?.chats.get(chatState.activeChatId)?.select ??
        group?.row.select ??
        active?.folder.select
      )?.focus();
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.menu.close(false);
    this.headerMenu.close(false);
    this.searchPrompt.destroy();
    this.newPanelMenu.destroy();
    this.notice.destroy();
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.projects.clear();
  }
}
