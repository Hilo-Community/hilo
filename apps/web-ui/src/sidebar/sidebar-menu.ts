import { createPromptInput } from "@hilo/editor-cm6";
import { button } from "../ui/dom-utils.js";
import { UI_STRINGS } from "../ui/ui-strings.js";
import { SEARCH_ICON } from "./icons.js";
import { MENU_CHECK_ICON, MENU_CHEVRON_RIGHT_ICON } from "./menu-icons.js";
import { type MenuBounds, placeMenu } from "./menu-placement.js";

interface SidebarMenuEntry {
  readonly label: string;
  readonly disabled?: boolean;
  /** Why the entry is disabled; shown as its tooltip. */
  readonly reason?: string;
  /** A destructive entry: drawn in red. */
  readonly danger?: boolean;
  readonly highlighted?: boolean;
  /** Draws a line above this entry, to group the entries that belong together. */
  readonly separatorBefore?: boolean;
  /** An icon (14 px SVG markup) shown before the label. */
  readonly icon?: string;
  /** A shortcut or other short note, shown at the end of the row. */
  readonly hint?: string;
}

export interface SidebarMenuAction extends SidebarMenuEntry {
  readonly run: () => void;
  readonly checked?: boolean;
  readonly checkbox?: boolean;
}

export type MenuEntry =
  | SidebarMenuAction
  | (SidebarMenuEntry & {
      readonly submenu: readonly MenuEntry[] | (() => readonly MenuEntry[]);
      readonly value?: string;
      readonly searchLabel?: string;
      readonly showTitle?: boolean;
    });

interface MenuOptions {
  readonly focusFirst?: boolean;
  readonly searchLabel?: string;
  readonly showTitle?: boolean;
  readonly reset?: { readonly label: string; readonly run: () => void; readonly hidden?: boolean };
}

/** Room the menu may use: the visible part of the sidebar, within the window. */
function visibleBounds(host: HTMLElement): MenuBounds {
  const doc = host.ownerDocument;
  const view = host.closest<HTMLElement>(".hilo-zone-2-viewport") ?? host;
  const rect = view.getBoundingClientRect();
  const windowHeight = doc.defaultView?.innerHeight ?? doc.documentElement.clientHeight;
  const top = Math.max(0, rect.top);
  const bottom = rect.height > 0 ? Math.min(windowHeight, rect.bottom) : windowHeight;
  return { top, bottom };
}

export class SidebarMenu {
  private menu: HTMLElement | undefined;
  private anchor: HTMLButtonElement | undefined;
  private cleanup: (() => void) | undefined;
  private submenu: SidebarMenu | undefined;
  private submenuCloseTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly host: HTMLElement,
    private readonly parent?: SidebarMenu,
  ) {}

  isOpen(): boolean {
    return this.menu !== undefined;
  }

  open(
    anchor: HTMLButtonElement,
    actions: readonly MenuEntry[],
    title?: string,
    { focusFirst = true, reset, searchLabel, showTitle }: MenuOptions = {},
  ): void {
    const same = this.anchor === anchor;
    this.close(false);
    if (same) return;
    const doc = this.host.ownerDocument;
    const menu = doc.createElement("div");
    menu.className = "sidebar-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute(
      "aria-label",
      title ?? anchor.getAttribute("aria-label") ?? UI_STRINGS.sidebar.options,
    );
    if (title && !this.parent) {
      const header = doc.createElement("div");
      header.className = "sidebar-menu-header";
      const heading = doc.createElement("div");
      heading.className = "sidebar-menu-title";
      heading.setAttribute("aria-hidden", "true");
      heading.textContent = title;
      header.appendChild(heading);
      if (reset) {
        const resetButton = button(doc, "sidebar-menu-reset");
        resetButton.textContent = reset.label;
        resetButton.hidden = reset.hidden ?? false;
        resetButton.setAttribute("role", "menuitem");
        resetButton.tabIndex = -1;
        resetButton.addEventListener("click", () => {
          this.close();
          reset.run();
        });
        header.appendChild(resetButton);
      }
      menu.appendChild(header);
    }
    const rows = new Map<HTMLButtonElement, string>();
    const searchField = searchLabel ? doc.createElement("div") : undefined;
    const search =
      searchField && searchLabel
        ? createPromptInput(searchField, {
            placeholder: searchLabel,
            ariaLabel: searchLabel,
            maxLength: 200,
            maxHeight: 24,
            onSubmit: () => {},
            onEscape: () => this.close(),
            onChange: (text) => {
              this.submenu?.close(false);
              const query = text.trim().toLowerCase();
              for (const [row, label] of rows) row.hidden = !label.includes(query);
            },
          })
        : undefined;
    if (searchField) {
      menu.classList.add("sidebar-menu--searchable");
      searchField.className = "sidebar-search sidebar-menu-search";
      const icon = doc.createElement("span");
      icon.className = "sidebar-menu-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.innerHTML = SEARCH_ICON;
      searchField.prepend(icon);
      menu.appendChild(searchField);
    }
    if (title && (searchLabel || showTitle)) {
      if (showTitle) menu.classList.add("sidebar-menu--titled");
      const heading = doc.createElement("div");
      heading.className = "sidebar-menu-section-title";
      heading.setAttribute("aria-hidden", "true");
      heading.textContent = title;
      menu.appendChild(heading);
    }
    this.anchor = anchor;
    this.menu = menu;
    anchor.setAttribute("aria-expanded", "true");
    const hasIcons = actions.some((action) => action.icon);
    for (const action of actions) {
      if (action.separatorBefore) {
        const line = doc.createElement("div");
        line.className = "sidebar-menu-separator";
        line.setAttribute("role", "separator");
        menu.appendChild(line);
      }
      const item = button(doc, "sidebar-menu-item");
      item.dataset.menuLabel = action.label;
      rows.set(item, action.label.toLowerCase());
      if (action.danger) item.classList.add("sidebar-menu-item--danger");
      if (action.highlighted) item.classList.add("sidebar-menu-item--highlighted");
      const main = doc.createElement("span");
      main.className = "sidebar-menu-label";
      // Entries without an icon keep the same gap when the others have one, so labels line up.
      if (hasIcons) {
        const icon = doc.createElement("span");
        icon.className = "sidebar-menu-icon";
        icon.setAttribute("aria-hidden", "true");
        if (action.icon) icon.innerHTML = action.icon;
        main.appendChild(icon);
      }
      main.append(action.label);
      item.appendChild(main);
      const trailing = doc.createElement("span");
      trailing.className = "sidebar-menu-trailing";
      if (action.hint) {
        const hint = doc.createElement("span");
        hint.className = "sidebar-menu-hint";
        hint.textContent = action.hint;
        trailing.appendChild(hint);
      }
      item.setAttribute("role", "menuitem");
      item.tabIndex = -1;
      item.disabled = action.disabled ?? false;
      if (item.disabled && action.reason) item.title = action.reason;
      if ("submenu" in action) {
        item.setAttribute("aria-haspopup", "menu");
        item.setAttribute("aria-expanded", "false");
        if (action.value !== undefined) {
          const value = doc.createElement("span");
          value.className = "sidebar-menu-value";
          value.textContent = action.value;
          value.hidden = action.value === "";
          trailing.appendChild(value);
        }
        const arrow = doc.createElement("span");
        arrow.className = "sidebar-menu-icon";
        arrow.setAttribute("aria-hidden", "true");
        arrow.innerHTML = MENU_CHEVRON_RIGHT_ICON;
        trailing.appendChild(arrow);
        const openSubmenu = (focus: boolean) => {
          clearTimeout(this.submenuCloseTimer);
          this.submenu ??= new SidebarMenu(doc.body, this);
          if (this.submenu.anchor === item) {
            if (focus)
              this.submenu.menu
                ?.querySelector<HTMLElement>('[role="textbox"], button:not(:disabled)')
                ?.focus();
            return;
          }
          const entries = typeof action.submenu === "function" ? action.submenu() : action.submenu;
          this.submenu.open(item, entries, action.label, {
            focusFirst: focus,
            ...(action.searchLabel ? { searchLabel: action.searchLabel } : {}),
            ...(action.showTitle ? { showTitle: true } : {}),
          });
          this.submenu.menu?.addEventListener("pointerenter", cancelClose);
          this.submenu.menu?.addEventListener("pointerleave", scheduleClose);
        };
        const cancelClose = () => this.cancelSubmenuClose();
        const scheduleClose = (event: PointerEvent) => {
          if (event.pointerType === "touch") return;
          cancelClose();
          // Leave time to cross the gap between the trigger and the submenu.
          this.submenuCloseTimer = setTimeout(() => {
            const submenu = this.submenu;
            const focused = doc.activeElement;
            submenu?.close(focused !== null && submenu.contains(focused));
          }, 180);
        };
        item.addEventListener("pointerenter", (event) => {
          if (event.pointerType !== "touch" && !item.disabled) openSubmenu(false);
        });
        item.addEventListener("pointerleave", scheduleClose);
        item.addEventListener("click", (event) => {
          if (event.detail === 0) openSubmenu(true);
        });
        item.addEventListener("keydown", (event) => {
          if (event.key !== "ArrowRight") return;
          event.preventDefault();
          openSubmenu(true);
        });
      } else {
        if (action.checked !== undefined) {
          item.setAttribute("role", action.checkbox ? "menuitemcheckbox" : "menuitemradio");
          item.setAttribute("aria-checked", String(action.checked));
          if (action.checkbox) {
            const check = doc.createElement("span");
            check.className = "sidebar-menu-checkbox";
            check.setAttribute("aria-hidden", "true");
            if (action.checked) check.innerHTML = MENU_CHECK_ICON;
            main.prepend(check);
            item.addEventListener("click", () => {
              const checked = item.getAttribute("aria-checked") !== "true";
              item.setAttribute("aria-checked", String(checked));
              check.innerHTML = checked ? MENU_CHECK_ICON : "";
              action.run();
            });
          } else if (action.checked) {
            const check = doc.createElement("span");
            check.className = "sidebar-menu-icon sidebar-menu-check";
            check.setAttribute("aria-hidden", "true");
            check.innerHTML = MENU_CHECK_ICON;
            trailing.appendChild(check);
          }
        }
        if (!action.checkbox) {
          item.addEventListener("click", () => {
            this.root().close();
            action.run();
          });
        }
      }
      if (trailing.childElementCount > 0) item.appendChild(trailing);
      menu.appendChild(item);
    }
    this.host.appendChild(menu);
    this.place(menu, anchor);

    const enabled = () =>
      Array.from(menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled):not([hidden])"));
    const keydown = (event: KeyboardEvent) => {
      if (
        event.target instanceof Node &&
        searchField?.contains(event.target) &&
        !["Escape", "ArrowDown", "ArrowUp", "Tab"].includes(event.key)
      )
        return;
      if (event.key === "Escape" || (event.key === "ArrowLeft" && this.parent)) {
        event.preventDefault();
        this.close();
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const items = enabled();
        const index = items.indexOf(doc.activeElement as HTMLButtonElement);
        const previous = index < 0 ? 0 : index;
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : event.key === "ArrowDown"
                ? (index + 1) % items.length
                : (previous - 1 + items.length) % items.length;
        items[next]?.focus();
      } else if (event.key === "Tab") this.root().close(false);
      else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        // Typing a letter jumps to the next entry that starts with it.
        const items = enabled();
        const start = items.indexOf(doc.activeElement as HTMLButtonElement) + 1;
        const letter = event.key.toLowerCase();
        const ordered = [...items.slice(start), ...items.slice(0, start)];
        const match = ordered.find((item) =>
          item.textContent?.trim().toLowerCase().startsWith(letter),
        );
        if (match) {
          event.preventDefault();
          match.focus();
        }
      }
    };
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!anchor.contains(target) && !this.contains(target)) this.close(false);
    };
    // Scrolling the sidebar or resizing the window moves the anchor away from the menu.
    const dismiss = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && this.contains(target)) return;
      this.close(false);
    };
    const view = doc.defaultView;
    doc.addEventListener("pointerdown", outside);
    doc.addEventListener("scroll", dismiss, true);
    view?.addEventListener("resize", dismiss);
    view?.addEventListener("blur", dismiss);
    menu.addEventListener("keydown", keydown);
    this.cleanup = () => {
      doc.removeEventListener("pointerdown", outside);
      doc.removeEventListener("scroll", dismiss, true);
      view?.removeEventListener("resize", dismiss);
      view?.removeEventListener("blur", dismiss);
      menu.removeEventListener("keydown", keydown);
      search?.destroy();
    };
    if (focusFirst)
      (search ?? menu.querySelector<HTMLElement>(".sidebar-menu-item:not(:disabled)"))?.focus();
  }

  private contains(target: Node): boolean {
    return Boolean(this.menu?.contains(target) || this.submenu?.contains(target));
  }

  setResetVisible(visible: boolean): void {
    const reset = this.menu?.querySelector<HTMLButtonElement>(".sidebar-menu-reset");
    if (reset) reset.hidden = !visible;
  }

  setEntryHighlight(label: string, highlighted: boolean, value?: string): void {
    const item = Array.from(this.menu?.querySelectorAll("button[data-menu-label]") ?? []).find(
      (item) => item.getAttribute("data-menu-label") === label,
    );
    if (item) {
      item.classList.toggle("sidebar-menu-item--highlighted", highlighted);
      const detail = item.querySelector<HTMLElement>(".sidebar-menu-value");
      if (detail && value !== undefined) {
        detail.textContent = value;
        detail.hidden = value === "";
      }
    }
    this.submenu?.setEntryHighlight(label, highlighted, value);
  }

  private root(): SidebarMenu {
    return this.parent?.root() ?? this;
  }

  private cancelSubmenuClose(): void {
    clearTimeout(this.submenuCloseTimer);
    this.parent?.cancelSubmenuClose();
  }

  /** Puts the menu under its button, or above it when it does not fit below. */
  private place(menu: HTMLElement, anchor: HTMLElement): void {
    if (this.parent?.menu) {
      menu.classList.add("sidebar-menu--submenu");
      const parentRect = this.parent.menu.getBoundingClientRect();
      const anchorRect = anchor.getBoundingClientRect();
      const view = menu.ownerDocument.defaultView;
      const width = menu.offsetWidth;
      const height = menu.offsetHeight;
      const viewportWidth = view?.innerWidth ?? parentRect.right + width;
      const viewportHeight = view?.innerHeight ?? anchorRect.top + height;
      const right = parentRect.right + 4;
      const left = right + width <= viewportWidth - 4 ? right : parentRect.left - width - 4;
      menu.style.left = `${Math.max(4, left)}px`;
      menu.style.top = `${Math.max(4, Math.min(anchorRect.top, viewportHeight - height - 4))}px`;
      return;
    }
    const hostRect = this.host.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const height = menu.offsetHeight || menu.getBoundingClientRect().height;
    const placement = placeMenu({
      anchor: { top: anchorRect.top, bottom: anchorRect.bottom },
      height,
      bounds: visibleBounds(this.host),
    });
    menu.dataset.placement = placement.side;
    if (placement.maxHeight !== undefined) {
      menu.style.maxHeight = `${placement.maxHeight}px`;
      menu.style.overflowY = "auto";
    }
    const shown =
      placement.maxHeight !== undefined ? Math.min(height, placement.maxHeight) : height;
    const scrolled = this.host.scrollTop;
    menu.style.top =
      placement.side === "below"
        ? `${anchorRect.bottom - hostRect.top + scrolled + 2}px`
        : `${anchorRect.top - hostRect.top + scrolled - shown - 2}px`;
  }

  closeIfDetached(): void {
    if (this.anchor && !this.anchor.isConnected) this.close(false);
  }

  close(restoreFocus = true): void {
    const anchor = this.anchor;
    clearTimeout(this.submenuCloseTimer);
    this.submenu?.close(false);
    this.submenu = undefined;
    this.cleanup?.();
    this.cleanup = undefined;
    this.menu?.remove();
    this.menu = undefined;
    this.anchor = undefined;
    anchor?.setAttribute("aria-expanded", "false");
    if (restoreFocus && anchor?.isConnected) anchor.focus();
  }
}
