import { type EditorView, WidgetType } from "@codemirror/view";
import katex from "katex";
import { parse as parseYaml } from "yaml";
import { api } from "../api/client";
import { vaultFileUrl } from "../lib/fileUrl";
import { attachContentHandlers, hydrate } from "../markdown/hydrate";
import { renderInline, renderMarkdown } from "../markdown/render";
import { CONTENT_RESIZED } from "../markdown/todos";
import {
  escapeHtml,
  imageSize,
  joinTarget,
  type WikiTarget,
  wikiDisplay,
} from "../markdown/syntax";
import { notePath } from "./context";

/**
 * Fills in a widget's links, embeds and diagrams. They change its height
 * after CodeMirror measured it, so ask for a new measurement; otherwise
 * clicks below the widget land on the wrong line.
 */
function hydrateWidget(view: EditorView, dom: HTMLElement, source: string) {
  const remeasure = () => view.requestMeasure();
  void hydrate(dom, source).then(remeasure);
  dom.addEventListener("load", remeasure, { capture: true });
  // Live blocks (todos) re-render as the vault changes.
  dom.addEventListener(CONTENT_RESIZED, remeasure);
}

/** Moves the cursor into a rendered block so its source shows. */
function editAt(view: EditorView, dom: HTMLElement) {
  const pos = view.posAtDOM(dom);
  view.dispatch({ selection: { anchor: pos } });
  view.focus();
}

function isInteractive(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    !!target.closest("a, input, button, summary, .embed-note, .embed-page, .todos-view")
  );
}

export class WikiLinkWidget extends WidgetType {
  constructor(
    readonly link: WikiTarget,
    readonly source: string,
  ) {
    super();
  }

  eq(other: WikiLinkWidget) {
    return (
      joinTarget(other.link) === joinTarget(this.link) &&
      other.link.alias === this.link.alias &&
      other.source === this.source
    );
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-wikilink";
    span.textContent = wikiDisplay(this.link);
    span.dataset.href = joinTarget(this.link);
    if (this.link.target) {
      void api
        .resolveLinks(this.source, [this.link.target])
        .then(([path]) => {
          if (path) span.dataset.resolved = path;
          else span.classList.add("is-unresolved");
        })
        .catch(() => {});
    } else {
      span.dataset.resolved = this.source;
    }
    return span;
  }

  // Clicks reach the editor's handler, which follows the link.
  ignoreEvent() {
    return false;
  }
}

export class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }

  eq(other: CheckboxWidget) {
    return other.checked === this.checked;
  }

  toDOM() {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-task-checkbox task-checkbox";
    box.checked = this.checked;
    box.dataset.editorTask = "true";
    return box;
  }

  // Clicks reach the editor's handler, which toggles the task in the document.
  ignoreEvent() {
    return false;
  }
}

/** Priority and dates, on their own line under the task. */
export class TaskMetaWidget extends WidgetType {
  constructor(readonly html: string) {
    super();
  }

  eq(other: TaskMetaWidget) {
    return other.html === this.html;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-task-meta";
    span.innerHTML = this.html;
    return span;
  }
}

export class BulletWidget extends WidgetType {
  eq() {
    return true;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-bullet";
    span.textContent = "•";
    return span;
  }
}

export class HrWidget extends WidgetType {
  eq() {
    return true;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-hr";
    return span;
  }
}

export class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
  ) {
    super();
  }

  eq(other: MathWidget) {
    return other.tex === this.tex && other.display === this.display;
  }

  toDOM(view: EditorView) {
    const el = document.createElement(this.display ? "div" : "span");
    el.className = this.display ? "cm-math-block" : "cm-math";
    el.innerHTML = katex.renderToString(this.tex, {
      displayMode: this.display,
      throwOnError: false,
    });
    if (this.display)
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        editAt(view, el);
      });
    return el;
  }

  ignoreEvent() {
    return this.display;
  }
}

/** `![[...]]` and `![alt](path)`: images, notes and pages, via the reading-view hydrator. */
export class EmbedWidget extends WidgetType {
  constructor(
    readonly target: string,
    readonly alias: string | undefined,
    readonly source: string,
    readonly external = false,
  ) {
    super();
  }

  eq(other: EmbedWidget) {
    return (
      other.target === this.target &&
      other.alias === this.alias &&
      other.source === this.source &&
      other.external === this.external
    );
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("span");
    wrap.className = "cm-embed";
    wrap.dataset.notePath = this.source;
    if (this.external) {
      const img = document.createElement("img");
      img.src = this.target;
      img.alt = this.alias ?? "";
      const { width, height } = imageSize(this.alias);
      if (width) img.width = width;
      if (height) img.height = height;
      img.addEventListener("load", () => view.requestMeasure());
      wrap.append(img);
      return wrap;
    }
    const placeholder = document.createElement("span");
    placeholder.className = "embed";
    placeholder.dataset.embed = this.target;
    placeholder.dataset.alias = this.alias ?? "";
    wrap.append(placeholder);
    hydrateWidget(view, wrap, this.source);
    attachContentHandlers(wrap);
    return wrap;
  }

  ignoreEvent(event: Event) {
    return event.type !== "mousedown" || isInteractive(event.target);
  }
}

/** A multi-line block rendered as Markdown: callouts, tables, Mermaid. */
export class MarkdownBlockWidget extends WidgetType {
  constructor(
    readonly markdown: string,
    readonly source: string,
    readonly lineOffset: number,
  ) {
    super();
  }

  eq(other: MarkdownBlockWidget) {
    return other.markdown === this.markdown && other.source === this.source;
  }

  toDOM(view: EditorView) {
    const div = document.createElement("div");
    div.className = "cm-rendered-block markdown-rendered";
    div.dataset.notePath = this.source;
    div.innerHTML = renderMarkdown(this.markdown, { lineOffset: this.lineOffset });
    hydrateWidget(view, div, this.source);
    attachContentHandlers(div);
    div.addEventListener("mousedown", (e) => {
      if (isInteractive(e.target)) return;
      e.preventDefault();
      editAt(view, div);
    });
    return div;
  }

  ignoreEvent() {
    return true;
  }
}

/** Frontmatter as a properties table. */
export class PropertiesWidget extends WidgetType {
  constructor(
    readonly yaml: string,
    readonly source: string,
  ) {
    super();
  }

  eq(other: PropertiesWidget) {
    return other.yaml === this.yaml && other.source === this.source;
  }

  toDOM(view: EditorView) {
    const div = document.createElement("div");
    div.className = "cm-properties";
    div.dataset.notePath = this.source;
    div.innerHTML = propertiesHtml(this.yaml);
    hydrateWidget(view, div, this.source);
    attachContentHandlers(div);
    div.addEventListener("mousedown", (e) => {
      if (isInteractive(e.target)) return;
      e.preventDefault();
      editAt(view, div);
    });
    return div;
  }

  ignoreEvent() {
    return true;
  }
}

/** Renders frontmatter YAML as a two-column table; values may contain links. */
export function propertiesHtml(yaml: string): string {
  let data: unknown;
  try {
    data = parseYaml(yaml);
  } catch {
    return `<div class="properties-error">Invalid properties</div><pre>${escapeHtml(yaml)}</pre>`;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return `<div class="properties-empty">No properties</div>`;
  }
  const rows = Object.entries(data as Record<string, unknown>).map(([key, value]) => {
    const values = Array.isArray(value) ? value : [value];
    const cells = values
      .filter((v) => v !== null && v !== undefined && v !== "")
      .map((v) => `<span class="property-value">${renderInline(formatValue(v))}</span>`)
      .join("");
    return `<div class="property"><div class="property-key">${escapeHtml(key)}</div><div class="property-values">${cells || '<span class="muted">—</span>'}</div></div>`;
  });
  return `<div class="properties-title">Properties</div>${rows.join("")}`;
}

function formatValue(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 16).replace("T", " ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Resolves a relative Markdown image path for the editor. */
export function imageUrlFor(path: string | null): string | null {
  return path ? vaultFileUrl(path) : null;
}

export { notePath };
