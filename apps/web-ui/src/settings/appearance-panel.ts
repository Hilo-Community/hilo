import type { Theme, UiPreferences } from "../state/ui-preferences.js";

const OPTIONS: ReadonlyArray<{ value: Theme; label: string }> = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

/** Lets the person pick between the dark and light palettes; the choice applies immediately. */
export class AppearancePanel {
  readonly element: HTMLElement;
  private readonly buttons = new Map<Theme, HTMLButtonElement>();
  private readonly unsubscribe: () => void;

  constructor(
    doc: Document,
    private readonly preferences: UiPreferences,
  ) {
    this.element = doc.createElement("section");
    this.element.className = "hilo-appearance";
    this.element.setAttribute("aria-label", "Appearance");

    const title = doc.createElement("h2");
    title.textContent = "Appearance";
    const about = doc.createElement("p");
    about.textContent = "Choose the color theme for Hilo's windows.";

    const group = doc.createElement("div");
    group.className = "hilo-appearance-options";
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", "Theme");
    for (const option of OPTIONS) {
      const button = doc.createElement("button");
      button.type = "button";
      button.textContent = option.label;
      button.setAttribute("role", "radio");
      button.addEventListener("click", () => this.preferences.setTheme(option.value));
      this.buttons.set(option.value, button);
      group.append(button);
    }

    this.element.append(title, about, group);
    this.render(preferences.getState().theme);
    this.unsubscribe = preferences.subscribeSelector(
      (state) => state.theme,
      (theme) => this.render(theme),
    );
  }

  destroy(): void {
    this.unsubscribe();
    this.element.remove();
  }

  private render(theme: Theme): void {
    for (const [value, button] of this.buttons) {
      const selected = value === theme;
      button.setAttribute("aria-checked", String(selected));
      button.classList.toggle("is-selected", selected);
    }
  }
}
