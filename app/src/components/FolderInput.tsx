import { FolderOpen } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api/client";
import type { TreeNode } from "../api/generated/TreeNode";
import { canPickFolder, pickFolder } from "../lib/pickFolder";

/**
 * A folder field: type the path, or press Choose… to pick it.
 *
 * - `machine`: a folder on this Mac, picked with the native dialog (the
 *   desktop app only; browser mode just has the text field).
 * - `vault`: a folder in the vault, picked from a searchable list of them,
 *   so the value is always vault-relative.
 */
export function FolderInput(props: {
  scope: "machine" | "vault";
  label: string;
  value: string;
  onChange(value: string): void;
  /** Called after a folder is picked, with it (e.g. to save at once). */
  onPick?(value: string): void;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  /** The native dialog's title. */
  title?: string;
  /** Vault scope: the value the vault's root is picked as; none offers no root. */
  rootValue?: string;
  onBlur?(): void;
  onKeyDown?(e: KeyboardEvent<HTMLInputElement>): void;
}) {
  /** Where the vault's folder list shows, while it's open. */
  const [listing, setListing] = useState<Place | null>(null);
  const native = props.scope === "machine";
  const pick = (value: string) => {
    props.onChange(value);
    props.onPick?.(value);
  };

  const choose = async (button: HTMLElement) => {
    if (!native) {
      setListing((open) => (open ? null : placeBelow(button)));
      return;
    }
    const picked = await pickFolder({ title: props.title ?? props.label, start: props.value });
    if (picked) pick(picked);
  };

  return (
    <div className="folder-input">
      <input
        aria-label={props.label}
        value={props.value}
        placeholder={props.placeholder}
        autoFocus={props.autoFocus}
        disabled={props.disabled}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => props.onChange(e.target.value)}
        onBlur={props.onBlur}
        onKeyDown={props.onKeyDown}
      />
      {(!native || canPickFolder()) && (
        <button
          type="button"
          disabled={props.disabled}
          title={native ? "Choose a folder on this Mac" : "Choose a folder in the vault"}
          aria-expanded={native ? undefined : listing !== null}
          onClick={(e) => void choose(e.currentTarget)}
        >
          <FolderOpen size={13} /> Choose…
        </button>
      )}
      {listing && (
        <VaultFolderList
          place={listing}
          label={props.label}
          rootValue={props.rootValue}
          onPick={(value) => {
            setListing(null);
            pick(value);
          }}
          onClose={() => setListing(null)}
        />
      )}
    </div>
  );
}

interface Place {
  left: number;
  top: number;
  width: number;
  /** The field it belongs to: clicks there don't close it. */
  field: Element;
}

/** Below the field, kept on screen; fixed, so a scrolling dialog doesn't clip it. */
function placeBelow(button: HTMLElement): Place {
  const field = button.closest(".folder-input") ?? button;
  const rect = field.getBoundingClientRect();
  const width = Math.min(Math.max(rect.width, 260), window.innerWidth - 16);
  return {
    left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
    top: rect.bottom + 4,
    width,
    field,
  };
}

function folderPaths(node: TreeNode, out: string[] = []): string[] {
  for (const child of node.children ?? []) {
    if (child.kind !== "folder" || child.name.startsWith(".")) continue;
    out.push(child.path);
    folderPaths(child, out);
  }
  return out;
}

/** The vault's folders, searchable, under the Choose… button. */
function VaultFolderList(props: {
  place: Place;
  label: string;
  rootValue?: string;
  onPick(value: string): void;
  onClose(): void;
}) {
  const [folders, setFolders] = useState<string[] | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void api.tree().then(
      (tree) => setFolders(folderPaths(tree).sort((a, b) => a.localeCompare(b))),
      () => setFolders([]),
    );
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!box.current?.contains(target) && !props.place.field.contains(target)) props.onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [props]);

  const q = query.trim().toLowerCase();
  const items: { value: string; label: string }[] = [
    ...(props.rootValue !== undefined && (!q || "vault root".includes(q))
      ? [{ value: props.rootValue, label: "Vault root" }]
      : []),
    ...(folders ?? [])
      .filter((f) => !q || f.toLowerCase().includes(q))
      .map((f) => ({ value: f, label: f })),
  ];
  const current = Math.min(active, Math.max(0, items.length - 1));

  useEffect(() => {
    box.current?.querySelector("[aria-selected]")?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      // Not the dialog behind it too.
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length)
        setActive((current + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      const item = items[current];
      if (item) props.onPick(item.value);
    }
  };

  return createPortal(
    <div
      ref={box}
      className="menu folder-list"
      role="dialog"
      aria-label={`Folders for ${props.label.toLowerCase()}`}
      style={{ left: props.place.left, top: props.place.top, width: props.place.width }}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={onKey}
    >
      <input
        className="folder-list-input"
        aria-label="Find a folder"
        placeholder="Find a folder…"
        autoFocus
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
      />
      <div className="folder-list-items" role="listbox">
        {folders === null ? (
          <div className="folder-list-empty">Loading…</div>
        ) : items.length === 0 ? (
          <div className="folder-list-empty">No folders match</div>
        ) : (
          items.map((item, i) => (
            <button
              key={item.label}
              type="button"
              role="option"
              aria-selected={i === current || undefined}
              onMouseMove={() => i !== current && setActive(i)}
              onClick={() => props.onPick(item.value)}
            >
              {item.label}
            </button>
          ))
        )}
      </div>
    </div>,
    document.body,
  );
}
