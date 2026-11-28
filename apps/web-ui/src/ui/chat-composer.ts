import { type PromptInput, createPromptInput } from "@hilo/editor-cm6";
import { UI_STRINGS } from "./ui-strings.js";

const SVG =
  'xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
// A heavier stroke than the other icons so the arrow reads at 16px inside the round button.
// One path, not two: the disabled arrow is translucent and overlapping strokes would show lighter.
const SEND_ICON = `<svg ${SVG.replace('stroke-width="2"', 'stroke-width="2.75"')}><path d="M12 19V5M5 12l7-7 7 7"/></svg>`;
const STOP_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>';

export interface NativeChatHost {
  send(
    requestId: string,
    messages: readonly { role: "user" | "assistant"; content: string }[],
  ): Promise<string>;
  cancel(requestId: string): Promise<void>;
}

/** Keeps the CodeMirror draft mounted while the conversation and transport state change. */
export class ChatComposer {
  readonly element: HTMLFormElement;
  private readonly input: PromptInput;
  private readonly submit: HTMLButtonElement;
  private readonly cancel: HTMLButtonElement;

  constructor(
    doc: Document,
    onSend: (text: string) => void,
    onCancel: () => void,
    mentionPaths?: (query: string) => readonly string[],
    onDraftChange?: (text: string) => void,
  ) {
    const form = doc.createElement("form");
    form.className = "hilo-agent-composer";
    this.element = form;
    this.input = createPromptInput(form, {
      placeholder: UI_STRINGS.agent.ask,
      ariaLabel: UI_STRINGS.agent.prompt,
      maxLength: 24 * 1024,
      maxHeight: 220,
      ...(mentionPaths ? { mentionPaths } : {}),
      ...(onDraftChange ? { onChange: onDraftChange } : {}),
      onSubmit: () => form.requestSubmit(),
      onMultilineChange: (multiline) => form.classList.toggle("is-multiline", multiline),
    });
    this.submit = doc.createElement("button");
    this.submit.className = "hilo-agent-send";
    this.submit.type = "submit";
    this.submit.innerHTML = SEND_ICON;
    this.submit.setAttribute("aria-label", UI_STRINGS.agent.send);
    this.cancel = doc.createElement("button");
    this.cancel.className = "hilo-agent-stop";
    this.cancel.type = "button";
    this.cancel.innerHTML = STOP_ICON;
    this.cancel.setAttribute("aria-label", UI_STRINGS.agent.cancel);
    this.cancel.addEventListener("click", onCancel);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = this.input.getText().trim();
      if (text && !this.submit.disabled) onSend(text);
    });
    const bar = doc.createElement("div");
    bar.className = "hilo-agent-bar";
    bar.append(this.submit, this.cancel);
    form.append(bar);
  }

  update(state: {
    started: boolean;
    busy: boolean;
    canCancel: boolean;
    pendingLabel: string;
  }): void {
    this.submit.disabled = Boolean(state.pendingLabel) || state.busy;
    this.submit.setAttribute("aria-label", state.pendingLabel || UI_STRINGS.agent.send);
    this.submit.title = state.pendingLabel;
    this.cancel.disabled = !state.canCancel;
    this.submit.hidden = state.busy;
    this.cancel.hidden = !state.busy;
    this.input.setPlaceholder(state.started ? UI_STRINGS.agent.followUp : UI_STRINGS.agent.ask);
  }

  restoreDraft(text: string): void {
    this.input.setText(text);
  }

  clearSent(text: string): void {
    if (this.input.getText().trim() === text) this.input.setText("");
  }

  destroy(): void {
    this.input.destroy();
  }
}
