/**
 * Code blocks of a rendered message: syntax colours from Shiki (the grammars and themes VS Code
 * uses) and the header's Copy button.
 *
 * - Shiki runs with its JavaScript regex engine: the app's CSP allows no WebAssembly.
 * - Grammars load on demand, the first time a language is shown.
 * - Shiki's HTML is never inserted: the spans are built here from its tokens, the text escaped and
 *   each colour checked to be a hex value, so a message can still only produce the markup the
 *   Markdown renderer allows.
 * - Colouring happens on the painted DOM, after the message is shown: results are cached by
 *   language and source, so a streaming message that repaints keeps its colours without flicker.
 */
import type { HighlighterCore, ThemedTokenWithVariants } from "shiki/core";
import { UI_STRINGS } from "./ui-strings.js";

/** Longer code is shown plain: tokenizing it would hold the UI thread. */
const MAX_CODE_CHARS = 20_000;
const MAX_CACHE = 300;
const HEX = /^#[0-9a-f]{3,8}$/i;

const cache = new Map<string, string>();
let highlighter: Promise<HighlighterCore> | undefined;
const languages = new Map<string, Promise<boolean>>();

/** Off under the unit tests (a test turns it on), where loading grammars would only slow them. */
let enabled = !(globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  ?.env?.VITEST;

export function setCodeHighlighting(on: boolean): void {
  enabled = on;
}

function escapeHtml(raw: string): string {
  return raw.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** The inner HTML of a `<code>`: one span per token, its colours for both app themes. */
export function tokensToHtml(lines: ThemedTokenWithVariants[][]): string {
  return lines
    .map((line) =>
      line
        .map((token) => {
          const dark = token.variants.dark?.color;
          const light = token.variants.light?.color;
          const font = token.variants.dark?.fontStyle ?? 0;
          const style = [
            dark && HEX.test(dark) ? `--shiki-dark:${dark}` : "",
            light && HEX.test(light) ? `--shiki-light:${light}` : "",
            font > 0 && font & 1 ? "font-style:italic" : "",
            font > 0 && font & 2 ? "font-weight:600" : "",
          ]
            .filter(Boolean)
            .join(";");
          const text = escapeHtml(token.content);
          return style ? `<span style="${style}">${text}</span>` : text;
        })
        .join(""),
    )
    .join("\n");
}

function loadHighlighter(): Promise<HighlighterCore> {
  highlighter ??= Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    import("shiki/themes"),
  ]).then(([{ createHighlighterCore }, { createJavaScriptRegexEngine }, { bundledThemes }]) =>
    createHighlighterCore({
      themes: [bundledThemes["github-dark"](), bundledThemes["github-light"]()],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    }),
  );
  return highlighter;
}

/** Loads the grammar of `lang` once; false when Shiki has none for it. */
function loadLanguage(core: HighlighterCore, lang: string): Promise<boolean> {
  let loading = languages.get(lang);
  if (!loading) {
    loading = import("shiki/langs").then(async ({ bundledLanguages }) => {
      const grammar = (bundledLanguages as Record<string, (() => Promise<unknown>) | undefined>)[
        lang
      ];
      if (!grammar) return false;
      await core.loadLanguage(grammar() as Parameters<HighlighterCore["loadLanguage"]>[0]);
      return true;
    });
    loading.catch(() => languages.delete(lang));
    languages.set(lang, loading);
  }
  return loading;
}

/** The coloured inner HTML of `source`, or null when the language is unknown. */
export async function highlightCode(lang: string, source: string): Promise<string | null> {
  const key = `${lang}\u0000${source}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const core = await loadHighlighter();
  if (!(await loadLanguage(core, lang))) return null;
  const html = tokensToHtml(
    core.codeToTokensWithThemes(source.replace(/\n$/, ""), {
      lang,
      themes: { dark: "github-dark", light: "github-light" },
    }),
  );
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string);
  cache.set(key, html);
  return html;
}

/** The older copy path, for a web view that refuses the Clipboard API. */
function copyWithSelection(doc: Document, text: string): boolean {
  const area = doc.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  doc.body.append(area);
  area.select();
  try {
    return doc.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

/** Puts `text` on the clipboard: the Clipboard API, or the older path when it is refused. */
export function writeClipboard(doc: Document, text: string): Promise<boolean> {
  const fallback = () => copyWithSelection(doc, text);
  const clipboard = doc.defaultView?.navigator.clipboard;
  if (!clipboard) return Promise.resolve(fallback());
  return clipboard.writeText(text).then(() => true, fallback);
}

function copy(button: HTMLElement): void {
  const text = button.closest(".hilo-code")?.querySelector("code")?.textContent ?? "";
  void writeClipboard(button.ownerDocument, text).then((copied) => {
    if (!copied) return;
    button.textContent = UI_STRINGS.code.copied;
    button.dataset.copied = "";
    setTimeout(() => {
      button.textContent = UI_STRINGS.code.copy;
      delete button.dataset.copied;
    }, 1500);
  });
}

/** Colours the code blocks under `root` and wires their Copy buttons (once per root). */
export function enhanceCodeBlocks(root: HTMLElement): void {
  if (root.dataset.hiloCode === undefined) {
    root.dataset.hiloCode = "";
    root.addEventListener("click", (event) => {
      const button = (event.target as Element | null)?.closest<HTMLElement>(".hilo-code-copy");
      if (button && root.contains(button)) copy(button);
    });
  }
  if (!enabled) return;
  for (const code of root.querySelectorAll<HTMLElement>(".hilo-code pre[data-lang] > code")) {
    if (code.dataset.highlighted !== undefined) continue;
    const lang = (code.parentElement?.dataset.lang ?? "").toLowerCase();
    const source = code.textContent ?? "";
    if (!lang || !source.trim() || source.length > MAX_CODE_CHARS) continue;
    const hit = cache.get(`${lang}\u0000${source}`);
    if (hit !== undefined) {
      code.innerHTML = hit;
      code.dataset.highlighted = "";
      continue;
    }
    void highlightCode(lang, source)
      .then((html) => {
        // Streaming may have replaced or grown the block since: only the same text is coloured.
        if (html !== null && root.contains(code) && code.textContent === source) {
          code.innerHTML = html;
          code.dataset.highlighted = "";
        }
      })
      .catch(() => undefined);
  }
}
