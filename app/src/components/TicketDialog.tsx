import { useMemo, useState } from "react";
import type { NewTicket } from "../api/generated/NewTicket";
import { createTicket, useTickets } from "../state/tickets";

/** "New ticket": key, title, projects, repo and the components it touches. */
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
  const [repo, setRepo] = useState(draft.repo ?? "");
  const [worktree, setWorktree] = useState(!draft.noWorktree);
  const [busy, setBusy] = useState(false);
  const fromNote = draft.note;
  const adopting = draft.adopt;

  // The repo the backend would pick: chosen, else the one the code or projects use.
  const autoRepo = useMemo(() => {
    const unique = (ids: string[]) => {
      const set = [...new Set(ids)];
      return set.length === 1 ? set[0] : undefined;
    };
    return (
      unique(code.map(repoOf)) ??
      unique(projects.filter((p) => chosen.includes(p.id)).flatMap((p) => p.code.map(repoOf)))
    );
  }, [code, chosen, projects]);
  const repoId = repo || autoRepo;
  const repoInfo = repos.find((r) => r.id === repoId);
  const toggle = (list: string[], item: string, on: boolean) =>
    on ? [...list, item] : list.filter((x) => x !== item);

  const submit = async () => {
    setBusy(true);
    const ok = await createTicket({
      key: key.trim() || undefined,
      title: title.trim() || undefined,
      slug: slug.trim() || undefined,
      projects: chosen,
      code: code.filter((c) => !repoId || repoOf(c) === repoId),
      repo: repo || undefined,
      note: fromNote,
      adopt: adopting,
      noWorktree: !worktree || !repoId,
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
            <legend>Projects (the first is its home)</legend>
            {projects.map((p) => (
              <label key={p.id} className="check">
                <input
                  type="checkbox"
                  checked={chosen.includes(p.id)}
                  onChange={(e) => setChosen(toggle(chosen, p.id, e.target.checked))}
                />
                {p.name}
                {chosen[0] === p.id && chosen.length > 1 && <span className="muted"> · home</span>}
              </label>
            ))}
          </fieldset>
        )}
        {repos.length > 0 && (
          <label className="dialog-field">
            <span>Repo</span>
            <select value={repo} onChange={(e) => setRepo(e.target.value)}>
              <option value="">{autoRepo ? `Automatic (${autoRepo})` : "None"}</option>
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {repoInfo && repoInfo.components.length > 0 && (
          <fieldset className="dialog-field ticket-choices">
            <legend>Touches</legend>
            {repoInfo.components.map((c) => {
              const id = `${repoInfo.id}:${c}`;
              return (
                <label key={id} className="check">
                  <input
                    type="checkbox"
                    checked={code.includes(id)}
                    onChange={(e) => setCode(toggle(code, id, e.target.checked))}
                  />
                  {c}
                </label>
              );
            })}
          </fieldset>
        )}
        {repoInfo && !adopting && (
          <label className="check dialog-field">
            <input
              type="checkbox"
              checked={worktree}
              onChange={(e) => setWorktree(e.target.checked)}
            />
            Make a worktree{repoInfo.location ? "" : " (you'll be asked where the repo is)"}
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
