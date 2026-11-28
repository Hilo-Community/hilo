// @vitest-environment happy-dom
import { promptInputOf } from "@hilo/editor-cm6";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCockpitStoreBundle } from "../stores/index.js";
import { FrameBatchedStreamRenderer } from "../ui/stream-renderer.js";
import { WorkspaceSidebar, type WorkspaceSidebarOptions } from "./workspace-sidebar.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  vi.useRealTimers();
});

function setup(
  openWorkspace?: () => Promise<readonly [] | null>,
  options: Pick<WorkspaceSidebarOptions, "newSessionKind" | "agentRegistryHost"> = {},
) {
  const stores = createCockpitStoreBundle({
    initialChats: [
      {
        kind: "agent" as const,
        chatId: "a",
        title: "Implementation",
        modelName: "Codex",
        validationState: "UnchangedBlue",
      },
      {
        kind: "agent" as const,
        chatId: "b",
        title: "Review",
        modelName: "Claude",
        validationState: "UnchangedBlue",
      },
    ],
  });
  stores.setProjectPath("/projects/Hilo");
  const root = document.createElement("aside");
  const controlsHost = document.createElement("div");
  const treeHost = document.createElement("div");
  root.append(controlsHost, treeHost);
  document.body.appendChild(root);
  const sidebar = new WorkspaceSidebar({
    stores,
    controlsHost,
    treeHost,
    ...options,
    ...(openWorkspace ? { openWorkspace } : {}),
  });
  cleanup.push(() => {
    sidebar.destroy();
    root.remove();
  });
  const get = (selector: string) => {
    const el = root.querySelector<HTMLButtonElement>(selector);
    if (!el) throw new Error(`Missing ${selector}`);
    return el;
  };
  return { root, stores, sidebar, get, treeHost };
}

/** The open menu's entry with this label. */
function menuItem(root: ParentNode, label: string): HTMLButtonElement {
  const item = Array.from(
    root.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]',
    ),
  ).find((entry) => entry.firstElementChild?.textContent === label);
  if (!item) throw new Error(`Missing menu entry: ${label}`);
  return item;
}

describe("Workspace sidebar", () => {
  it.each(["agent", "terminal"] as const)(
    "shows the panel limit as a temporary notification when adding a %s",
    (kind) => {
      vi.useFakeTimers();
      const { stores, root, get } = setup(undefined, { newSessionKind: kind });
      stores.setPanelArea({ widthPx: 440, heightPx: 270 });
      const add = get(".sidebar-row--group .sidebar-add");
      const attempt = () => {
        add.focus();
        add.click();
        if (kind === "terminal") {
          document.querySelector<HTMLButtonElement>(".hilo-new-panel-item")?.click();
        }
      };
      attempt();
      const notice = document.querySelector<HTMLElement>(".hilo-toast");
      expect(notice?.hidden).toBe(false);
      expect(notice?.textContent).toContain("No room for another panel");
      expect(notice?.getAttribute("role")).toBe("status");
      expect(root.contains(notice)).toBe(false);
      expect(root.querySelector<HTMLElement>(".sidebar-error")?.hidden).toBe(true);
      expect(stores.zone3.getState().chats).toHaveLength(2);
      expect(document.activeElement).toBe(add);

      vi.advanceTimersByTime(4000);
      attempt();
      expect(document.querySelectorAll(".hilo-toast")).toHaveLength(1);
      vi.advanceTimersByTime(4000);
      expect(notice?.hidden).toBe(false);
      vi.advanceTimersByTime(1000);
      expect(notice?.hidden).toBe(true);

      attempt();
      notice?.querySelector<HTMLButtonElement>("button")?.click();
      expect(notice?.hidden).toBe(true);
      expect(vi.getTimerCount()).toBe(1);
    },
  );

  it("removes its notification and timer when the sidebar is destroyed", () => {
    vi.useFakeTimers();
    const { stores, sidebar, get } = setup();
    stores.setPanelArea({ widthPx: 440, heightPx: 270 });
    get(".sidebar-row--group .sidebar-add").click();
    sidebar.destroy();
    expect(document.querySelector(".hilo-toast")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves row nodes and focus through selection, collapse, rename and adding another group", () => {
    const { stores, get } = setup();
    const session = get('button[data-chat-id="b"]');
    const toggle = get(".sidebar-group-toggle");
    session.focus();
    session.click();
    expect(document.activeElement).toBe(session);
    stores.renameChat("a", "New implementation title");
    stores.createWorkGroup("Other task");
    stores.selectWorkGroup("initial-group");
    expect(stores.zone3.getState().activeChatId).toBe("b");
    expect(get('button[data-chat-id="b"]')).toBe(session);
    expect(document.activeElement).toBe(session);
    toggle.focus();
    toggle.click();
    expect(get(".sidebar-group-toggle")).toBe(toggle);
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("makes no sidebar DOM mutations during token/log streaming or unrelated file-tree updates", () => {
    const { stores, treeHost } = setup();
    const observer = new MutationObserver(() => {});
    observer.observe(treeHost, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    const stream = new FrameBatchedStreamRenderer(stores.zone3, () => {});
    for (let i = 0; i < 30; i++) {
      stream.enqueueToken("a", "reply", "word ");
      stream.enqueueTerminalLog("a", "test log");
      stream.flushNow();
    }
    stores.setFileTree([]);
    expect(observer.takeRecords()).toHaveLength(0);
    observer.disconnect();
  });

  it("opens independent group menus without changing selection or expansion, and supports Escape", () => {
    const { stores, get } = setup();
    stores.createWorkGroup("Other task");
    const more = get(
      '.sidebar-group[data-group-id="initial-group"] .sidebar-row--group .sidebar-more',
    );
    more.click();
    expect(stores.navigation.getState().activeGroupId).not.toBe("initial-group");
    expect(stores.navigation.getState().groups[0]?.expanded).not.toBe(false);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    const first = get('[role="menuitem"]');
    expect(document.activeElement).toBe(first);
    expect(first.textContent).toBe("Rename group");
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect((document.activeElement as HTMLElement)?.textContent).toBe("Close all sessions");
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(more);
    expect(more.getAttribute("aria-expanded")).toBe("false");
  });

  it("renames a group through its menu, without rebuilding its row or header hierarchy", () => {
    const { stores, get, root } = setup();
    const row = get('button[data-group-id="initial-group"]');
    get(".sidebar-row--group .sidebar-more").click();
    menuItem(root, "Rename group").click();
    const input = root.querySelector<HTMLInputElement>('input[aria-label="Name"]');
    if (!input) throw new Error("Missing rename input");
    input.value = "Authentication";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(stores.navigation.getState().groups[0]?.title).toBe("Authentication");
    expect(get('button[data-group-id="initial-group"]')).toBe(row);
    expect(row.hidden).toBe(false);
    expect(document.activeElement).toBe(row);
  });

  it("session menus rename and close the intended session without selecting it", () => {
    const { stores, get, root } = setup();
    const session = get('.sidebar-row--session[data-chat-id="b"] .sidebar-more');
    session.click();
    expect(stores.zone3.getState().activeChatId).toBe("a");
    get('[role="menuitem"]').click();
    const input = root.querySelector<HTMLInputElement>("input");
    if (!input) throw new Error("Missing session rename input");
    input.value = "Security review";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(stores.zone3.getState().chats.find((chat) => chat.chatId === "b")?.title).toBe(
      "Security review",
    );
    session.click();
    const close = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
      (item) => item.textContent === "Close session",
    );
    close?.click();
    expect(stores.zone3.getState().chats.map((chat) => chat.chatId)).toEqual(["a"]);
    expect(stores.navigation.getState().groups[0]?.chatIds).toEqual(["a"]);
    expect(root.querySelector('[data-chat-id="b"]')).toBeNull();
  });

  it("toggles the folder from the row background and keeps the options action independent", () => {
    const { stores, get } = setup();
    const row = get(".sidebar-row--folder");
    row.click();
    expect(stores.navigation.getState().expanded).toBe(false);
    get(".sidebar-row--folder .sidebar-more").click();
    expect(stores.navigation.getState().expanded).toBe(false);
    expect(get('[role="menu"]')).toBeDefined();
  });

  it("folder options expand/collapse all without changing the active session", () => {
    const { stores, get, root } = setup();
    stores.createWorkGroup("Other task");
    get(".sidebar-row--folder .sidebar-more").click();
    Array.from(root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((item) => item.textContent === "Collapse all groups")
      ?.click();
    expect(stores.navigation.getState().groups.every((group) => group.expanded === false)).toBe(
      true,
    );
    expect(stores.zone3.getState().activeChatId).toBe("a");
    get(".sidebar-row--folder .sidebar-row-select").click();
    expect(stores.navigation.getState().expanded).toBe(false);
  });

  it("keeps the open-project button stable and prevents duplicate opens, preserves cancellation, reports errors", async () => {
    let resolve: (value: null) => void = () => {};
    const open = vi.fn(
      () =>
        new Promise<null>((done) => {
          resolve = done;
        }),
    );
    const { stores, get, root } = setup(open);
    const add = get('[aria-label="Open project"]');
    const initialTree = stores.zone2.getState().fileTree;
    add.click();
    add.click();
    expect(open).toHaveBeenCalledTimes(1);
    stores.renameWorkGroup("initial-group", "Renamed while opening");
    expect(get('[aria-label="Open project"]')).toBe(add);
    expect(add.disabled).toBe(true);
    resolve(null);
    await Promise.resolve();
    await Promise.resolve();
    expect(add.disabled).toBe(false);
    expect(stores.zone2.getState().fileTree).toBe(initialTree);
    open.mockRejectedValueOnce(new Error("Folder unavailable"));
    add.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(root.querySelector('[role="alert"]')?.textContent).toBe("Folder unavailable");
    expect(add.disabled).toBe(false);
  });

  it("restores focus to the remaining session when a focused session is closed", () => {
    const { stores, get } = setup();
    const second = get('button[data-chat-id="b"]');
    second.click();
    second.focus();
    stores.closeChat("b");
    expect(document.activeElement).toBe(get('button[data-chat-id="a"]'));
  });

  it("keeps folder and group expansion independent, and cancels rename with Escape", () => {
    const { stores, get, root } = setup();
    get(".sidebar-group-toggle").click();
    get(".sidebar-row--folder .sidebar-row-select").click();
    get(".sidebar-row--folder .sidebar-row-select").click();
    expect(stores.navigation.getState().groups[0]?.expanded).toBe(false);
    get(".sidebar-row--group .sidebar-more").click();
    menuItem(root, "Rename group").click();
    const input = root.querySelector<HTMLInputElement>("input");
    if (!input) throw new Error("Missing input");
    input.value = "Discard this";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(stores.navigation.getState().groups[0]?.title).toBe("Workspace");
  });

  it("unsubscribes and removes document listeners on destruction", () => {
    const { stores, sidebar, treeHost, get } = setup();
    get(".sidebar-row--group .sidebar-more").click();
    sidebar.destroy();
    expect(treeHost.querySelector('[role="menu"]')).toBeNull();
    const before = treeHost.innerHTML;
    stores.createWorkGroup("After destroy");
    expect(treeHost.innerHTML).toBe(before);
  });

  it("stacks every opened project and keeps each project's groups after opening another", () => {
    const { stores, root } = setup();
    stores.createWorkGroup("Authentication");
    stores.setProjectPath("/projects/Website");
    stores.createWorkGroup("Landing");
    const projects = Array.from(root.querySelectorAll<HTMLElement>(".sidebar-project"));
    expect(projects.map((project) => project.dataset.projectPath)).toEqual([
      "/projects/Hilo",
      "/projects/Website",
    ]);
    const titles = (project: HTMLElement) =>
      Array.from(project.querySelectorAll(".sidebar-row--group .sidebar-row-title")).map(
        (el) => el.textContent,
      );
    expect(titles(projects[0] as HTMLElement)).toEqual(["Workspace", "Authentication"]);
    expect(titles(projects[1] as HTMLElement)).toEqual(["Workspace", "Landing"]);
    expect(projects.map((project) => project.dataset.active)).toEqual(["false", "true"]);
  });

  it("switches project (through the host) when selecting a group of another project", async () => {
    const switchWorkspace = vi.fn(async () => [] as const);
    const stores = createCockpitStoreBundle();
    stores.setProjectPath("/projects/one");
    stores.setProjectPath("/projects/two");
    const root = document.createElement("aside");
    const controlsHost = document.createElement("div");
    const treeHost = document.createElement("div");
    root.append(controlsHost, treeHost);
    document.body.appendChild(root);
    const sidebar = new WorkspaceSidebar({ stores, controlsHost, treeHost, switchWorkspace });
    cleanup.push(() => {
      sidebar.destroy();
      root.remove();
    });
    root
      .querySelector<HTMLButtonElement>(
        '.sidebar-project[data-project-path="/projects/one"] .sidebar-row--group .sidebar-row-select',
      )
      ?.click();
    await vi.waitFor(() => expect(stores.navigation.getState().projectPath).toBe("/projects/one"));
    expect(switchWorkspace).toHaveBeenCalledWith("/projects/one");
  });

  it("collapses one project without touching the others and removes a project from the list", async () => {
    const { stores, root } = setup();
    stores.setProjectPath("/projects/Website");
    const folder = root.querySelector<HTMLButtonElement>(
      '.sidebar-project[data-project-path="/projects/Hilo"] .sidebar-row--folder .sidebar-row-select',
    );
    folder?.click();
    const [first, second] = Array.from(root.querySelectorAll<HTMLElement>(".sidebar-group-tree"));
    expect(first?.hidden).toBe(true);
    expect(second?.hidden).toBe(false);
    root
      .querySelector<HTMLButtonElement>(
        '.sidebar-project[data-project-path="/projects/Hilo"] .sidebar-row--folder .sidebar-more',
      )
      ?.click();
    const remove = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
      (item) => item.textContent === "Remove from list",
    );
    remove?.click();
    await vi.waitFor(() => expect(root.querySelectorAll(".sidebar-project")).toHaveLength(1));
    expect(stores.navigation.getState().projectPath).toBe("/projects/Website");
  });

  it("ends the sessions that kept running for a project when it is removed, after switching away", async () => {
    const calls: string[] = [];
    const switchWorkspace = vi.fn(async (path: string) => {
      calls.push(`switch:${path}`);
      return [] as const;
    });
    const closeWorkspaceSessions = vi.fn(async (path: string) => {
      calls.push(`close:${path}`);
    });
    const stores = createCockpitStoreBundle();
    stores.setProjectPath("/projects/one");
    stores.setProjectPath("/projects/two");
    const root = document.createElement("aside");
    const controlsHost = document.createElement("div");
    const treeHost = document.createElement("div");
    root.append(controlsHost, treeHost);
    document.body.appendChild(root);
    const sidebar = new WorkspaceSidebar({
      stores,
      controlsHost,
      treeHost,
      switchWorkspace,
      closeWorkspaceSessions,
    });
    cleanup.push(() => {
      sidebar.destroy();
      root.remove();
    });
    // "/projects/two" is the shown project: the host switches to another one first, so nothing
    // is closed under the feet of a project that is still on screen.
    root
      .querySelector<HTMLButtonElement>(
        '.sidebar-project[data-project-path="/projects/two"] .sidebar-row--folder .sidebar-more',
      )
      ?.click();
    Array.from(root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find((item) => item.textContent === "Remove from list")
      ?.click();
    await vi.waitFor(() => expect(root.querySelectorAll(".sidebar-project")).toHaveLength(1));
    expect(calls).toEqual(["switch:/projects/one", "close:/projects/two"]);
  });

  describe("new group in a project", () => {
    const groupTitles = (root: HTMLElement, project: string) =>
      Array.from(
        root.querySelectorAll<HTMLElement>(
          `.sidebar-project[data-project-path="${project}"] .sidebar-row--group .sidebar-row-title`,
        ),
      ).map((el) => el.textContent);
    const renameInput = (root: HTMLElement) =>
      root.querySelector<HTMLInputElement>(".sidebar-rename-input");

    it("has a + on the project row that creates a group, selects it and asks for its name", () => {
      const { stores, root, get } = setup();
      const add = get(".sidebar-row--folder .sidebar-add");
      expect(add.getAttribute("aria-label")).toBe("New group in Hilo");
      add.click();

      const groups = stores.navigation.getState().groups;
      expect(groups.map((group) => group.title)).toEqual(["Workspace", "New group"]);
      expect(stores.navigation.getState().activeGroupId).toBe(groups[1]?.id);
      // It is already being named: type and press Enter.
      const input = renameInput(root);
      expect(input?.value).toBe("New group");
      expect(document.activeElement).toBe(input);
      if (!input) throw new Error("Missing rename input");
      input.value = "Payments";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(groupTitles(root, "/projects/Hilo")).toEqual(["Workspace", "Payments"]);
      expect(stores.navigation.getState().groups[1]?.title).toBe("Payments");
    });

    it("keeps the default name when the naming is cancelled, and numbers repeated ones", () => {
      const { stores, root, get } = setup();
      get(".sidebar-row--folder .sidebar-add").click();
      renameInput(root)?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      get(".sidebar-row--folder .sidebar-add").click();
      expect(stores.navigation.getState().groups.map((group) => group.title)).toEqual([
        "Workspace",
        "New group",
        "New group 2",
      ]);
    });

    it("expands a collapsed project to show the new group, and is not in the options menu", () => {
      const { stores, root, get } = setup();
      get(".sidebar-row--folder .sidebar-row-select").click();
      expect(stores.navigation.getState().expanded).toBe(false);
      get(".sidebar-row--folder .sidebar-more").click();
      // Adding is done with the "+": the options menu does not repeat it.
      expect(
        Array.from(root.querySelectorAll('[role="menuitem"]')).some(
          (el) => el.textContent === "New group",
        ),
      ).toBe(false);
      get(".sidebar-row--folder .sidebar-more").click();
      get(".sidebar-row--folder .sidebar-add").click();
      expect(stores.navigation.getState().groups).toHaveLength(2);
      expect(stores.navigation.getState().expanded).toBe(true);
      expect(renameInput(root)).not.toBeNull();
    });

    it("creates the group in the project whose + was pressed, even if another is active", async () => {
      const { stores, root } = setup();
      stores.setProjectPath("/projects/Website");
      const hilo = root.querySelector<HTMLElement>(
        '.sidebar-project[data-project-path="/projects/Hilo"] .sidebar-row--folder .sidebar-add',
      );
      hilo?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(stores.navigation.getState().projectPath).toBe("/projects/Hilo");
      expect(groupTitles(root, "/projects/Hilo")).toEqual(["Workspace", "New group"]);
      expect(groupTitles(root, "/projects/Website")).toEqual(["Workspace"]);
    });
  });
});

describe("Zone 2 option menus", () => {
  const labels = (root: ParentNode) =>
    Array.from(root.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent);

  it("keeps Status open while toggling both options", () => {
    const { root, get } = setup();
    get('button[aria-label="Properties"]').click();
    menuItem(root, "Filter").click();
    menuItem(document, "Status").click();
    const statuses = document.querySelector('[role="menu"][aria-label="Status"]');
    if (!statuses) throw new Error("Missing status menu");
    const running = menuItem(statuses, "Running");
    const inactive = menuItem(statuses, "Inactive");
    expect(running.getAttribute("aria-checked")).toBe("false");
    expect(inactive.getAttribute("aria-checked")).toBe("false");

    running.click();
    inactive.click();
    expect(statuses.isConnected).toBe(true);
    expect(running.getAttribute("aria-checked")).toBe("true");
    expect(inactive.getAttribute("aria-checked")).toBe("true");
    expect(get(".sidebar-menu-reset").hidden).toBe(false);

    running.click();
    inactive.click();
    expect(statuses.isConnected).toBe(true);
    expect(get(".sidebar-menu-reset").hidden).toBe(true);
  });

  it("shows searchable workspace options", () => {
    const { root, get } = setup();
    get('button[aria-label="Properties"]').click();
    menuItem(root, "Filter").dispatchEvent(
      new PointerEvent("pointerenter", { pointerType: "mouse" }),
    );
    menuItem(document, "Workspace").dispatchEvent(
      new PointerEvent("pointerenter", { pointerType: "mouse" }),
    );
    const workspace = document.querySelector('[role="menu"][aria-label="Workspace"]');
    if (!workspace) throw new Error("Missing workspace menu");
    const search = promptInputOf(workspace.querySelector(".cm-editor"));
    if (!search) throw new Error("Missing workspace search");
    search.setText("missing");
    const hilo = menuItem(workspace, "Hilo");
    expect(hilo.hidden).toBe(true);
    search.setText("hilo");
    expect(hilo.hidden).toBe(false);
    hilo.click();
    expect(hilo.getAttribute("aria-checked")).toBe("true");
    expect(workspace.isConnected).toBe(true);
  });

  it("shows Sort first in Properties and opens its submenu on hover", () => {
    vi.useFakeTimers();
    const { root, get } = setup();
    get('button[aria-label="Properties"]').click();
    const sort = menuItem(root, "Sort");
    expect(root.querySelector('[role="menuitem"]:not([hidden])')).toBe(sort);
    sort.dispatchEvent(new MouseEvent("click", { detail: 1 }));
    expect(sort.getAttribute("aria-expanded")).toBe("false");

    const pointer = (target: HTMLElement, type: string) =>
      target.dispatchEvent(new PointerEvent(type, { pointerType: "mouse" }));
    pointer(sort, "pointerenter");
    expect(sort.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(sort);
    const submenu = menuItem(document, "Updated").parentElement as HTMLElement;
    pointer(sort, "pointerleave");
    pointer(submenu, "pointerenter");
    vi.advanceTimersByTime(250);
    expect(submenu.isConnected).toBe(true);
    pointer(submenu, "pointerleave");
    vi.advanceTimersByTime(250);
    expect(submenu.isConnected).toBe(false);
  });

  it("searches filter categories and applies or resets a session status filter", () => {
    const { root, get, stores } = setup();
    stores.setChatStatusBadge("a", "running");
    get('button[aria-label="Properties"]').click();
    menuItem(root, "Filter").dispatchEvent(
      new PointerEvent("pointerenter", { pointerType: "mouse" }),
    );
    const search = promptInputOf(document.querySelector(".sidebar-menu-search .cm-editor"));
    if (!search) throw new Error("Missing filter search");
    search.setText("sta");
    expect(menuItem(document, "Workspace").hidden).toBe(true);
    expect(menuItem(document, "Status").hidden).toBe(false);
    menuItem(document, "Status").click();
    const running = menuItem(document, "Running");
    running.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
    expect(running.isConnected).toBe(true);
    running.click();

    expect(menuItem(root, "Filter").querySelector(".sidebar-menu-value")?.textContent).toBe("1");
    expect(
      get('button[data-chat-id="a"]').closest<HTMLElement>(".sidebar-row--session")?.hidden,
    ).toBe(false);
    expect(
      get('button[data-chat-id="b"]').closest<HTMLElement>(".sidebar-row--session")?.hidden,
    ).toBe(true);
    get(".sidebar-menu-reset").click();
    expect(
      get('button[data-chat-id="b"]').closest<HTMLElement>(".sidebar-row--session")?.hidden,
    ).toBe(false);
  });

  it("opens Sort with the keyboard and orders sessions by activity or creation", () => {
    vi.useFakeTimers();
    const { root, get, stores } = setup();
    const filter = get('button[aria-label="Properties"]');
    const sessionIds = () =>
      Array.from(root.querySelectorAll<HTMLButtonElement>("button[data-chat-id]"), (button) =>
        button.getAttribute("data-chat-id"),
      );
    vi.advanceTimersByTime(1000);
    stores.setChatStatusBadge("a", "running");

    filter.click();
    const sort = menuItem(root, "Sort");
    expect(sort.querySelector(".sidebar-menu-value")?.textContent).toBe("Created");
    expect(root.querySelector(".sidebar-menu-reset:not([hidden])")).toBeNull();
    sort.focus();
    sort.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    const updated = menuItem(document, "Updated");
    expect(menuItem(document, "Created").getAttribute("aria-checked")).toBe("true");
    expect(menuItem(document, "Created").querySelector(".sidebar-menu-check svg")).not.toBeNull();
    expect(updated.getAttribute("aria-checked")).toBe("false");
    expect(document.activeElement).toBe(updated);
    updated.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(document.activeElement).toBe(sort);
    sort.click();
    menuItem(document, "Updated").click();
    expect(sessionIds()).toEqual(["a", "b"]);

    const sortUpdated = menuItem(root, "Sort");
    expect(document.activeElement).toBe(sortUpdated);
    expect(sortUpdated.classList.contains("sidebar-menu-item--highlighted")).toBe(true);
    expect(sortUpdated.querySelector(".sidebar-menu-value")?.textContent).toBe("Updated");
    sortUpdated.click();
    expect(menuItem(document, "Updated").getAttribute("aria-checked")).toBe("true");
    expect(menuItem(document, "Updated").classList.contains("sidebar-menu-item--highlighted")).toBe(
      true,
    );
    get(".sidebar-menu-reset").click();
    expect(root.querySelector(".sidebar-menu-reset:not([hidden])")).toBeNull();
    expect(menuItem(root, "Sort").classList.contains("sidebar-menu-item--highlighted")).toBe(false);
    expect(menuItem(root, "Sort").querySelector(".sidebar-menu-value")?.textContent).toBe(
      "Created",
    );
    expect(sessionIds()).toEqual(["b", "a"]);
    expect(stores.navigation.getState().groups[0]?.chatIds).toEqual(["a", "b"]);
  });

  it("offers every folder action, with the destructive one last and in red", () => {
    const { root, get } = setup();
    get(".sidebar-row--folder .sidebar-more").click();
    expect(labels(root)).toEqual([
      "Collapse project",
      "Expand all groups",
      "Collapse all groups",
      "Copy path",
      "Open project…",
      "Remove from list",
    ]);
    expect(root.querySelectorAll(".sidebar-menu-separator")).toHaveLength(2);
    expect(menuItem(root, "Remove from list").classList.contains("sidebar-menu-item--danger")).toBe(
      true,
    );
  });

  it("collapses and expands the project from its menu", () => {
    const { root, get, stores } = setup();
    get(".sidebar-row--folder .sidebar-more").click();
    menuItem(root, "Collapse project").click();
    expect(stores.navigation.getState().expanded).toBe(false);
    get(".sidebar-row--folder .sidebar-more").click();
    expect(labels(root)).toContain("Expand project");
  });

  it("copies the project path", async () => {
    const { root, get } = setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    get(".sidebar-row--folder .sidebar-more").click();
    menuItem(root, "Copy path").click();
    expect(writeText).toHaveBeenCalledWith("/projects/Hilo");
  });

  it("offers every group action; the group with sessions cannot be deleted", () => {
    const { root, get, stores } = setup();
    stores.createWorkGroup("Other task");
    get('.sidebar-group[data-group-id="initial-group"] .sidebar-row--group .sidebar-more').click();
    expect(labels(root)).toEqual(["Rename group", "Close all sessions", "Delete group"]);
    const del = menuItem(root, "Delete group");
    expect(del.disabled).toBe(true);
    expect(del.title).toBe("Close the group's sessions first");
    expect(menuItem(root, "Close all sessions").disabled).toBe(false);
  });

  it("deletes an empty group and moves the selection to a neighbour", () => {
    const { root, get, stores } = setup();
    stores.createWorkGroup("Other task");
    const other = stores.navigation.getState().groups[1]?.id ?? "";
    expect(stores.navigation.getState().activeGroupId).toBe(other);
    get(`.sidebar-group[data-group-id="${other}"] .sidebar-row--group .sidebar-more`).click();
    menuItem(root, "Delete group").click();
    expect(stores.navigation.getState().groups.map((group) => group.id)).toEqual(["initial-group"]);
    expect(stores.navigation.getState().activeGroupId).toBe("initial-group");
  });

  it("never deletes the only group", () => {
    const { get, root, stores } = setup();
    get(".sidebar-row--group .sidebar-more").click();
    expect(menuItem(root, "Delete group").disabled).toBe(true);
    stores.removeWorkGroup("initial-group");
    expect(stores.navigation.getState().groups).toHaveLength(1);
  });

  it("offers every session action and closes the others without touching this one", () => {
    const { root, get, stores } = setup();
    get('.sidebar-row--session[data-chat-id="a"] .sidebar-more').click();
    expect(labels(root)).toEqual([
      "Rename session",
      "Duplicate session",
      "Maximize",
      "Close session",
      "Close other sessions",
    ]);
    menuItem(root, "Close other sessions").click();
    expect(stores.zone3.getState().chats.map((chat) => chat.chatId)).toEqual(["a"]);
  });

  it("duplicates a session next to it and maximizes then restores it", () => {
    const { root, get, stores } = setup();
    get('.sidebar-row--session[data-chat-id="b"] .sidebar-more').click();
    menuItem(root, "Duplicate session").click();
    const chats = stores.zone3.getState().chats;
    expect(chats).toHaveLength(3);
    expect(chats.at(-1)?.modelName).toBe("Claude");
    get('.sidebar-row--session[data-chat-id="b"] .sidebar-more').click();
    menuItem(root, "Maximize").click();
    expect(stores.navigation.getState().groups[0]?.maximizedChatId).toBe("b");
    get('.sidebar-row--session[data-chat-id="b"] .sidebar-more').click();
    menuItem(root, "Restore layout").click();
    expect(stores.navigation.getState().groups[0]?.maximizedChatId).toBeNull();
  });

  it("can close the last session, but not one with a running agent", () => {
    const { root, get, stores } = setup();
    stores.closeChat("b");
    get(".sidebar-row--session .sidebar-more").click();
    expect(menuItem(root, "Close session").disabled).toBe(false);
    root
      .querySelector('[role="menu"]')
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    stores.zone3.setState((prev) => ({ ...prev, activeRunningAgentChatId: "a" }));
    get(".sidebar-row--session .sidebar-more").click();
    const close = menuItem(root, "Close session");
    expect(close.disabled).toBe(true);
    expect(close.title).toBe("No session can be closed right now");
  });

  it("opens the same menu on a right click, but not while renaming", () => {
    const { root, get } = setup();
    const row = get(".sidebar-row--folder");
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    row.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(labels(root)).toContain("Collapse project");
  });

  it("jumps to an entry by typing its first letter", () => {
    const { root, get } = setup();
    get(".sidebar-row--folder .sidebar-more").click();
    const menu = root.querySelector('[role="menu"]') as HTMLElement;
    // The first entry has the focus; typing "c" moves on to the next one starting with it.
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }));
    expect(document.activeElement?.textContent).toBe("Collapse all groups");
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }));
    expect(document.activeElement?.textContent).toBe("Copy path");
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }));
    expect(document.activeElement?.textContent).toBe("Collapse project");
  });

  it("closes when the sidebar scrolls or the window resizes", () => {
    const { root, get } = setup();
    get(".sidebar-row--folder .sidebar-more").click();
    expect(root.querySelector('[role="menu"]')).not.toBeNull();
    window.dispatchEvent(new Event("resize"));
    expect(root.querySelector('[role="menu"]')).toBeNull();
    get(".sidebar-row--folder .sidebar-more").click();
    document.body.dispatchEvent(new Event("scroll"));
    expect(root.querySelector('[role="menu"]')).toBeNull();
  });

  it("opens above its button when there is no room below", () => {
    const { root, get } = setup();
    const more = get(".sidebar-row--group .sidebar-more");
    vi.spyOn(more, "getBoundingClientRect").mockReturnValue({
      top: window.innerHeight - 40,
      bottom: window.innerHeight - 20,
    } as DOMRect);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(200);
    more.click();
    expect(root.querySelector<HTMLElement>('[role="menu"]')?.dataset.placement).toBe("above");
    vi.restoreAllMocks();
  });
});
