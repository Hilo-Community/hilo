import {
  type InlineCompletionStatus,
  SettingsPage,
  UiPreferences,
  browserStorage,
  watchTheme,
} from "@hilo/web-ui";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createTauriAgentRegistryHost } from "./tauri-agent-registry-host.js";

/** Entry point for the independent native Settings window; never boots another editor. */
export function mountSettingsWindow(root: HTMLElement): void {
  root.className = "hilo-standalone-settings";
  const preferences = new UiPreferences(browserStorage(document));
  const stopThemeWatch = watchTheme(document, preferences);
  const page = new SettingsPage(document, {
    agentRegistry: createTauriAgentRegistryHost(invoke),
    inlineCompletion: {
      status: () => invoke<InlineCompletionStatus>("inline_completion_status_command"),
      save: (settings) => invoke("set_inline_completion_settings_command", { settings }),
    },
    preferences,
  });
  root.replaceChildren(page.element);
  page.showExternalAgents();
  let stop: (() => void) | undefined;
  let disposed = false;
  void listen("settings-open-external-agents", () => page.showExternalAgents()).then((unlisten) => {
    if (disposed) unlisten();
    else stop = unlisten;
  });
  window.addEventListener(
    "pagehide",
    () => {
      disposed = true;
      stop?.();
      stopThemeWatch();
      page.destroy();
    },
    { once: true },
  );
}
