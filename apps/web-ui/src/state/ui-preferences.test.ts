// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { UI_PREFERENCES_KEY, UiPreferences, browserStorage, watchTheme } from "./ui-preferences.js";
afterEach(() => localStorage.clear());
it("migrates the three legacy keys into a validated single snapshot", () => {
  localStorage.setItem("hilo.sidebarWidthPx", "320");
  localStorage.setItem("hilo.inspectorWidthPx", "580");
  localStorage.setItem("hilo.treeHidden", "true");
  const prefs = new UiPreferences(localStorage);
  expect(prefs.getState()).toEqual({
    sidebarWidthPx: 320,
    inspectorWidthPx: 580,
    treeHidden: true,
    theme: "dark",
  });
  expect(localStorage.length).toBe(1);
  prefs.setPanelWidth("sidebar", 400, false);
  expect(JSON.parse(localStorage.getItem(UI_PREFERENCES_KEY) as string).sidebarWidthPx).toBe(320);
  prefs.setPanelWidth("sidebar", 400);
  prefs.setTreeHidden(false);
  expect(new UiPreferences(localStorage).getState()).toEqual({
    sidebarWidthPx: 400,
    inspectorWidthPx: 580,
    treeHidden: false,
    theme: "dark",
  });
  prefs.setPanelWidth("sidebar", null);
  expect(new UiPreferences(localStorage).getState().sidebarWidthPx).toBeNull();
});
it("uses safe defaults for corrupt snapshots and bounds finite persisted widths", () => {
  for (const raw of ["broken", "null", "[]"]) {
    localStorage.setItem(UI_PREFERENCES_KEY, raw);
    expect(new UiPreferences(localStorage).getState()).toEqual({
      sidebarWidthPx: null,
      inspectorWidthPx: null,
      treeHidden: false,
      theme: "dark",
    });
  }
  localStorage.setItem(
    UI_PREFERENCES_KEY,
    JSON.stringify({ sidebarWidthPx: 999999, inspectorWidthPx: -1, treeHidden: "true" }),
  );
  expect(new UiPreferences(localStorage).getState()).toEqual({
    sidebarWidthPx: 560,
    inspectorWidthPx: null,
    treeHidden: false,
    theme: "dark",
  });
});
it("works with denied getters and retains legacy keys if persistence fails", () => {
  const denied = {
    getItem: () => {
      throw Error("denied");
    },
    setItem: () => {
      throw Error("quota");
    },
    removeItem: () => {
      throw Error("must not remove");
    },
  };
  const removeItem = vi.fn();
  new UiPreferences({
    getItem: (key) => (key === "hilo.sidebarWidthPx" ? "320" : null),
    setItem: () => {
      throw Error("quota");
    },
    removeItem,
  });
  expect(removeItem).not.toHaveBeenCalled();
  const prefs = new UiPreferences(denied);
  prefs.setTreeHidden(true);
  prefs.setPanelWidth("sidebar", 320);
  expect(prefs.getState().treeHidden).toBe(true);
  const fake = {
    defaultView: {
      get localStorage() {
        throw Error("denied");
      },
    },
  } as unknown as Document;
  expect(browserStorage(fake)).toBeUndefined();
});
it("applies the persisted theme, tracks store changes, and mirrors other windows", () => {
  localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify({ theme: "light" }));
  const preferences = new UiPreferences(localStorage);
  const stop = watchTheme(document, preferences);
  expect(document.documentElement.getAttribute("data-theme")).toBe("light");

  preferences.setTheme("dark");
  expect(document.documentElement.getAttribute("data-theme")).toBeNull();

  localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify({ theme: "light" }));
  window.dispatchEvent(
    new StorageEvent("storage", { key: UI_PREFERENCES_KEY, storageArea: localStorage }),
  );
  expect(preferences.getState().theme).toBe("light");
  expect(document.documentElement.getAttribute("data-theme")).toBe("light");

  stop();
  preferences.setTheme("dark");
  window.dispatchEvent(
    new StorageEvent("storage", { key: UI_PREFERENCES_KEY, storageArea: localStorage }),
  );
  expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  document.documentElement.removeAttribute("data-theme");
});
