// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { renderInline, renderMarkdownBlock } from "./markdown.js";

/** markdown-it puts a newline between block tags; the layout does not depend on it. */
const block = (markdown: string) => renderMarkdownBlock(markdown).replaceAll("\n", "");

describe("agent Markdown", () => {
  it("renders a table with alignment and inline code", () => {
    const html = renderMarkdownBlock(
      "| File | Time |\n|---|---:|\n| `a.mp4` | 69,29 s |\n| b.mp4 | — |",
    );
    expect(html).toContain("<table>");
    expect(html).toContain("<th>File</th>");
    expect(html).toContain('<th style="text-align:right">Time</th>');
    expect(html).toContain("<td><code>a.mp4</code></td>");
    expect(html.match(/<tr>/g)).toHaveLength(3);
  });
  it("renders bold, italics and code, and leaves code literal", () => {
    expect(renderInline("a **b** and *c* and `**d**`")).toBe(
      "a <strong>b</strong> and <em>c</em> and <code>**d**</code>",
    );
  });
  it("lets bold wrap code and code sit inside italics, without stray asterisks", () => {
    expect(renderInline("**Deps in `latest`**: pin")).toBe(
      "<strong>Deps in <code>latest</code></strong>: pin",
    );
    expect(renderInline("*see `x`*")).toBe("<em>see <code>x</code></em>");
    // Code stays literal.
    expect(renderInline("`**not bold**`")).toBe("<code>**not bold**</code>");
  });
  it("turns the references an agent writes into inline text that opens a file, not links", () => {
    const ref = (path: string, line: number, label: string) =>
      `<span role="link" tabindex="0" class="hilo-agent-ref" data-path="${path}" data-line="${line}" title="${path}:${line}">${label}</span>`;
    expect(renderInline("see [App.jsx](<src/App.jsx:6>) now")).toBe(
      `see ${ref("src/App.jsx", 6, "App.jsx")} now`,
    );
    expect(renderInline("[package.json](package.json)")).toBe(
      ref("package.json", 1, "package.json"),
    );
    expect(renderInline("[a](<src/a.ts:3>) · [b](<src/b.ts:9>)")).toBe(
      `${ref("src/a.ts", 3, "a")} · ${ref("src/b.ts", 9, "b")}`,
    );
    // Absolute paths into the agent's snapshot are made relative to it.
    expect(
      renderInline(
        "[x](</Users/me/Library/Application Support/dev.hilo.desktop/agent-worktrees/58f/acp-17-3/src/x.ts:4>)",
      ),
    ).toContain('data-path="src/x.ts" data-line="4"');
    // Code inside a label survives.
    expect(renderInline("[`Foo`](<src/foo.ts:2>)")).toContain("<code>Foo</code></span>");
  });
  it("never makes a link that navigates, and drops what could run", () => {
    const web = renderInline("[docs](https://example.com/a?b=1)");
    expect(web).toBe('<span class="hilo-agent-link" title="https://example.com/a?b=1">docs</span>');
    expect(web).not.toContain("<a ");
    for (const bad of [
      "[x](javascript:alert(1))",
      "[x](data:text/html,<b>)",
      "[x](/etc/passwd)",
      "[x](<../secret.txt:1>)",
      "[x](C:\\Windows\\a)",
    ]) {
      const html = renderInline(bad);
      expect(html).not.toContain("hilo-agent-ref");
      expect(html).not.toContain("hilo-agent-link");
      expect(html).not.toContain("<a ");
    }
    expect(renderInline('[x](<src/a"onclick="y.ts:1>)')).not.toContain('onclick="y');
  });
  it("renders lists and keeps single line breaks", () => {
    expect(block("- one\n- **two**")).toBe("<ul><li>one</li><li><strong>two</strong></li></ul>");
    expect(block("1. a\n2. b")).toContain("<ol>");
    expect(block("line one\nline two")).toBe("<p>line one<br>line two</p>");
  });
  it("renders headings of any level, with text after them", () => {
    expect(block("#### Small\nbody")).toBe("<h4>Small</h4><p>body</p>");
  });
  it("never emits agent HTML, links or images as markup", () => {
    const html = renderMarkdownBlock(
      "<img src=x onerror=alert(1)> [a](javascript:alert(1)) ![i](http://x/y.png)",
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<a ");
    expect(html).toContain("&lt;img");
    const cell = renderMarkdownBlock("| <b> |\n|---|\n| <script> |");
    expect(cell).not.toContain("<script>");
  });
  it("nests lists, keeps the numbering of a list split by blank lines, and quotes", () => {
    expect(block("1. **Alta** · one\n   - detail `a.ts`\n   - more\n2. two")).toBe(
      "<ol><li><strong>Alta</strong> · one<ul><li>detail <code>a.ts</code></li><li>more</li></ul></li><li>two</li></ol>",
    );
    // A streamed message is cut into blocks at blank lines: the second item keeps its number.
    expect(block("2. second")).toBe('<ol start="2"><li>second</li></ol>');
    expect(block("> quoted **text**")).toBe(
      "<blockquote><p>quoted <strong>text</strong></p></blockquote>",
    );
    expect(block("~~gone~~ and ---")).toBe("<p><s>gone</s> and ---</p>");
    // A continuation indented after a blank line stays text, never an accidental code block.
    expect(block("    still prose")).toBe("<p>still prose</p>");
  });
  it("shows a bare web address as a link, but not file names that look like domains", () => {
    expect(renderInline("see https://example.com/x now")).toBe(
      'see <span class="hilo-agent-link" title="https://example.com/x">https://example.com/x</span> now',
    );
    expect(renderInline("edit README.md and App.swift")).toBe("edit README.md and App.swift");
  });
  it("keeps only allowed markup and table alignment styles", () => {
    const html = block("| a |\n|:-:|\n| b |");
    expect(html).toContain('<th style="text-align:center">a</th>');
    const code = block("```js\nconst a = '<b>';\n```");
    expect(code).toContain('<div class="hilo-code"><div class="hilo-code-header">');
    expect(code).toContain('<span class="hilo-code-lang">js</span>');
    expect(code).toContain('<button type="button" class="hilo-code-copy" aria-label="Copy code">');
    expect(code).toContain("<pre data-lang=\"js\"><code>const a = '&lt;b&gt;';</code></pre>");
    expect(block("```\nplain\n```")).toContain('<span class="hilo-code-lang">text</span>');
    // The info string cannot break out of its attribute.
    expect(block('```js"onclick="x\n1\n```')).not.toContain('onclick="x"');
  });
  it("cuts very long tables", () => {
    const rows = Array.from({ length: 500 }, (_, i) => `| ${i} |`).join("\n");
    expect(renderMarkdownBlock(`| h |\n|---|\n${rows}`).match(/<tr>/g)?.length).toBe(201);
    const items = Array.from({ length: 500 }, (_, i) => `- ${i}`).join("\n");
    expect(renderMarkdownBlock(items).match(/<li>/g)?.length).toBe(200);
  });
});
