import { FileText, FolderKanban, Sparkles, SquareTerminal } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { BarChip, BarRequest } from "../lib/commandBar";

const ICONS = { note: FileText, project: FolderKanban, workspace: SquareTerminal };
const LINES = 6;

/**
 * Ask Claude: a request, typed or dictated, and chips for what you had open.
 * ↩ starts it in the background, ⌘↩ starts it and shows it, ⇧↩ adds a line.
 */
export function CommandBar({
  chips,
  onStart,
  onClose,
}: {
  chips: BarChip[];
  onStart: (request: BarRequest) => void | Promise<void>;
  onClose: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [off, setOff] = useState<Set<string>>(new Set());
  const input = useRef<HTMLTextAreaElement>(null);
  const key = (c: BarChip) => `${c.kind}:${c.value}`;

  // Grows with what's typed, up to a few lines.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
    el.style.height = `${Math.min(el.scrollHeight, line * LINES)}px`;
  }, [prompt]);

  const start = (show: boolean) => {
    if (!prompt.trim()) return;
    void onStart({ prompt: prompt.trim(), chips: chips.filter((c) => !off.has(key(c))), show });
  };

  return (
    <form
      className="command-bar"
      aria-label="Ask Claude"
      onSubmit={(e) => {
        e.preventDefault();
        start(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="command-bar-input">
        <Sparkles size={16} aria-hidden />
        <textarea
          ref={input}
          autoFocus
          rows={1}
          aria-label="Ask Claude"
          placeholder="Ask Claude…"
          spellCheck={false}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
            e.preventDefault();
            start(e.metaKey);
          }}
        />
      </div>
      <div className="command-bar-foot">
        <div className="command-bar-chips" role="group" aria-label="What Claude is told about">
          {chips.map((c) => {
            const Icon = ICONS[c.kind];
            const on = !off.has(key(c));
            return (
              <button
                key={key(c)}
                type="button"
                className="command-bar-chip"
                aria-pressed={on}
                title={on ? `Claude is told about this ${c.kind}` : `Not told about this ${c.kind}`}
                onClick={() => {
                  setOff((was) => {
                    const next = new Set(was);
                    if (on) next.add(key(c));
                    else next.delete(key(c));
                    return next;
                  });
                  input.current?.focus();
                }}
              >
                <Icon size={12} aria-hidden /> {c.label}
              </button>
            );
          })}
        </div>
        <span className="command-bar-hint">
          <kbd>↩</kbd> start <kbd>⌘↩</kbd> and show <kbd>esc</kbd> close
        </span>
      </div>
    </form>
  );
}
