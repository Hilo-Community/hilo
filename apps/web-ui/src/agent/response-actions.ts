import { writeClipboard } from "../ui/code-blocks.js";
import { UI_STRINGS } from "../ui/ui-strings.js";

const SVG =
  'xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const COPY_ICON = `<svg ${SVG}><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const CHECK_ICON = `<svg ${SVG}><path d="M20 6 9 17l-5-5"/></svg>`;
const RETRY_ICON = `<svg ${SVG}><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>`;

/** How long "Copied" shows before the button reads "Copy" again. */
const COPIED_MS = 1500;

/**
 * The row under a finished answer: copy the answer's text, and retry the last turn. It appears
 * once the turn ends (with a short fade), never while the agent is still writing.
 */
export class ResponseActionsView {
  readonly element: HTMLElement;
  private readonly copyButton: HTMLButtonElement;
  private readonly retryButton: HTMLButtonElement;
  private text = "";
  private retry: (() => void) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(doc: Document) {
    this.element = doc.createElement("div");
    this.element.className = "hilo-agent-response-actions";
    this.copyButton = this.button(doc, UI_STRINGS.agent.copyResponse, COPY_ICON, () => this.copy());
    this.retryButton = this.button(doc, UI_STRINGS.agent.retryResponse, RETRY_ICON, () =>
      this.retry?.(),
    );
    this.element.append(this.copyButton, this.retryButton);
  }

  /** `retry` only for the latest answer: retrying an older one would rewrite history. */
  update(text: string, retry: (() => void) | undefined): HTMLElement {
    this.text = text;
    this.retry = retry;
    this.retryButton.hidden = retry === undefined;
    return this.element;
  }

  dispose(): void {
    clearTimeout(this.timer);
  }

  private button(doc: Document, label: string, icon: string, click: () => void) {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "hilo-agent-response-action";
    button.setAttribute("aria-label", label);
    button.title = label;
    button.innerHTML = icon;
    button.addEventListener("click", click);
    return button;
  }

  private copy(): void {
    void writeClipboard(this.element.ownerDocument, this.text).then((copied) => {
      if (!copied) return;
      this.copyButton.innerHTML = CHECK_ICON;
      this.copyButton.dataset.copied = "";
      this.copyButton.setAttribute("aria-label", UI_STRINGS.agent.copiedResponse);
      this.copyButton.title = UI_STRINGS.agent.copiedResponse;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.copyButton.innerHTML = COPY_ICON;
        delete this.copyButton.dataset.copied;
        this.copyButton.setAttribute("aria-label", UI_STRINGS.agent.copyResponse);
        this.copyButton.title = UI_STRINGS.agent.copyResponse;
      }, COPIED_MS);
    });
  }
}
