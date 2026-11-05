import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { closePreview, enterPreview, leavePreview } from "../lib/linkPreview";
import { attachContentHandlers, hydrate } from "../markdown/hydrate";
import { renderMarkdown } from "../markdown/render";
import { escapeHtml, extractSubpath, splitFrontmatter } from "../markdown/syntax";
import { startFromBar, useCommandBar } from "../state/commandBar";
import { useUi } from "../state/ui";
import { CommandBar } from "./CommandBar";
import { CommandLog } from "./CommandLog";
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

  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const { width, height } = ref.current.getBoundingClientRect();
    setPos({
      x: Math.min(menu.x, window.innerWidth - width - 4),
      y: Math.min(menu.y, window.innerHeight - height - 4),
    });
    ref.current.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [menu]);

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
        onKeyDown={(e) => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          const buttons = [
            ...ref.current!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
          ];
          const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next =
            e.key === "ArrowDown"
              ? (i + 1) % buttons.length
              : (i - 1 + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }}
      >
        {menu.items.map((item, i) =>
          item === "separator" ? (
            <div key={i} className="menu-separator" role="separator" />
          ) : (
            <button
              key={i}
              role="menuitem"
              className={item.danger ? "danger" : undefined}
              disabled={item.disabled}
              onClick={() => {
                close();
                item.action();
              }}
            >
              {item.label}
            </button>
          ),
        )}
      </div>
    </div>
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
  const finish = (result: string[] | null) => {
    useUi.setState({ dialog: null });
    dialog.resolve(result);
  };

  return (
    <div className="overlay" onMouseDown={() => finish(null)}>
      <form
        className="dialog"
        role="dialog"
        aria-label={dialog.title}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && finish(null)}
        onSubmit={(e) => {
          e.preventDefault();
          finish(values);
        }}
      >
        <h2>{dialog.title}</h2>
        {dialog.message && <p className="muted">{dialog.message}</p>}
        {fields.map((field, i) => {
          const set = (value: string) =>
            setValues((v) => v.map((old, j) => (j === i ? value : old)));
          const input = field.options ? (
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
              onFocus={(e) => field.type !== "date" && e.target.select()}
            />
          );
          // A single prompt is titled by the dialog; several get their own labels.
          return fields.length === 1 ? (
            <div key={i} className="dialog-field">
              {input}
            </div>
          ) : (
            <label key={i} className="dialog-field">
              <span>{field.label}</span>
              {input}
            </label>
          );
        })}
        <div className="dialog-buttons">
          <button type="button" onClick={() => finish(null)}>
            Cancel
          </button>
          <button
            type="submit"
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
