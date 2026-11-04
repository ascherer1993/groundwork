/**
 * Key combinations, written like `Ctrl+Cmd+1` (modifiers in the order Ctrl,
 * Alt, Shift, Cmd, then the key) and shown like `⌃⌘1`. Keys come from the
 * physical key (`KeyboardEvent.code`), so ⇧ doesn't turn `1` into `!`.
 */

const MODIFIERS = ["Ctrl", "Alt", "Shift", "Cmd"] as const;

const CODES: Record<string, string> = {
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Slash: "/",
  Comma: ",",
  Period: ".",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
};

const SYMBOLS: Record<string, string> = {
  Ctrl: "⌃",
  Alt: "⌥",
  Shift: "⇧",
  Cmd: "⌘",
  Enter: "↩",
  Tab: "⇥",
  Backspace: "⌫",
  Delete: "⌦",
  Escape: "⎋",
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
};

type KeyLike = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

function keyName(e: KeyLike): string | null {
  if (["Meta", "Control", "Alt", "Shift", "CapsLock", "Fn"].includes(e.key)) return null;
  const code = e.code ?? "";
  const letter = code.match(/^Key([A-Z])$/);
  if (letter) return letter[1]!;
  const digit = code.match(/^(?:Digit|Numpad)(\d)$/);
  if (digit) return digit[1]!;
  if (/^F\d{1,2}$/.test(code)) return code;
  if (CODES[code]) return CODES[code]!;
  if (["Enter", "Tab", "Space", "Backspace", "Delete", "Escape"].includes(code)) return code;
  if (!e.key) return null;
  return e.key.length === 1 ? e.key.toUpperCase() : e.key;
}

/** The combination a key event makes, or null for a modifier on its own. */
export function comboOf(e: KeyLike): string | null {
  const key = keyName(e);
  if (!key) return null;
  const held = { Ctrl: e.ctrlKey, Alt: e.altKey, Shift: e.shiftKey, Cmd: e.metaKey };
  return [...MODIFIERS.filter((m) => held[m]), key].join("+");
}

/** Whether a combination can be a shortcut: it needs ⌘, ⌃ or ⌥ (or is a function key). */
export function usable(combo: string): boolean {
  const parts = combo.split("+");
  const key = parts[parts.length - 1]!;
  return /^F\d{1,2}$/.test(key) || parts.some((p) => p === "Cmd" || p === "Ctrl" || p === "Alt");
}

/** `Ctrl+Cmd+1` → `⌃⌘1`. */
export function displayCombo(combo: string): string {
  return combo
    .split("+")
    .map((part) => SYMBOLS[part] ?? part)
    .join("");
}
