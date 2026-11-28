// @vitest-environment happy-dom
import { completionStatus, startCompletion } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPromptInput } from "./prompt-input.js";

function input(onMultilineChange: (multiline: boolean) => void) {
  return createPromptInput(document.body, {
    placeholder: "Ask the agent…",
    ariaLabel: "Prompt",
    maxLength: 1000,
    maxHeight: 200,
    onSubmit: () => undefined,
    onMultilineChange,
  });
}

describe("prompt input", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("goes back to one line when emptied, even in a panel too narrow for the hint", () => {
    // A narrow panel: whatever is shown measures two lines.
    vi.spyOn(EditorView.prototype, "contentHeight", "get").mockReturnValue(42);
    vi.spyOn(EditorView.prototype, "defaultLineHeight", "get").mockReturnValue(21);
    const changes: boolean[] = [];
    const prompt = input((multiline) => changes.push(multiline));
    prompt.setText("a long question that wraps");
    expect(changes).toEqual([true]);
    prompt.setText("");
    expect(changes).toEqual([true, false]);
    prompt.destroy();
  });

  it("completes a file mention before Enter sends the draft", async () => {
    const onSubmit = vi.fn();
    const mentionPaths = vi.fn(() => ["src/with space.ts"]);
    const prompt = createPromptInput(document.body, {
      placeholder: "Ask the agent",
      ariaLabel: "Prompt",
      maxLength: 1000,
      maxHeight: 200,
      onSubmit,
      mentionPaths,
    });
    const view = EditorView.findFromDOM(prompt.element);
    if (!view) throw new Error("Prompt editor was not mounted");
    prompt.setText("Inspect @with");
    startCompletion(view);
    await vi.waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    const enter = () =>
      view.contentDOM.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    enter();
    expect(mentionPaths).toHaveBeenCalledWith("with");
    expect(prompt.getText()).toBe('Inspect @"src/with space.ts" ');
    expect(onSubmit).not.toHaveBeenCalled();
    enter();
    expect(onSubmit).toHaveBeenCalledOnce();
    prompt.destroy();
  });

  it("is multiline for a newline and one line again once the text is cleared", () => {
    const changes: boolean[] = [];
    const prompt = input((multiline) => changes.push(multiline));
    prompt.setText("first\nsecond");
    prompt.setText("");
    expect(changes).toEqual([true, false]);
    prompt.destroy();
  });
});
