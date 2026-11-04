/**
 * The `tickets` code block: a live list of tickets in any note, e.g. on a
 * project's overview. Each line is a filter: `project: this` (the note's
 * project) or a project's name, `repo:`, `component:`, `status:
 * active|closed|all`, `group: project|repo|status|none`.
 */
import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { TicketList, type TicketGrouping, type TicketListSpec } from "../components/TicketList";
import { useTickets } from "../state/tickets";
import { CONTENT_RESIZED } from "./todos";

export function parseTicketsSpec(source: string, notePath: string): TicketListSpec {
  const spec: TicketListSpec = {};
  for (const line of source.split("\n")) {
    const m = line.trim().match(/^(\w+)\s*:\s*(.+)$/);
    if (!m) continue;
    const value = m[2]!.trim();
    switch (m[1]!.toLowerCase()) {
      case "project":
        spec.project = value === "this" ? (projectOf(notePath) ?? "this") : value;
        break;
      case "repo":
        spec.repo = value;
        break;
      case "component":
        spec.component = value;
        break;
      case "status":
        spec.status = value;
        break;
      case "group":
        if (["project", "repo", "status", "none"].includes(value)) {
          spec.group = value as TicketGrouping;
        }
        break;
    }
  }
  return spec;
}

/** The project a note is in (its folder, or the project it's the overview of). */
function projectOf(path: string): string | undefined {
  const { projects } = useTickets.getState();
  return projects
    .filter((p) => p.overview === path || path.startsWith(`${p.folder}/`))
    .sort((a, b) => b.folder.length - a.folder.length)[0]?.id;
}

function Block({ source, notePath, el }: { source: string; notePath: string; el: HTMLElement }) {
  // Re-read once projects load, so `project: this` resolves.
  const projects = useTickets((s) => s.projects);
  const tickets = useTickets((s) => s.tickets);
  const spec = parseTicketsSpec(source, notePath);
  const first = useRef(true);
  useEffect(() => {
    if (first.current && !projects.length) void useTickets.getState().load();
    first.current = false;
    el.dispatchEvent(new Event(CONTENT_RESIZED, { bubbles: true }));
  }, [projects, tickets, el]);
  return <TicketList spec={spec} />;
}

/** Renders a `tickets` block into `el`. Returns a function that stops it. */
export function mountTickets(el: HTMLElement, source: string, notePath: string): () => void {
  el.classList.add("tickets-view");
  const root = createRoot(el);
  root.render(<Block source={source} notePath={notePath} el={el} />);
  let stopped = false;
  // Stop once the block leaves the page (its note re-rendered or closed).
  const watch = setInterval(() => {
    if (!el.isConnected) stop();
  }, 2000);
  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(watch);
    setTimeout(() => root.unmount());
  }
  return stop;
}
