import { Star } from "lucide-react";
import { useMemo, useState } from "react";
import type { NewTicket } from "../api/generated/NewTicket";
import { addRepo, createTicket, useTickets } from "../state/tickets";

/** "New ticket": key, title, projects, its repos (one starred as the default) and the components it touches. */
export function TicketDialog() {
  const draft = useTickets((s) => s.draft);
  return draft ? <TicketForm key={JSON.stringify(draft)} draft={draft} /> : null;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

const repoOf = (code: string) => code.split(":")[0]!;

function TicketForm({ draft }: { draft: NewTicket }) {
  const { projects, repos, closeDraft } = useTickets();
  const [key, setKey] = useState(draft.key ?? "");
  const [title, setTitle] = useState(draft.title ?? "");
  const [slug, setSlug] = useState(draft.slug ?? "");
  const [chosen, setChosen] = useState<string[]>(draft.projects ?? []);
  const [code, setCode] = useState<string[]>(draft.code ?? []);
  // Repos chosen, the default first; `null` until one is, when the projects decide.
  const [picked, setPicked] = useState<string[] | null>(() => {
    const given = [...(draft.repo ? [draft.repo] : []), ...(draft.repos ?? [])];
    return given.length ? [...new Set(given)] : null;
  });
  const [worktree, setWorktree] = useState(!draft.noWorktree);
  const [busy, setBusy] = useState(false);
  const fromNote = draft.note;
  const adopting = draft.adopt;

  // Until repos are chosen: the one repo the projects use, if they use one.
  const autoRepos = useMemo(() => {
    const ids = [
      ...new Set(projects.filter((p) => chosen.includes(p.id)).flatMap((p) => p.code.map(repoOf))),
    ];
    return ids.length === 1 ? ids : [];
  }, [chosen, projects]);
  const repoIds = picked ?? autoRepos;
  const chosenRepos = repoIds.flatMap((id) => repos.filter((r) => r.id === id));
  const toggle = (list: string[], item: string, on: boolean) =>
    on ? [...list, item] : list.filter((x) => x !== item);
  const several = repoIds.length > 1;

  const submit = async () => {
    setBusy(true);
    const ok = await createTicket({
      key: key.trim() || undefined,
      title: title.trim() || undefined,
      slug: slug.trim() || undefined,
      projects: chosen,
      code: code.filter((c) => repoIds.includes(repoOf(c))),
      repos: repoIds,
      note: fromNote,
      adopt: adopting,
      noWorktree: !worktree || !repoIds.length,
    });
    setBusy(false);
    if (ok) closeDraft();
  };

  const named = !!(key.trim() || title.trim() || slug.trim() || fromNote || adopting);

  return (
    <div className="overlay" onMouseDown={closeDraft}>
      <form
        className="dialog ticket-dialog"
        role="dialog"
        aria-label={fromNote ? "Add worktree" : "New ticket"}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && closeDraft()}
        onSubmit={(e) => {
          e.preventDefault();
          if (named && !busy) void submit();
        }}
      >
        <h2>{fromNote ? "Add worktree" : "New ticket"}</h2>
        {fromNote && <p className="muted">Turns {fromNote} into a ticket, where it is.</p>}
        {adopting && <p className="muted">Adopts the worktree at {adopting}.</p>}
        <label className="dialog-field">
          <span>Key or link</span>
          <input
            autoFocus
            value={key}
            placeholder="INT-123 or a Jira link (optional)"
            spellCheck={false}
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
        {!fromNote && (
          <label className="dialog-field">
            <span>Title</span>
            <input
              value={title}
              placeholder="Fix login"
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
        )}
        {!adopting && (
          <label className="dialog-field">
            <span>Branch name</span>
            <input
              value={slug}
              placeholder={slugify(title) || "fix-login"}
              spellCheck={false}
              onChange={(e) => setSlug(e.target.value)}
            />
          </label>
        )}
        {projects.length > 0 && (
          <fieldset className="dialog-field ticket-choices">
            <legend>Projects</legend>
            {projects.map((p) => (
              <label key={p.id} className="check">
                <input
                  type="checkbox"
                  checked={chosen.includes(p.id)}
                  onChange={(e) => setChosen(toggle(chosen, p.id, e.target.checked))}
                />
                {p.name}
                {chosen[0] === p.id && chosen.length > 1 && (
                  <span className="muted"> · grouped under</span>
                )}
              </label>
            ))}
          </fieldset>
        )}
        <fieldset className="dialog-field ticket-choices">
          <legend>{several ? "Repos (★ is the default)" : "Repos"}</legend>
          {repos.map((r) => {
            const on = repoIds.includes(r.id);
            const isDefault = several && repoIds[0] === r.id;
            return (
              <div key={r.id} className="repo-choice">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={!!adopting && !on && repoIds.length > 0}
                    onChange={(e) => setPicked(toggle(repoIds, r.id, e.target.checked))}
                  />
                  {r.name}
                  {!r.location && <span className="muted"> · not located yet</span>}
                </label>
                {on && several && (
                  <button
                    type="button"
                    className={`icon repo-star${isDefault ? " is-default" : ""}`}
                    aria-pressed={isDefault}
                    aria-label={
                      isDefault ? `${r.name} is the default` : `Make ${r.name} the default`
                    }
                    title={
                      isDefault
                        ? "The default: its worktree is where terminals start"
                        : "Make this the default"
                    }
                    onClick={() => setPicked([r.id, ...repoIds.filter((x) => x !== r.id)])}
                  >
                    <Star size={12} />
                  </button>
                )}
              </div>
            );
          })}
          {!adopting && (
            <button
              type="button"
              className="link-button"
              onClick={async () => {
                const id = await addRepo();
                if (id) setPicked([...repoIds, id]);
              }}
            >
              Another repo…
            </button>
          )}
        </fieldset>
        {chosenRepos.some((r) => r.components.length > 0) && (
          <fieldset className="dialog-field ticket-choices">
            <legend>Touches</legend>
            {chosenRepos.flatMap((r) =>
              r.components.map((c) => {
                const id = `${r.id}:${c}`;
                return (
                  <label key={id} className="check">
                    <input
                      type="checkbox"
                      checked={code.includes(id)}
                      onChange={(e) => setCode(toggle(code, id, e.target.checked))}
                    />
                    {several ? `${c} (${r.name})` : c}
                  </label>
                );
              }),
            )}
          </fieldset>
        )}
        {chosenRepos.length > 0 && !adopting && (
          <label className="check dialog-field">
            <input
              type="checkbox"
              checked={worktree}
              onChange={(e) => setWorktree(e.target.checked)}
            />
            {several ? "Make a worktree in each" : "Make a worktree"}
            {chosenRepos.every((r) => r.location) ? "" : " (you'll be asked where the repo is)"}
          </label>
        )}
        <div className="dialog-buttons">
          <button type="button" onClick={closeDraft}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!named || busy}>
            {busy ? "Creating…" : fromNote ? "Add worktree" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}
