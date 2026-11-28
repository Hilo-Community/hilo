import {
  HILO_STATE_VISUAL_TOKENS,
  type HiloStateVisualTokens,
  type MergeLayout,
  MergeReviewView,
} from "@hilo/editor-cm6";
import { JUDGE_STRINGS } from "./strings.js";
import type { AcceptResponse, JudgeReview, ReviewPreview } from "./types.js";

/** Most diagnostics listed; the agent got the full evidence. */
const MAX_LISTED_DIAGNOSTICS = 20;

export type AcceptOutcome = AcceptResponse | { readonly type: "moved" };

export interface ReviewPanelActions {
  /** Applies one file of the change (the Host plans it, the editor dispatches it). */
  accept(path: string): Promise<AcceptOutcome>;
  reject(): Promise<void>;
  adjust(note: string): Promise<void>;
  close(): void;
}

/**
 * The review of one judged change (`LOT-015`): its Hilo state and evidence, the diff of each
 * file in `@codemirror/merge`, and `[✓ Accept]`, `[✕ Reject]`, `[Request Adjustment]`.
 */
export class JudgeReviewPanel {
  readonly element: HTMLElement;
  private readonly merge: MergeReviewView;
  private readonly fileTabs: HTMLElement;
  private readonly conflictNotice: HTMLElement;
  private readonly status: HTMLElement;
  private readonly acceptButton: HTMLButtonElement;
  private readonly rejectButton: HTMLButtonElement;
  private readonly adjustButton: HTMLButtonElement;
  private readonly adjustForm: HTMLFormElement;
  private readonly adjustInput: HTMLTextAreaElement;
  private readonly layoutButtons = new Map<MergeLayout, HTMLButtonElement>();
  private selected: string;
  private readonly accepted = new Set<string>();
  private readonly conflicts = new Map<string, Extract<AcceptResponse, { type: "conflict" }>>();
  private busy = false;

  constructor(
    private readonly doc: Document,
    readonly review: JudgeReview,
    private readonly actions: ReviewPanelActions,
    layout: MergeLayout = "unified",
  ) {
    this.selected = review.files[0]?.path ?? "";
    this.element = doc.createElement("section");
    this.element.className = "hilo-judge-review";
    this.element.dataset.verdict = review.verdict;
    this.element.dataset.reviewId = review.reviewId;
    this.element.setAttribute("aria-label", JUDGE_STRINGS.panel);

    const header = this.el("header", "hilo-judge-review-header");
    const meta = HILO_STATE_VISUAL_TOKENS[review.verdict];
    const badge = this.el("span", "hilo-judge-badge", meta.labelEn);
    badge.dataset.state = review.verdict;
    badge.title = meta.labelEn;
    applyStateColors(badge, meta.dark);
    const attempts = this.el("span", "hilo-judge-meta", JUDGE_STRINGS.attempts(review.attempts));
    const close = this.button("hilo-judge-close", "×", () => this.actions.close());
    close.setAttribute("aria-label", JUDGE_STRINGS.close);
    header.append(badge, attempts, close);
    this.element.append(header);

    if (review.stopped) {
      this.element.append(
        this.el("p", "hilo-judge-stopped", JUDGE_STRINGS.stopped[review.stopped] ?? review.stopped),
      );
    }
    if (review.steps.length === 0) {
      this.element.append(this.el("p", "hilo-judge-stopped", JUDGE_STRINGS.noChecks));
    }
    const steps = this.el("ul", "hilo-judge-steps");
    for (const step of review.steps) {
      const item = this.el(
        "li",
        "hilo-judge-step",
        `${JUDGE_STRINGS.steps[step.kind]} — ${step.passed ? JUDGE_STRINGS.passed : JUDGE_STRINGS.failed} (${step.durationMs} ms)`,
      );
      item.dataset.passed = String(step.passed);
      if (!step.passed) item.style.color = HILO_STATE_VISUAL_TOKENS.FailedRed.dark.text;
      steps.append(item);
    }
    this.element.append(steps);

    if (review.diagnostics.length > 0) {
      const list = this.el("ul", "hilo-judge-diagnostics");
      for (const item of review.diagnostics.slice(0, MAX_LISTED_DIAGNOSTICS)) {
        const where = item.filePath ? `${item.filePath}:${item.line}:${item.column} ` : "";
        // Tool output is data: shown as text, never as markup.
        list.append(
          this.el(
            "li",
            "hilo-judge-diagnostic",
            `${where}[${item.code}] ${item.message.split("\n")[0]}`,
          ),
        );
      }
      this.element.append(list);
    }

    if (review.preview) this.element.append(this.previewSection(review.preview));

    const toolbar = this.el("div", "hilo-judge-toolbar");
    this.fileTabs = this.el("div", "hilo-judge-files");
    this.fileTabs.setAttribute("role", "tablist");
    this.fileTabs.setAttribute("aria-label", JUDGE_STRINGS.files);
    const layouts = this.el("div", "hilo-judge-layouts");
    layouts.setAttribute("role", "group");
    layouts.setAttribute("aria-label", JUDGE_STRINGS.layout);
    for (const [value, label] of [
      ["unified", JUDGE_STRINGS.unified],
      ["side-by-side", JUDGE_STRINGS.sideBySide],
    ] as const) {
      const option = this.button("hilo-judge-layout", label, () => this.setLayout(value));
      this.layoutButtons.set(value, option);
      layouts.append(option);
    }
    toolbar.append(this.fileTabs, layouts);
    this.element.append(toolbar);

    this.conflictNotice = this.el("p", "hilo-judge-conflict", JUDGE_STRINGS.conflict);
    this.conflictNotice.hidden = true;
    applyStateColors(this.conflictNotice, HILO_STATE_VISUAL_TOKENS.StaleOrange.dark);
    this.conflictNotice.setAttribute("role", "alert");
    this.element.append(this.conflictNotice);

    const file = this.file(this.selected);
    this.merge = new MergeReviewView(
      doc,
      { path: this.selected, original: file?.base_text ?? "", proposed: file?.proposed_text ?? "" },
      layout,
    );
    this.element.append(this.merge.element);

    const footer = this.el("footer", "hilo-judge-actions");
    this.acceptButton = this.button("hilo-judge-accept", JUDGE_STRINGS.accept, () => {
      void this.acceptSelected();
    });
    this.acceptButton.style.setProperty(
      "--judge-accept-border",
      HILO_STATE_VISUAL_TOKENS.ValidatedGreen.dark.border,
    );
    this.rejectButton = this.button("hilo-judge-reject", JUDGE_STRINGS.reject, () => {
      void this.run(() => this.actions.reject());
    });
    this.adjustButton = this.button("hilo-judge-adjust", JUDGE_STRINGS.adjust, () => {
      this.adjustForm.hidden = false;
      this.adjustInput.focus();
    });
    footer.append(this.acceptButton, this.rejectButton, this.adjustButton);

    this.adjustForm = doc.createElement("form");
    this.adjustForm.className = "hilo-judge-adjust-form";
    this.adjustForm.hidden = true;
    this.adjustInput = doc.createElement("textarea");
    this.adjustInput.className = "hilo-judge-adjust-input";
    this.adjustInput.placeholder = JUDGE_STRINGS.adjustPlaceholder;
    this.adjustInput.setAttribute("aria-label", JUDGE_STRINGS.adjustPlaceholder);
    this.adjustInput.maxLength = 8000;
    const send = doc.createElement("button");
    send.type = "submit";
    send.className = "hilo-judge-adjust-send";
    send.textContent = JUDGE_STRINGS.send;
    const cancel = this.button("hilo-judge-adjust-cancel", JUDGE_STRINGS.cancel, () => {
      this.adjustForm.hidden = true;
    });
    this.adjustForm.append(this.adjustInput, send, cancel);
    this.adjustForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const note = this.adjustInput.value.trim();
      if (note) void this.run(() => this.actions.adjust(note));
    });

    this.status = this.el("p", "hilo-judge-status");
    this.status.setAttribute("role", "status");
    this.element.append(footer, this.adjustForm, this.status);
    this.render();
  }

  getMergeView(): MergeReviewView {
    return this.merge;
  }

  selectFile(path: string): void {
    if (!this.file(path)) return;
    this.selected = path;
    this.render();
  }

  destroy(): void {
    this.merge.destroy();
    this.element.remove();
  }

  /**
   * The components' rendered DOM in an iframe with an empty `sandbox`: an opaque origin, no
   * script, no form, no navigation of the IDE. The document's own policy loads nothing.
   */
  private previewSection(preview: ReviewPreview): HTMLElement {
    const section = this.el("section", "hilo-judge-preview");
    section.append(this.el("h3", "hilo-judge-preview-title", JUDGE_STRINGS.preview));
    const frame = this.doc.createElement("iframe");
    frame.className = "hilo-judge-preview-frame";
    frame.setAttribute("sandbox", "");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.title = JUDGE_STRINGS.previewFrame;
    frame.srcdoc = preview.document;
    const tree = this.doc.createElement("details");
    tree.className = "hilo-judge-a11y";
    tree.append(
      this.el("summary", "", JUDGE_STRINGS.a11yTree),
      this.el("pre", "hilo-judge-a11y-tree", preview.a11y),
    );
    section.append(frame, tree);
    return section;
  }

  private setLayout(layout: MergeLayout): void {
    this.merge.setLayout(layout);
    this.render();
  }

  private async acceptSelected(): Promise<void> {
    const path = this.selected;
    await this.run(async () => {
      this.status.textContent = JUDGE_STRINGS.accepting;
      const outcome = await this.actions.accept(path);
      this.status.textContent = "";
      if (outcome.type === "conflict") {
        this.conflicts.set(path, outcome);
      } else if (outcome.type === "moved") {
        this.status.textContent = JUDGE_STRINGS.moved;
      } else {
        this.accepted.add(path);
        const next = this.review.files.find((file) => !this.accepted.has(file.path));
        if (next) this.selected = next.path;
      }
    });
  }

  private async run(action: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.render();
    try {
      await action();
    } catch (error) {
      this.status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private render(): void {
    const conflict = this.conflicts.get(this.selected);
    const file = this.file(this.selected);
    this.conflictNotice.hidden = !conflict;
    this.element.dataset.conflict = String(Boolean(conflict));
    // A conflict compares the user's current text with the verified proposal.
    const content = conflict
      ? { path: this.selected, original: conflict.currentText, proposed: conflict.proposedText }
      : {
          path: this.selected,
          original: file?.base_text ?? "",
          proposed: file?.proposed_text ?? "",
        };
    if (
      this.merge.getOriginalText() !== content.original ||
      this.merge.getProposedText() !== content.proposed
    ) {
      this.merge.setContent(content);
    }
    this.fileTabs.replaceChildren(
      ...this.review.files.map((entry) => {
        const tab = this.button(
          "hilo-judge-file",
          `${this.accepted.has(entry.path) ? "✓ " : ""}${entry.path}`,
          () => this.selectFile(entry.path),
        );
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-selected", String(entry.path === this.selected));
        tab.dataset.path = entry.path;
        return tab;
      }),
    );
    for (const [value, option] of this.layoutButtons) {
      option.setAttribute("aria-pressed", String(this.merge.getLayout() === value));
    }
    const done = this.accepted.has(this.selected);
    this.acceptButton.disabled = this.busy || done || Boolean(conflict);
    this.rejectButton.disabled = this.busy;
    this.adjustButton.disabled = this.busy;
  }

  private file(path: string) {
    return this.review.files.find((file) => file.path === path);
  }

  private el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
    text?: string,
  ): HTMLElementTagNameMap[K] {
    const element = this.doc.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  private button(className: string, text: string, onClick: () => void): HTMLButtonElement {
    const button = this.doc.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = text;
    button.addEventListener("click", onClick);
    return button;
  }
}

function applyStateColors(element: HTMLElement, colors: HiloStateVisualTokens["dark"]): void {
  element.style.setProperty("--judge-state-bg", colors.background);
  element.style.setProperty("--judge-state-border", colors.border);
  element.style.setProperty("--judge-state-text", colors.text);
}
