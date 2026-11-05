import { api } from "../api/client";
import type { TreeNode } from "../api/generated/TreeNode";
import { undoLast } from "../components/NoteView";
import { editorFor } from "../editor/active";
import { insertRendered } from "../editor/templates";
import { formDialog, type PaletteItem, promptDialog, useUi } from "../state/ui";
import { message, newNoteFolder, useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { useWorkspaces } from "../state/workspaces";
import { useInbox } from "../state/inbox";
import { testNotification } from "../state/inbox";
import { keyLabel } from "../state/keys";
import {
  closeTicket,
  locateRepo,
  noteWorkspace,
  pickAction,
  showSplit,
  ticketAt,
  useTickets,
} from "../state/tickets";

/** Past any note's end: "put the cursor at the end". */
const END = Number.MAX_SAFE_INTEGER;

function templateName(path: string): { name: string; folder: string } {
  const slash = path.lastIndexOf("/");
  return {
    name: path.slice(slash + 1).replace(/\.md$/, ""),
    folder: path.slice(0, Math.max(slash, 0)),
  };
}

/** Lists the vault's templates in a palette; `run` gets the chosen one. */
async function pickTemplate(placeholder: string, run: (template: string) => Promise<void>) {
  const templates = await api.templates();
  if (templates.length === 0) {
    useUi.getState().notify("No templates yet. Add notes to the Templates folder.");
    return;
  }
  useUi.getState().openPalette({
    placeholder,
    recentKey: "templates",
    items: templates.map((path) => {
      const { name, folder } = templateName(path);
      return { id: path, label: name, detail: folder, run: () => run(path) };
    }),
  });
}

export function newNoteFromTemplate() {
  return pickTemplate("New note from template…", async (template) => {
    const prompts = await api.templatePrompts(template);
    const values = await formDialog({
      title: `New note from “${templateName(template).name}”`,
      fields: [{ label: "Name", placeholder: "Note name" }, ...prompts.map((label) => ({ label }))],
      confirmLabel: "Create",
    });
    if (!values) return;
    const [name, ...answers] = values;
    const folder = newNoteFolder(useWorkspace.getState().activePath);
    const file = `${name!.trim() || "Untitled"}.md`;
    const created = await api.createFromTemplate(
      template,
      folder ? `${folder}/${file}` : file,
      Object.fromEntries(prompts.map((label, i) => [label, answers[i] ?? ""])),
    );
    useVault.getState().revealInTree(created.path);
    useWorkspace.getState().open(created.path, { offset: created.cursor ?? END });
  });
}

export function insertTemplate() {
  const path = useWorkspace.getState().activePath;
  const view = path ? editorFor(path) : null;
  if (!path || !view) {
    useUi.getState().notify("Open a note in the editor to insert a template.");
    return;
  }
  return pickTemplate("Insert template…", async (template) => {
    const prompts = await api.templatePrompts(template);
    let answers: Record<string, string> = {};
    if (prompts.length) {
      const values = await formDialog({
        title: `Insert “${templateName(template).name}”`,
        fields: prompts.map((label) => ({ label })),
        confirmLabel: "Insert",
      });
      if (!values) return;
      answers = Object.fromEntries(prompts.map((label, i) => [label, values[i] ?? ""]));
    }
    insertRendered(view, await api.renderTemplate(template, path, answers));
  });
}

export async function openToday() {
  try {
    useWorkspace.getState().open(await api.openDaily());
  } catch (err) {
    useUi.getState().notify(message(err));
  }
}

interface Command {
  id: string;
  label: string;
  /** Hidden from the palette when this returns false. */
  when?: () => boolean;
  run(): void | Promise<void>;
}

const hasActive = () => !!useWorkspace.getState().activePath;

function commands(): Command[] {
  const ws = useWorkspace.getState();
  const ui = useUi.getState();
  return [
    {
      id: "switcher",
      label: "Open quick switcher",
      run: () => ui.setSwitcher(true),
    },
    { id: "new-note", label: "New note", run: () => ws.newNote() },
    { id: "new-from-template", label: "New note from template…", run: newNoteFromTemplate },
    {
      id: "insert-template",
      label: "Insert template…",
      when: hasActive,
      run: insertTemplate,
    },
    {
      id: "search",
      label: "Search in all notes",
      run: () => ui.searchFor(),
    },
    { id: "files", label: "Show files", run: () => ui.setSidebarView("files") },
    { id: "tags", label: "Show tags", run: () => ui.setSidebarView("tags") },
    { id: "todos", label: "Show todos", run: () => ui.setSidebarView("todos") },
    { id: "daily-today", label: "Open today’s daily note", run: openToday },
    {
      id: "toggle-reading",
      label: "Toggle reading view",
      when: hasActive,
      run: () => ws.toggleReading(),
    },
    {
      id: "split-right",
      label: "Split right",
      when: hasActive,
      run: () => ws.open(ws.activePath!, { split: "right" }),
    },
    {
      id: "split-down",
      label: "Split down",
      when: hasActive,
      run: () => ws.open(ws.activePath!, { split: "below" }),
    },
    { id: "back", label: "Go back", run: () => ws.back() },
    { id: "forward", label: "Go forward", run: () => ws.forward() },
    { id: "new-terminal", label: "New terminal", run: () => ws.openTerminal() },
    { id: "new-terminal-in", label: "New terminal in folder…", run: terminalInFolder },
    {
      id: "new-workspace",
      label: "New workspace…",
      run: () => useWorkspaces.getState().create(),
    },
    { id: "switch-workspace", label: "Switch workspace…", run: switchWorkspace },
    {
      id: "toggle-pin",
      label: ws.pinned ? "Let the terminals follow notes" : "Pin the terminals to this workspace",
      when: () => ws.pinned || !!ws.workspace,
      run: () => ws.setPinned(!ws.pinned),
    },
    { id: "next-workspace", label: "Next workspace", run: () => stepWorkspace(1) },
    { id: "previous-workspace", label: "Previous workspace", run: () => stepWorkspace(-1) },
    { id: "settings", label: "Settings…", run: () => ui.setSettingsOpen(true) },
    {
      id: "test-notification",
      label: "Send a test notification",
      run: async () => {
        const failed = await testNotification();
        ui.notify(
          failed
            ? `No notification: ${failed}`
            : "A test question arrives in 5 seconds: switch to another app to see it.",
        );
      },
    },
    {
      id: "inbox",
      label: "Show the inbox",
      run: () => useInbox.getState().setOpen(!useInbox.getState().open),
    },
    {
      id: "workspaces",
      label: "Show workspaces and terminals",
      run: () => ui.setSidebarView("workspaces"),
    },
    { id: "new-ticket", label: "New ticket…", run: () => useTickets.getState().newTicket() },
    { id: "new-worktree", label: "New worktree in…", run: newWorktreeIn },
    {
      id: "add-worktree",
      label: "Add worktree to this note…",
      when: () => hasActive() && !ticketAt(ws.activePath),
      run: () => useTickets.getState().newTicket({ note: ws.activePath! }),
    },
    {
      id: "note-workspace",
      label: "Open this note’s workspace",
      when: hasActive,
      run: () => openNoteWorkspace(ws.activePath!),
    },
    {
      id: "run-action",
      label: "Run action…",
      when: hasActive,
      run: () => pickAction(ws.activePath!),
    },
    {
      id: "close-ticket",
      label: "Close ticket…",
      when: () => ticketAt(ws.activePath)?.status === "active",
      run: () => closeTicket(ws.activePath!),
    },
    { id: "locate-repo", label: "Locate repo…", run: pickRepoToLocate },
    { id: "tickets", label: "Show tickets", run: () => ui.setSidebarView("tickets") },
    {
      id: "close-tab",
      label: "Close tab",
      run: () => ws.closeActive(),
    },
    { id: "view-note", label: "Show notes only", run: () => ws.setView("note") },
    {
      id: "view-split",
      label: "Show notes and terminals",
      run: () => ws.setView("split"),
    },
    {
      id: "view-terminal",
      label: "Show terminals only",
      run: () => ws.setView("terminal"),
    },
    {
      id: "toggle-right",
      label: "Toggle links panel",
      run: () => ui.toggleRightPanel(),
    },
    {
      id: "reveal-tree",
      label: "Reveal current file in file tree",
      when: hasActive,
      run: () => useVault.getState().revealInTree(ws.activePath!),
    },
    {
      id: "reveal-finder",
      label: "Reveal current file in Finder",
      when: hasActive,
      run: () => api.reveal(ws.activePath!),
    },
    { id: "undo-file", label: "Undo last file change (rename, move…)", run: undoLast },
    { id: "setup-claude", label: "Set up Claude Code…", run: () => useUi.getState().openSetup() },
  ];
}

/** The note's workspace (made if it has none), with the note beside its terminals. */
export async function openNoteWorkspace(path: string) {
  const id = await noteWorkspace(path);
  if (id) await showSplit(path, id);
}

/** Picks a repo, then opens the new-ticket dialog for it. */
async function newWorktreeIn() {
  await useTickets.getState().load();
  const { repos } = useTickets.getState();
  if (!repos.length) {
    useUi.getState().notify("No repos yet. Add them to .groundwork/repos.yml.");
    return;
  }
  useUi.getState().openPalette({
    placeholder: "New worktree in…",
    items: repos.map((r) => ({
      id: r.id,
      label: r.name,
      detail: r.id,
      run: () => useTickets.getState().newTicket({ repo: r.id }),
    })),
  });
}

async function pickRepoToLocate() {
  await useTickets.getState().load();
  const { repos } = useTickets.getState();
  if (!repos.length) {
    useUi.getState().notify("No repos yet. Add them to .groundwork/repos.yml.");
    return;
  }
  useUi.getState().openPalette({
    placeholder: "Locate repo…",
    items: repos.map((r) => ({
      id: r.id,
      label: r.name,
      detail: r.location?.path ?? "not located",
      run: () => void locateRepo(r.id),
    })),
  });
}

/** Lists the vault's folders and the workspaces' to start a terminal in, or asks for another. */
async function terminalInFolder() {
  const vault = useVault.getState().vault;
  const tree = useVault.getState().tree;
  if (!vault) return;
  const folders: string[] = [];
  const walk = (node: TreeNode) => {
    if (node.kind !== "folder") return;
    folders.push(node.path);
    node.children?.forEach(walk);
  };
  if (tree) walk(tree);
  const open = (cwd: string) => useWorkspace.getState().openTerminal(cwd);
  const items: PaletteItem[] = [];
  // In a ticket's workspace: the components it touches, in its worktree.
  const current = useWorkspace.getState().workspace;
  const note = useWorkspaces.getState().list.find((w) => w.id === current)?.note;
  if (note) {
    const context = await api.context({ note }).catch(() => null);
    for (const c of context?.components ?? []) {
      if (c.absPath) {
        const cwd = c.absPath;
        items.push({ id: `component:${c.id}`, label: c.id, detail: c.path, run: () => open(cwd) });
      }
    }
  }
  items.push(
    ...folders.map((path) => ({
      id: `vault:${path}`,
      label: path || vault.name,
      detail: path ? undefined : "vault root",
      run: () => open(path ? `${vault.path}/${path}` : vault.path),
    })),
  );
  for (const w of useWorkspaces.getState().list) {
    items.push({ id: `workspace:${w.id}`, label: w.cwd, detail: w.name, run: () => open(w.cwd) });
  }
  items.push({
    id: "other",
    label: "Another folder…",
    run: async () => {
      const cwd = await promptDialog({ title: "Folder", value: "~/", confirmLabel: "Open" });
      if (cwd?.trim()) await open(cwd.trim());
    },
  });
  useUi.getState().openPalette({
    placeholder: "New terminal in…",
    recentKey: "terminal-folders",
    items,
  });
}

/** Lists the workspaces, with their shortcuts. */
export function switchWorkspace() {
  useUi.getState().openPalette({
    placeholder: "Switch to…",
    items: useWorkspaces.getState().list.map((w, i) => ({
      id: w.id,
      label: w.name,
      detail: w.cwd,
      hint: i < 9 ? keyLabel(`workspace-${i + 1}`) : undefined,
      run: () => useWorkspaces.getState().pick(w.id),
    })),
  });
}

/** The workspace after (or before) the current one, round the list. */
function stepWorkspace(by: number) {
  const list = useWorkspaces.getState().list;
  if (!list.length) return;
  const at = list.findIndex((w) => w.id === useWorkspace.getState().workspace);
  const next = list[(at + by + list.length) % list.length]!;
  useWorkspaces.getState().pick(next.id);
}

function inEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    !!target.closest(".cm-editor")
  );
}

/**
 * Runs the command a shortcut is bound to (`state/keys.ts`). Returns false
 * when the key should do what it otherwise would.
 */
export function runKey(id: string, target: EventTarget | null): boolean {
  if (id === "palette") {
    openCommandPalette();
    return true;
  }
  // Outside editors, ⌘Z undoes the last file operation (rename, move…).
  if (id === "undo-file") {
    if (inEditable(target)) return false;
    void undoLast();
    return true;
  }
  const n = id.match(/^workspace-(\d)$/);
  if (n) {
    const workspace = useWorkspaces.getState().list[Number(n[1]) - 1];
    if (workspace) useWorkspaces.getState().pick(workspace.id);
    return true;
  }
  const command = commands().find((c) => c.id === id);
  if (!command) return false;
  if (!command.when || command.when()) void command.run();
  return true;
}

export function openCommandPalette() {
  const items: PaletteItem[] = commands()
    .filter((c) => !c.when || c.when())
    .map((c) => ({ id: c.id, label: c.label, hint: keyLabel(c.id), run: c.run }));
  useUi.getState().openPalette({ placeholder: "Run a command…", recentKey: "commands", items });
}
