/**
 * The project view (PLAN §5.13): a tab with a project's events, people and
 * tickets, each with a search, a filter and a sort. Its path is
 * `project:<id>` (`lib/paths.ts`), so opening a note from it keeps it in the
 * tab's history.
 */
import { CalendarPlus, FileText, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { ProjectEvent } from "../api/generated/ProjectEvent";
import type { ProjectPerson } from "../api/generated/ProjectPerson";
import type { ProjectView as View } from "../api/generated/ProjectView";
import { today } from "../markdown/syntax";
import { runChoice, useQuickAdd } from "../state/quickadd";
import { message, onVaultChange } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { TicketList } from "./TicketList";

type Section = "events" | "people" | "tickets";
type EventFilter = "all" | "upcoming" | "past";
type EventSort = "newest" | "oldest" | "title";
type PersonFilter = "all" | "members" | "mentioned";
type PersonSort = "name" | "seen" | "mentions";

const SECTION_KEY = "groundwork.projectSection";

function savedSection(): Section {
  try {
    const s = localStorage.getItem(SECTION_KEY);
    return s === "people" || s === "tickets" ? s : "events";
  } catch {
    return "events";
  }
}

/** Searches, filters and sorts, per project, so going back to a view finds it as it was. */
const remembered = new Map<string, unknown>();

function useRemembered<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => (remembered.get(key) as T | undefined) ?? initial);
  const set = (v: T) => {
    remembered.set(key, v);
    setValue(v);
  };
  return [value, set];
}

/** Every word is somewhere in `hay`. */
function matches(query: string, ...hay: (string | null | undefined)[]): boolean {
  const text = hay.join(" ").toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((w) => text.includes(w));
}

/** "Wed, Nov 4", with the year when it isn't this one. */
function formatDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const when = new Date(y!, m! - 1, d!);
  return when.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: y === new Date().getFullYear() ? undefined : "numeric",
  });
}

/** Opens a note from the view: here, or in a new tab with ⌘. */
function openNote(path: string, e: React.MouseEvent) {
  useWorkspace.getState().open(path, { newTab: e.metaKey });
}

/** A filter's choices, as a row of buttons. */
function Choices<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

function Sort<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <label className="project-sort">
      <span className="muted">Sort</span>
      <select aria-label="Sort" value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

function Search({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <input
      className="project-search"
      type="search"
      aria-label={label}
      placeholder={`${label}…`}
      spellCheck={false}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** The Quick add choice that makes notes in `folder`, if there is one. */
function useChoiceIn(folder: string): string | undefined {
  return useQuickAdd(
    (s) => s.choices.find((c) => c.kind === "note" && c.folder === folder && c.project)?.name,
  );
}

function Events({ events, project }: { events: ProjectEvent[]; project: string }) {
  const [query, setQuery] = useRemembered(`${project}:events:query`, "");
  const [filter, setFilter] = useRemembered<EventFilter>(`${project}:events:filter`, "all");
  const [sort, setSort] = useRemembered<EventSort>(`${project}:events:sort`, "newest");
  const choice = useChoiceIn("Events");
  const now = today();
  const shown = events
    .filter((e) => {
      if (filter === "upcoming") return !!e.date && e.date >= now;
      if (filter === "past") return !e.date || e.date < now;
      return true;
    })
    .filter((e) => !query.trim() || matches(query, e.title, ...e.people));
  // The list comes newest first.
  if (sort === "oldest") shown.reverse();
  if (sort === "title") shown.sort((a, b) => a.title.localeCompare(b.title));

  return (
    <section className="project-section" aria-label="Events">
      <div className="project-toolbar">
        <Search label="Search events" value={query} onChange={setQuery} />
        <Choices
          label="Show events"
          value={filter}
          onChange={setFilter}
          options={[
            ["all", "All"],
            ["upcoming", "Upcoming"],
            ["past", "Past"],
          ]}
        />
        <Sort
          value={sort}
          onChange={setSort}
          options={[
            ["newest", "Newest first"],
            ["oldest", "Oldest first"],
            ["title", "Title"],
          ]}
        />
        {choice && (
          <button
            type="button"
            className="note-bar-button"
            onClick={() => void runChoice(choice, { project })}
          >
            <CalendarPlus size={13} /> New event
          </button>
        )}
      </div>
      {shown.length ? (
        <ul className="project-list">
          {shown.map((e) => (
            <li key={e.path}>
              <button
                type="button"
                className={`project-row${e.date && e.date >= now ? " is-upcoming" : ""}`}
                title={e.path}
                onClick={(ev) => openNote(e.path, ev)}
              >
                <span className="project-when">
                  {e.date ? (e.date === now ? "Today" : formatDate(e.date)) : "No date"}
                  {e.time && <span className="muted"> {e.time}</span>}
                </span>
                <span className="project-name">{e.title}</span>
                {e.people.length > 0 && (
                  <span className="project-detail muted">{e.people.join(", ")}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="project-empty muted">
          {events.length ? "No events match." : "No events yet. Quick add (⇧⌘A) makes one."}
        </p>
      )}
    </section>
  );
}

function People({ people, project }: { people: ProjectPerson[]; project: string }) {
  const [query, setQuery] = useRemembered(`${project}:people:query`, "");
  const [filter, setFilter] = useRemembered<PersonFilter>(`${project}:people:filter`, "all");
  const [sort, setSort] = useRemembered<PersonSort>(`${project}:people:sort`, "name");
  const choice = useChoiceIn("Contacts");
  const shown = people
    .filter((p) => (filter === "members" ? p.member : filter === "mentioned" ? !p.member : true))
    .filter((p) => !query.trim() || matches(query, p.name, p.role, p.company));
  if (sort === "seen") {
    shown.sort((a, b) => (b.lastSeen ?? "").localeCompare(a.lastSeen ?? ""));
  }
  if (sort === "mentions") shown.sort((a, b) => b.mentions - a.mentions);

  return (
    <section className="project-section" aria-label="People">
      <div className="project-toolbar">
        <Search label="Search people" value={query} onChange={setQuery} />
        <Choices
          label="Show people"
          value={filter}
          onChange={setFilter}
          options={[
            ["all", "All"],
            ["members", "Members"],
            ["mentioned", "Mentioned only"],
          ]}
        />
        <Sort
          value={sort}
          onChange={setSort}
          options={[
            ["name", "Name"],
            ["seen", "Last seen"],
            ["mentions", "Most mentioned"],
          ]}
        />
        {choice && (
          <button
            type="button"
            className="note-bar-button"
            onClick={() => void runChoice(choice, { project })}
          >
            <UserPlus size={13} /> New person
          </button>
        )}
      </div>
      {shown.length ? (
        <ul className="project-list">
          {shown.map((p) => (
            <li key={p.path}>
              <button
                type="button"
                className="project-row"
                title={p.path}
                onClick={(ev) => openNote(p.path, ev)}
              >
                <span className="project-name">{p.name}</span>
                <span className="project-tags">
                  {p.member && <span className="project-tag">Member</span>}
                  {p.mentions > 0 && (
                    <span className="project-tag is-mentioned">
                      Mentioned in {p.mentions} {p.mentions === 1 ? "note" : "notes"}
                    </span>
                  )}
                </span>
                <span className="project-detail muted">
                  {[p.role, p.company].filter(Boolean).join(" · ")}
                </span>
                <span className="project-when muted">
                  {p.lastSeen ? `Seen ${formatDate(p.lastSeen)}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="project-empty muted">
          {people.length
            ? "No one matches."
            : "No people yet. Link them from the project’s notes, or add the project to theirs."}
        </p>
      )}
    </section>
  );
}

function Tickets({ project }: { project: string }) {
  const [query, setQuery] = useRemembered(`${project}:tickets:query`, "");
  const [closed, setClosed] = useRemembered(`${project}:tickets:closed`, false);
  return (
    <section className="project-section" aria-label="Tickets">
      <div className="project-toolbar">
        <Search label="Search tickets" value={query} onChange={setQuery} />
        <Choices
          label="Show tickets"
          value={closed ? "all" : "active"}
          onChange={(v) => setClosed(v === "all")}
          options={[
            ["active", "Active"],
            ["all", "All"],
          ]}
        />
      </div>
      <TicketList
        spec={{ project, text: query.trim() || undefined, status: closed ? "all" : "active" }}
        empty={closed ? "No tickets." : "No active tickets."}
      />
    </section>
  );
}

/** A project's view, kept up to date as notes change. */
export function ProjectView({ id, setTitle }: { id: string; setTitle: (title: string) => void }) {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState<Section>(savedSection);
  const choose = (s: Section) => {
    setSection(s);
    try {
      localStorage.setItem(SECTION_KEY, s);
    } catch {
      // Not remembered.
    }
  };

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      void api
        .projectView(id)
        .then((v) => !cancelled && (setView(v), setError(null)))
        .catch((err) => !cancelled && setError(message(err)));
    load();
    const stop = onVaultChange(load);
    return () => {
      cancelled = true;
      stop();
    };
  }, [id]);

  const name = view?.project.id === id ? view.project.name : null;
  useEffect(() => {
    if (name) setTitle(name);
  }, [name, setTitle]);

  if (error) {
    return (
      <p className="error" role="alert">
        {error}
      </p>
    );
  }
  if (!view || view.project.id !== id) return <div className="loading" aria-busy="true" />;
  const { project, events, people } = view;
  const upcoming = events.filter((e) => e.date && e.date >= today()).length;

  return (
    <div className="project-view">
      <header className="project-head">
        <h1>{project.name}</h1>
        <p className="muted">
          {events.length} {events.length === 1 ? "event" : "events"}
          {upcoming > 0 && ` (${upcoming} upcoming)`} · {people.length}{" "}
          {people.length === 1 ? "person" : "people"}
        </p>
        {project.overview && (
          <button
            type="button"
            className="note-bar-button"
            onClick={(e) => openNote(project.overview!, e)}
          >
            <FileText size={13} /> Overview
          </button>
        )}
      </header>
      <div className="segmented project-tabs" role="tablist" aria-label="Show">
        {(
          [
            ["events", "Events", events.length],
            ["people", "People", people.length],
            ["tickets", "Tickets", null],
          ] as const
        ).map(([s, label, count]) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={section === s}
            aria-pressed={section === s}
            onClick={() => choose(s)}
          >
            {label}
            {count !== null && <span className="count">{count}</span>}
          </button>
        ))}
      </div>
      {section === "events" && <Events events={events} project={project.id} />}
      {section === "people" && <People people={people} project={project.id} />}
      {section === "tickets" && <Tickets project={project.id} />}
    </div>
  );
}
