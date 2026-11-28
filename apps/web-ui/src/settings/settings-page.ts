import { browserStorage } from "../state/ui-preferences.js";
import type { UiPreferences } from "../state/ui-preferences.js";
import { type ThinScrollbar, attachThinScrollbar } from "../ui/thin-scrollbar.js";
import { AgentRegistryPanel } from "./agent-registry-panel.js";
import type { AgentRegistryHost } from "./agent-registry.js";
import { AppearancePanel } from "./appearance-panel.js";
import { type InlineCompletionHost, InlineCompletionPanel } from "./inline-completion-panel.js";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "./settings-content.js";

const CHEVRON =
  '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 4 8 8-8 8"/></svg>';
const SECTION_KEY = "hilo.settings.section.v1";

/** The Settings screen. Hiding it never removes or reparents the singleton code editor. */
export class SettingsPage {
  readonly element: HTMLElement;
  private readonly search: HTMLInputElement;
  private readonly nav: HTMLElement;
  /** The scroller of the content (its native scrollbar is hidden; a thin one is drawn). */
  private readonly scroller: HTMLElement;
  /** Stable child of the scroller: what is rendered goes here, so its size can be observed. */
  private readonly main: HTMLElement;
  private readonly scrollbars: ThinScrollbar[] = [];
  private active: SettingsSectionId = SETTINGS_SECTIONS[0].id;
  private activeGroup: string | null = null;
  private readonly expanded = new Set<SettingsSectionId>();
  private panel: AgentRegistryPanel | null = null;
  private completionPanel: InlineCompletionPanel | null = null;
  private appearancePanel: AppearancePanel | null = null;

  constructor(
    private readonly doc: Document,
    private readonly options: {
      agentRegistry: AgentRegistryHost;
      inlineCompletion?: InlineCompletionHost;
      preferences?: UiPreferences;
    },
  ) {
    try {
      const saved = browserStorage(doc)?.getItem(SECTION_KEY);
      this.active = SETTINGS_SECTIONS.find((s) => s.id === saved)?.id ?? this.active;
    } catch {
      /* Use the first category when storage is unavailable. */
    }
    this.expanded.add(this.active);
    this.element = doc.createElement("section");
    this.element.className = "hilo-settings-page";
    this.element.setAttribute("aria-label", "Settings");
    this.element.hidden = true;
    const aside = doc.createElement("aside");
    aside.className = "hilo-settings-navigation";
    const label = doc.createElement("label");
    label.className = "hilo-settings-search";
    label.innerHTML =
      '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="10.5" cy="10.5" r="8.5"/><path d="m17 17 5 5"/></svg>';
    this.search = doc.createElement("input");
    this.search.type = "search";
    this.search.placeholder = "Search settings…";
    this.search.setAttribute("aria-label", "Search settings");
    this.search.addEventListener("input", () => this.render());
    label.append(this.search);
    this.nav = doc.createElement("nav");
    this.nav.className = "hilo-settings-categories";
    this.nav.setAttribute("aria-label", "Settings sections");
    const navViewport = doc.createElement("div");
    navViewport.className = "hilo-settings-viewport hilo-settings-viewport--nav";
    navViewport.append(this.nav);
    aside.append(label, navViewport);
    const mainViewport = doc.createElement("div");
    mainViewport.className = "hilo-settings-viewport";
    this.scroller = doc.createElement("div");
    this.scroller.className = "hilo-settings-main";
    this.scroller.tabIndex = 0;
    this.main = doc.createElement("div");
    this.scroller.append(this.main);
    mainViewport.append(this.scroller);
    this.element.append(aside, mainViewport);
    this.scrollbars.push(
      attachThinScrollbar(navViewport, this.nav, "y"),
      attachThinScrollbar(mainViewport, this.scroller, "y"),
    );
    this.element.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        event.stopPropagation();
        this.search.focus();
      }
      if (event.key === "Escape" && this.search.value) {
        event.preventDefault();
        event.stopPropagation();
        this.search.value = "";
        this.render();
      }
    });
    this.renderNavigation(false);
  }

  show(): void {
    if (this.element.hidden) {
      this.element.hidden = false;
      this.render();
    }
    this.search.focus();
  }
  showExternalAgents(): void {
    this.show();
    this.select(SETTINGS_SECTIONS[0].id, SETTINGS_SECTIONS[0].groups[0]);
  }
  hide(): void {
    this.element.hidden = true;
  }
  destroy(): void {
    for (const scrollbar of this.scrollbars) scrollbar.destroy();
    this.panel?.destroy();
    this.panel = null;
    this.completionPanel?.destroy();
    this.completionPanel = null;
    this.appearancePanel?.destroy();
    this.appearancePanel = null;
    this.element.remove();
  }

  private button(label: string, action: () => void, className = ""): HTMLButtonElement {
    const button = this.doc.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.className = className;
    button.addEventListener("click", action);
    return button;
  }

  private select(section: SettingsSectionId, group: string | null = null): void {
    this.active = section;
    this.activeGroup = group;
    this.search.value = "";
    if (group) this.expanded.add(section);
    try {
      browserStorage(this.doc)?.setItem(SECTION_KEY, section);
    } catch {
      /* In-memory navigation still works. */
    }
    this.render();
    this.scroller.scrollTop = 0;
    const selected = group
      ? this.nav.querySelector<HTMLButtonElement>('.hilo-settings-subnav [aria-current="page"]')
      : this.nav.querySelector<HTMLButtonElement>('.hilo-settings-nav-label[aria-current="page"]');
    selected?.focus();
    if (group)
      [...this.main.querySelectorAll<HTMLElement>(".hilo-settings-group")]
        .find((el) => el.dataset.group === group)
        ?.scrollIntoView?.({ block: "start" });
  }

  private render(): void {
    const needle = this.search.value.trim().toLocaleLowerCase();
    this.renderNavigation(Boolean(needle));
    this.main.replaceChildren();
    this.scroller.setAttribute(
      "aria-label",
      needle
        ? "Search settings results"
        : `${SETTINGS_SECTIONS.find((s) => s.id === this.active)?.label} settings`,
    );
    let matches = 0;
    for (const section of SETTINGS_SECTIONS) {
      if (!needle && section.id !== this.active) continue;
      if (
        needle &&
        !`${section.label} ${section.groups.join(" ")} ${section.keywords}`
          .toLocaleLowerCase()
          .includes(needle)
      )
        continue;
      const content = this.doc.createElement("div");
      content.className = "hilo-settings-category is-wide";
      for (const groupName of section.groups) {
        const group = this.doc.createElement("section");
        group.className = "hilo-settings-group";
        group.dataset.group = groupName;
        if (section.id === "ai-completion") {
          const host = this.options.inlineCompletion;
          if (!host) continue;
          this.completionPanel ??= new InlineCompletionPanel(this.doc, host);
          group.append(this.completionPanel.element);
        } else if (section.id === "appearance") {
          const preferences = this.options.preferences;
          if (!preferences) continue;
          this.appearancePanel ??= new AppearancePanel(this.doc, preferences);
          group.append(this.appearancePanel.element);
        } else {
          this.panel ??= new AgentRegistryPanel(this.doc, this.options.agentRegistry);
          group.append(this.panel.element);
        }
        content.append(group);
        matches++;
      }
      if (needle) {
        const title = this.doc.createElement("h3");
        title.className = "hilo-settings-result-title";
        title.textContent = section.label;
        content.prepend(title);
      }
      this.main.append(content);
    }
    if (!matches) {
      const empty = this.doc.createElement("div");
      empty.className = "hilo-settings-empty";
      empty.setAttribute("role", "status");
      const title = this.doc.createElement("h2");
      title.textContent = "No settings found";
      const hint = this.doc.createElement("p");
      hint.textContent = "Try a search such as agent, registry or install.";
      empty.append(
        title,
        hint,
        this.button("Clear search", () => {
          this.search.value = "";
          this.render();
          this.search.focus();
        }),
      );
      this.main.append(empty);
    }
    this.updateScrollbars();
  }

  private updateScrollbars(): void {
    for (const scrollbar of this.scrollbars) scrollbar.update();
  }

  private renderNavigation(searching: boolean): void {
    const scrollTop = this.nav.scrollTop;
    this.nav.replaceChildren();
    for (const section of SETTINGS_SECTIONS) {
      const item = this.doc.createElement("div");
      item.className = "hilo-settings-nav-item";
      const row = this.doc.createElement("div");
      row.className = "hilo-settings-nav-row";
      const open = !searching && this.expanded.has(section.id);
      const toggle = this.button(
        "",
        () => {
          if (this.expanded.has(section.id)) this.expanded.delete(section.id);
          else this.expanded.add(section.id);
          this.renderNavigation(searching);
          this.nav.querySelector<HTMLButtonElement>(`[data-toggle="${section.id}"]`)?.focus();
        },
        "hilo-settings-nav-toggle",
      );
      toggle.innerHTML = CHEVRON;
      toggle.dataset.toggle = section.id;
      toggle.setAttribute("aria-label", `${open ? "Collapse" : "Expand"} ${section.label}`);
      toggle.setAttribute("aria-expanded", String(open));
      const label = this.button(
        section.label,
        () => this.select(section.id),
        "hilo-settings-nav-label",
      );
      if (!searching && this.active === section.id && !this.activeGroup)
        row.dataset.selected = "true";
      if (row.dataset.selected) label.setAttribute("aria-current", "page");
      row.append(toggle, label);
      item.append(row);
      if (open) {
        const children = this.doc.createElement("div");
        children.className = "hilo-settings-subnav";
        for (const group of section.groups) {
          const child = this.button(group, () => this.select(section.id, group));
          if (this.active === section.id && this.activeGroup === group)
            child.setAttribute("aria-current", "page");
          children.append(child);
        }
        item.append(children);
      }
      this.nav.append(item);
    }
    this.nav.scrollTop = scrollTop;
    this.updateScrollbars();
  }
}
