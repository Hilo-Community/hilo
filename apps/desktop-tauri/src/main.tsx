import type { InlineCompletionResponse } from "@hilo/editor-cm6";
import type { DocumentDiagnostics, LanguageFeatureResponse } from "@hilo/protocol-types";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { StrictMode, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import "@hilo/web-ui/theme.css";
import type { NativeMigrationReport, WorkspaceTrustReport } from "@hilo/web-ui";
import {
  type BackgroundServicesState,
  decodeWorkspaceSessionCacheBinary,
  encodeWorkspaceSessionCacheBinary,
  lazyBootDesktopCockpit,
} from "./index.js";
import "./shell.css";
import type { AcpEvent } from "@hilo/web-ui";
import { createAgentFinishedAlert } from "./agent-alert.js";
import { NativeThreadHistory } from "./native-thread-history.js";
import { createTauriAgentHost } from "./tauri-agent-host.js";
import { createTauriAgentRegistryHost } from "./tauri-agent-registry-host.js";
import { TauriBinaryHostBridge } from "./tauri-binary-host-bridge.js";
import { createTauriDebugHost } from "./tauri-debug-host.js";
import { createTauriJudgeHost } from "./tauri-judge-host.js";
import { createTauriTerminalHost } from "./tauri-terminal-host.js";

import { mountSettingsWindow } from "./settings-window.js";

interface NativeWorkspaceNode {
  readonly path: string;
  readonly name: string;
  readonly depth: number;
  readonly isDirectory: boolean;
}

interface NativeSearchResult {
  readonly filePath: string;
  readonly line: number;
  readonly snippet: string;
  readonly freshness: "LiveUnsavedBuffer" | "IndexedCommit" | "StaleNeedsReindex";
  readonly score: number;
  readonly secretsRedacted: number;
}

interface NativeAstAnalysis {
  readonly symbols: ReadonlyArray<{
    readonly name: string;
    readonly kind: "function" | "component" | "class" | "interface" | "type" | "const";
    readonly line: number;
    readonly exported: boolean;
    readonly confidence: "ExactAstLsp" | "HeuristicText";
  }>;
  readonly impactedTests: ReadonlyArray<{
    readonly testFilePath: string;
    readonly coveredSymbol: string;
    readonly confidence: "ExactAstLsp" | "HeuristicText";
  }>;
}

/** Carries one tool's diagnostics for one revision of one document (see `lsp/session.rs`). */
const DOCUMENT_DIAGNOSTICS_EVENT = "hilo-document-diagnostics";

/** Sent by the Rust side when closing or quitting was held back because of unsaved changes. */
const CLOSE_REQUESTED_EVENT = "hilo-close-requested";

function mapWorkspaceNodes(nodes: readonly NativeWorkspaceNode[]) {
  return nodes.map((node) => ({
    ...node,
    validationState: "UnchangedBlue" as const,
  }));
}

function HiloDesktopApp() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let desktop: ReturnType<typeof lazyBootDesktopCockpit> | undefined;
    let sessionPersistenceTimer: number | undefined;
    let stopListeningForClose: (() => void) | undefined;
    let stopListeningForDiagnostics: (() => void) | undefined;
    let sessionWrite = Promise.resolve();
    const agentHost = createTauriAgentHost(invoke, () => new Channel<AcpEvent>());
    const nativeHistory = agentHost.transcripts
      ? new NativeThreadHistory(agentHost.transcripts)
      : null;
    const persistSession = () => {
      if (!desktop) return;
      const state = desktop.stores.zone3.getState();
      const payload = Array.from(desktop.exportSessionCacheBinary(!nativeHistory));
      const write = sessionWrite.then(async () => {
        await nativeHistory?.save(state);
        await invoke<void>("save_session_cache_command", { payload });
      });
      sessionWrite = write.catch(() => undefined);
      return write;
    };

    void invoke<number[] | null>("load_session_cache_command")
      .catch(() => null)
      .then(async (cachedBytes) => {
        if (cancelled) return;
        let validCachedBytes: Uint8Array | undefined;
        let restoredWorkspaceNodes: ReturnType<typeof mapWorkspaceNodes> | undefined;
        if (cachedBytes) {
          const candidate = Uint8Array.from(cachedBytes);
          try {
            const snapshot = decodeWorkspaceSessionCacheBinary(candidate);
            if (nativeHistory) {
              const chatMessages = await nativeHistory.load(
                snapshot.chats ?? [],
                snapshot.chatMessages,
              );
              validCachedBytes = encodeWorkspaceSessionCacheBinary({ ...snapshot, chatMessages });
            } else {
              validCachedBytes = candidate;
            }
            if (snapshot.workspaceRoot && snapshot.workspaceRoot !== "/workspace/hilo") {
              const nodes = await invoke<NativeWorkspaceNode[]>("load_workspace_command", {
                root: snapshot.workspaceRoot,
              }).catch(() => []);
              restoredWorkspaceNodes = mapWorkspaceNodes(nodes);
              if (
                !nodes.some((node) => !node.isDirectory && node.path === snapshot.activeDocumentId)
              ) {
                const firstFile = nodes.find((node) => !node.isDirectory);
                const activeDocumentId = firstFile?.path ?? "untitled:welcome.ts";
                const activeDocumentContent = firstFile
                  ? await invoke<string>("read_workspace_file_command", {
                      relativePath: firstFile.path,
                    }).catch(() => "")
                  : "// Empty workspace\n";
                validCachedBytes = encodeWorkspaceSessionCacheBinary({
                  ...decodeWorkspaceSessionCacheBinary(validCachedBytes),
                  activeDocumentId,
                  activeDocumentContent,
                });
              }
            }
          } catch {
            validCachedBytes = undefined;
          }
        }
        if (cancelled) return;
        const ipcChannel = new TauriBinaryHostBridge();
        desktop = lazyBootDesktopCockpit({
          rootContainer: host,
          ipcChannel,
          ...(validCachedBytes ? { cachedSessionBytes: validCachedBytes } : {}),
          ...(restoredWorkspaceNodes ? { initialFileTree: restoredWorkspaceNodes } : {}),
          openWorkspace: async () => {
            const selected = await open({ directory: true, multiple: false });
            if (!selected) return null;
            const nodes = await invoke<NativeWorkspaceNode[]>("load_workspace_command", {
              root: selected,
            });
            desktop?.setWorkspaceRoot(selected);
            void invoke("initialize_background_services_command");
            return mapWorkspaceNodes(nodes);
          },
          switchWorkspace: async (root) => {
            const nodes = await invoke<NativeWorkspaceNode[]>("load_workspace_command", { root });
            desktop?.setWorkspaceRoot(root);
            void invoke("initialize_background_services_command");
            return mapWorkspaceNodes(nodes);
          },
          // A sound whenever an agent finishes, plus a notification for a session not on screen.
          onAgentFinished: createAgentFinishedAlert(invoke),
          closeWorkspaceSessions: (path) =>
            invoke<void>("close_workspace_sessions_command", { root: path }),
          readWorkspaceFile: (path) =>
            invoke<string>("read_workspace_file_command", { relativePath: path }),
          // Rust holds the window open while this is above zero (see commands/window.rs).
          onUnsavedCountChange: (count) => {
            void invoke("report_unsaved_buffers_command", { count });
          },
          // Ctrl+`: shells in the trusted workspace, streamed over a binary channel.
          terminalHost: createTauriTerminalHost(
            invoke,
            () => new Channel<ArrayBuffer>(),
            () => new Channel<{ agentId: string | null; busy: boolean }>(),
          ),
          agentHost,
          nativeChat: {
            send: (requestId, messages) =>
              invoke<string>("native_chat_command", { requestId, messages }),
            cancel: (requestId) => invoke<void>("cancel_native_chat_command", { requestId }),
          },
          judgeHost: createTauriJudgeHost(invoke, listen),
          agentRegistryHost: createTauriAgentRegistryHost(invoke),
          openSettingsWindow: () => invoke<void>("open_settings_window_command"),
          // F5: debug the shown JavaScript file (vscode-js-debug, trusted workspaces only).
          debugHost: createTauriDebugHost(invoke, () => new Channel<ArrayBuffer>()),
          // The decision is taken in a native dialog owned by the Rust side (commands/trust.rs).
          workspaceTrust: {
            getTrust: () => invoke<WorkspaceTrustReport>("workspace_trust_command"),
            requestTrust: async () => {
              const report = await invoke<WorkspaceTrustReport>("request_workspace_trust_command");
              // Services that were held back (language servers, linters) may start now.
              if (report.state === "Trusted") void invoke("initialize_background_services_command");
              return report;
            },
          },
          searchWorkspace: (query) =>
            invoke<NativeSearchResult[]>("search_workspace_command", { query, limit: 100 }),
          analyzeDocument: async (documentId, sessionGeneration) => {
            await ipcChannel.waitForDocumentReady();
            return invoke<NativeAstAnalysis>("analyze_document_command", {
              documentId,
              sessionGeneration,
            });
          },
          initializeBackgroundServices: () =>
            invoke<BackgroundServicesState>("initialize_background_services_command"),
          loadNativeMigrationReport: () =>
            invoke<NativeMigrationReport>("run_native_migration_command"),
        });
        // Completions, F12 and Shift+Alt+F, answered by vtsls/Biome about one exact revision.
        desktop.editorView.setLanguageFeatureProvider(
          (request) => invoke<LanguageFeatureResponse>("language_feature_command", { request }),
          (location) => {
            if (location.inside_workspace) {
              void desktop?.domController?.openWorkspaceFile(location.file_path);
            }
          },
        );
        // Ghost-text suggestions from the local model (strict local mode, no account). The
        // host reads the text from its own rope and cancels a call on the next keystroke.
        desktop.editorView.setInlineCompletionProvider((request) =>
          invoke<InlineCompletionResponse | null>("inline_completion_command", { request }),
        );
        sessionPersistenceTimer = window.setInterval(() => {
          void persistSession()?.catch(() => undefined);
        }, 2_000);
        // The editor places each batch by its revision, and drops what its text has moved past.
        void listen<DocumentDiagnostics>(DOCUMENT_DIAGNOSTICS_EVENT, (event) => {
          desktop?.editorView.applyDocumentDiagnostics(event.payload);
        }).then((stopListening) => {
          if (cancelled) stopListening();
          else stopListeningForDiagnostics = stopListening;
        });
        // Flush the chat history and session cache before letting Rust close the window.
        void listen(CLOSE_REQUESTED_EVENT, async () => {
          const allowed = (await desktop?.domController?.confirmClose()) ?? true;
          if (!allowed) return;
          await persistSession()?.catch(() => undefined);
          await invoke("confirm_exit_command");
        }).then((stopListening) => {
          if (cancelled) stopListening();
          else {
            stopListeningForClose = stopListening;
            return invoke("register_close_handler_command");
          }
        });
      });

    return () => {
      cancelled = true;
      if (sessionPersistenceTimer !== undefined) window.clearInterval(sessionPersistenceTimer);
      stopListeningForClose?.();
      stopListeningForDiagnostics?.();
      if (desktop) {
        void persistSession()?.catch(() => undefined);
        desktop.destroy();
      }
    };
  }, []);

  return <div ref={hostRef} className="hilo-desktop-root" />;
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing #root desktop mount point");

if (new URLSearchParams(window.location.search).get("view") === "settings") {
  mountSettingsWindow(rootElement);
} else {
  createRoot(rootElement).render(
    <StrictMode>
      <HiloDesktopApp />
    </StrictMode>,
  );
}
