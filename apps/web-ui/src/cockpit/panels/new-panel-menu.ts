import { agentMark } from "../../settings/agent-marks.js";
import type { AgentRegistryHost, InstalledAgent } from "../../settings/agent-registry.js";
import { PLUS_ICON } from "../../sidebar/icons.js";
import { UI_STRINGS } from "../../ui/ui-strings.js";
import { TERMINAL_ICON } from "./panel-icons.js";
import { isMacPlatform } from "./panel-shortcuts.js";

export interface NewPanelMenuActions {
  /** A plain shell panel; absent when the host offers no terminal. */
  readonly openTerminal?: () => void;
  readonly openLocalChat?: () => void;
  readonly openAgentInterface: (agent: InstalledAgent) => void;
  readonly installAgents: () => void;
}

/**
 * The "+" menu, flat: a terminal (with its shortcut), the locally installed agents under
 * "External Agents", and a way to install more.
 */
export class NewPanelMenu {
  private menu: HTMLElement | null = null;
  private anchor: HTMLElement | null = null;
  private cleanup: (() => void) | null = null;
  private installed: readonly InstalledAgent[] = [];
  private request = 0;
  private disposed = false;
  private refreshAgents: (() => void) | null = null;
  private readonly stopListening: (() => void) | undefined;

  constructor(
    private readonly doc: Document,
    private readonly registry?: AgentRegistryHost,
  ) {
    this.stopListening = registry?.onChanged?.(() => void this.refresh());
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    if (!this.registry) return;
    const request = ++this.request;
    try {
      const listing = await this.registry.list(false);
      if (this.disposed || request !== this.request) return;
      this.installed = listing.installed;
      this.refreshAgents?.();
    } catch {
      // Settings remains available to diagnose the local registry or install an agent.
    }
  }

  destroy(): void {
    this.disposed = true;
    this.stopListening?.();
    this.close(false);
  }

  isOpen(): boolean {
    return this.menu !== null;
  }

  toggle(anchor: HTMLElement, actions: NewPanelMenuActions): void {
    if (this.anchor === anchor) {
      this.close();
      return;
    }
    this.close(false);
    this.open(anchor, actions);
  }

  private item(
    label: string,
    run: (() => void) | null,
    hint?: string,
    icon?: string,
  ): HTMLButtonElement {
    const item = this.doc.createElement("button");
    item.type = "button";
    item.className = "hilo-new-panel-item";
    item.setAttribute("role", "menuitem");
    const text = this.doc.createElement("span");
    text.className = "hilo-new-panel-label";
    if (icon) {
      const glyph = this.doc.createElement("span");
      glyph.className = "hilo-new-panel-icon";
      glyph.innerHTML = icon;
      text.append(glyph);
    }
    text.append(label);
    item.append(text);
    if (hint) {
      const tag = this.doc.createElement("span");
      tag.className = "hilo-new-panel-hint";
      tag.textContent = hint;
      item.append(tag);
    }
    if (run) {
      item.addEventListener("click", () => {
        this.close();
        run();
      });
    } else {
      item.disabled = true;
    }
    return item;
  }

  private panel(label: string): HTMLElement {
    const panel = this.doc.createElement("div");
    panel.className = "hilo-new-panel-menu";
    panel.setAttribute("role", "menu");
    panel.setAttribute("aria-label", label);
    return panel;
  }

  private separator(): HTMLElement {
    const line = this.doc.createElement("div");
    line.className = "hilo-new-panel-separator";
    line.setAttribute("role", "separator");
    return line;
  }

  private open(anchor: HTMLElement, actions: NewPanelMenuActions): void {
    const text = UI_STRINGS.chat;
    const menu = this.panel(text.newMenu);
    if (actions.openTerminal) {
      // Cmd/Ctrl+J opens a terminal from anywhere (see the shell shortcuts).
      const shortcut = isMacPlatform(this.doc) ? "⌘J" : "Ctrl+J";
      menu.append(
        this.item(text.newTerminal, actions.openTerminal, shortcut, TERMINAL_ICON),
        this.separator(),
      );
    }
    if (actions.openLocalChat)
      menu.append(this.item(text.localChat, actions.openLocalChat), this.separator());
    const heading = this.doc.createElement("div");
    heading.className = "hilo-new-panel-heading";
    heading.textContent = text.externalAgents;
    const agents = this.doc.createElement("div");
    agents.setAttribute("role", "group");
    agents.setAttribute("aria-label", text.externalAgents);
    const install = this.doc.createElement("div");
    install.className = "hilo-new-panel-install";
    const populate = () => {
      agents.replaceChildren(
        ...this.installed.map((installed) => {
          const entry = this.item(installed.name, () => actions.openAgentInterface(installed));
          entry
            .querySelector(".hilo-new-panel-label")
            ?.prepend(agentMark(this.doc, installed.agentId, installed.name));
          return entry;
        }),
      );
      heading.hidden = this.installed.length === 0;
      install.replaceChildren(
        ...(this.installed.length ? [this.separator()] : []),
        this.item(
          this.installed.length ? text.addMoreAgents : text.installAgent,
          actions.installAgents,
          undefined,
          PLUS_ICON,
        ),
      );
    };
    populate();
    this.refreshAgents = populate;
    menu.append(heading, agents, install);

    this.doc.body.append(menu);
    const rect = anchor.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(rect.left, this.doc.documentElement.clientWidth - 200))}px`;
    menu.style.top = `${rect.bottom + 6}px`;
    this.menu = menu;
    this.anchor = anchor;
    anchor.setAttribute("aria-expanded", "true");

    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.close();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const items = Array.from(menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
        const index = items.indexOf(this.doc.activeElement as HTMLButtonElement);
        const step = event.key === "ArrowDown" ? 1 : -1;
        items[(index + step + items.length) % items.length]?.focus();
      }
    };
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (menu.contains(target) || anchor.contains(target)) return;
      this.close(false);
    };
    this.doc.addEventListener("pointerdown", outside);
    this.doc.addEventListener("keydown", keydown);
    this.cleanup = () => {
      this.doc.removeEventListener("pointerdown", outside);
      this.doc.removeEventListener("keydown", keydown);
    };
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }

  close(restoreFocus = true): void {
    const anchor = this.anchor;
    this.cleanup?.();
    this.cleanup = null;
    this.refreshAgents = null;
    this.menu?.remove();
    this.menu = null;
    this.anchor = null;
    anchor?.setAttribute("aria-expanded", "false");
    if (restoreFocus && anchor?.isConnected) anchor.focus();
  }
}
