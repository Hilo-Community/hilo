// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  SidebarRow,
  relativeTime,
  sessionDisplayTitle,
  splitSessionNumber,
} from "./sidebar-row.js";

describe("session number written after the name", () => {
  it("splits '#16 New session' into its number and name", () => {
    expect(splitSessionNumber("#16 New session")).toEqual({ number: "#16", name: "New session" });
    expect(splitSessionNumber("#4 Fix login")).toEqual({ number: "#4", name: "Fix login" });
    // Anything else is a plain name, e.g. a session the user renamed.
    expect(splitSessionNumber("Fix login")).toEqual({ number: null, name: "Fix login" });
    expect(splitSessionNumber("#16")).toEqual({ number: null, name: "#16" });
  });

  it("reads '#16 New session' as 'New session #16', in a single text", () => {
    expect(sessionDisplayTitle("#16 New session")).toBe("New session #16");
    expect(sessionDisplayTitle("Renamed")).toBe("Renamed");

    const row = new SidebarRow(document, { kind: "session", onSelect: () => {}, onMore: () => {} });
    row.update("#16 New session", false);
    expect(row.el.querySelector(".sidebar-row-title")?.textContent).toBe("New session #16");
    // The stored title stays as the tooltip, and nothing else carries the number.
    expect(row.select.getAttribute("title")).toBe("#16 New session");
    expect(row.el.querySelector(".sidebar-row-badge")).toBeNull();

    const group = new SidebarRow(document, { kind: "group", onSelect: () => {}, onMore: () => {} });
    group.update("#1 Workspace", false, true);
    expect(group.el.querySelector(".sidebar-row-title")?.textContent).toBe("#1 Workspace");
  });
});

describe("relative time under a session's title", () => {
  const now = Date.UTC(2026, 10, 28, 12);
  it("reads the elapsed time in the largest whole unit", () => {
    expect(relativeTime(now - 20_000, now)).toBe("just now");
    expect(relativeTime(now + 5_000, now)).toBe("just now");
    expect(relativeTime(now - 60_000, now)).toBe("1 minute ago");
    expect(relativeTime(now - 23 * 60_000, now)).toBe("23 minutes ago");
    expect(relativeTime(now - 2 * 3_600_000, now)).toBe("2 hours ago");
    expect(relativeTime(now - 26 * 3_600_000, now)).toBe("yesterday");
    expect(relativeTime(now - 10 * 86_400_000, now)).toBe("last week");
  });

  it("adds and removes the second line without touching the title", () => {
    const row = new SidebarRow(document, { kind: "session", onSelect: () => {}, onMore: () => {} });
    row.update("Review", false);
    row.setSubtitle("3 minutes ago");
    expect(row.el.querySelector(".sidebar-row-subtitle")?.textContent).toBe("3 minutes ago");
    row.setSubtitle(null);
    expect(row.el.querySelector(".sidebar-row-subtitle")).toBeNull();
    expect(row.el.querySelector(".sidebar-row-title")?.textContent).toBe("Review");
  });
});
