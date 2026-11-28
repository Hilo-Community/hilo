/**
 * Renders the Markdown of a conversation to HTML with markdown-it (CommonMark + tables,
 * strikethrough, nested lists, block quotes, headings) and sanitizes the result with DOMPurify.
 *
 * Agent text is untrusted:
 * - raw HTML in the text is escaped by markdown-it (`html: false`), never emitted;
 * - links never become `<a>`: a click would navigate the webview. A reference to a project file
 *   (`src/a.ts:12`) becomes inline text the panel opens in the editor; a web address is shown with
 *   its address as a tooltip; anything else is its label only;
 * - images are not loaded (their syntax renders as text);
 * - DOMPurify then keeps only the tags and attributes listed below.
 */
import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import type { MarkdownIt as Parser, Token } from "markdown-it";
import { UI_STRINGS } from "./ui-strings.js";

/** A table or list longer than this is cut: one message must not build an enormous DOM. */
const MAX_ROWS = 200;
/** Where an agent's snapshot lives: absolute paths in its text point into it. */
const SNAPSHOT_ROOT = /^.*\/agent-worktrees\/[^/]+\/acp-[^/]+\//;
/** `path` or `path:line`, no scheme, query, fragment or backslash. */
const FILE_REFERENCE = /^([^\s:#?\\]+?)(?::(\d{1,7}))?$/;

const ALLOWED_TAGS = [
  "div",
  "button",
  "p",
  "br",
  "strong",
  "em",
  "s",
  "code",
  "pre",
  "span",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "hr",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
];
const ALLOWED_ATTR = [
  "class",
  "type",
  "aria-label",
  "title",
  "role",
  "tabindex",
  "start",
  "style",
  "data-path",
  "data-line",
  "data-lang",
];

function escapeHtml(raw: string): string {
  return raw
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function decode(href: string): string {
  try {
    return decodeURI(href);
  } catch {
    return href;
  }
}

/** The opening tag a link becomes, and its closing tag (empty when it is plain text). */
function linkTags(href: string): [string, string] {
  const destination = decode(href).replace(SNAPSHOT_ROOT, "");
  const reference = FILE_REFERENCE.exec(destination);
  const path = reference?.[1];
  if (path && !path.startsWith("/") && !path.split("/").includes("..")) {
    const line = Number(reference?.[2] ?? 1) || 1;
    const where = escapeHtml(path);
    // Plain inline text that acts as a link: it flows and wraps with the sentence around it.
    return [
      `<span role="link" tabindex="0" class="hilo-agent-ref" data-path="${where}" data-line="${line}" title="${where}:${line}">`,
      "</span>",
    ];
  }
  if (/^https?:\/\//i.test(destination))
    return [`<span class="hilo-agent-link" title="${escapeHtml(destination)}">`, "</span>"];
  return ["", ""];
}

/** Drops table rows and list items past `MAX_ROWS` in each table or list. */
function limitRows(tokens: Token[]): Token[] {
  const kept: Token[] = [];
  const counts: number[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as Token;
    if ((token.type === "tr_open" || token.type === "list_item_open") && counts.length) {
      const top = counts.length - 1;
      counts[top] = (counts[top] ?? 0) + 1;
      if ((counts[top] ?? 0) > MAX_ROWS) {
        // Skip to the matching close.
        let depth = 0;
        for (; i < tokens.length; i += 1) {
          depth += (tokens[i] as Token).nesting;
          if (depth === 0) break;
        }
        continue;
      }
    }
    if (/^(thead|tbody|bullet_list|ordered_list)_open$/.test(token.type)) counts.push(0);
    if (/^(thead|tbody|bullet_list|ordered_list)_close$/.test(token.type)) counts.pop();
    kept.push(token);
  }
  return kept;
}

function createParser(): Parser {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });
  // Agents fence their code; an indented line (a list continuation after a blank line, split
  // into its own streaming block) must stay text, not turn into a code block. No images.
  md.disable(["code", "image"]);
  // Only explicit addresses become links: `README.md` or `App.swift` are not web sites.
  md.linkify.set({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false });
  md.core.ruler.push("hilo_limit_rows", (state) => {
    state.tokens = limitRows(state.tokens);
  });
  const closings: string[] = [];
  md.renderer.rules.link_open = (tokens, idx) => {
    const [open, close] = linkTags(String(tokens[idx]?.attrGet("href") ?? ""));
    closings.push(close);
    return open;
  };
  md.renderer.rules.link_close = () => closings.pop() ?? "";
  // A rounded card: the language and a Copy button above the code (`code-blocks.ts` colours it).
  md.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx];
    const lang = escapeHtml((token?.info ?? "").trim().split(/\s+/)[0] ?? "");
    const { copy, copyLabel, plain } = UI_STRINGS.code;
    return (
      `<div class="hilo-code"><div class="hilo-code-header"><span class="hilo-code-lang">${lang || plain}</span>` +
      `<button type="button" class="hilo-code-copy" aria-label="${copyLabel}">${copy}</button></div>` +
      `<pre data-lang="${lang}"><code>${escapeHtml(token?.content ?? "")}</code></pre></div>`
    );
  };
  return md;
}

const parser = createParser();
let hooked = false;

/** DOMPurify needs a DOM; without one (a non-browser test) markdown-it's escaping still holds. */
function sanitize(html: string): string {
  if (!DOMPurify.isSupported) return html;
  if (!hooked) {
    hooked = true;
    // The only style markdown-it writes is a table column's alignment.
    DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
      if (data.attrName === "style" && !/^text-align:(left|right|center)$/.test(data.attrValue))
        data.keepAttr = false;
    });
  }
  return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR, ALLOW_DATA_ATTR: false });
}

/** One Markdown block (text between blank lines, or a whole message). */
export function renderMarkdownBlock(block: string): string {
  return sanitize(parser.render(block)).trim();
}

/** The inline Markdown of one line: code spans, links, bold, italics, strikethrough. */
export function renderInline(text: string): string {
  return sanitize(parser.renderInline(text));
}
