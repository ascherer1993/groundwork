/**
 * Brings rendered Markdown to life: resolves links, loads images and
 * embeds, draws Mermaid diagrams, and wires clicks to the workspace.
 */
import { api } from "../api/client";
import { openExternalUrl, vaultFileUrl } from "../lib/fileUrl";
import { closePreview, enterLink, leaveLink } from "../lib/linkPreview";
import { createPageFrame } from "../lib/pages";
import { isPagePath } from "../lib/paths";
import { useUi } from "../state/ui";
import { message } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { renderMarkdown } from "./render";
import { mountTickets } from "./tickets";
import { CONTENT_RESIZED, mountTodos, parseTodosSpec } from "./todos";
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
  mountTicketBlocks(root, source);
  await Promise.all([
    ...embeds.map((el) => {
      const { target, subpath } = splitTarget(el.dataset.embed!);
      const path = target ? (resolved.get(target) ?? null) : source;
      return renderEmbed(el, source, path, target, subpath, el.dataset.alias || undefined, depth);
    }),
    renderMermaid(root),
  ]);
}

/** Embeds folded this session, by the note they're in and what they embed. */
const collapsed = new Set<string>();

const CHEVRON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';

/** The header over an embedded note or page: a chevron that folds it, and a link to open it. */
function embedHeader(link: string): string {
  return `<div class="embed-header"><button type="button" class="embed-toggle">${CHEVRON}</button>${link}</div>`;
}

/** Wires an embed's chevron; it stays folded, this session, wherever it's shown. */
function foldable(el: HTMLElement, source: string) {
  const toggle = el.querySelector<HTMLButtonElement>(":scope > .embed-header > .embed-toggle");
  if (!toggle) return;
  const key = `${source}\n${el.dataset.embed}`;
  const show = (folded: boolean) => {
    el.classList.toggle("is-collapsed", folded);
    toggle.setAttribute("aria-expanded", String(!folded));
    toggle.setAttribute("aria-label", folded ? "Expand embed" : "Collapse embed");
    toggle.title = folded ? "Expand" : "Collapse";
  };
  show(collapsed.has(key));
  toggle.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const folded = !collapsed.has(key);
    if (folded) collapsed.add(key);
    else collapsed.delete(key);
    show(folded);
    // Live preview re-measures its lines.
    el.dispatchEvent(new Event(CONTENT_RESIZED, { bubbles: true }));
  });
}

async function renderEmbed(
  el: HTMLElement,
  source: string,
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
    el.innerHTML = `${embedHeader(`<a class="internal-link" href="#" data-href="${escapeHtml(target + (subpath ? `#${subpath}` : ""))}" data-resolved="${escapeHtml(path)}">${escapeHtml(path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, ""))}${subpath ? ` › ${escapeHtml(subpath)}` : ""}</a>`)}<div class="embed-body"></div>`;
    foldable(el, source);
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
  if (isPagePath(path)) {
    // Live: `![[x.page]]` sizes itself to the page, `![[x.page|400]]` is 400px tall.
    el.className = "embed embed-page";
    el.innerHTML = embedHeader(
      `<a class="internal-link" href="#" data-href="${escapeHtml(target)}" data-resolved="${escapeHtml(path)}">${escapeHtml(path.slice(path.lastIndexOf("/") + 1))}</a>`,
    );
    foldable(el, source);
    const height = alias && /^\d+$/.test(alias) ? Number(alias) : undefined;
    el.append(createPageFrame(path, { embed: true, height }));
    return;
  }
  el.className = "embed embed-card";
  el.innerHTML = `<span>${escapeHtml(path.slice(path.lastIndexOf("/") + 1))}</span><a class="internal-link" href="#" data-href="${escapeHtml(target)}" data-resolved="${escapeHtml(path)}">Open</a>`;
}

/** `tickets` blocks become live lists too. */
function mountTicketBlocks(root: HTMLElement, source: string) {
  for (const block of root.querySelectorAll<HTMLElement>(".tickets-block[data-source]")) {
    const spec = decodeURIComponent(block.dataset.source!);
    block.removeAttribute("data-source");
    mountTickets(block, spec, source);
  }
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

/**
 * Mermaid isn't safe to run concurrently: overlapping renders (reading view
 * and live preview hydrating at once, say) corrupt its state and leave its
 * scratch elements in `<body>`. So every render goes through one queue.
 */
let mermaidQueue: Promise<void> = Promise.resolve();

function renderMermaid(root: HTMLElement): Promise<void> {
  // Claim the blocks now, before any await, so a second hydrate of the same
  // root doesn't render them again.
  const blocks = [...root.querySelectorAll<HTMLElement>(".mermaid-block[data-source]")].map(
    (block) => {
      const source = decodeURIComponent(block.dataset.source!);
      block.removeAttribute("data-source");
      return { block, source };
    },
  );
  if (!blocks.length) return Promise.resolve();
  const run = mermaidQueue.then(async () => {
    const mermaid = (await import("mermaid")).default;
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: dark ? "dark" : "default",
      // Errors show in the block, not as diagrams appended to the page.
      suppressErrorRendering: true,
    });
    for (const { block, source } of blocks) {
      // The view may have re-rendered while this waited its turn.
      if (!block.isConnected) continue;
      const id = `mermaid-${++mermaidCounter}`;
      try {
        const { svg } = await mermaid.render(id, source);
        block.innerHTML = svg;
      } catch (err) {
        block.classList.add("mermaid-error");
        block.textContent = `Mermaid: ${message(err)}`;
      } finally {
        // Mermaid's scratch container, which it can leave behind on failure.
        document.getElementById(`d${id}`)?.remove();
      }
    }
  });
  mermaidQueue = run.catch(() => {});
  return run;
}

/** The file a rendered element came from. */
function notePathOf(el: Element): string | null {
  return el.closest<HTMLElement>("[data-note-path]")?.dataset.notePath ?? null;
}

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
      closePreview();
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

  // ⌘-hover previews (see `lib/linkPreview.ts`).
  const onOver = (e: MouseEvent) => {
    if (!opts.hover) return;
    const link = (e.target as HTMLElement).closest<HTMLAnchorElement>("a.internal-link");
    if (!link?.dataset.resolved) return;
    const { subpath } = splitTarget(link.dataset.href ?? "");
    enterLink({ el: link, path: link.dataset.resolved, subpath }, e.metaKey);
  };

  const onOut = (e: MouseEvent) => {
    const link = (e.target as HTMLElement).closest<HTMLElement>("a.internal-link");
    if (link && !link.contains(e.relatedTarget as Node | null)) leaveLink(link);
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
