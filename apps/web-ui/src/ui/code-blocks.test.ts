// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enhanceCodeBlocks,
  highlightCode,
  setCodeHighlighting,
  tokensToHtml,
} from "./code-blocks.js";
import { renderMarkdownBlock } from "./markdown.js";

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("code blocks", () => {
  afterEach(() => setCodeHighlighting(false));

  it("builds escaped spans and keeps only hex colours", () => {
    const html = tokensToHtml([
      [
        {
          content: "<b>",
          offset: 0,
          variants: { dark: { color: "#ff0000", fontStyle: 2 }, light: { color: "red;x" } },
        },
        { content: " & ", offset: 3, variants: {} },
      ],
      [{ content: "x", offset: 5, variants: { dark: { color: "#abc", fontStyle: 1 } } }],
    ]);
    expect(html).toBe(
      '<span style="--shiki-dark:#ff0000;font-weight:600">&lt;b&gt;</span> &amp; \n' +
        '<span style="--shiki-dark:#abc;font-style:italic">x</span>',
    );
  });

  it("colours a TypeScript block with Shiki and caches the result", async () => {
    const first = await highlightCode("ts", "const answer: number = 42;\n");
    expect(first).toContain("--shiki-dark:#");
    expect(first).toContain("--shiki-light:#");
    expect(first?.replace(/<[^>]+>/g, "")).toBe("const answer: number = 42;");
    expect(await highlightCode("ts", "const answer: number = 42;\n")).toBe(first);
    expect(await highlightCode("not-a-language", "x")).toBeNull();
  }, 20_000);

  it("colours the painted block only while its text is unchanged", async () => {
    setCodeHighlighting(true);
    const root = document.createElement("article");
    root.innerHTML = renderMarkdownBlock("```ts\nlet x = 1;\n```");
    enhanceCodeBlocks(root);
    await vi.waitFor(() => expect(root.querySelector("code[data-highlighted]")).not.toBeNull(), {
      timeout: 20_000,
    });
    expect(root.querySelector("code")?.textContent).toBe("let x = 1;");
    // A repaint of the same text is coloured at once from the cache, without waiting.
    root.innerHTML = renderMarkdownBlock("```ts\nlet x = 1;\n```");
    enhanceCodeBlocks(root);
    expect(root.querySelector("code[data-highlighted] span")).not.toBeNull();
  }, 20_000);

  it("copies the block's code from its header button", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const root = document.createElement("article");
    root.innerHTML = renderMarkdownBlock("```sh\necho <hi>\n```");
    enhanceCodeBlocks(root);
    enhanceCodeBlocks(root); // wiring twice still copies once
    const button = root.querySelector<HTMLButtonElement>(".hilo-code-copy");
    button?.click();
    await settle();
    expect(writeText).toHaveBeenCalledExactlyOnceWith("echo <hi>\n");
    expect(button?.textContent).toBe("Copied");
  });
});
