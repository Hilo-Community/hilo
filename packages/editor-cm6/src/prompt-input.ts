import { acceptCompletion, autocompletion, completionStatus } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, insertNewline } from "@codemirror/commands";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { EditorView, drawSelection, keymap, placeholder } from "@codemirror/view";

import { textOnlySelection } from "./selection.js";

export interface PromptInputOptions {
  readonly placeholder: string;
  readonly ariaLabel: string;
  /** Longest text accepted, in UTF-16 code units (what CodeMirror counts). */
  readonly maxLength: number;
  /** Grows with its text up to this height, then scrolls. */
  readonly maxHeight: number;
  /** Enter; Shift+Enter makes a new line. Never fired while an input method is composing. */
  onSubmit(): void;
  onFocus?(): void;
  mentionPaths?(query: string): readonly string[];
  /**
   * True once the text needs more than one line (wrapped or a newline), false when it fits on
   * one again. A host can then move its buttons under the text.
   */
  onMultilineChange?(multiline: boolean): void;
  /** The text after any edit (typing, paste, undo…), for a host that filters as you type. */
  onChange?(text: string): void;
  /** Escape, e.g. for a host that uses the field as a dismissible filter. */
  onEscape?(): void;
}

export interface PromptInput {
  readonly element: HTMLElement;
  getText(): string;
  setText(text: string): void;
  setPlaceholder(text: string): void;
  focus(): void;
  destroy(): void;
}

const inputs = new WeakMap<Element, PromptInput>();

/** The prompt input whose root element is `element`, if any (for tests and hosts). */
export function promptInputOf(element: Element | null): PromptInput | null {
  return element ? (inputs.get(element) ?? null) : null;
}

/**
 * A one-to-few-line plain-text field drawn by CodeMirror, used where a chat composer would use a
 * textarea: CodeMirror draws its own thin caret and selection instead of the system's.
 */
export function createPromptInput(parent: HTMLElement, options: PromptInputOptions): PromptInput {
  const hint = new Compartment();
  let shownHint = options.placeholder;
  let multiline = false;
  // Text length when it first needed a second line. Giving the text the full width can make it
  // fit on one line again, so it only goes back to one line once it is shorter than that.
  let multilineFrom = 0;
  const report = (next: boolean) => {
    if (next === multiline) return;
    multiline = next;
    options.onMultilineChange?.(next);
  };
  const view = new EditorView({
    parent,
    state: EditorState.create({
      extensions: [
        history(),
        ...(options.mentionPaths
          ? [
              autocompletion({
                interactionDelay: 0,
                override: [
                  (context) => {
                    const match = context.matchBefore(/(?:^|\s)@[^\s@"]*$/);
                    if (!match) return null;
                    const at = match.text.indexOf("@");
                    const paths = options.mentionPaths?.(match.text.slice(at + 1)) ?? [];
                    if (!paths.length) return null;
                    return {
                      from: match.from + at,
                      filter: false,
                      options: paths.map((path) => ({
                        label: path,
                        apply: `@${/\s|"/.test(path) ? JSON.stringify(path) : path} `,
                        type: "text",
                      })),
                    };
                  },
                ],
              }),
            ]
          : []),
        drawSelection(),
        // The code editor's rounded, text-only selection, not the system's highlight.
        textOnlySelection(),
        EditorView.lineWrapping,
        hint.of(placeholder(options.placeholder)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) options.onChange?.(update.state.doc.toString());
          if (!update.docChanged && !update.geometryChanged) return;
          const doc = update.state.doc;
          // Only text counts: an empty field shows the placeholder, which never wraps.
          if (doc.length === 0) {
            report(false);
            return;
          }
          if (doc.lines > 1) {
            if (!multiline) multilineFrom = doc.length;
            report(true);
            return;
          }
          const wraps = update.view.contentHeight > update.view.defaultLineHeight * 1.5;
          if (!multiline && wraps) {
            multilineFrom = doc.length;
            report(true);
          } else if (multiline && !wraps && doc.length < multilineFrom) {
            report(false);
          }
        }),
        EditorState.changeFilter.of((tr) => tr.newDoc.length <= options.maxLength),
        Prec.highest(
          keymap.of([
            {
              key: "Enter",
              run: (view) => {
                if (options.mentionPaths && completionStatus(view.state) === "active") {
                  acceptCompletion(view);
                  return true;
                }
                options.onSubmit();
                return true;
              },
            },
            { key: "Shift-Enter", run: insertNewline },
            {
              key: "Escape",
              run: () => {
                if (!options.onEscape) return false;
                options.onEscape();
                return true;
              },
            },
          ]),
        ),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.contentAttributes.of({
          "aria-label": options.ariaLabel,
          "aria-multiline": "true",
          role: "textbox",
          // No red or blue squiggles under what is typed: prompts are code and paths, not prose.
          spellcheck: "false",
          autocorrect: "off",
          autocapitalize: "off",
        }),
        EditorView.domEventHandlers({
          focus: () => {
            options.onFocus?.();
            return false;
          },
        }),
        EditorView.theme({
          "&": {
            backgroundColor: "transparent",
            color: "inherit",
            fontSize: "inherit",
          },
          "&.cm-focused": { outline: "none" },
          ".cm-scroller": {
            maxHeight: `${options.maxHeight}px`,
            overflowY: "auto",
            fontFamily: "inherit",
            lineHeight: "inherit",
          },
          ".cm-content": { padding: "0", caretColor: "transparent" },
          ".cm-line": { padding: "0" },
          // One line, cut with an ellipsis in a narrow panel: a wrapped hint would make the
          // empty field two lines tall.
          ".cm-placeholder": {
            color: "var(--color-text-placeholder, #a4a4a4)",
            display: "inline-block",
            maxWidth: "100%",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            verticalAlign: "top",
          },
          ".cm-cursor, .cm-dropCursor": {
            borderLeftColor: "var(--color-text-primary, #f0f4f8)",
            borderLeftWidth: "1.5px",
          },
          ".cm-line ::selection, .cm-line::selection, .cm-content ::selection": {
            backgroundColor: "transparent !important",
            color: "inherit",
          },
          ".cm-textSelectionLayer .cm-selectionPath": {
            overflow: "visible",
            pointerEvents: "none",
          },
          ".cm-textSelectionLayer .cm-selectionPath-fill": {
            fill: "rgba(148, 163, 184, 0.24) !important",
          },
        }),
      ],
    }),
  });
  const input: PromptInput = {
    element: view.dom,
    getText: () => view.state.doc.toString(),
    setText: (text) =>
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: text.length },
      }),
    setPlaceholder: (text) => {
      if (text === shownHint) return;
      shownHint = text;
      view.dispatch({ effects: hint.reconfigure(placeholder(text)) });
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
  inputs.set(view.dom, input);
  return input;
}
