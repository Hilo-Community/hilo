import type { AcpEvent, AgentHost } from "@hilo/web-ui";
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
export interface AgentChannel {
  onmessage: (event: AcpEvent) => void;
}
export function createTauriAgentHost(invoke: Invoke, channel: () => AgentChannel): AgentHost {
  return {
    transcripts: {
      load: (chatId) => invoke("agent_transcript_load_command", { chatId }),
      save: (chatId, json) => invoke("agent_transcript_save_command", { chatId, payload: json }),
      remove: (chatId) => invoke("agent_transcript_delete_command", { chatId }),
    },
    signOut: (installedAgentId) =>
      invoke("agent_account_sign_out_command", { agentId: installedAgentId }),
    async start(config, onEvent) {
      const events = channel();
      events.onmessage = onEvent;
      const id = await invoke<number>("agent_start_command", {
        ...config,
        events,
      });
      return {
        startLogin: () => invoke("agent_terminal_auth_start_command", { id }),
        chooseAuth: (methodId) => invoke("agent_auth_choose_command", { id, methodId }),
        setOption: (optionId, value) => invoke("agent_option_command", { id, optionId, value }),
        openLogin: () => invoke("agent_terminal_auth_open_command", { id }),
        writeLogin: (data) => invoke("agent_terminal_auth_input_command", { id, data }),
        resizeLogin: (cols, rows) =>
          invoke("agent_terminal_auth_resize_command", { id, cols, rows }),
        prompt: (text, previousTurns) =>
          invoke("agent_prompt_command", { id, text, previousTurns }),
        cancel: () => invoke("agent_cancel_command", { id }),
        stop: () => invoke("agent_stop_command", { id }),
        answer: (requestId, choice) =>
          invoke("agent_permission_command", {
            id,
            requestId,
            ...(typeof choice === "string" ? { optionId: choice } : { allow: choice }),
          }),
        elicit: (requestId, action) =>
          invoke("agent_elicitation_command", { id, requestId, action }),
      };
    },
  };
}
