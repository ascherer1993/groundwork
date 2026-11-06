/**
 * The todo board (PLAN §5.11): a week, a column a day, each with its events,
 * the todos due that day and the ones done. Overdue todos show on today.
 * Ticking, dragging a todo to another day (rescheduling it) and adding one
 * edit the notes where the todos live. Its path is `todos:board`
 * (`lib/paths.ts`), so a note opened from it is one Back away.
 */
import { CalendarDays, ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { Board } from "../api/generated/Board";
import type { BoardDay } from "../api/generated/BoardDay";
import type { ProjectEvent } from "../api/generated/ProjectEvent";
import type { Todo } from "../api/generated/Todo";
import type { TaskChange } from "../api/generated/TaskChange";
import { todoField } from "../editor/todoField";
import { isoDate } from "../markdown/dates";
import { attachContentHandlers, hydrate } from "../markdown/hydrate";
import { renderInline } from "../markdown/render";
import { taskMetaHtml } from "../markdown/tasks";
import { parseTodoInput, todoSource } from "../markdown/todos";
import { useUi } from "../state/ui";
import { message, onVaultChange } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { filterOf } from "./TodosPanel";

/** What a dragged todo carries. */
const DRAGGED = "application/x-groundwork-todo";

function parseDay(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

function addDays(iso: string, days: number): string {
  const date = parseDay(iso);
  date.setDate(date.getDate() + days);
  return isoDate(date);
}

/** The Monday of `iso`'s week. */
function weekOf(iso: string): string {
  return addDays(iso, -((parseDay(iso).getDay() + 6) % 7));
}

/** "Nov 2 – 8, 2026", "Oct 26 – Nov 1, 2026", "Dec 28, 2026 – Jan 3, 2027". */
function weekLabel(start: string): string {
  const from = parseDay(start);
  const to = parseDay(addDays(start, 6));
  const month = (d: Date) => d.toLocaleDateString("en-US", { month: "short" });
  if (from.getFullYear() !== to.getFullYear()) {
    const full = (d: Date) =>
      d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    return `${full(from)} – ${full(to)}`;
  }
  const end =
    from.getMonth() === to.getMonth() ? `${to.getDate()}` : `${month(to)} ${to.getDate()}`;
  return `${month(from)} ${from.getDate()} – ${end}, ${to.getFullYear()}`;
}

/** The week last looked at, so coming Back to the board keeps it. */
let lastWeek: string | null = null;

function open(path: string, e: React.MouseEvent, line?: number) {
  useWorkspace.getState().open(path, { newTab: e.metaKey, line });
}

async function change(id: string, what: TaskChange) {
  try {
    await api.updateTodo(id, what);
  } catch (err) {
    useUi.getState().notify(message(err));
  }
}

export function TodoBoard() {
  const today = isoDate(new Date());
  const [week, setWeek] = useState(() => lastWeek ?? weekOf(today));
  const [query, setQuery] = useState("");
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    lastWeek = week;
  }, [week]);

  useEffect(() => {
    let cancelled = false;
    let pending: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      api
        .todoBoard(week, 7, filterOf(query))
        .then((b) => !cancelled && (setBoard(b), setError(null)))
        .catch((err) => !cancelled && setError(message(err)));
    const first = setTimeout(load, query ? 120 : 0);
    // Changes come in bursts (a save, an agent at work): one fetch for each.
    const stop = onVaultChange(() => {
      clearTimeout(pending);
      pending = setTimeout(load, 250);
    });
    return () => {
      cancelled = true;
      clearTimeout(first);
      clearTimeout(pending);
      stop();
    };
  }, [week, query]);

  // Links in todos open notes, like anywhere else.
  useEffect(() => {
    if (root.current) attachContentHandlers(root.current);
  }, []);

  // Today in view, when the week has it and the window is too narrow for all seven days.
  const shown = board?.days[0]?.date;
  useLayoutEffect(() => {
    root.current
      ?.querySelector(".board-day.is-today")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [shown]);

  const thisWeek = weekOf(today);
  return (
    <div className="todo-board" ref={root}>
      <header className="board-head">
        <h1>{weekLabel(week)}</h1>
        <div className="board-nav" role="group" aria-label="Week">
          <button
            type="button"
            className="icon"
            aria-label="Previous week"
            title="Previous week"
            onClick={() => setWeek(addDays(week, -7))}
          >
            <ChevronLeft size={16} />
          </button>
          <button
            type="button"
            className="note-bar-button"
            disabled={week === thisWeek}
            onClick={() => setWeek(thisWeek)}
          >
            This week
          </button>
          <button
            type="button"
            className="icon"
            aria-label="Next week"
            title="Next week"
            onClick={() => setWeek(addDays(week, 7))}
          >
            <ChevronRight size={16} />
          </button>
        </div>
        <input
          className="search-input board-filter"
          type="search"
          aria-label="Filter todos"
          placeholder="Filter…  #tag  path:Projects  p1"
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </header>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : !board || board.days[0]?.date !== week ? (
        <div className="loading" aria-busy="true" />
      ) : (
        <div className="board-days">
          {board.days.map((day) => (
            <Day key={day.date} day={day} today={board.today} />
          ))}
        </div>
      )}
    </div>
  );
}

function Day({ day, today }: { day: BoardDay; today: string }) {
  const [over, setOver] = useState(false);
  const date = parseDay(day.date);
  const weekday = date.toLocaleDateString("en-US", { weekday: "short" });
  const full = date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const when = day.date === today ? " is-today" : day.date < today ? " is-past" : "";
  const empty = !day.events.length && !day.open.length && !day.done.length;

  return (
    <section
      className={`board-day${when}${over ? " is-drop-target" : ""}`}
      aria-label={full}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAGGED)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        setOver(false);
        const id = e.dataTransfer.getData(DRAGGED);
        if (!id) return;
        e.preventDefault();
        void change(id, { kind: "due", date: day.date });
      }}
    >
      <h2 className="board-day-head">
        <span className="board-weekday">{weekday}</span>
        <span className="board-date">{date.getDate()}</span>
      </h2>
      {day.events.length > 0 && (
        <ul className="board-events" aria-label="Events">
          {day.events.map((e) => (
            <EventItem key={e.path} event={e} />
          ))}
        </ul>
      )}
      {day.open.length > 0 && (
        <ul className="board-todos" aria-label="To do">
          {day.open.map((t) => (
            <TodoItem key={t.id} todo={t} today={today} />
          ))}
        </ul>
      )}
      {day.done.length > 0 && (
        <ul className="board-todos is-done" aria-label="Done">
          {day.done.map((t) => (
            <TodoItem key={t.id} todo={t} today={today} />
          ))}
        </ul>
      )}
      {empty && day.date < today && <p className="board-empty muted">Nothing</p>}
      <AddTodo date={day.date} />
    </section>
  );
}

function EventItem({ event }: { event: ProjectEvent }) {
  return (
    <li>
      <button
        type="button"
        className="board-event"
        title={event.people.length ? `With ${event.people.join(", ")}` : undefined}
        onClick={(e) => open(event.path, e)}
      >
        <CalendarDays size={13} aria-hidden="true" />
        {event.time && <span className="board-event-time">{event.time}</span>}
        <span className="board-event-title">{event.title}</span>
      </button>
    </li>
  );
}

function TodoItem({ todo, today }: { todo: Todo; today: string }) {
  const isOpen = todo.status === "todo" || todo.status === "other";
  const text = useRef<HTMLSpanElement>(null);
  // Only what the column doesn't say: priority, and the date if it's overdue.
  const overdue = isOpen && !!todo.due && todo.due < today ? todo.due : undefined;
  const priority = todo.priority === 3 ? undefined : todo.priority;
  const meta =
    priority !== undefined || overdue ? taskMetaHtml({ priority, due: overdue }, isOpen) : "";

  useLayoutEffect(() => {
    const el = text.current;
    if (!el) return;
    el.innerHTML = renderInline(todo.text);
    void hydrate(el, todo.path);
  }, [todo.text, todo.path]);

  return (
    <li
      className={`board-todo${isOpen ? "" : " is-closed"}`}
      data-note-path={todo.path}
      draggable={isOpen}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAGGED, todo.id);
        e.dataTransfer.setData("text/plain", todo.text);
        e.dataTransfer.effectAllowed = "move";
      }}
    >
      <input
        type="checkbox"
        className="todo-checkbox"
        aria-label={`Done: ${todo.text}`}
        checked={todo.status === "done"}
        disabled={todo.status === "cancelled"}
        onChange={() => void change(todo.id, { kind: isOpen ? "done" : "reopen" })}
      />
      <div className="board-todo-body">
        <span className="todo-text" ref={text} />
        <span className="todo-details">
          {meta && <span dangerouslySetInnerHTML={{ __html: meta }} />}
          <button
            type="button"
            className="link-button todo-source"
            onClick={(e) => open(todo.path, e, todo.line)}
          >
            {todoSource(todo)}
          </button>
        </span>
      </div>
    </li>
  );
}

/** "+ Add" under a day, opening a field for a todo due that day. */
function AddTodo({ date }: { date: string }) {
  const [adding, setAdding] = useState(false);
  const holder = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = holder.current;
    if (!adding || !el) return;
    const view = todoField(el, {
      label: `Add a todo on ${date}`,
      placeholder: "Add a todo…  !priority",
      onSubmit: (input) => {
        const { text, due, priority } = parseTodoInput(input);
        if (!text) return;
        // Into today's daily note, due that day (PLAN §5.11).
        api
          .addTodo({ text, due: due ?? date, priority })
          .catch((err) => useUi.getState().notify(message(err)));
      },
    });
    view.focus();
    // Leaving an empty field closes it.
    const onBlur = () => {
      if (!view.state.doc.length) setAdding(false);
    };
    view.contentDOM.addEventListener("blur", onBlur);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAdding(false);
    };
    el.addEventListener("keydown", onKey);
    return () => {
      view.contentDOM.removeEventListener("blur", onBlur);
      el.removeEventListener("keydown", onKey);
      view.destroy();
    };
  }, [adding, date]);

  if (!adding) {
    return (
      <button type="button" className="board-add" onClick={() => setAdding(true)}>
        <Plus size={13} aria-hidden="true" /> Add
      </button>
    );
  }
  return <div className="todo-add board-add-field" ref={holder} />;
}
