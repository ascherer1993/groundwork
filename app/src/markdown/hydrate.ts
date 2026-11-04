/**
 * Brings rendered Markdown to life: resolves links, loads images and
 * embeds, draws Mermaid diagrams, and wires clicks to the workspace.
 */
import { api } from "../api/client";
import { openExternalUrl, vaultFileUrl } from "../lib/fileUrl";
import { useUi } from "../state/ui";
import { message } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { renderMarkdown } from "./render";
import { mountTodos, parseTodosSpec } from "./todos";
import {
  escapeHtml,
  extension,
  extractSubpath,
  imageSize,
  isImage,
  splitFrontmatter,
  splitTarget,
} from "./syntax";

const MAX_EMBED_DEPTH = 3;

/**
 * Fills in placeholders inside `root`, rendered from the note at `source`.
 * Safe to call again after re-rendering.
 */
export async function hydrate(root: HTMLElement, source: string, depth = 0): Promise<void> {
  root.dataset.notePath ??= source;
  const links = [...root.querySelectorAll<HTMLElement>("a.internal-link[data-href]")].filter(
    (a) => a.closest("[data-note-path]") === root,
  );
  const embeds = [...root.querySelectorAll<HTMLElement>(".embed[data-embed]")];
  const images = [...root.querySelectorAll<HTMLImageElement>("img[data-src-link]")];

  const targets = new Set<string>();
  for (const a of links) targets.add(splitTarget(a.dataset.href!).target);
  for (const e of embeds) targets.add(splitTarget(e.dataset.embed!).target);
  for (const img of images) targets.add(img.dataset.srcLink!);
  targets.delete("");

  const list = [...targets];
  const resolved = new Map<string, string | null>();
  if (list.length) {
    try {
      const results = await api.resolveLinks(source, list);
      list.forEach((t, i) => resolved.set(t, results[i] ?? null));
    } catch {
      // Leave everything unresolved; the links still navigate on click.
    }
  }

  for (const a of links) {
    const { target } = splitTarget(a.dataset.href!);
    if (!target) {
      a.dataset.resolved = source;
      continue;
    }
    const path = resolved.get(target);
    if (path) a.dataset.resolved = path;
    else a.classList.add("is-unresolved");
  }

  for (const img of images) {
    const path = resolved.get(img.dataset.srcLink!);
    if (path) img.src = vaultFileUrl(path);
    else img.classList.add("is-unresolved");
  }

  mountTodoBlocks(root, source);
  await Promise.all([
    ...embeds.map((el) => {
      const { target, subpath } = splitTarget(el.dataset.embed!);
      const path = target ? (resolved.get(target) ?? null) : source;
      return renderEmbed(el, path, target, subpath, el.dataset.alias || undefined, depth);
    }),
    renderMermaid(root),
  ]);
}

async function renderEmbed(
  el: HTMLElement,
  path: string | null,
  target: string,
  subpath: string | undefined,
  alias: string | undefined,
  depth: number,
): Promise<void> {
  if (!path) {
    el.className = "embed embed-missing";
    el.textContent = `“${target}” not found`;
    return;
  }
  if (isImage(path)) {
    const img = document.createElement("img");
    img.src = vaultFileUrl(path);
    img.alt = alias && !/^\d/.test(alias) ? alias : target;
    const { width, height } = imageSize(alias);
    if (width) img.width = width;
    if (height) img.height = height;
    el.replaceWith(img);
    return;
  }
  const kind = extension(path);
  if (kind === "md" && depth < MAX_EMBED_DEPTH) {
    el.className = "embed embed-note";
    el.innerHTML = `<div class="embed-header"><a class="internal-link" href="#" data-href="${escapeHtml(target + (subpath ? `#${subpath}` : ""))}" data-resolved="${escapeHtml(path)}">${escapeHtml(path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, ""))}${subpath ? ` › ${escapeHtml(subpath)}` : ""}</a></div><div class="embed-body"></div>`;
    const body = el.querySelector<HTMLElement>(".embed-body")!;
    try {
      const file = await api.readFile(path);
      const fm = splitFrontmatter(file.text ?? "");
      const text = subpath ? extractSubpath(fm.body, subpath) : fm.body;
      if (text === null) {
        body.textContent = `“${subpath}” not found in this note`;
        return;
      }
      // Task line numbers only match the file when embedding the whole note.
      body.innerHTML = renderMarkdown(text, { lineOffset: subpath ? -1e6 : fm.lineOffset });
      body.dataset.notePath = path;
      await hydrate(body, path, depth + 1);
    } catch (err) {
      body.textContent = message(err);
    }
    return;
  }
  if (kind === "html" || kind === "htm" || kind === "page" || path.endsWith(".page")) {
    el.className = "embed embed-card";
    el.innerHTML = `<span>${escapeHtml(path.slice(path.lastIndexOf("/") + 1))}</span><span class="muted">Interactive page embeds arrive with HTML pages.</span><a class="internal-link" href="#" data-href="${escapeHtml(target)}" data-resolved="${escapeHtml(path)}">Open</a>`;
    return;
  }
  el.className = "embed embed-card";
  el.innerHTML = `<span>${escapeHtml(path.slice(path.lastIndexOf("/") + 1))}</span><a class="internal-link" href="#" data-href="${escapeHtml(target)}" data-resolved="${escapeHtml(path)}">Open</a>`;
}

/** `todos` blocks become live lists (they update themselves from then on). */
function mountTodoBlocks(root: HTMLElement, source: string) {
  for (const block of root.querySelectorAll<HTMLElement>(".todos-block[data-source]")) {
    const spec = parseTodosSpec(decodeURIComponent(block.dataset.source!));
    block.removeAttribute("data-source");
    mountTodos(block, spec, source);
  }
}

let mermaidCounter = 0;

async function renderMermaid(root: HTMLElement): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>(".mermaid-block[data-source]")];
  if (!blocks.length) return;
  const mermaid = (await import("mermaid")).default;
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: dark ? "dark" : "default",
  });
  for (const block of blocks) {
    const source = decodeURIComponent(block.dataset.source!);
    block.removeAttribute("data-source");
    try {
      const { svg } = await mermaid.render(`mermaid-${++mermaidCounter}`, source);
      block.innerHTML = svg;
    } catch (err) {
      block.classList.add("mermaid-error");
      block.textContent = `Mermaid: ${message(err)}`;
    }
  }
}

/** The file a rendered element came from. */
function notePathOf(el: Element): string | null {
  return el.closest<HTMLElement>("[data-note-path]")?.dataset.notePath ?? null;
}

let hoverTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Click and hover handling for rendered Markdown (reading view, embeds, hover
 * previews). Returns a cleanup function.
 */
export function attachContentHandlers(root: HTMLElement, opts: { hover?: boolean } = {}) {
  const onClick = (e: MouseEvent) => {
    const el = e.target as HTMLElement;
    const link = el.closest<HTMLAnchorElement>("a");
    if (link?.classList.contains("internal-link")) {
      e.preventDefault();
      const source = notePathOf(link);
      if (!source) return;
      void useWorkspace.getState().openLink(source, link.dataset.href ?? "", {
        newTab: e.metaKey || e.ctrlKey,
        resolved: link.dataset.resolved,
      });
      useUi.getState().showHover(null);
      return;
    }
    if (link?.classList.contains("external-link")) {
      e.preventDefault();
      void openExternalUrl(link.href);
      return;
    }
    if (link?.classList.contains("tag")) {
      e.preventDefault();
      return;
    }
    if (el instanceof HTMLInputElement && el.classList.contains("task-checkbox")) {
      const path = notePathOf(el);
      const line = Number(el.dataset.line);
      if (!path || !(line >= 0)) {
        e.preventDefault();
        return;
      }
      void api.toggleTask(path, line).catch((err) => {
        el.checked = !el.checked;
        useUi.getState().notify(message(err));
      });
    }
  };

  const onOver = (e: MouseEvent) => {
    if (!opts.hover) return;
    const link = (e.target as HTMLElement).closest<HTMLAnchorElement>("a.internal-link");
    if (!link?.dataset.resolved) return;
    const path = link.dataset.resolved;
    const { subpath } = splitTarget(link.dataset.href ?? "");
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      const rect = link.getBoundingClientRect();
      useUi.getState().showHover({ path, subpath, x: rect.left, y: rect.bottom + 6 });
    }, 450);
  };

  const onOut = (e: MouseEvent) => {
    const link = (e.target as HTMLElement).closest("a.internal-link");
    if (link && hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
  };

  root.addEventListener("click", onClick);
  root.addEventListener("mouseover", onOver);
  root.addEventListener("mouseout", onOut);
  return () => {
    root.removeEventListener("click", onClick);
    root.removeEventListener("mouseover", onOver);
    root.removeEventListener("mouseout", onOut);
  };
}
