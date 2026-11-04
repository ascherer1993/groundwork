import { Inbox as InboxIcon, SquareTerminal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { InboxItem } from "../api/generated/InboxItem";
import { goToTab, title, useInbox } from "../state/inbox";
import { useKeyLabel, withKey } from "../state/keys";
import { useWorkspace } from "../state/workspace";
import { useWorkspaces } from "../state/workspaces";

function age(ms: number): string {
  const minutes = Math.floor((Date.now() - ms) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** Where an item came from: its terminal's tab and workspace. */
function source(item: InboxItem): string | null {
  if (!item.tab) return null;
  const tab = useWorkspace
    .getState()
    .terminalTabs()
    .find((t) => t.terminal === item.tab);
  if (!tab) return null;
  const workspace = useWorkspaces.getState().list.find((w) => w.id === tab.area);
  return workspace ? `${workspace.name} · ${tab.panel.title}` : (tab.panel.title ?? null);
}

/** The inbox button in the top bar, and its list. */
export function InboxButton() {
  const count = useInbox((s) => s.items.length);
  const open = useInbox((s) => s.open);
  const setOpen = useInbox((s) => s.setOpen);
  const key = useKeyLabel("inbox");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen]);

  return (
    <div className="inbox-anchor" ref={ref}>
      <button
        className="icon inbox-button"
        aria-label={count ? `Inbox, ${count} waiting` : "Inbox"}
        title={withKey("Inbox", key)}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <InboxIcon size={14} />
        {count > 0 && <span className="inbox-count">{count}</span>}
      </button>
      {open && <InboxPanel />}
    </div>
  );
}

function InboxPanel() {
  const items = useInbox((s) => s.items);
  const history = useInbox((s) => s.history);
  const view = useInbox((s) => s.view);
  const setView = useInbox((s) => s.setView);
  // Newest first.
  const shown = [...items].reverse();
  return (
    <div className="inbox-popover" role="dialog" aria-label="Inbox">
      <div className="inbox-header">
        <div className="segmented" role="tablist" aria-label="Inbox">
          <button
            role="tab"
            aria-selected={view === "waiting"}
            aria-pressed={view === "waiting"}
            onClick={() => setView("waiting")}
          >
            Waiting{items.length > 0 && ` (${items.length})`}
          </button>
          <button
            role="tab"
            aria-selected={view === "earlier"}
            aria-pressed={view === "earlier"}
            onClick={() => setView("earlier")}
          >
            Earlier
          </button>
        </div>
      </div>
      {view === "waiting" ? (
        <>
          {shown.length === 0 && <p className="panel-empty muted small">Nothing waiting on you.</p>}
          <ul className="inbox-list">
            {shown.map((item) => (
              <InboxRow key={item.id} item={item} />
            ))}
          </ul>
        </>
      ) : (
        <>
          {history.length === 0 && (
            <p className="panel-empty muted small">Nothing yet. Items stay here for 30 days.</p>
          )}
          <ul className="inbox-list">
            {history.map((item) => (
              <EarlierRow key={item.id} item={item} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** What became of a done item. */
function outcome(item: InboxItem): string {
  if (item.answer !== undefined) return `Answered: ${item.answer}`;
  switch (item.kind) {
    case "ask":
      return "Dismissed without an answer";
    case "notify":
      return "Dismissed";
    case "attention":
      return "Seen";
  }
}

function EarlierRow({ item }: { item: InboxItem }) {
  const from = source(item);
  const link = item.link?.replace(/^\[\[|\]\]$/g, "");
  return (
    <li
      className={`inbox-item inbox-done inbox-${item.kind}`}
      aria-label={`${title(item)}: ${item.text}`}
    >
      <div className="inbox-meta">
        <span className="inbox-kind">{title(item)}</span>
        {from && <span className="inbox-from">{from}</span>}
        <span className="inbox-age" title={new Date(item.created).toLocaleString()}>
          {age(item.doneAt ?? item.created)}
        </span>
      </div>
      <p className="inbox-text">{item.text}</p>
      <p className="inbox-outcome">{outcome(item)}</p>
      {link && (
        <button
          className="link-button"
          onClick={() => {
            useInbox.getState().setOpen(false);
            void useWorkspace.getState().openLink("", link);
          }}
        >
          {link}
        </button>
      )}
    </li>
  );
}

function InboxRow({ item }: { item: InboxItem }) {
  const answer = useInbox((s) => s.answer);
  const [typed, setTyped] = useState("");
  const from = source(item);
  const link = item.link?.replace(/^\[\[|\]\]$/g, "");

  return (
    <li className={`inbox-item inbox-${item.kind}`} aria-label={`${title(item)}: ${item.text}`}>
      <div className="inbox-meta">
        <span className="inbox-kind">{title(item)}</span>
        {from && <span className="inbox-from">{from}</span>}
        <span className="inbox-age">{age(item.created)}</span>
        <button
          className="icon"
          aria-label="Dismiss"
          title={item.kind === "ask" ? "Dismiss without answering" : "Dismiss"}
          onClick={() => void answer(item.id)}
        >
          <X size={12} />
        </button>
      </div>
      <p className="inbox-text">{item.text}</p>
      {link && (
        <button
          className="link-button"
          onClick={() => {
            useInbox.getState().setOpen(false);
            void useWorkspace.getState().openLink("", link);
          }}
        >
          {link}
        </button>
      )}
      {item.kind === "ask" && (
        <form
          className="inbox-answer"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed.trim()) void answer(item.id, typed.trim());
          }}
        >
          {item.choices && item.choices.length > 0 && (
            <div className="inbox-choices">
              {item.choices.map((c) => (
                <button key={c} type="button" onClick={() => void answer(item.id, c)}>
                  {c}
                </button>
              ))}
            </div>
          )}
          <div className="inbox-typed">
            <input
              aria-label="Answer"
              placeholder={item.choices?.length ? "Or type an answer" : "Answer"}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
            <button type="submit" className="primary" disabled={!typed.trim()}>
              Send
            </button>
          </div>
        </form>
      )}
      {item.tab && (
        <button className="inbox-go" onClick={() => goToTab(item)}>
          <SquareTerminal size={12} /> Go to the terminal
        </button>
      )}
    </li>
  );
}
