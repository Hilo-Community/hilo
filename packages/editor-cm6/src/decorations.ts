import {
  type EditorState,
  type Extension,
  type Range,
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  GutterMarker,
  gutter,
  gutterLineClass,
} from "@codemirror/view";
import { HILO_STATE_META, type HiloValidationState } from "@hilo/protocol-types";
import { HILO_STATE_VISUAL_TOKENS } from "./validation-theme.js";

export interface EditorRangeDecoration {
  readonly fromLine: number;
  readonly toLine: number;
  readonly state: HiloValidationState;
  readonly snapshotHash: string;
}

export function invalidateRangeOnLocalEdit(
  decoration: EditorRangeDecoration,
  editedLine: number,
): EditorRangeDecoration {
  if (
    decoration.state === "ValidatedGreen" &&
    editedLine >= decoration.fromLine &&
    editedLine <= decoration.toLine
  ) {
    return {
      ...decoration,
      state: "StaleOrange",
    };
  }
  return decoration;
}

export function describeDecorationAccessibleLabel(decoration: EditorRangeDecoration): string {
  const meta = HILO_STATE_META[decoration.state];
  return `${meta.labelFr} | ${meta.labelEn} (L${decoration.fromLine}-L${decoration.toLine})`;
}

export interface HiloDecorationFieldValue {
  readonly ranges: readonly EditorRangeDecoration[];
  readonly lineDecorations: DecorationSet;
}

export const setHiloDecorationsEffect = StateEffect.define<readonly EditorRangeDecoration[]>();

export const suppressLocalInvalidationAnnotation = StateEffect.define<boolean>();

function clampLine(doc: Text, lineNumber1Based: number): number {
  if (lineNumber1Based < 1) {
    return 1;
  }
  if (lineNumber1Based > doc.lines) {
    return doc.lines;
  }
  return lineNumber1Based;
}

const STATIC_LINE_DECORATION_BY_STATE: Record<HiloValidationState, Decoration> = {
  ValidatedGreen: Decoration.line({
    attributes: {
      class: "cm-hilo-line cm-hilo-state-ValidatedGreen",
      "data-hilo-state": "ValidatedGreen",
      "data-hilo-icon": HILO_STATE_VISUAL_TOKENS.ValidatedGreen.icon,
      "data-hilo-bg": HILO_STATE_VISUAL_TOKENS.ValidatedGreen.dark.background,
      "data-hilo-border": HILO_STATE_VISUAL_TOKENS.ValidatedGreen.dark.border,
      "aria-label": `${HILO_STATE_META.ValidatedGreen.labelFr} | ${HILO_STATE_META.ValidatedGreen.labelEn}`,
    },
  }),
  ReviewYellow: Decoration.line({
    attributes: {
      class: "cm-hilo-line cm-hilo-state-ReviewYellow",
      "data-hilo-state": "ReviewYellow",
      "data-hilo-icon": HILO_STATE_VISUAL_TOKENS.ReviewYellow.icon,
      "data-hilo-bg": HILO_STATE_VISUAL_TOKENS.ReviewYellow.dark.background,
      "data-hilo-border": HILO_STATE_VISUAL_TOKENS.ReviewYellow.dark.border,
      "aria-label": `${HILO_STATE_META.ReviewYellow.labelFr} | ${HILO_STATE_META.ReviewYellow.labelEn}`,
    },
  }),
  FailedRed: Decoration.line({
    attributes: {
      class: "cm-hilo-line cm-hilo-state-FailedRed",
      "data-hilo-state": "FailedRed",
      "data-hilo-icon": HILO_STATE_VISUAL_TOKENS.FailedRed.icon,
      "data-hilo-bg": HILO_STATE_VISUAL_TOKENS.FailedRed.dark.background,
      "data-hilo-border": HILO_STATE_VISUAL_TOKENS.FailedRed.dark.border,
      "aria-label": `${HILO_STATE_META.FailedRed.labelFr} | ${HILO_STATE_META.FailedRed.labelEn}`,
    },
  }),
  StaleOrange: Decoration.line({
    attributes: {
      class: "cm-hilo-line cm-hilo-state-StaleOrange",
      "data-hilo-state": "StaleOrange",
      "data-hilo-icon": HILO_STATE_VISUAL_TOKENS.StaleOrange.icon,
      "data-hilo-bg": HILO_STATE_VISUAL_TOKENS.StaleOrange.dark.background,
      "data-hilo-border": HILO_STATE_VISUAL_TOKENS.StaleOrange.dark.border,
      "aria-label": `${HILO_STATE_META.StaleOrange.labelFr} | ${HILO_STATE_META.StaleOrange.labelEn}`,
    },
  }),
  UnchangedBlue: Decoration.line({
    attributes: {
      class: "cm-hilo-line cm-hilo-state-UnchangedBlue",
      "data-hilo-state": "UnchangedBlue",
      "data-hilo-icon": HILO_STATE_VISUAL_TOKENS.UnchangedBlue.icon,
      "data-hilo-bg": HILO_STATE_VISUAL_TOKENS.UnchangedBlue.dark.background,
      "data-hilo-border": HILO_STATE_VISUAL_TOKENS.UnchangedBlue.dark.border,
      "aria-label": `${HILO_STATE_META.UnchangedBlue.labelFr} | ${HILO_STATE_META.UnchangedBlue.labelEn}`,
    },
  }),
};

/// Line-decoration ranges for a single `EditorRangeDecoration`, as a sorted array ready for
/// `DecorationSet.update({ add })`. Used both for a full rebuild (`buildLineDecorationSet`) and,
/// on its own, to patch just the one range an edit actually touched (see `hiloStateField`).
function lineDecorationRangesFor(
  doc: Text,
  dec: EditorRangeDecoration,
  afterLine = 0,
): Range<Decoration>[] {
  const startLine = Math.max(afterLine + 1, clampLine(doc, dec.fromLine));
  const endLine = clampLine(doc, Math.max(dec.fromLine, dec.toLine));
  if (startLine > endLine) {
    return [];
  }
  const lineDec = STATIC_LINE_DECORATION_BY_STATE[dec.state];
  const ranges: Range<Decoration>[] = [];
  for (let lineNo = startLine; lineNo <= endLine; lineNo += 1) {
    ranges.push(lineDec.range(doc.line(lineNo).from));
  }
  return ranges;
}

function buildLineDecorationSet(
  doc: Text,
  ranges: readonly EditorRangeDecoration[],
): DecorationSet {
  if (ranges.length === 0) {
    return Decoration.none;
  }

  const sortedRanges =
    ranges.length <= 1
      ? ranges
      : [...ranges].sort((a, b) => a.fromLine - b.fromLine || a.toLine - b.toLine);

  const builder = new RangeSetBuilder<Decoration>();
  let lastAddedLine = 0;

  for (const dec of sortedRanges) {
    for (const { from, to, value } of lineDecorationRangesFor(doc, dec, lastAddedLine)) {
      builder.add(from, to, value);
      lastAddedLine = doc.lineAt(from).number;
    }
  }
  return builder.finish();
}

class HiloGutterMarker extends GutterMarker {
  constructor(readonly decoration: EditorRangeDecoration) {
    super();
  }

  override eq(other: GutterMarker): boolean {
    return (
      other instanceof HiloGutterMarker &&
      other.decoration.state === this.decoration.state &&
      other.decoration.fromLine === this.decoration.fromLine &&
      other.decoration.toLine === this.decoration.toLine &&
      other.decoration.snapshotHash === this.decoration.snapshotHash
    );
  }

  override toDOM(): HTMLElement {
    const tokens = HILO_STATE_VISUAL_TOKENS[this.decoration.state];
    const span = document.createElement("span");
    span.className = `cm-hilo-gutter-badge cm-hilo-gutter-${this.decoration.state}`;
    span.textContent = tokens.icon;
    span.setAttribute("role", "status");
    span.setAttribute("data-hilo-state", this.decoration.state);
    span.setAttribute("data-hilo-icon", tokens.icon);
    span.setAttribute("aria-label", describeDecorationAccessibleLabel(this.decoration));
    return span;
  }
}

export const hiloStateField = StateField.define<HiloDecorationFieldValue>({
  create(state: EditorState): HiloDecorationFieldValue {
    return {
      ranges: [],
      lineDecorations: buildLineDecorationSet(state.doc, []),
    };
  },
  update(value, tr): HiloDecorationFieldValue {
    for (const effect of tr.effects) {
      if (effect.is(setHiloDecorationsEffect)) {
        const nextRanges = effect.value;
        return {
          ranges: nextRanges,
          lineDecorations: buildLineDecorationSet(tr.state.doc, nextRanges),
        };
      }
    }

    if (!tr.docChanged || value.ranges.length === 0) {
      return value;
    }

    const suppressInvalidation = tr.effects.some(
      (e) => e.is(suppressLocalInvalidationAnnotation) && e.value,
    );

    // Cheaply shift every existing line decoration through the edit (O(edit size), not O(total
    // decorated lines)); only the range(s) this transaction actually touched get their line
    // marks rebuilt below, since those are the only ones whose state or line count can change.
    let lineDecorations = value.lineDecorations.map(tr.changes);

    const updatedRanges: EditorRangeDecoration[] = value.ranges.map((range) => {
      const oldStartLineNo = clampLine(tr.startState.doc, range.fromLine);
      const oldEndLineNo = clampLine(tr.startState.doc, Math.max(range.fromLine, range.toLine));
      const oldRangeFrom = tr.startState.doc.line(oldStartLineNo).from;
      const oldRangeTo = tr.startState.doc.line(oldEndLineNo).to;

      let touched = false;
      tr.changes.iterChangedRanges((fromA, toA) => {
        if (fromA <= oldRangeTo && toA >= oldRangeFrom) {
          touched = true;
        }
      });

      const mappedFromPos = tr.changes.mapPos(oldRangeFrom, -1);
      const mappedToPos = tr.changes.mapPos(oldRangeTo, 1);
      const nextFromLine = tr.state.doc.lineAt(Math.min(mappedFromPos, tr.state.doc.length)).number;
      const nextToLine = tr.state.doc.lineAt(Math.min(mappedToPos, tr.state.doc.length)).number;

      const nextState: HiloValidationState =
        touched && !suppressInvalidation && range.state === "ValidatedGreen"
          ? "StaleOrange"
          : range.state;

      const updated: EditorRangeDecoration = {
        fromLine: nextFromLine,
        toLine: Math.max(nextFromLine, nextToLine),
        state: nextState,
        snapshotHash: range.snapshotHash,
      };

      if (touched) {
        const spanFrom = tr.state.doc.line(clampLine(tr.state.doc, updated.fromLine)).from;
        const spanTo = tr.state.doc.line(clampLine(tr.state.doc, updated.toLine)).to;
        lineDecorations = lineDecorations.update({
          filterFrom: spanFrom,
          filterTo: spanTo,
          filter: () => false,
          add: lineDecorationRangesFor(tr.state.doc, updated),
        });
      }

      return updated;
    });

    return {
      ranges: updatedRanges,
      lineDecorations,
    };
  },
  provide: (field) => EditorView.decorations.from(field, (val) => val.lineDecorations),
});

export const hiloStateGutter = gutter({
  class: "cm-hilo-validation-gutter cm-gutter-hilo-change",
  renderEmptyElements: false,
  lineMarker(view, line) {
    const fieldVal = view.state.field(hiloStateField, false);
    if (!fieldVal) {
      return null;
    }
    const lineNumber = view.state.doc.lineAt(line.from).number;
    for (const dec of fieldVal.ranges) {
      if (lineNumber >= dec.fromLine && lineNumber <= dec.toLine) {
        return new HiloGutterMarker(dec);
      }
    }
    return null;
  },
  lineMarkerChange(update) {
    return (
      update.docChanged ||
      update.transactions.some((tr) => tr.effects.some((e) => e.is(setHiloDecorationsEffect)))
    );
  },
});

const gutterWashMarkerByState: Record<HiloValidationState, GutterMarker> = {
  ValidatedGreen: new (class extends GutterMarker {
    override elementClass = "hilo-hunk-gutter-ValidatedGreen";
  })(),
  ReviewYellow: new (class extends GutterMarker {
    override elementClass = "hilo-hunk-gutter-ReviewYellow";
  })(),
  FailedRed: new (class extends GutterMarker {
    override elementClass = "hilo-hunk-gutter-FailedRed";
  })(),
  StaleOrange: new (class extends GutterMarker {
    override elementClass = "hilo-hunk-gutter-StaleOrange";
  })(),
  UnchangedBlue: new (class extends GutterMarker {
    override elementClass = "hilo-hunk-gutter-UnchangedBlue";
  })(),
};

/**
 * Wash line-number and fold-gutter cells with the exact same 5-state Hilo background
 * (like `Rectury-Package`'s `hilo-hunk-gutter-*` and `hilo-fold-wash-*`) so there is
 * zero gap between the 3px state bar, line numbers, fold chevron, and code line.
 */
export function hiloGutterStateWash(): Extension {
  return gutterLineClass.compute([hiloStateField], (state) => {
    const fieldVal = state.field(hiloStateField, false);
    if (!fieldVal || fieldVal.ranges.length === 0) {
      return RangeSet.empty;
    }
    const sorted =
      fieldVal.ranges.length <= 1
        ? fieldVal.ranges
        : [...fieldVal.ranges].sort((a, b) => a.fromLine - b.fromLine || a.toLine - b.toLine);

    const builder = new RangeSetBuilder<GutterMarker>();
    let lastLine = 0;
    for (const dec of sorted) {
      const startLine = Math.max(lastLine + 1, clampLine(state.doc, dec.fromLine));
      const endLine = clampLine(state.doc, Math.max(dec.fromLine, dec.toLine));
      const marker = gutterWashMarkerByState[dec.state];
      for (let lineNo = startLine; lineNo <= endLine; lineNo += 1) {
        const lineFrom = state.doc.line(lineNo).from;
        builder.add(lineFrom, lineFrom, marker);
        lastLine = lineNo;
      }
    }
    return builder.finish();
  });
}

export const hiloThemeExtension = EditorView.baseTheme({
  ".cm-hilo-validation-gutter": {
    width: "3px",
    minWidth: "3px",
    userSelect: "none",
  },
  ".cm-hilo-validation-gutter .cm-gutterElement": {
    padding: "0",
  },
  ".cm-hilo-gutter-badge": {
    display: "block",
    width: "3px",
    height: "100%",
    minHeight: "1.5em",
    fontSize: "0",
    lineHeight: "0",
    color: "transparent",
    overflow: "hidden",
  },
  // 3px left bar in all 5 Hilo states
  ".cm-hilo-gutter-ValidatedGreen": {
    backgroundColor: HILO_STATE_VISUAL_TOKENS.ValidatedGreen.dark.border,
  },
  ".cm-hilo-gutter-ReviewYellow": {
    backgroundColor: HILO_STATE_VISUAL_TOKENS.ReviewYellow.dark.border,
  },
  ".cm-hilo-gutter-FailedRed": {
    backgroundColor: HILO_STATE_VISUAL_TOKENS.FailedRed.dark.border,
  },
  ".cm-hilo-gutter-StaleOrange": {
    backgroundColor: HILO_STATE_VISUAL_TOKENS.StaleOrange.dark.border,
  },
  ".cm-hilo-gutter-UnchangedBlue": {
    backgroundColor: HILO_STATE_VISUAL_TOKENS.UnchangedBlue.dark.border,
  },
  // Full-width line wash + gutter wash (line numbers & fold gutter) for all 5 Hilo states
  // Uses !important so `.cm-has-selection .cm-activeLine` never strips the Hilo state background
  ".cm-hilo-state-ValidatedGreen, &.cm-has-selection .cm-activeLine.cm-hilo-state-ValidatedGreen, .cm-activeLine.cm-hilo-state-ValidatedGreen, .cm-gutterElement.hilo-hunk-gutter-ValidatedGreen, &.cm-has-selection .cm-gutterElement.hilo-hunk-gutter-ValidatedGreen.cm-activeLineGutter, .cm-gutterElement.hilo-hunk-gutter-ValidatedGreen.cm-activeLineGutter":
    {
      backgroundColor: "rgba(34, 197, 94, 0.11) !important",
    },
  ".cm-lineNumbers .cm-gutterElement.hilo-hunk-gutter-ValidatedGreen, .cm-lineNumbers .cm-gutterElement.hilo-hunk-gutter-ValidatedGreen.cm-activeLineGutter":
    {
      color: HILO_STATE_VISUAL_TOKENS.ValidatedGreen.dark.text,
    },
  ".cm-hilo-state-ReviewYellow, &.cm-has-selection .cm-activeLine.cm-hilo-state-ReviewYellow, .cm-activeLine.cm-hilo-state-ReviewYellow, .cm-gutterElement.hilo-hunk-gutter-ReviewYellow, &.cm-has-selection .cm-gutterElement.hilo-hunk-gutter-ReviewYellow.cm-activeLineGutter, .cm-gutterElement.hilo-hunk-gutter-ReviewYellow.cm-activeLineGutter":
    {
      backgroundColor: "rgba(234, 179, 8, 0.11) !important",
    },
  ".cm-lineNumbers .cm-gutterElement.hilo-hunk-gutter-ReviewYellow, .cm-lineNumbers .cm-gutterElement.hilo-hunk-gutter-ReviewYellow.cm-activeLineGutter":
    {
      color: HILO_STATE_VISUAL_TOKENS.ReviewYellow.dark.text,
    },
  ".cm-hilo-state-FailedRed, &.cm-has-selection .cm-activeLine.cm-hilo-state-FailedRed, .cm-activeLine.cm-hilo-state-FailedRed, .cm-gutterElement.hilo-hunk-gutter-FailedRed, &.cm-has-selection .cm-gutterElement.hilo-hunk-gutter-FailedRed.cm-activeLineGutter, .cm-gutterElement.hilo-hunk-gutter-FailedRed.cm-activeLineGutter":
    {
      backgroundColor: "rgba(239, 68, 68, 0.12) !important",
    },
  ".cm-lineNumbers .cm-gutterElement.hilo-hunk-gutter-FailedRed, .cm-lineNumbers .cm-gutterElement.hilo-hunk-gutter-FailedRed.cm-activeLineGutter":
    {
      color: HILO_STATE_VISUAL_TOKENS.FailedRed.dark.text,
    },
  ".cm-hilo-state-StaleOrange, &.cm-has-selection .cm-activeLine.cm-hilo-state-StaleOrange, .cm-activeLine.cm-hilo-state-StaleOrange, .cm-gutterElement.hilo-hunk-gutter-StaleOrange, &.cm-has-selection .cm-gutterElement.hilo-hunk-gutter-StaleOrange.cm-activeLineGutter, .cm-gutterElement.hilo-hunk-gutter-StaleOrange.cm-activeLineGutter":
    {
      backgroundColor: "rgba(249, 115, 22, 0.11) !important",
    },
  ".cm-lineNumbers .cm-gutterElement.hilo-hunk-gutter-StaleOrange, .cm-lineNumbers .cm-gutterElement.hilo-hunk-gutter-StaleOrange.cm-activeLineGutter":
    {
      color: HILO_STATE_VISUAL_TOKENS.StaleOrange.dark.text,
    },
  ".cm-hilo-state-UnchangedBlue, &.cm-has-selection .cm-activeLine.cm-hilo-state-UnchangedBlue, .cm-activeLine.cm-hilo-state-UnchangedBlue, .cm-gutterElement.hilo-hunk-gutter-UnchangedBlue, &.cm-has-selection .cm-gutterElement.hilo-hunk-gutter-UnchangedBlue.cm-activeLineGutter, .cm-gutterElement.hilo-hunk-gutter-UnchangedBlue.cm-activeLineGutter":
    {
      backgroundColor: "rgba(59, 130, 246, 0.10) !important",
    },
  ".cm-lineNumbers .cm-gutterElement.hilo-hunk-gutter-UnchangedBlue, .cm-lineNumbers .cm-gutterElement.hilo-hunk-gutter-UnchangedBlue.cm-activeLineGutter":
    {
      color: HILO_STATE_VISUAL_TOKENS.UnchangedBlue.dark.text,
    },
});

export function hiloStateDecorations() {
  return [hiloStateField, hiloStateGutter, hiloGutterStateWash(), hiloThemeExtension];
}
