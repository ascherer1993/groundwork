/**
 * The properties panel at the top of a note in live preview, edited in
 * place as in Obsidian: each property has an editor for its type (text with
 * `[[` link suggestions, lists of chips, checkboxes, numbers, dates), people,
 * projects, teams and references are picked from the vault, and properties
 * can be added, renamed, retyped and removed. The YAML is one click away
 * (`</>`), but clicking the panel never turns it into YAML.
 *
 * Every change rewrites the note through the editor; the panel then redraws
 * from the new YAML (`update`), keeping the focused field focused.
 */
import type { EditorView } from "@codemirror/view";
import { parse as parseYaml } from "yaml";
import { api } from "../api/client";
import type { PropertyValue } from "../api/generated/PropertyValue";
import { attachContentHandlers, hydrate } from "../markdown/hydrate";
import { renderInline } from "../markdown/render";
import { escapeHtml } from "../markdown/syntax";
import { addTicketRepo, removeTicketRepo } from "../state/tickets";
import {
  ADD_LABEL,
  type Choice,
  chooseType,
  convert,
  createTeam,
  currentData,
  displayValue,
  keyProblem,
  linkTarget,
  listValues,
  loadChoices,
  missingRows,
  NONE,
  type PickKind,
  pickKind,
  plain,
  type PropType,
  REFERENCES,
  renameProperty,
  setProperty,
  setValues,
  TYPE_LABEL,
  TYPES,
  typeForName,
  typeOf,
} from "./properties";
import {
  attachSuggest,
  closeSuggestions,
  fold,
  folderOf,
  linkSuggestions,
  matchFiles,
  type Suggestion,
} from "./suggest";

const svg = (body: string) =>
  `<svg class="property-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICONS: Record<PropType | PickKind | "tags", string> = {
  text: svg('<path d="M15 12H3"/><path d="M17 18H3"/><path d="M21 6H3"/>'),
  list: svg(
    '<path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/>',
  ),
  number: svg(
    '<line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/><line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/>',
  ),
  checkbox: svg('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 12 2 2 4-4"/>'),
  date: svg(
    '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
  ),
  datetime: svg('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
  object: svg(
    '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/>',
  ),
  people: svg(
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  ),
  teams: svg(
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  ),
  projects: svg(
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  ),
  notes: svg(
    '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  ),
  repos: svg(
    '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  ),
  tags: svg(
    '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
  ),
};

/** Names offered when adding a property, with the type each starts as. */
const SUGGESTED_NAMES = [
  REFERENCES,
  "links",
  "tags",
  "aliases",
  "people",
  "projects",
  "team",
  "status",
  "type",
  "date",
  "due",
  "url",
  "source",
];

/** A field to focus once the panel for `source` next draws, by its `data-fid`. */
let pendingFocus: { source: string; fid: string } | null = null;

/** A property being added, per note, so a redraw doesn't lose it. */
const adding = new Map<string, { name: string; type: PropType; typed: boolean; error?: string }>();

const fidOf = (key: string, slot: string) => `${key}\u001f${slot}`;

export interface PanelOptions {
  /** Shows the YAML in the editor. */
  onSource: () => void;
}

export class PropertyPanel {
  readonly root: HTMLDivElement;
  private yaml: string | null;
  private redrawing = false;

  constructor(
    private view: EditorView,
    readonly source: string,
    yaml: string | null,
    private opts: PanelOptions,
  ) {
    this.yaml = yaml;
    this.root = document.createElement("div");
    this.root.className = yaml === null ? "cm-properties cm-properties-none" : "cm-properties";
    this.root.dataset.notePath = source;
    attachContentHandlers(this.root);
    // Clicks on the panel's background mustn't reach the editor, which
    // would move its cursor and scroll.
    this.root.addEventListener("mousedown", (e) => {
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest("a")) {
        // Follow the link without opening the field around it.
        e.preventDefault();
        return;
      }
      if (t?.closest("input, textarea, select, button, [tabindex]")) return;
      e.preventDefault();
    });
    this.root.addEventListener("load", () => view.requestMeasure(), { capture: true });
    this.draw();
  }

  /** Redraws from new YAML, keeping the focused field as it was. */
  update(view: EditorView, yaml: string | null) {
    this.view = view;
    this.yaml = yaml;
    this.draw();
  }

  destroy() {
    closeSuggestions();
  }

  private draw() {
    const active = document.activeElement;
    let keep: { fid: string; value?: string; start?: number | null; end?: number | null } | null =
      null;
    if (active instanceof HTMLElement && this.root.contains(active) && active.dataset.fid) {
      keep = { fid: active.dataset.fid };
      if (
        (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
        active.dataset.dirty
      ) {
        keep.value = active.value;
        keep.start = safeSelection(active, "start");
        keep.end = safeSelection(active, "end");
      }
    }

    this.redrawing = true;
    closeSuggestions();
    this.root.replaceChildren();
    this.build();
    this.redrawing = false;

    let fid = keep?.fid;
    if (pendingFocus?.source === this.source) {
      fid = pendingFocus.fid;
      keep = null;
      pendingFocus = null;
    }
    const el = fid ? this.root.querySelector<HTMLElement>(`[data-fid="${CSS.escape(fid)}"]`) : null;
    if (el && !el.isConnected) {
      // A new panel (the note's first property): focus once it's on the page.
      requestAnimationFrame(() => {
        if (el.isConnected) el.focus();
      });
    } else if (el) {
      el.focus();
      const now = document.activeElement;
      if (
        keep?.value !== undefined &&
        (now instanceof HTMLInputElement || now instanceof HTMLTextAreaElement)
      ) {
        now.value = keep.value;
        now.dataset.dirty = "1";
        try {
          now.setSelectionRange(keep.start ?? now.value.length, keep.end ?? now.value.length);
        } catch {
          // Not a text field.
        }
      }
    }
    void hydrate(this.root, this.source).then(() => this.view.requestMeasure());
    this.view.requestMeasure();
  }

  private build() {
    if (this.yaml === null) {
      this.root.append(this.addRow({}));
      return;
    }
    let data: unknown;
    try {
      data = parseYaml(this.yaml);
    } catch {
      this.root.append(this.head());
      const err = document.createElement("div");
      err.className = "properties-error";
      err.textContent = "These properties aren't valid YAML. ";
      const fix = document.createElement("button");
      fix.type = "button";
      fix.className = "properties-error-fix";
      fix.textContent = "Edit the YAML";
      fix.addEventListener("click", () => this.opts.onSource());
      err.append(fix);
      this.root.append(err);
      return;
    }
    const record =
      data && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : {};
    this.root.append(this.head());
    const entries: [string, unknown, boolean][] = Object.entries(record).map(([k, v]) => [
      k,
      v,
      true,
    ]);
    for (const key of missingRows(this.source, record)) entries.push([key, null, false]);
    for (const [key, value, present] of entries)
      this.root.append(this.row(record, key, value, present));
    this.root.append(this.addRow(record));
  }

  private head(): HTMLElement {
    const head = document.createElement("div");
    head.className = "properties-head";
    const title = document.createElement("div");
    title.className = "properties-title";
    title.textContent = "Properties";
    const src = document.createElement("button");
    src.type = "button";
    src.className = "properties-source";
    src.title = "Edit as YAML";
    src.setAttribute("aria-label", "Edit properties as YAML");
    src.textContent = "</>";
    src.addEventListener("mousedown", (e) => e.preventDefault());
    src.addEventListener("click", () => this.opts.onSource());
    head.append(title, src);
    return head;
  }

  // Rows

  private row(
    data: Record<string, unknown>,
    key: string,
    value: unknown,
    present: boolean,
  ): HTMLElement {
    const kind = pickKind(key, data);
    const type = typeOf(this.source, key, value, kind);
    const row = document.createElement("div");
    row.className = "property";
    if (!present) row.classList.add("is-suggested");
    row.dataset.key = key;
    row.dataset.type = type;
    if (kind) row.dataset.kind = kind;

    const keyEl = this.keyButton(key, type, kind, present);
    const values = document.createElement("div");
    values.className = "property-values";
    switch (type) {
      case "list":
        this.listEditor(values, key, value, kind);
        break;
      case "checkbox":
        values.append(this.checkbox(key, value));
        break;
      case "number":
        values.append(this.numberInput(key, value));
        break;
      case "date":
      case "datetime":
        values.append(this.dateInput(key, value, type));
        break;
      case "object": {
        const obj = document.createElement("button");
        obj.type = "button";
        obj.className = "pv-object";
        obj.title = "Edit as YAML";
        obj.textContent = plain(value);
        obj.addEventListener("click", () => this.opts.onSource());
        values.append(obj);
        break;
      }
      default:
        values.append(this.textDisplay(key, value));
    }
    row.append(keyEl, values);
    return row;
  }

  private keyButton(key: string, type: PropType, kind: PickKind | null, present: boolean) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "property-key";
    btn.dataset.fid = fidOf(key, "key");
    btn.setAttribute("aria-label", `${key} property options`);
    btn.setAttribute("aria-haspopup", "menu");
    btn.title = kind ? key : `${key} · ${TYPE_LABEL[type]}`;
    const icon = kind ?? (key === "tags" ? "tags" : type);
    btn.innerHTML = `${ICONS[icon]}<span class="property-key-name">${escapeHtml(key)}</span>`;
    btn.addEventListener("click", () => this.keyMenu(btn, key, type, kind, present));
    return btn;
  }

  private keyMenu(
    anchor: HTMLElement,
    key: string,
    type: PropType,
    kind: PickKind | null,
    present: boolean,
  ) {
    closeSuggestions();
    const backdrop = document.createElement("div");
    backdrop.className = "menu-backdrop";
    const menu = document.createElement("div");
    menu.className = "menu property-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", `${key} property`);
    const close = (refocus = true) => {
      backdrop.remove();
      menu.remove();
      if (refocus && anchor.isConnected) anchor.focus();
    };
    backdrop.addEventListener("mousedown", (e) => {
      e.preventDefault();
      close(false);
    });
    const item = (
      label: string,
      run: () => void,
      opts: { danger?: boolean; check?: boolean } = {},
    ) => {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", opts.check === undefined ? "menuitem" : "menuitemradio");
      if (opts.check !== undefined) b.setAttribute("aria-checked", String(opts.check));
      if (opts.danger) b.className = "danger";
      b.textContent = label;
      if (opts.check) {
        const c = document.createElement("span");
        c.className = "menu-check";
        c.textContent = "✓";
        b.append(c);
      }
      b.addEventListener("click", () => {
        close(false);
        run();
      });
      menu.append(b);
      return b;
    };
    const separator = () => {
      const s = document.createElement("div");
      s.className = "menu-separator";
      menu.append(s);
    };
    const heading = (text: string) => {
      const h = document.createElement("div");
      h.className = "menu-heading";
      h.textContent = text;
      menu.append(h);
    };

    if (present) item("Rename…", () => this.startRename(key));
    if (!kind && type !== "object") {
      if (present) separator();
      heading("Type");
      for (const t of TYPES) {
        item(TYPE_LABEL[t], () => void this.retype(key, t), { check: t === type });
      }
    }
    if (present) {
      separator();
      item("Remove property", () => void setProperty(this.view, key, null), { danger: true });
    }
    if (!menu.childElementCount) return;

    menu.addEventListener("keydown", (e) => {
      const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button")];
      const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const next = (i + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    });
    document.body.append(backdrop, menu);
    const rect = anchor.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 220))}px`;
    const below = window.innerHeight - rect.bottom;
    if (below < menu.offsetHeight + 12 && rect.top > below) {
      menu.style.bottom = `${window.innerHeight - rect.top + 4}px`;
    } else {
      menu.style.top = `${rect.bottom + 4}px`;
    }
    menu.querySelector<HTMLButtonElement>("button")?.focus();
  }

  private async retype(key: string, type: PropType) {
    chooseType(this.source, key, type);
    const value = currentData(this.view)[key];
    pendingFocus = { source: this.source, fid: fidOf(key, "value") };
    // A suggested row takes its type when it gets a value.
    if (value !== undefined) await setProperty(this.view, key, convert(value, type));
    // Drawn again even when the YAML stays the same (an empty value).
    this.draw();
  }

  private startRename(key: string) {
    const row = this.root.querySelector<HTMLElement>(`.property[data-key="${CSS.escape(key)}"]`);
    const btn = row?.querySelector<HTMLElement>(".property-key");
    if (!row || !btn) return;
    const input = document.createElement("input");
    input.className = "property-key-input";
    input.value = key;
    input.dataset.fid = fidOf(key, "rename");
    input.setAttribute("aria-label", `Rename ${key}`);
    btn.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      const to = input.value.trim();
      if (!commit || to === key) {
        this.draw();
        return;
      }
      const problem = keyProblem(to, Object.keys(currentData(this.view)));
      if (problem) {
        done = false;
        input.setCustomValidity(problem);
        input.reportValidity();
        input.title = problem;
        return;
      }
      const type = typeOf(this.source, key, currentData(this.view)[key], null);
      chooseType(this.source, to, type);
      pendingFocus = { source: this.source, fid: fidOf(to, "key") };
      void renameProperty(this.view, key, to);
    };
    input.addEventListener("input", () => input.setCustomValidity(""));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => {
      if (!this.redrawing) finish(true);
    });
  }

  // Value editors

  /** Text shows rendered, links and all; clicking it (or focusing it) edits the source. */
  private textDisplay(key: string, value: unknown): HTMLElement {
    const text = plain(value);
    const display = document.createElement("div");
    display.className = "pv-text";
    display.tabIndex = 0;
    display.dataset.fid = fidOf(key, "value");
    display.setAttribute("role", "textbox");
    display.setAttribute("aria-label", key);
    const shown = displayValue(key, null, text);
    if (!text) display.innerHTML = '<span class="pv-empty">Empty</span>';
    else display.innerHTML = shown === text ? renderInline(text) : escapeHtml(shown);
    const edit = () => {
      if (!display.isConnected) return;
      const input = document.createElement("textarea");
      input.className = "pv-input pv-text-input";
      input.rows = 1;
      input.value = text;
      input.dataset.fid = display.dataset.fid;
      input.setAttribute("aria-label", key);
      input.spellcheck = true;
      display.replaceWith(input);
      const grow = () => {
        input.style.height = "auto";
        input.style.height = `${input.scrollHeight}px`;
        this.view.requestMeasure();
      };
      grow();
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      let cancelled = false;
      const suggest = attachSuggest(input, (el) =>
        linkSuggestions(el, this.source, () => {
          input.dataset.dirty = "1";
          grow();
          suggest.refresh();
        }),
      );
      input.addEventListener("input", () => {
        input.dataset.dirty = "1";
        if (input.value.includes("\n")) input.value = input.value.replace(/\r?\n/g, " ");
        grow();
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.isComposing) {
          e.preventDefault();
          input.blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancelled = true;
          input.blur();
        }
      });
      input.addEventListener("blur", () => {
        if (this.redrawing) return;
        const next = input.value.trim();
        const now = currentData(this.view)[key];
        if (cancelled || next === plain(now)) {
          this.draw();
          return;
        }
        void setProperty(this.view, key, next ? { kind: "text", value: next } : { kind: "empty" });
      });
    };
    display.addEventListener("focus", edit);
    return display;
  }

  private checkbox(key: string, value: unknown): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "pv-checkbox";
    box.checked = value === true;
    box.dataset.fid = fidOf(key, "value");
    box.setAttribute("aria-label", key);
    box.addEventListener("change", () => {
      void setProperty(this.view, key, { kind: "bool", value: box.checked });
    });
    return box;
  }

  private numberInput(key: string, value: unknown): HTMLElement {
    const input = document.createElement("input");
    input.type = "number";
    input.step = "any";
    input.className = "pv-input pv-number";
    input.value = typeof value === "number" ? String(value) : "";
    input.placeholder = "Empty";
    input.dataset.fid = fidOf(key, "value");
    input.setAttribute("aria-label", key);
    const commit = () => {
      if (this.redrawing) return;
      const now = currentData(this.view)[key];
      const n = input.value === "" ? null : Number(input.value);
      if (n !== null && !Number.isFinite(n)) return;
      if ((n ?? null) === (typeof now === "number" ? now : null) && now !== undefined) return;
      void setProperty(
        this.view,
        key,
        n === null ? { kind: "empty" } : { kind: "number", value: n },
      );
    };
    input.addEventListener("input", () => (input.dataset.dirty = "1"));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      }
    });
    input.addEventListener("blur", commit);
    return input;
  }

  private dateInput(key: string, value: unknown, type: "date" | "datetime"): HTMLElement {
    const input = document.createElement("input");
    input.type = type === "date" ? "date" : "datetime-local";
    input.className = "pv-input pv-date";
    const text = plain(value);
    input.value = type === "date" ? text.slice(0, 10) : text.replace(" ", "T").slice(0, 16);
    input.dataset.fid = fidOf(key, "value");
    input.setAttribute("aria-label", key);
    const commit = () => {
      if (this.redrawing) return;
      const v = input.value;
      // While a year is being typed, it passes through 0002, 0020…
      if (v && !/^[1-9]\d{3}-/.test(v)) return;
      const now = plain(currentData(this.view)[key]);
      const current = type === "date" ? now.slice(0, 10) : now.replace(" ", "T").slice(0, 16);
      if (v === current && currentData(this.view)[key] !== undefined) return;
      void setProperty(this.view, key, v ? { kind: "text", value: v } : { kind: "empty" });
    };
    input.addEventListener("change", commit);
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      }
    });
    return input;
  }

  private listEditor(host: HTMLElement, key: string, value: unknown, kind: PickKind | null) {
    host.classList.add("pv-list");
    const values = (
      Array.isArray(value) ? value : value == null || value === "" ? [] : [value]
    ).map(plain);
    values.forEach((v, i) => {
      if (v === "") return;
      const chip = document.createElement("span");
      chip.className = "property-value";
      if (key === "tags") chip.classList.add("is-tag");
      const text = displayValue(key, kind, v);
      const label = document.createElement("span");
      label.className = "property-value-text";
      label.innerHTML =
        text !== v
          ? escapeHtml(text)
          : key === "tags"
            ? escapeHtml(`#${v.replace(/^#/, "")}`)
            : renderInline(v);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "property-remove";
      remove.title = "Remove";
      remove.setAttribute("aria-label", `Remove ${text}`);
      remove.textContent = "×";
      remove.addEventListener("mousedown", (e) => e.preventDefault());
      remove.addEventListener("keydown", (e) => {
        if (e.key === "Backspace" || e.key === "Delete") {
          e.preventDefault();
          remove.click();
        }
      });
      remove.addEventListener("click", () => {
        if (kind === "repos") {
          void removeTicketRepo(this.source, v);
          return;
        }
        const now = listValues(this.view, key);
        if (now[i] !== v) return;
        void setValues(
          this.view,
          key,
          now.filter((_, j) => j !== i),
        );
      });
      chip.append(label, remove);
      host.append(chip);
    });

    if (kind === "repos") {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "property-add";
      add.title = ADD_LABEL.repos;
      add.dataset.fid = fidOf(key, "value");
      add.setAttribute("aria-label", `${ADD_LABEL.repos} to ${key}`);
      add.textContent = "+";
      add.addEventListener("click", () => void addTicketRepo(this.source));
      host.append(add);
      return;
    }

    const input = document.createElement("input");
    input.className = "pv-add";
    input.dataset.fid = fidOf(key, "value");
    const label = kind ? ADD_LABEL[kind] : key === "tags" ? "Add a tag" : "Add a value";
    input.placeholder = values.length ? "" : `${label}…`;
    input.setAttribute("aria-label", `${label} to ${key}`);
    input.size = Math.max(4, input.placeholder.length);
    host.append(input);
    host.addEventListener("mousedown", (e) => {
      if (e.target === host) {
        e.preventDefault();
        input.focus();
      }
    });

    const add = async (item: string) => {
      const v = item.trim();
      if (!v) return;
      input.value = "";
      delete input.dataset.dirty;
      pendingFocus = { source: this.source, fid: fidOf(key, "value") };
      const now = listValues(this.view, key);
      if (now.includes(v)) {
        pendingFocus = null;
        return;
      }
      await setValues(this.view, key, [...now, v]);
    };

    // What's already there, for leaving it out of the suggestions.
    let taken: Set<string> | null = null;
    const loadTaken = async () => {
      const targets = listValues(this.view, key).map(linkTarget);
      const paths = targets.length ? await api.resolveLinks(this.source, targets) : [];
      taken = new Set([
        ...paths.filter((p): p is string => !!p),
        ...targets.map((t) => t.toLowerCase()),
      ]);
      return taken;
    };
    const isTaken = (t: Set<string>, c: { path?: string; name: string }) =>
      (c.path !== undefined && t.has(c.path)) || t.has(c.name.toLowerCase());
    const linkTo = async (path: string) => add(await api.formatLink(this.source, path));

    let choices: Promise<Choice[]> | null = null;
    let tags: ReturnType<typeof api.tags> | null = null;
    const source = async (
      el: HTMLInputElement | HTMLTextAreaElement,
    ): Promise<Suggestion[] | null> => {
      const links = linkSuggestions(el, this.source, () => {
        input.dataset.dirty = "1";
        void add(input.value);
      });
      if (links) return links;
      const q = el.value.trim();
      if (kind === "notes") {
        const t = taken ?? (await loadTaken());
        return matchFiles(q, this.source, 30)
          .filter((f) => !t.has(f.path))
          .slice(0, 20)
          .map((f) => ({
            label: f.title,
            detail: folderOf(f.path) || undefined,
            pick: () => linkTo(f.path),
          }));
      }
      if (kind === "people" || kind === "projects" || kind === "teams") {
        choices ??= loadChoices(kind);
        const [all, t] = await Promise.all([choices, taken ?? loadTaken()]);
        const fq = fold(q);
        const shown: Suggestion[] = all
          .filter((c) => !isTaken(t, c) && (!fq || fold(c.search).includes(fq)))
          .slice(0, 30)
          .map((c) => ({
            label: c.name,
            detail: c.detail,
            pick: () => (c.path ? linkTo(c.path) : add(c.name)),
          }));
        if (kind === "teams" && q && !all.some((c) => fold(c.name) === fq)) {
          shown.push({
            label: `Create team “${q}”`,
            action: true,
            pick: async () => linkTo(await createTeam(q)),
          });
        }
        if (!shown.length && !q && !all.length) {
          return [{ label: NONE[kind], action: true, pick: () => input.focus() }];
        }
        return shown;
      }
      if (key === "tags") {
        tags ??= api.tags();
        const t = new Set(listValues(this.view, key).map((s) => s.replace(/^#/, "").toLowerCase()));
        const fq = fold(q.replace(/^#/, ""));
        return (await tags)
          .filter((tag) => !t.has(tag.tag.toLowerCase()) && (!fq || fold(tag.tag).includes(fq)))
          .slice(0, 20)
          .map((tag) => ({
            label: `#${tag.tag}`,
            detail: String(tag.count),
            pick: () => add(tag.tag),
          }));
      }
      return null;
    };
    attachSuggest(input, source, { openOnFocus: !!kind || key === "tags", label });

    input.addEventListener("input", () => {
      input.dataset.dirty = "1";
      input.size = Math.max(4, input.value.length + 1, input.placeholder.length);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        let v = input.value.trim();
        if (!v) return;
        if (key === "tags") v = v.replace(/^#/, "");
        else if (kind && !/^\[\[.*\]\]$|^\[.*\]\(.*\)$/.test(v)) v = `[[${v}]]`;
        void add(v);
      } else if (e.key === "Escape") {
        e.preventDefault();
        input.value = "";
        input.blur();
        this.view.focus();
      } else if (e.key === "Backspace" && input.value === "") {
        // Back to the last value's remove button, as a way to take it out.
        const last = [...host.querySelectorAll<HTMLButtonElement>(".property-remove")].pop();
        if (last) {
          e.preventDefault();
          last.focus();
        }
      }
    });
    // Pasting several lines adds a value for each.
    input.addEventListener("paste", (e) => {
      const text = e.clipboardData?.getData("text/plain") ?? "";
      const lines = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      if (lines.length < 2) return;
      e.preventDefault();
      pendingFocus = { source: this.source, fid: fidOf(key, "value") };
      const now = listValues(this.view, key);
      void setValues(this.view, key, [...now, ...lines.filter((l) => !now.includes(l))]);
    });
  }

  // Adding properties

  private addRow(data: Record<string, unknown>): HTMLElement {
    const state = adding.get(this.source);
    const wrap = document.createElement("div");
    wrap.className = "property-new-row";
    if (!state) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "property-new";
      btn.dataset.fid = "\u001fnew";
      btn.innerHTML = `<span aria-hidden="true">+</span> Add property`;
      btn.addEventListener("click", () => {
        adding.set(this.source, { name: "", type: "text", typed: false });
        pendingFocus = { source: this.source, fid: "\u001fnew-name" };
        this.draw();
      });
      wrap.append(btn);
      return wrap;
    }

    wrap.classList.add("is-adding");
    const name = document.createElement("input");
    name.className = "property-new-name";
    name.placeholder = "Property name";
    name.value = state.name;
    name.dataset.fid = "\u001fnew-name";
    name.setAttribute("aria-label", "New property name");
    const type = document.createElement("select");
    type.className = "property-new-type";
    type.dataset.fid = "\u001fnew-type";
    type.setAttribute("aria-label", "New property type");
    for (const t of TYPES) {
      const o = document.createElement("option");
      o.value = t;
      o.textContent = TYPE_LABEL[t];
      type.append(o);
    }
    type.value = state.type;
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "property-new-ok";
    ok.textContent = "Add";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "property-new-cancel";
    cancel.textContent = "Cancel";
    const error = document.createElement("div");
    error.className = "property-new-error";
    error.setAttribute("role", "alert");
    error.textContent = state.error ?? "";
    wrap.append(name, type, ok, cancel, error);

    const stop = () => {
      adding.delete(this.source);
      pendingFocus = { source: this.source, fid: "\u001fnew" };
      this.draw();
    };
    const confirm = (key = name.value.trim(), t = state.type) => {
      const present = Object.keys(currentData(this.view));
      const problem = keyProblem(key, present);
      if (problem) {
        state.error = problem;
        error.textContent = problem;
        name.focus();
        return;
      }
      adding.delete(this.source);
      chooseType(this.source, key, t);
      pendingFocus = { source: this.source, fid: fidOf(key, "value") };
      const value: PropertyValue =
        t === "list"
          ? { kind: "list", value: [] }
          : t === "checkbox"
            ? { kind: "bool", value: false }
            : { kind: "empty" };
      void setProperty(this.view, key, value);
    };

    name.addEventListener("input", () => {
      state.name = name.value;
      state.error = undefined;
      error.textContent = "";
      if (!state.typed) {
        state.type = typeForName(name.value.trim());
        type.value = state.type;
      }
    });
    type.addEventListener("change", () => {
      state.type = type.value as PropType;
      state.typed = true;
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        confirm();
      } else if (e.key === "Escape") {
        e.preventDefault();
        stop();
      }
    };
    name.addEventListener("keydown", onKey);
    type.addEventListener("keydown", onKey);
    ok.addEventListener("click", () => confirm());
    cancel.addEventListener("click", stop);
    wrap.addEventListener("focusout", (e) => {
      if (this.redrawing) return;
      const next = e.relatedTarget;
      if (next instanceof Node && wrap.contains(next)) return;
      // Leaving an empty form puts it away.
      setTimeout(() => {
        if (!wrap.isConnected || wrap.contains(document.activeElement)) return;
        if (!name.value.trim()) stop();
      });
    });
    attachSuggest(
      name,
      (el) => {
        const q = el.value.trim().toLowerCase();
        return SUGGESTED_NAMES.filter(
          (k) => !(k in data) && (!q || k.startsWith(q)) && k !== q,
        ).map((k) => ({
          label: k,
          detail: TYPE_LABEL[typeForName(k)],
          pick: () => confirm(k, state.typed ? state.type : typeForName(k)),
        }));
      },
      { openOnFocus: true, label: "Property names" },
    );
    return wrap;
  }
}

function safeSelection(el: HTMLInputElement | HTMLTextAreaElement, which: "start" | "end") {
  try {
    return which === "start" ? el.selectionStart : el.selectionEnd;
  } catch {
    return null;
  }
}
