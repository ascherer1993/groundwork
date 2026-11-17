/**
 * ⌘T's new tabs (PLAN §5.5). Among the notes, a blank tab with the quick
 * switcher over it: the note picked opens in it. Among a workspace's
 * terminals, a page of where the new tab can start, Claude at the vault
 * root (with the workspace's context) highlighted; ↑↓ and ↩ pick, or a
 * click, or 1–9. Nothing starts until one is picked; Escape closes it.
 */
import type { IDockviewPanelProps } from "dockview-react";
import { Bot, FilePlus, Search, SquareTerminal, Star } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useKeyLabel } from "../state/keys";
import { type LaunchItem, launchItems } from "../state/tickets";
import { useUi } from "../state/ui";
import { message } from "../state/vault";
import { useWorkspace } from "../state/workspace";

function Key({ id }: { id: string }) {
  const key = useKeyLabel(id);
  return key ? <kbd>{key}</kbd> : null;
}

/** A blank note tab: what the quick switcher left, if it was closed. */
export function NotesNewTab() {
  const setSwitcher = useUi((s) => s.setSwitcher);
  const newNote = useWorkspace((s) => s.newNote);
  return (
    <div className="watermark new-tab">
      <button onClick={() => setSwitcher(true)}>
        <Search size={14} /> Open a file <Key id="switcher" />
      </button>
      <button onClick={() => void newNote("")}>
        <FilePlus size={14} /> New note <Key id="new-note" />
      </button>
    </div>
  );
}

/** A launcher tab's params: the workspace it starts a tab in. */
export interface LauncherParams {
  launcher: string;
}

/** The terminals' new-tab page: pick where the tab starts. */
export function LauncherPanel(props: IDockviewPanelProps) {
  const area = (props.params as unknown as LauncherParams).launcher;
  const [items, setItems] = useState<LaunchItem[] | null>(null);
  const [selected, setSelected] = useState(0);
  const [starting, setStarting] = useState(false);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    let live = true;
    launchItems(area)
      .then((found) => live && setItems(found))
      .catch((err) => {
        if (live) setItems([]);
        useUi.getState().notify(message(err));
      });
    return () => {
      live = false;
    };
  }, [area]);

  // The keys are the list's whenever its tab is the one showing.
  useEffect(() => {
    const focus = () => requestAnimationFrame(() => list.current?.focus());
    if (props.api.isActive) focus();
    const d = props.api.onDidActiveChange((e) => e.isActive && focus());
    return () => d.dispose();
  }, [props.api, items]);

  const choose = useCallback(
    async (item: LaunchItem | undefined) => {
      if (!item || starting) return;
      setStarting(true);
      try {
        // The new terminal joins this tab's group, where it stood.
        await item.launch();
      } finally {
        props.api.close();
      }
    },
    [props.api, starting],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!items || e.metaKey || e.ctrlKey || e.altKey) return;
    const last = items.length - 1;
    const step = (to: number) => {
      e.preventDefault();
      setSelected(Math.max(0, Math.min(last, to)));
    };
    if (e.key === "ArrowDown") step(selected + 1);
    else if (e.key === "ArrowUp") step(selected - 1);
    else if (e.key === "Home") step(0);
    else if (e.key === "End") step(last);
    else if (e.key === "Enter") {
      e.preventDefault();
      void choose(items[selected]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      props.api.close();
    } else if (/^[1-9]$/.test(e.key)) {
      e.preventDefault();
      void choose(items[Number(e.key) - 1]);
    }
  };

  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <div className="launcher">
      <h2 className="launcher-title" id={`launcher-${props.api.id}`}>
        New tab
      </h2>
      {!items ? (
        <p className="launcher-loading" aria-busy="true">
          Finding places…
        </p>
      ) : (
        <ul
          ref={list}
          className="launcher-list"
          role="listbox"
          tabIndex={0}
          aria-labelledby={`launcher-${props.api.id}`}
          aria-activedescendant={`${props.api.id}-${selected}`}
          aria-busy={starting}
          onKeyDown={onKeyDown}
        >
          {items.map((item, i) => {
            const Icon = item.kind === "claude" ? Bot : SquareTerminal;
            return (
              <li
                key={i}
                id={`${props.api.id}-${i}`}
                data-index={i}
                role="option"
                aria-selected={i === selected}
                className={`launcher-item${i === selected ? " is-selected" : ""}`}
                onMouseMove={() => i !== selected && setSelected(i)}
                onClick={() => void choose(item)}
              >
                <Icon size={15} className="launcher-icon" aria-hidden="true" />
                <span className="launcher-text">
                  <span className="launcher-label">
                    {item.label}
                    {item.starred && (
                      <Star size={11} className="launcher-star" aria-label="default" />
                    )}
                  </span>
                  {item.detail && <span className="launcher-detail">{item.detail}</span>}
                </span>
                {i < 9 && <kbd className="launcher-key">{i + 1}</kbd>}
              </li>
            );
          })}
        </ul>
      )}
      <p className="launcher-hint">↑↓ to choose · ↩ to open · esc to close</p>
    </div>
  );
}
