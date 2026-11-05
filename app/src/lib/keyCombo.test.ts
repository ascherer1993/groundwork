import { describe, expect, it } from "vitest";
import { comboOf, displayCombo, toAccelerator, usable } from "./keyCombo";

const key = (code: string, key: string, mods: Partial<Record<string, boolean>> = {}) => ({
  code,
  key,
  metaKey: !!mods.meta,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
});

describe("key combinations", () => {
  it("reads events in a fixed modifier order", () => {
    expect(comboOf(key("KeyO", "o", { meta: true }))).toBe("Cmd+O");
    expect(comboOf(key("Digit1", "1", { meta: true, ctrl: true }))).toBe("Ctrl+Cmd+1");
    // ⇧1 is still 1, and ⌥ doesn't change the letter.
    expect(comboOf(key("Digit1", "!", { meta: true, shift: true }))).toBe("Shift+Cmd+1");
    expect(comboOf(key("KeyF", "ƒ", { alt: true }))).toBe("Alt+F");
    expect(comboOf(key("BracketRight", "]", { meta: true, ctrl: true }))).toBe("Ctrl+Cmd+]");
    expect(comboOf(key("F5", "F5"))).toBe("F5");
    expect(comboOf(key("MetaLeft", "Meta", { meta: true }))).toBeNull();
  });

  it("shows them as macOS symbols", () => {
    expect(displayCombo("Ctrl+Cmd+1")).toBe("⌃⌘1");
    expect(displayCombo("Shift+Cmd+F")).toBe("⇧⌘F");
    expect(displayCombo("Cmd+\\")).toBe("⌘\\");
    expect(displayCombo("Alt+Left")).toBe("⌥←");
  });

  it("needs a modifier", () => {
    expect(usable("Cmd+O")).toBe(true);
    expect(usable("Alt+F")).toBe(true);
    expect(usable("F5")).toBe(true);
    expect(usable("Shift+A")).toBe(false);
    expect(usable("A")).toBe(false);
  });
});

describe("toAccelerator", () => {
  it("names keys as the global shortcut plugin does", () => {
    expect(toAccelerator("Ctrl+Alt+Space")).toBe("Control+Alt+Space");
    expect(toAccelerator("Shift+Cmd+K")).toBe("Shift+Command+KeyK");
    expect(toAccelerator("Alt+Cmd+1")).toBe("Alt+Command+Digit1");
    expect(toAccelerator("Cmd+\\")).toBe("Command+Backslash");
    expect(toAccelerator("Ctrl+Up")).toBe("Control+ArrowUp");
    expect(toAccelerator("F5")).toBe("F5");
  });
});
