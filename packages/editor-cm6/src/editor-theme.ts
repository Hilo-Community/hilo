import { HighlightStyle } from "@codemirror/language";
import type { Compartment, Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

export interface DeclarativeVsixTheme {
  readonly label: string;
  readonly uiTheme: "vs-dark" | "vs" | "hc-black" | string;
  readonly editorBackground: string;
  readonly editorForeground: string;
  readonly fontFamily?: string | undefined;
  readonly fontSizePx?: number | undefined;
}

export const DEFAULT_HILO_CM6_THEME: DeclarativeVsixTheme = {
  label: "Hilo Dark (WCAG AAA)",
  uiTheme: "vs-dark",
  editorBackground: "var(--color-main, #141414)",
  editorForeground: "var(--color-content-text, #f5f5f5)",
  fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, monospace',
  fontSizePx: 13,
};

const chalky = "#e5c07b";
const coral = "#e06c75";
const cyan = "#56b6c2";
const invalid = "#ffffff";
const ivory = "#abb2bf";
const stone = "#7d8799";
const malibu = "#61afef";
const sage = "#98c379";
const whiskey = "#d19a66";
const violet = "#c678dd";

/**
 * Hilo's default syntax highlighting palette.
 */
export const hiloDarkHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: violet },
  {
    tag: [tags.name, tags.deleted, tags.character, tags.propertyName, tags.macroName],
    color: coral,
  },
  { tag: [tags.function(tags.variableName), tags.labelName], color: malibu },
  { tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)], color: whiskey },
  { tag: [tags.definition(tags.name), tags.separator], color: ivory },
  {
    tag: [
      tags.typeName,
      tags.className,
      tags.number,
      tags.changed,
      tags.annotation,
      tags.modifier,
      tags.self,
      tags.namespace,
    ],
    color: chalky,
  },
  {
    tag: [
      tags.operator,
      tags.operatorKeyword,
      tags.url,
      tags.escape,
      tags.regexp,
      tags.link,
      tags.special(tags.string),
    ],
    color: cyan,
  },
  { tag: [tags.meta, tags.comment], color: stone },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.link, color: stone, textDecoration: "underline" },
  { tag: tags.heading, fontWeight: "bold", color: coral },
  { tag: [tags.atom, tags.bool, tags.special(tags.variableName)], color: whiskey },
  { tag: [tags.processingInstruction, tags.string, tags.inserted], color: sage },
  { tag: tags.invalid, color: invalid },
]);

export function createThemeExtension(theme: DeclarativeVsixTheme): Extension {
  const fontFamily =
    theme.fontFamily ??
    '"JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, monospace';
  const fontSizePx = theme.fontSizePx ?? 13;
  const lineHeightPx = Math.round(fontSizePx * 1.5);
  return EditorView.theme(
    {
      "&": {
        "--hilo-review-add-bg": "rgba(74, 222, 128, 0.10)",
        "--hilo-review-mod-bg": "rgba(210, 153, 34, 0.10)",
        "--hilo-review-del-bg": "rgba(248, 113, 113, 0.10)",
        "--hilo-review-add-number": "#8ea995",
        "--hilo-review-mod-number": "#b4a282",
        backgroundColor: theme.editorBackground,
        color: theme.editorForeground,
        fontFamily,
        fontSize: `${fontSizePx}px`,
        lineHeight: `${lineHeightPx}px`,
        height: "100%",
      },
      "&.cm-focused": {
        outline: "none",
      },
      ".cm-scopeGuideLayer": {
        pointerEvents: "none",
        zIndex: "2",
      },
      ".cm-scopeGuide": {
        pointerEvents: "none",
        backgroundColor: "color-mix(in srgb, var(--agent-card-tint, #fff) 14%, transparent)",
      },
      ".cm-scopeGuide-active": {
        backgroundColor: "color-mix(in srgb, var(--agent-card-tint, #fff) 30%, transparent)",
      },
      ".cm-scroller": {
        fontFamily,
        fontSize: `${fontSizePx}px`,
        lineHeight: `${lineHeightPx}px`,
        overflow: "auto",
        scrollbarWidth: "none",
        scrollbarGutter: "auto",
      },
      ".cm-scroller::-webkit-scrollbar": {
        display: "none",
        width: "0",
        height: "0",
      },
      ".cm-content": {
        caretColor: theme.editorForeground,
        fontFamily,
        fontSize: `${fontSizePx}px`,
        lineHeight: `${lineHeightPx}px`,
        paddingTop: "0px",
        paddingBottom: "4px",
        boxSizing: "border-box",
        minHeight: "100%",
      },
      ".cm-widgetBuffer": {
        display: "inline",
        verticalAlign: "text-top",
        height: "1em",
        width: "0",
        maxWidth: "none",
        maxHeight: "none",
      },
      ".cm-line": {
        padding: "0",
        fontSize: `${fontSizePx}px`,
        lineHeight: `${lineHeightPx}px`,
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: theme.editorForeground,
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
      ".cm-textSelectionLayer": {
        zIndex: "1",
      },
      ".cm-selectionLayer": {
        zIndex: "0",
      },
      ".cm-activeLine": {
        backgroundColor: "color-mix(in srgb, var(--agent-card-tint, #fff) 4%, transparent)",
      },
      "&.cm-has-selection .cm-activeLine": {
        backgroundColor: "transparent",
      },
      "&.cm-has-selection .cm-activeLineGutter": {
        backgroundColor: "transparent",
      },
      ".cm-gutters, .cm-gutters.cm-gutters-before, .cm-gutters.cm-gutters-after": {
        backgroundColor: theme.editorBackground,
        color: "var(--color-text-muted, #a1a1a1)",
        fontFamily,
        fontSize: `${fontSizePx}px`,
        lineHeight: `${lineHeightPx}px`,
        border: "none",
        boxShadow: "none",
        userSelect: "none",
      },
      ".cm-gutter": {
        backgroundColor: "transparent",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "color-mix(in srgb, var(--agent-card-tint, #fff) 4%, transparent)",
        color: "var(--color-text-secondary, #bcbcbc)",
      },
      ".cm-lineNumbers .cm-gutterElement": {
        padding: "0 8px 0 6px",
        minWidth: "calc(3ch + 16px)",
        boxSizing: "border-box",
        fontFamily,
        fontSize: `${fontSizePx}px`,
        lineHeight: `${lineHeightPx}px`,
        textAlign: "right",
        fontVariantNumeric: "tabular-nums",
        userSelect: "none",
        position: "relative",
      },
      ".cm-lineNumbers .cm-gutterElement.hilo-selected-line-gutter": {
        color: "var(--color-text-primary, #f5f5f5)",
      },
      ".cm-foldGutter": {
        width: "18px",
        minWidth: "18px",
        position: "relative",
        zIndex: "2",
        userSelect: "none",
      },
      ".cm-foldGutter .cm-gutterElement": {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      },
      ".hilo-fold-btn": {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: "14px",
        height: "14px",
        borderRadius: "4px",
        color: "var(--color-text-muted, #a1a1a1)",
        cursor: "pointer",
        lineHeight: "0",
        opacity: "0",
      },
      ".cm-foldGutter:hover .hilo-fold-btn": {
        opacity: "1",
      },
      ".hilo-fold-btn svg": {
        display: "block",
        width: "10px",
        height: "10px",
        transition: "transform 0.12s ease",
      },
      ".hilo-fold-btn.is-closed svg": {
        transform: "rotate(-90deg)",
      },
      ".hilo-fold-btn:hover": {
        backgroundColor: "color-mix(in srgb, var(--agent-card-tint, #fff) 10%, transparent)",
        color: "var(--color-text-secondary, #bcbcbc)",
      },
      ".cm-foldPlaceholder": {
        backgroundColor: "transparent",
        border: "none",
        color: "var(--color-text-muted, #a1a1a1) !important",
        margin: "0 2px",
        padding: "0 4px",
        borderRadius: "3px",
        cursor: "pointer",
      },
      ".cm-matchingBracket, .cm-nonmatchingBracket": {
        backgroundColor: "color-mix(in srgb, var(--agent-card-tint, #fff) 18%, transparent)",
        outline: "none",
      },
    },
    { dark: theme.uiTheme !== "vs" },
  );
}

export function createThemeCompartmentExtension(
  compartment: Compartment,
  theme: DeclarativeVsixTheme,
): Extension {
  return compartment.of(createThemeExtension(theme));
}
