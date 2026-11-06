import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { Backlinks } from "../api/generated/Backlinks";
import type { Mention } from "../api/generated/Mention";
import type { OutgoingLink } from "../api/generated/OutgoingLink";
import { displayName, isViewPath, projectOfView } from "../lib/paths";
import { useTickets } from "../state/tickets";
import { useUi } from "../state/ui";
import { message, useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";

interface Data {
  path: string;
  /** Unlinked mentions and outgoing links are for notes only. */
  note: boolean;
  backlinks: Backlinks[];
  unlinked: Mention[];
  outgoing: OutgoingLink[];
}

/** A line of Markdown as plain text: links show as their display text. */
function plain(context: string) {
  return context
    .replace(
      /!?\[\[([^\]|#]*)(?:#([^\]|]*))?(?:\|([^\]]*))?\]\]/g,
      (_, t, sub, alias) => alias ?? (t || "") + (sub ? ` › ${sub}` : ""),
    )
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?/, "")
    .replace(/(\*\*|__|==|~~)(.+?)\1/g, "$2");
}

function title(path: string) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.toLowerCase().endsWith(".md") ? displayName(name, "note").base : name;
}

/** Whether a tab showing `path` has links to show. */
export function hasLinks(path: string): boolean {
  return !!projectOfView(path) || !isViewPath(path);
}

/**
 * Backlinks, unlinked mentions and outgoing links of the note a tab shows,
 * beside it. Other files (pages, images) get their backlinks.
 */
export function LinksPanel({ path: shown }: { path: string }) {
  // A project's view shows its overview note's links.
  const project = projectOfView(shown);
  const overview = useTickets((s) => s.projects.find((p) => p.id === project)?.overview ?? null);
  // Other views (the todo board) have no links.
  const path = project ? overview : isViewPath(shown) ? null : shown;
  const revision = useVault((s) => s.revision);
  const [data, setData] = useState<Data | null>(null);

  useEffect(() => {
    if (!path) return;
    const note = path.toLowerCase().endsWith(".md");
    let cancelled = false;
    const timer = setTimeout(() => {
      Promise.all([
        api.backlinks(path),
        note ? api.unlinked(path) : [],
        note ? api.outgoing(path) : [],
      ])
        .then(([backlinks, unlinked, outgoing]) => {
          if (!cancelled) setData({ path, note, backlinks, unlinked, outgoing });
        })
        .catch(() => {});
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [path, revision]);

  if (!path) return <p className="panel-empty muted">No links here.</p>;
  // Still loading: stay blank rather than flash a wrong message.
  if (!data || data.path !== path) return null;

  const linkCount = data.backlinks.reduce((n, b) => n + b.links.length, 0);
  // One row per destination.
  const seen = new Set<string>();
  const outgoing = data.outgoing.filter((o) => {
    const key =
      (o.resolved ?? o.link.target.toLowerCase()) + (o.link.subpath ? `#${o.link.subpath}` : "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const open = useWorkspace.getState().open;

  return (
    <div className="links-panel">
      <Section title="Backlinks" count={linkCount} testId="backlinks">
        {data.backlinks.length === 0 && <p className="muted small">No backlinks.</p>}
        {data.backlinks.map((b) => (
          <div key={b.source} className="link-group">
            <button
              className="link-source"
              onClick={(e) => open(b.source, { newTab: e.metaKey })}
              title={b.source}
            >
              {title(b.source)}
            </button>
            {b.links.map((l, i) => (
              <button
                key={i}
                className="link-context"
                onClick={(e) => open(b.source, { line: l.line, newTab: e.metaKey })}
              >
                {plain(l.context)}
              </button>
            ))}
          </div>
        ))}
      </Section>

      {data.note && (
        <Section title="Unlinked mentions" count={data.unlinked.length} testId="unlinked" collapsed>
          {data.unlinked.length === 0 && <p className="muted small">No unlinked mentions.</p>}
          {data.unlinked.map((m, i) => (
            <div key={`${m.source}:${m.range.start}:${i}`} className="link-group">
              <div className="mention-row">
                <button className="link-source" onClick={() => open(m.source, { line: m.line })}>
                  {title(m.source)}
                </button>
                <button
                  className="small-button"
                  onClick={() =>
                    void api
                      .linkMention(m.source, m.range.start, m.range.end, m.text, path)
                      .catch((err) => useUi.getState().notify(message(err)))
                  }
                >
                  Link
                </button>
              </div>
              <div className="link-context static">{plain(m.context)}</div>
            </div>
          ))}
        </Section>
      )}

      {data.note && (
        <Section title="Outgoing links" count={outgoing.length} testId="outgoing">
          {outgoing.length === 0 && <p className="muted small">No outgoing links.</p>}
          {outgoing.map((o, i) => (
            <button
              key={i}
              className={`outgoing${o.resolved ? "" : " is-unresolved"}`}
              title={o.resolved ?? `${o.link.target} (not created yet)`}
              onClick={(e) =>
                void useWorkspace
                  .getState()
                  .openLink(
                    path,
                    o.link.subpath ? `${o.link.target}#${o.link.subpath}` : o.link.target,
                    {
                      newTab: e.metaKey,
                      resolved: o.resolved ?? null,
                    },
                  )
              }
            >
              {o.resolved ? title(o.resolved) : o.link.target}
              {o.link.subpath && <span className="muted"> › {o.link.subpath}</span>}
            </button>
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({
  title,
  count,
  children,
  testId,
  collapsed = false,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
  testId: string;
  collapsed?: boolean;
}) {
  const [open, setOpen] = useState(!collapsed);
  return (
    <section className="panel-section" data-testid={testId}>
      <button className="section-header" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight size={12} className={`chevron${open ? " open" : ""}`} />
        {title}
        <span className="count">{count}</span>
      </button>
      {open && <div className="section-body">{children}</div>}
    </section>
  );
}
