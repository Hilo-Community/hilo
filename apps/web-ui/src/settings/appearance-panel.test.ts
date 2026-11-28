// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { UiPreferences } from "../state/ui-preferences.js";
import { AppearancePanel } from "./appearance-panel.js";

describe("AppearancePanel", () => {
  it("marks the persisted theme as selected and switches it on click", () => {
    const preferences = new UiPreferences(localStorage);
    const panel = new AppearancePanel(document, preferences);
    const buttons = [...panel.element.querySelectorAll("button")];
    const dark = buttons.find((b) => b.textContent === "Dark");
    const light = buttons.find((b) => b.textContent === "Light");
    expect(dark?.getAttribute("aria-checked")).toBe("true");
    expect(light?.getAttribute("aria-checked")).toBe("false");

    light?.click();
    expect(preferences.getState().theme).toBe("light");
    expect(light?.getAttribute("aria-checked")).toBe("true");
    expect(dark?.getAttribute("aria-checked")).toBe("false");

    panel.destroy();
    localStorage.clear();
  });

  it("reflects a theme change made elsewhere on the same preferences store", () => {
    const preferences = new UiPreferences(localStorage);
    const panel = new AppearancePanel(document, preferences);
    preferences.setTheme("light");
    const light = [...panel.element.querySelectorAll("button")].find(
      (b) => b.textContent === "Light",
    );
    expect(light?.classList.contains("is-selected")).toBe(true);
    panel.destroy();
    localStorage.clear();
  });
});
