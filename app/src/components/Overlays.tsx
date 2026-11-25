import { Check, ChevronRight, Star, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { closePreview, enterPreview, leavePreview } from "../lib/linkPreview";
import { attachContentHandlers, hydrate } from "../markdown/hydrate";
import { renderMarkdown } from "../markdown/render";
import { escapeHtml, extractSubpath, splitFrontmatter } from "../markdown/syntax";
import { startFromBar, useCommandBar } from "../state/commandBar";
import { todoField } from "../editor/todoField";
import { type MenuEntry, type MenuItem, useUi } from "../state/ui";
import { CommandBar } from "./CommandBar";
import { CommandLog } from "./CommandLog";
import { FolderInput } from "./FolderInput";
import { Palette } from "./Palette";
import { QuickSwitcher } from "./QuickSwitcher";
import { SettingsDialog } from "./SettingsDialog";
import { SetupDialog } from "./SetupDialog";
import { TicketDialog } from "./TicketDialog";

/** Everything that floats above the layout. */
export function Overlays() {
  const switcherOpen = useUi((s) => s.switcherOpen);
  return (
    <>
      <ContextMenu />
      <Toast />
      <TicketDialog />
      <SettingsDialog />
      <Dialog />
      <HoverPreview />
      {switcherOpen && <QuickSwitcher />}
      <Palette />
      <CommandBarOverlay />
      <CommandLog />
      <SetupDialog />
    </>
  );
}

function ContextMenu() {
  const menu = useUi((s) => s.menu);
  const close = useUi((s) => s.closeMenu);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  /** The submenu that's open: its menu, its item's index, and where it goes. */
  const [subState, setSub] = useState<{
    menu: unknown;
    index: number;
    x: number;
    y: number;
    focus: boolean;
  } | null>(null);
  // One left open in an earlier menu doesn't count.
  const sub = subState && subState.menu === menu ? subState : null;
  const subRef = useRef<HTMLDivElement>(null);
  const [subPos, setSubPos] = useState({ x: 0, y: 0 });

  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const { width, height } = ref.current.getBoundingClientRect();
    setPos({
      x: Math.min(menu.x, window.innerWidth - width - 4),
      y: Math.min(menu.y, window.innerHeight - height - 4),
    });
    ref.current.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [menu]);

  // A submenu goes to the right of its item, or the left when there's no room.
  useLayoutEffect(() => {
    if (!sub || !subRef.current || !ref.current) return;
    const { width, height } = subRef.current.getBoundingClientRect();
    const parent = ref.current.getBoundingClientRect();
    const right = sub.x + width + 4 <= window.innerWidth;
    setSubPos({
      x: right ? sub.x : Math.max(4, parent.left - width),
      y: Math.min(sub.y, window.innerHeight - height - 4),
    });
    if (sub.focus)
      subRef.current.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [sub]);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
    };
  }, [menu, close]);

  if (!menu) return null;
  const subItems = sub ? (menu.items[sub.index] as MenuItem | undefined)?.items : undefined;

  const openSub = (index: number, button: HTMLElement, focus: boolean) => {
    const box = button.getBoundingClientRect();
    setSub({ menu, index, x: box.right + 2, y: box.top - 4, focus });
  };

  return (
    <div
      className="menu-backdrop"
      onMouseDown={close}
      onContextMenu={(e) => (e.preventDefault(), close())}
    >
      <div
        ref={ref}
        className="menu"
        role="menu"
        style={{ left: pos.x, top: pos.y }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => moveFocus(e, ref.current!)}
      >
        <MenuButtons
          items={menu.items}
          openIndex={sub?.index}
          onChoose={(item) => {
            close();
            item.action?.();
          }}
          onHover={(index, button) => {
            const item = menu.items[index];
            if (item !== "separator" && item?.items) openSub(index, button, false);
            else setSub(null);
          }}
          onOpen={(index, button) => openSub(index, button, true)}
        />
      </div>
      {sub && subItems && (
        <div
          ref={subRef}
          className="menu submenu"
          role="menu"
          aria-label={(menu.items[sub.index] as MenuItem).label}
          style={{ left: subPos.x, top: subPos.y }}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") {
              e.preventDefault();
              const index = sub.index;
              setSub(null);
              ref.current
                ?.querySelector<HTMLButtonElement>(`button[data-index="${index}"]`)
                ?.focus();
              return;
            }
            moveFocus(e, subRef.current!);
          }}
        >
          <MenuButtons
            items={subItems}
            onChoose={(item) => {
              close();
              item.action?.();
            }}
          />
        </div>
      )}
    </div>
  );
}

/** ↑ and ↓ move between a menu's items. */
function moveFocus(e: { key: string; preventDefault(): void }, menu: HTMLElement) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    e.key === "ArrowDown" ? (i + 1) % buttons.length : (i - 1 + buttons.length) % buttons.length;
  buttons[next]?.focus();
}

function MenuButtons({
  items,
  openIndex,
  onChoose,
  onHover,
  onOpen,
}: {
  items: MenuEntry[];
  openIndex?: number;
  onChoose: (item: MenuItem) => void;
  onHover?: (index: number, button: HTMLElement) => void;
  onOpen?: (index: number, button: HTMLElement) => void;
}) {
  return items.map((item, i) =>
    item === "separator" ? (
      <div key={i} className="menu-separator" role="separator" />
    ) : (
      <button
        key={i}
        role="menuitem"
        data-index={i}
        className={item.danger ? "danger" : item.items && openIndex === i ? "open" : undefined}
        disabled={item.disabled}
        aria-current={item.checked || undefined}
        aria-haspopup={item.items ? "menu" : undefined}
        aria-expanded={item.items ? openIndex === i : undefined}
        onMouseEnter={(e) => onHover?.(i, e.currentTarget)}
        onClick={(e) => (item.items ? onOpen?.(i, e.currentTarget) : onChoose(item))}
        onKeyDown={(e) => {
          if (item.items && (e.key === "ArrowRight" || e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            e.stopPropagation();
            onOpen?.(i, e.currentTarget);
          }
        }}
      >
        {item.color !== undefined && (
          <span className="menu-swatch" data-color={item.color || undefined} />
        )}
        {item.label}
        {item.checked && <Check size={13} className="menu-check" aria-hidden="true" />}
        {item.starred && <Star size={12} className="menu-check menu-star" aria-label="default" />}
        {item.items && <ChevronRight size={13} className="menu-check" aria-hidden="true" />}
      </button>
    ),
  );
}

function Toast() {
  const toast = useUi((s) => s.toast);
  const dismiss = useUi((s) => s.dismissToast);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(dismiss, toast.action ? 8000 : 4000);
    return () => clearTimeout(timer);
  }, [toast, dismiss]);

  if (!toast) return null;
  return (
    <div className="toast" role="status" key={toast.id}>
      <span>{toast.message}</span>
      {toast.action && (
        <button
          className="toast-action"
          onClick={() => {
            dismiss();
            toast.action!.run();
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button className="icon" aria-label="Dismiss" onClick={dismiss}>
        <X size={12} />
      </button>
    </div>
  );
}

function Dialog() {
  const dialog = useUi((s) => s.dialog);
  return dialog ? <DialogForm key={dialog.id} dialog={dialog} /> : null;
}

function DialogForm({
  dialog,
}: {
  dialog: NonNullable<ReturnType<typeof useUi.getState>["dialog"]>;
}) {
  const fields = dialog.fields ?? [];
  const [values, setValues] = useState(() => fields.map((f) => f.value ?? ""));
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const finish = (result: string[] | null) => {
    useUi.setState({ dialog: null });
    dialog.resolve(result);
  };
  const submit = async () => {
    if (busy) return;
    if (dialog.validate) {
      setBusy(true);
      const found = await Promise.resolve(dialog.validate(values)).catch((err: unknown) =>
        err instanceof Error ? err.message : String(err),
      );
      setBusy(false);
      if (found) {
        setProblem(found);
        return;
      }
    }
    finish(values);
  };

  return (
    <div className="overlay" onMouseDown={() => finish(null)}>
      <form
        className="dialog"
        role="dialog"
        aria-label={dialog.title}
        onMouseDown={(e) => e.stopPropagation()}
        // A todo field's suggestions take Escape first.
        onKeyDown={(e) => e.key === "Escape" && !e.defaultPrevented && finish(null)}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2>{dialog.title}</h2>
        {dialog.message && <p className="muted">{dialog.message}</p>}
        {fields.map((field, i) => {
          const set = (value: string) => {
            setProblem(null);
            setValues((v) => v.map((old, j) => (j === i ? value : old)));
          };
          const input =
            field.type === "todo" ? (
              <TodoInput
                label={field.label}
                placeholder={field.placeholder}
                value={values[i] ?? ""}
                autoFocus={i === 0}
                onChange={set}
              />
            ) : field.type === "folder" ? (
              <FolderInput
                scope="machine"
                label={field.label}
                placeholder={field.placeholder}
                value={values[i] ?? ""}
                autoFocus={i === 0}
                onChange={set}
              />
            ) : field.options ? (
              <select
                autoFocus={i === 0}
                aria-label={field.label}
                value={values[i]}
                onChange={(e) => set(e.target.value)}
              >
                {field.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                autoFocus={i === 0}
                aria-label={field.label}
                type={field.type ?? "text"}
                placeholder={field.placeholder}
                value={values[i]}
                spellCheck={false}
                onChange={(e) => set(e.target.value)}
                autoComplete={field.type === "password" ? "off" : undefined}
                onFocus={(e) => field.type !== "date" && e.target.select()}
              />
            );
          // A single prompt is titled by the dialog; several get their own labels.
          return fields.length === 1 ? (
            <div key={i} className="dialog-field">
              {input}
            </div>
          ) : field.type === "folder" ? (
            // Two controls: the text and its Choose… button.
            <div key={i} className="dialog-field">
              <span>{field.label}</span>
              {input}
            </div>
          ) : (
            <label key={i} className="dialog-field">
              <span>{field.label}</span>
              {input}
            </label>
          );
        })}
        {problem && (
          <p className="dialog-problem" role="alert">
            {problem}
          </p>
        )}
        <div className="dialog-buttons">
          <button type="button" onClick={() => finish(null)}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            autoFocus={fields.length === 0}
            className={dialog.danger ? "danger-button" : "primary"}
          >
            {dialog.confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

/** A dialog's todo field: one line with `@date` and `!priority` suggestions. */
function TodoInput(props: {
  label: string;
  placeholder?: string;
  value: string;
  autoFocus: boolean;
  onChange(value: string): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  useEffect(() => {
    const parent = ref.current!;
    const view = todoField(parent, {
      label: latest.current.label,
      placeholder: latest.current.placeholder ?? "@date  !priority",
      value: latest.current.value,
      keep: true,
      onChange: (text) => latest.current.onChange(text),
      // Enter with no suggestion open submits the dialog.
      onSubmit: () => parent.closest("form")?.requestSubmit(),
    });
    if (latest.current.autoFocus) {
      view.focus();
      view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    }
    return () => view.destroy();
  }, []);
  return <div ref={ref} className="dialog-todo" />;
}

/** A floating preview of a linked note, from ⌘-hovering a link (`lib/linkPreview.ts`). */
function HoverPreview() {
  const hover = useUi((s) => s.hover);
  const show = useUi((s) => s.showHover);
  const ref = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState<{ for: unknown; html: string } | null>(null);
  const isNote = !!hover && hover.path.toLowerCase().endsWith(".md");
  const html = !hover
    ? null
    : !isNote
      ? `<p class="muted">${escapeHtml(hover.path)}</p>`
      : loaded?.for === hover
        ? loaded.html
        : null;

  useEffect(() => {
    if (!hover || !hover.path.toLowerCase().endsWith(".md")) return;
    let cancelled = false;
    void api
      .readFile(hover.path)
      .then((file) => {
        if (cancelled) return;
        if (file.encrypted) {
          setLoaded({
            for: hover,
            html: `<p class="muted">Encrypted note. Open it to unlock it.</p>`,
          });
          return;
        }
        const fm = splitFrontmatter(file.text ?? "");
        const text = hover.subpath ? (extractSubpath(fm.body, hover.subpath) ?? fm.body) : fm.body;
        setLoaded({
          for: hover,
          html: renderMarkdown(text, { lineOffset: hover.subpath ? -1e6 : fm.lineOffset }),
        });
      })
      .catch(() => !cancelled && show(null));
    return () => {
      cancelled = true;
    };
  }, [hover, show]);

  useEffect(() => {
    if (html && body.current && hover) {
      body.current.dataset.notePath = hover.path;
      void hydrate(body.current, hover.path);
    }
  }, [html, hover]);

  useEffect(() => {
    const el = body.current;
    return el ? attachContentHandlers(el) : undefined;
  }, [html]);

  useEffect(() => {
    if (!hover) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closePreview();
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) closePreview();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [hover, show]);

  if (!hover || html === null) return null;
  const left = Math.min(hover.x, window.innerWidth - 480);
  const top = hover.y + 360 > window.innerHeight ? Math.max(8, hover.y - 380) : hover.y;
  return (
    <div
      ref={ref}
      className="hover-preview"
      role="tooltip"
      style={{ left: Math.max(8, left), top }}
      onMouseEnter={enterPreview}
      onMouseLeave={leavePreview}
    >
      <div ref={body} className="markdown-rendered" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

/** The bar over the app: in the browser, or when it has no window of its own. */
function CommandBarOverlay() {
  const open = useCommandBar((s) => s.open);
  const chips = useCommandBar((s) => s.chips);
  const close = useCommandBar((s) => s.close);
  if (!open) return null;
  return (
    <div className="overlay" onMouseDown={close}>
      <div onMouseDown={(e) => e.stopPropagation()}>
        <CommandBar
          chips={chips}
          onClose={close}
          onStart={async (request) => {
            close();
            await startFromBar(request);
          }}
        />
      </div>
    </div>
  );
}
