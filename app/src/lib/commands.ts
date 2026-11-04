import { api } from "../api/client";
import { undoLast } from "../components/NoteView";
import { editorFor } from "../editor/active";
import { insertRendered } from "../editor/templates";
import { formDialog, type PaletteItem, useUi } from "../state/ui";
import { message, newNoteFolder, useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";

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
  shortcut?: string;
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
      shortcut: "⌘O",
      run: () => ui.setSwitcher(true),
    },
    { id: "new-note", label: "New note", shortcut: "⌘N", run: () => ws.newNote() },
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
      shortcut: "⌘⇧F",
      run: () => ui.searchFor(),
    },
    { id: "files", label: "Show files", run: () => ui.setSidebarView("files") },
    { id: "tags", label: "Show tags", run: () => ui.setSidebarView("tags") },
    { id: "todos", label: "Show todos", run: () => ui.setSidebarView("todos") },
    { id: "daily-today", label: "Open today’s daily note", shortcut: "⌘⇧D", run: openToday },
    {
      id: "toggle-reading",
      label: "Toggle reading view",
      shortcut: "⌘E",
      when: hasActive,
      run: () => ws.toggleReading(),
    },
    {
      id: "split-right",
      label: "Split right",
      shortcut: "⌘\\",
      when: hasActive,
      run: () => ws.open(ws.activePath!, { split: "right" }),
    },
    {
      id: "split-down",
      label: "Split down",
      when: hasActive,
      run: () => ws.open(ws.activePath!, { split: "below" }),
    },
    { id: "back", label: "Go back", shortcut: "⌘[", run: () => ws.back() },
    { id: "forward", label: "Go forward", shortcut: "⌘]", run: () => ws.forward() },
    { id: "new-terminal", label: "New terminal", shortcut: "⌘T", run: () => ws.openTerminal() },
    {
      id: "close-tab",
      label: "Close tab",
      shortcut: "⌘W",
      when: () => !!ws.dock?.activePanel,
      run: () => ws.closeActive(),
    },
    {
      id: "toggle-right",
      label: "Toggle links panel",
      shortcut: "⌘⇧B",
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

/** ⌘P */
export function openCommandPalette() {
  const items: PaletteItem[] = commands()
    .filter((c) => !c.when || c.when())
    .map((c) => ({ id: c.id, label: c.label, hint: c.shortcut, run: c.run }));
  useUi.getState().openPalette({ placeholder: "Run a command…", recentKey: "commands", items });
}
