import { useEffect, useMemo, useRef } from "react";
import { propertiesHtml } from "../editor/widgets";
import { attachContentHandlers, hydrate } from "../markdown/hydrate";
import { renderMarkdown } from "../markdown/render";
import { splitFrontmatter } from "../markdown/syntax";
import type { FocusTarget } from "../state/workspace";

/** Scrolls a rendered note to a heading or block id. */
function scrollToSubpath(root: HTMLElement, subpath: string) {
  let el: Element | null = null;
  if (subpath.startsWith("^")) {
    el = root.querySelector(`[data-block-id="${CSS.escape(subpath.slice(1))}"]`);
  } else {
    const last = subpath.split("#").pop()!.trim().toLowerCase();
    el =
      [...root.querySelectorAll<HTMLElement>("[data-heading]")].find(
        (h) => h.dataset.heading!.toLowerCase() === last,
      ) ?? null;
  }
  el?.scrollIntoView({ block: "start" });
  el?.classList.add("flash");
  setTimeout(() => el?.classList.remove("flash"), 1200);
}

export function ReadingView({
  path,
  text,
  focus,
}: {
  path: string;
  text: string;
  focus?: FocusTarget;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { html, properties } = useMemo(() => {
    const fm = splitFrontmatter(text);
    return {
      html: renderMarkdown(fm.body, { lineOffset: fm.lineOffset }),
      properties: fm.yaml !== null ? propertiesHtml(fm.yaml) : null,
    };
  }, [text]);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    root.dataset.notePath = path;
    void hydrate(root, path).then(() => {
      if (focus?.subpath) scrollToSubpath(root, focus.subpath);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, path, focus?.nonce]);

  useEffect(() => {
    const root = ref.current;
    return root ? attachContentHandlers(root, { hover: true }) : undefined;
  }, []);

  return (
    <div className="reading-view" ref={ref} data-testid="reading-view">
      {properties && (
        <div className="properties" dangerouslySetInnerHTML={{ __html: properties }} />
      )}
      <div className="markdown-rendered" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
