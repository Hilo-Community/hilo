// @vitest-environment happy-dom
import { HiloEditorView, InMemoryBinaryHostBridge } from "@hilo/editor-cm6";
import { describe, expect, it, vi } from "vitest";
import { CockpitDomController, createCockpitStoreBundle } from "../index.js";
import { AgentRegistryPanel } from "./agent-registry-panel.js";
import {
  type AgentRegistryHost,
  type AgentRegistryListing,
  type AgentRegistryState,
  AgentRegistryStore,
  type InstalledAgent,
  type RegistryAgent,
  visibleRows,
} from "./agent-registry.js";
import { SettingsPage } from "./settings-page.js";

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function agent(id: string, extra: Partial<RegistryAgent> = {}): RegistryAgent {
  return {
    id,
    name: id.toUpperCase(),
    version: "1.0.0",
    description: `The ${id} agent`,
    repository: null,
    website: null,
    license: "MIT",
    licenseUrl: null,
    distribution: "binary",
    blocked: null,
    ...extra,
  };
}

function installed(agentId: string, version = "1.0.0"): InstalledAgent {
  return {
    id: `${agentId}@${version}`,
    agentId,
    name: agentId.toUpperCase(),
    version,
    distribution: "binary",
  };
}

function listing(
  agents: RegistryAgent[],
  installedAgents: InstalledAgent[] = [],
  extra: Partial<AgentRegistryListing> = {},
): AgentRegistryListing {
  return {
    agents,
    installed: installedAgents,
    origin: "network",
    refreshError: null,
    ...extra,
  };
}

/** A Host whose answers the test controls. */
function fakeHost(initial: AgentRegistryListing) {
  let current = initial;
  const host: AgentRegistryHost = {
    list: vi.fn(async () => current),
    install: vi.fn(async (agentId: string, version: string) => {
      const done = installed(agentId, version);
      current = { ...current, installed: [...current.installed, done] };
      return done;
    }),
    uninstall: vi.fn(async (id: string) => {
      current = { ...current, installed: current.installed.filter((item) => item.id !== id) };
    }),
  };
  return {
    host,
    set: (next: AgentRegistryListing) => {
      current = next;
    },
  };
}

const buttons = (root: ParentNode, label: string) =>
  [...root.querySelectorAll("button")].filter((b) => b.getAttribute("aria-label") === label);
const click = (root: ParentNode, label: string) => {
  const found = buttons(root, label)[0];
  if (!found) throw new Error(`no button "${label}"`);
  found.click();
};
const cards = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>(".hilo-registry-card")];

describe("agent registry state", () => {
  it("returns an existing Settings page to External Agents after a filtered search", async () => {
    const { host } = fakeHost(listing([agent("codex")]));
    const page = new SettingsPage(document, { agentRegistry: host });
    page.show();
    const search = page.element.querySelector<HTMLInputElement>('[aria-label="Search settings"]');
    if (search) {
      search.value = "no matching section";
      search.dispatchEvent(new Event("input"));
    }
    expect(page.element.textContent).toContain("No settings found");
    page.showExternalAgents();
    await settle();
    expect(search?.value).toBe("");
    expect(page.element.querySelector(".hilo-registry")).not.toBeNull();
    page.destroy();
  });
  it("opens installed agents only when Open is clicked, alongside the current action", async () => {
    const fake = fakeHost(listing([agent("codex")], [installed("codex")]));
    const open = vi.fn(async () => {});
    const panel = new AgentRegistryPanel(document, { ...fake.host, open });
    await settle();
    expect(open).not.toHaveBeenCalled();
    const button = buttons(panel.element, "Open CODEX")[0];
    expect(button?.textContent).toBe("Open");
    expect(button?.querySelector("svg")).toBeNull();
    expect(button?.classList.contains("hilo-registry-ghost")).toBe(false);
    expect(buttons(panel.element, "Remove CODEX")).toHaveLength(1);
    button?.click();
    await settle();
    expect(open).toHaveBeenCalledWith("codex");
    panel.destroy();
  });
  it("loads the catalog and the installed agents", async () => {
    const { host } = fakeHost(listing([agent("a")], [installed("a")]));
    const store = new AgentRegistryStore(host);
    expect(store.getState().loading).toBe(true);
    await store.load();
    const state = store.getState();
    expect(state.loading).toBe(false);
    expect(state.agents.map((a) => a.id)).toEqual(["a"]);
    expect(state.installed.map((a) => a.agentId)).toEqual(["a"]);
    expect(host.list).toHaveBeenCalledWith(true);
  });

  it("reports a listing that cannot be loaded and keeps what it had", async () => {
    const { host } = fakeHost(listing([agent("a")]));
    const store = new AgentRegistryStore(host);
    await store.load();
    vi.mocked(host.list).mockRejectedValueOnce(new Error("The registry could not be reached"));
    await store.load();
    expect(store.getState().error).toBe("The registry could not be reached");
    expect(store.getState().agents).toHaveLength(1);
    await store.load();
    expect(store.getState().error).toBe("");
  });

  it("installs the exact version it is showing, then reloads from the Host without the network", async () => {
    const { host } = fakeHost(listing([agent("a", { version: "2.0.0" })]));
    const store = new AgentRegistryStore(host);
    await store.load();
    await store.install(store.getState().agents[0] as RegistryAgent);
    expect(host.install).toHaveBeenCalledWith("a", "2.0.0");
    expect(host.list).toHaveBeenLastCalledWith(false);
    expect(store.getState().installed[0]?.version).toBe("2.0.0");
    expect(store.getState().notice).toContain("installed");
    expect(store.getState().pending).toEqual({});
  });

  it("does not report the registry as unreachable after an install that did not refresh", async () => {
    const { host } = fakeHost(listing([agent("a")]));
    // The Host answers from its saved catalog whenever the registry is not asked.
    host.list = vi.fn(async (refresh: boolean) => ({
      ...listing([agent("a")]),
      origin: refresh ? ("network" as const) : ("saved" as const),
    }));
    const store = new AgentRegistryStore(host);
    await store.load(true);
    await store.install(store.getState().agents[0] as RegistryAgent);
    expect(store.getState().origin).toBe("network");
    expect(store.getState().refreshError).toBeNull();
  });

  it("does nothing when the user declines the Host's confirmation", async () => {
    const { host } = fakeHost(listing([agent("a")]));
    vi.mocked(host.install).mockResolvedValueOnce(null);
    const store = new AgentRegistryStore(host);
    await store.load();
    await store.install(store.getState().agents[0] as RegistryAgent);
    expect(store.getState().notice).toBe("");
    expect(store.getState().failures).toEqual({});
    expect(store.getState().installed).toEqual([]);
    expect(host.list).toHaveBeenCalledTimes(1);
  });

  it("never asks the Host to install an agent that is blocked", async () => {
    const { host } = fakeHost(listing([agent("a", { blocked: "No checksum" })]));
    const store = new AgentRegistryStore(host);
    await store.load();
    await store.install(store.getState().agents[0] as RegistryAgent);
    expect(host.install).not.toHaveBeenCalled();
  });

  it("shows a failure on its own card and clears it on the next try", async () => {
    const { host } = fakeHost(listing([agent("a"), agent("b")]));
    vi.mocked(host.install).mockRejectedValueOnce(new Error("The download does not match"));
    const store = new AgentRegistryStore(host);
    await store.load();
    const [a, b] = store.getState().agents as [RegistryAgent, RegistryAgent];
    await store.install(a);
    expect(store.getState().failures).toEqual({ a: "The download does not match" });
    expect(store.getState().pending).toEqual({});
    await store.install(b);
    expect(store.getState().failures).toEqual({ a: "The download does not match" });
    await store.install(a);
    expect(store.getState().failures).toEqual({});
  });

  it("ignores a second click while an install is running", async () => {
    const { host } = fakeHost(listing([agent("a")]));
    let finish: (value: InstalledAgent | null) => void = () => undefined;
    vi.mocked(host.install).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const store = new AgentRegistryStore(host);
    await store.load();
    const a = store.getState().agents[0] as RegistryAgent;
    const first = store.install(a);
    expect(store.getState().pending).toEqual({ a: "installing" });
    await store.install(a);
    finish(installed("a"));
    await first;
    expect(host.install).toHaveBeenCalledTimes(1);
  });

  it("removes an installation by its id", async () => {
    const { host } = fakeHost(listing([agent("a")], [installed("a")]));
    const store = new AgentRegistryStore(host);
    await store.load();
    await store.uninstall(store.getState().installed[0] as InstalledAgent);
    expect(host.uninstall).toHaveBeenCalledWith("a@1.0.0");
    expect(store.getState().installed).toEqual([]);
    expect(store.getState().notice).toContain("removed");
  });

  it("lets only the latest listing write its result", async () => {
    const { host } = fakeHost(listing([]));
    const resolvers: ((value: AgentRegistryListing) => void)[] = [];
    vi.mocked(host.list).mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve)),
    );
    const store = new AgentRegistryStore(host);
    const slow = store.load();
    const fast = store.load();
    resolvers[1]?.(listing([agent("new")]));
    await fast;
    resolvers[0]?.(listing([agent("old")]));
    await slow;
    expect(store.getState().agents.map((a) => a.id)).toEqual(["new"]);
  });

  it("writes nothing once disposed", async () => {
    const { host } = fakeHost(listing([agent("a")]));
    const store = new AgentRegistryStore(host);
    const loading = store.load();
    store.dispose();
    await loading;
    expect(store.getState().agents).toEqual([]);
  });
});

describe("agent registry rows", () => {
  const base = {
    loading: false,
    origin: "network" as const,
    refreshError: null,
    query: "",
    filter: "all" as const,
    pending: {},
    awaiting: {},
    failures: {},
    error: "",
    notice: "",
  };

  it("filters by installation, searches name, id and description, and sorts by name", () => {
    const state = {
      ...base,
      agents: [
        agent("zeta", { name: "Zeta" }),
        agent("alpha", { name: "Alpha", description: "writes Rust" }),
        agent("mid", { name: "Mid" }),
      ],
      installed: [installed("mid")],
    };
    const names = (change: Partial<AgentRegistryState>) =>
      visibleRows({ ...state, ...change }).map((row) => row.agent.name);
    expect(names({})).toEqual(["Alpha", "Mid", "Zeta"]);
    expect(names({ filter: "installed" })).toEqual(["Mid"]);
    expect(names({ filter: "available" })).toEqual(["Alpha", "Zeta"]);
    expect(names({ query: "  RUST " })).toEqual(["Alpha"]);
    expect(names({ query: "zeta" })).toEqual(["Zeta"]);
    expect(names({ query: "nothing" })).toEqual([]);
  });

  it("marks an installed agent as updatable when another version is on offer", () => {
    const rows = visibleRows({
      ...base,
      agents: [agent("a", { version: "2.0.0" }), agent("b")],
      installed: [installed("a", "1.0.0"), installed("b", "1.0.0")],
    });
    expect(rows.map((row) => row.updatable)).toEqual([true, false]);
  });

  it("keeps an installed agent the catalog dropped, so it can still be removed", () => {
    const rows = visibleRows({ ...base, agents: [], installed: [installed("gone")] });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.installed?.agentId).toBe("gone");
    expect(rows[0]?.agent.blocked).toContain("No longer");
  });
});

describe("agent registry panel", () => {
  async function mount(initial: AgentRegistryListing) {
    const fake = fakeHost(initial);
    const panel = new AgentRegistryPanel(document, fake.host);
    document.body.append(panel.element);
    await settle();
    return { ...fake, panel };
  }

  it("shows one card per agent with its version, license and install button", async () => {
    const { panel } = await mount(listing([agent("a"), agent("b", { version: "3.1.0" })]));
    expect(cards(panel.element).map((card) => card.getAttribute("aria-label"))).toEqual(["A", "B"]);
    expect(cards(panel.element)[1]?.textContent).toContain("v3.1.0");
    expect(cards(panel.element)[1]?.textContent).toContain("MIT");
    expect(buttons(panel.element, "Install B 3.1.0")).toHaveLength(1);
    panel.destroy();
  });

  it("installs from the card and then offers to remove it", async () => {
    const { panel, host } = await mount(listing([agent("a")]));
    click(panel.element, "Install A 1.0.0");
    await settle();
    expect(host.install).toHaveBeenCalledWith("a", "1.0.0");
    expect(buttons(panel.element, "Install A 1.0.0")).toHaveLength(0);
    click(panel.element, "Remove A");
    await settle();
    expect(host.uninstall).toHaveBeenCalledWith("a@1.0.0");
    expect(buttons(panel.element, "Install A 1.0.0")).toHaveLength(1);
    panel.destroy();
  });

  it("offers only Unlink for the account, asking before it signs the agent out", async () => {
    const fake = fakeHost(listing([agent("a")], [installed("a")]));
    const account = {
      status: vi.fn(async () => ({
        preferences: { mode: "auto", provider: null, methodId: null, extraAllowedHosts: [] },
        providers: [],
        authMethods: [],
        knownProfile: true,
      })),
      setKey: vi.fn(async () => {}),
      save: vi.fn(async () => {}),
      signOut: vi.fn(async () => {}),
    } as unknown as NonNullable<AgentRegistryHost["account"]>;
    const panel = new AgentRegistryPanel(document, { ...fake.host, account });
    document.body.append(panel.element);
    await settle();
    expect(buttons(panel.element, "Account A")).toHaveLength(0);
    expect(panel.element.textContent).not.toContain("API key");
    click(panel.element, "Unlink A");
    await settle();
    expect(account.signOut).not.toHaveBeenCalled();
    const confirm = [
      ...panel.element.querySelectorAll<HTMLButtonElement>(".hilo-agent-account button"),
    ].find((b) => b.textContent === "Unlink");
    confirm?.click();
    await settle();
    expect(account.signOut).toHaveBeenCalledWith("a");
    panel.destroy();
  });

  it("says why an agent cannot be installed and disables its button", async () => {
    const { panel } = await mount(
      listing([agent("c", { blocked: "The registry publishes no SHA-256 for this download." })]),
    );
    const card = cards(panel.element)[0] as HTMLElement;
    expect(card.textContent).toContain("Cannot be installed here");
    expect(card.textContent).toContain("SHA-256");
    expect(buttons(panel.element, "Install C 1.0.0")[0]?.disabled).toBe(true);
    panel.destroy();
  });

  it("turns the button into Update, with the new version in green, when one is on offer", async () => {
    const { panel, host } = await mount(
      listing([agent("a", { version: "2.0.0" })], [installed("a", "1.0.0")]),
    );
    const card = cards(panel.element)[0] as HTMLElement;
    expect(card.textContent).toContain("v2.0.0");
    const version = card.querySelector(".hilo-registry-version--update") as HTMLElement;
    expect(version.title).toBe("Installed 1.0.0; 2.0.0 is available.");
    expect(buttons(panel.element, "Remove A")).toHaveLength(0);
    click(panel.element, "Update A to 2.0.0");
    await settle();
    expect(host.install).toHaveBeenCalledWith("a", "2.0.0");
    panel.destroy();
  });

  it("filters and searches without reloading", async () => {
    const { panel, host } = await mount(
      listing([agent("alpha"), agent("beta")], [installed("beta")]),
    );
    const filter = (label: string) =>
      [...panel.element.querySelectorAll(".hilo-registry-filters button")].find(
        (b) => b.textContent === label,
      ) as HTMLButtonElement;
    filter("Installed").click();
    expect(cards(panel.element).map((c) => c.dataset.agent)).toEqual(["beta"]);
    expect(filter("Installed").getAttribute("aria-pressed")).toBe("true");
    filter("All").click();
    const search = panel.element.querySelector("input") as HTMLInputElement;
    search.value = "alp";
    search.dispatchEvent(new Event("input"));
    expect(cards(panel.element).map((c) => c.dataset.agent)).toEqual(["alpha"]);
    search.value = "zzz";
    search.dispatchEvent(new Event("input"));
    expect(panel.element.querySelector(".hilo-registry-empty")?.textContent).toContain(
      "No agents match",
    );
    expect(host.list).toHaveBeenCalledTimes(1);
    panel.destroy();
  });

  it("says when the saved catalog is shown and retries from the network", async () => {
    const { panel, host, set } = await mount(
      listing([agent("a")], [], { origin: "saved", refreshError: "Download failed: offline" }),
    );
    const alert = panel.element.querySelector(".hilo-registry-alert") as HTMLElement;
    expect(alert.hidden).toBe(false);
    expect(alert.textContent).toContain("saved earlier");
    expect(alert.textContent).toContain("Download failed: offline");
    set(listing([agent("a"), agent("b")]));
    (alert.querySelector("button") as HTMLButtonElement).click();
    await settle();
    expect(host.list).toHaveBeenLastCalledWith(true);
    expect(cards(panel.element)).toHaveLength(2);
    expect((panel.element.querySelector(".hilo-registry-alert") as HTMLElement).hidden).toBe(true);
    panel.destroy();
  });

  it("shows a failed install on its card as an alert", async () => {
    const { panel, host } = await mount(listing([agent("a")]));
    vi.mocked(host.install).mockRejectedValueOnce(new Error("npm could not install a@1.0.0: 404"));
    click(panel.element, "Install A 1.0.0");
    await settle();
    const failure = panel.element.querySelector(".hilo-registry-failure") as HTMLElement;
    expect(failure.getAttribute("role")).toBe("alert");
    expect(failure.textContent).toContain("404");
    expect(buttons(panel.element, "Install A 1.0.0")[0]?.disabled).toBe(false);
    panel.destroy();
  });

  it("keeps the keyboard focus on the same button when the cards are rebuilt", async () => {
    const { panel } = await mount(listing([agent("a"), agent("b")]));
    const target = buttons(panel.element, "Install B 1.0.0")[0] as HTMLButtonElement;
    target.focus();
    expect(document.activeElement).toBe(target);
    panel.store.setQuery("");
    panel.store.setFilter("all");
    await settle();
    const after = buttons(panel.element, "Install B 1.0.0")[0];
    expect(after).not.toBe(target);
    expect(document.activeElement).toBe(after);
    panel.destroy();
  });

  it("renders hostile catalog text as text, never as markup", async () => {
    const { panel } = await mount(
      listing([
        agent("x", {
          name: "<img src=x onerror=alert(1)>",
          description: "<script>attack()</script>",
          blocked: "<b>bold</b>",
        }),
      ]),
    );
    expect(panel.element.querySelector("img, script, b")).toBeNull();
    expect(cards(panel.element)[0]?.textContent).toContain("<script>attack()</script>");
    panel.destroy();
  });
});

describe("settings page", () => {
  function mount() {
    const fake = fakeHost(listing([agent("a")]));
    const root = document.createElement("div");
    document.body.append(root);
    const page = new SettingsPage(document, { agentRegistry: fake.host });
    root.append(page.element);
    page.show();
    return {
      ...fake,
      root,
      page,
      cleanup: () => {
        page.destroy();
        root.remove();
      },
    };
  }

  it("shows the sidebar with External Agents first, then AI Completion, then Appearance", async () => {
    const { root, cleanup } = mount();
    await settle();
    const labels = [...root.querySelectorAll(".hilo-settings-nav-label")];
    expect(labels.map((l) => l.textContent)).toEqual([
      "External Agents",
      "AI Completion",
      "Appearance",
    ]);
    expect(root.querySelector(".hilo-settings-subnav")?.textContent).toBe("ACP Registry");
    expect(root.querySelector(".hilo-registry")).not.toBeNull();
    expect(cards(root).map((c) => c.dataset.agent)).toEqual(["a"]);
    cleanup();
  });

  it("searches the sidebar and reports when nothing matches", async () => {
    const { root, cleanup } = mount();
    await settle();
    const search = root.querySelector<HTMLInputElement>(
      '[aria-label="Search settings"]',
    ) as HTMLInputElement;
    search.value = "registry";
    search.dispatchEvent(new Event("input"));
    expect(root.querySelector(".hilo-registry")).not.toBeNull();
    search.value = "xyzxyz";
    search.dispatchEvent(new Event("input"));
    expect(root.querySelector(".hilo-registry")).toBeNull();
    expect(root.querySelector('[role="status"]')?.textContent).toContain("No settings found");
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(search.value).toBe("");
    expect(root.querySelector(".hilo-registry")).not.toBeNull();
    cleanup();
  });

  it("keeps the registry and pending operations alive when hidden and shown again", async () => {
    const { root, page, host, cleanup } = mount();
    await settle();
    const registry = root.querySelector(".hilo-registry");
    click(root, "Install A 1.0.0");
    page.hide();
    page.show();
    await settle();
    expect(root.querySelector(".hilo-registry")).toBe(registry);
    expect(host.install).toHaveBeenCalledWith("a", "1.0.0");
    expect(buttons(root, "Remove A")).toHaveLength(1);
    cleanup();
  });
});

describe("settings tab in the cockpit", () => {
  function mount(registry?: AgentRegistryHost, openSettingsWindow?: () => Promise<void>) {
    const root = document.createElement("div");
    document.body.append(root);
    const stores = createCockpitStoreBundle();
    const editor = new HiloEditorView({
      initialDocumentId: "src/file.ts",
      initialContent: "const a = 1;",
      ipcChannel: new InMemoryBinaryHostBridge(),
    });
    const cockpit = new CockpitDomController({
      rootContainer: root,
      stores,
      editorView: editor,
      ...(registry ? { agentRegistryHost: registry } : {}),
      ...(openSettingsWindow ? { openSettingsWindow } : {}),
    });
    return {
      root,
      stores,
      editor,
      cleanup: () => {
        cockpit.destroy();
        editor.destroy();
        root.remove();
      },
    };
  }

  it("offers no Settings button without a registry host", () => {
    const { root, cleanup } = mount();
    expect(root.querySelector(".hilo-settings-btn")).toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: ",", metaKey: true }));
    expect(root.querySelector(".hilo-settings-page")).toBeNull();
    cleanup();
  });

  it("opens the host window from the gear and shortcut without adding a workspace tab", async () => {
    const { host } = fakeHost(listing([agent("a")]));
    const openSettingsWindow = vi.fn(async () => {});
    const { root, editor, cleanup } = mount(host, openSettingsWindow);
    const instance = editor.getEditorView();
    (root.querySelector(".hilo-settings-btn") as HTMLButtonElement).click();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: ",", metaKey: true, bubbles: true }),
    );
    await settle();
    expect(openSettingsWindow).toHaveBeenCalledTimes(2);
    expect(root.querySelector('[data-view="settings"]')).toBeNull();
    expect((root.querySelector(".hilo-settings-page") as HTMLElement).hidden).toBe(true);
    expect(editor.getEditorView()).toBe(instance);
    expect(editor.getStoreSnapshot().mountCount).toBe(1);
    cleanup();
  });

  it("opens a single closable tab, switches back to sessions and preserves the editor", () => {
    const { host } = fakeHost(listing([agent("a")]));
    const { root, stores, editor, cleanup } = mount(host);
    const instance = editor.getEditorView();
    const parent = instance.dom.parentElement;
    const updates = stores.zone4.getUpdateCount();
    const open = () => (root.querySelector(".hilo-settings-btn") as HTMLButtonElement).click();
    open();
    open();
    expect(stores.zone4.getUpdateCount()).toBe(updates);
    const page = root.querySelector<HTMLElement>(".hilo-settings-page") as HTMLElement;
    expect(page.hidden).toBe(false);
    expect(root.querySelectorAll('[data-view="settings"]')).toHaveLength(1);
    expect(root.querySelector('[data-view="settings"]')?.getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(page.getAttribute("role")).not.toBe("dialog");
    (root.querySelector('[role="tab"][data-chat-id]:not([data-view])') as HTMLElement).click();
    expect(page.hidden).toBe(true);
    expect(root.querySelector('[data-view="settings"]')).not.toBeNull();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: ",", metaKey: true, bubbles: true }),
    );
    expect(page.hidden).toBe(false);
    (root.querySelector('[data-view="settings"] button') as HTMLButtonElement).click();
    expect(page.hidden).toBe(true);
    expect(root.querySelector('[data-view="settings"]')).toBeNull();
    expect(editor.getEditorView()).toBe(instance);
    expect(instance.dom.parentElement).toBe(parent);
    expect(editor.getStoreSnapshot().mountCount).toBe(1);
    cleanup();
  });
});

describe("agent logos", () => {
  it("bundles only inert, monochrome markup", async () => {
    const { AGENT_ICONS } = await import("./agent-icons.js");
    expect(Object.keys(AGENT_ICONS).length).toBeGreaterThan(10);
    for (const [id, svg] of Object.entries(AGENT_ICONS)) {
      expect(svg.startsWith("<svg"), id).toBe(true);
      expect(svg, id).not.toMatch(/<script|<image|<style|<foreignObject|<use|href|on\w+=|url\(/i);
    }
  });

  it("draws the logo of a known agent and the first letter of an unknown one", async () => {
    const { agentMark } = await import("./agent-marks.js");
    expect(agentMark(document, "codex-acp", "Codex").querySelector("svg")).not.toBeNull();
    const letter = agentMark(document, "brand-new-agent", "Zed");
    expect(letter.querySelector("svg")).toBeNull();
    expect(letter.textContent).toBe("Z");
  });
});

describe("hidden agents", () => {
  it("leaves out little-used agents unless they are installed", () => {
    const state = {
      ...new AgentRegistryStore(fakeHost(listing([])).host).getState(),
      agents: [agent("opencode"), agent("goose"), agent("sigit")],
      installed: [
        { id: "i1", agentId: "sigit", name: "Sigit", version: "1.0.0", distribution: "npm" },
      ],
    };
    expect(visibleRows(state).map((row) => row.agent.id)).toEqual(["opencode", "sigit"]);
  });
});
