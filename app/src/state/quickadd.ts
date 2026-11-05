/**
 * Quick add (PLAN §5.13): ⇧⌘A lists the vault's choices (a person, an
 * event, a todo…); each asks only what it needs, then makes the note or adds
 * the line. Each choice is also a command with its own shortcut.
 */
import { create } from "zustand";
import { api } from "../api/client";
import type { QuickAddChoice } from "../api/generated/QuickAddChoice";
import { projectOfView } from "../lib/paths";
import { today } from "../markdown/syntax";
import { type KeyCommand, keyLabel, useKeys } from "./keys";
import { useTickets } from "./tickets";
import { type DialogField, formDialog, useUi } from "./ui";
import { message, useVault } from "./vault";
import { useWorkspace } from "./workspace";
import { useWorkspaces } from "./workspaces";

/** A choice's command id, which its shortcut is saved under. */
export function choiceCommand(choice: Pick<QuickAddChoice, "name">): string {
  return `quick-add:${slug(choice.name)}`;
}

/** As `config::slugify` makes them. */
function slug(name: string): string {
  return name
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .join("-");
}

interface QuickAddState {
  choices: QuickAddChoice[];
  load(): Promise<void>;
  save(choices: QuickAddChoice[]): Promise<boolean>;
}

export const useQuickAdd = create<QuickAddState>((set) => ({
  choices: [],

  async load() {
    try {
      set({ choices: await api.quickAddChoices() });
    } catch {
      set({ choices: [] });
    }
    registerCommands();
  },

  async save(choices) {
    try {
      await api.saveQuickAddChoices(choices);
    } catch (err) {
      useUi.getState().notify(message(err));
      return false;
    }
    set({ choices });
    registerCommands();
    return true;
  },
}));

function registerCommands() {
  const commands: KeyCommand[] = useQuickAdd.getState().choices.map((c) => ({
    id: choiceCommand(c),
    label: `Quick add: ${c.name}`,
    group: "Quick add",
    key: null,
  }));
  useKeys.getState().setExtra(commands);
}

/** The note you're in: the open one, else the current workspace's. */
function whereYouAre(): string | undefined {
  const ws = useWorkspace.getState();
  if (ws.activePath?.endsWith(".md")) return ws.activePath;
  return useWorkspaces.getState().list.find((w) => w.id === ws.workspace)?.note ?? undefined;
}

/** The Quick add menu. */
export async function openQuickAdd() {
  await useQuickAdd.getState().load();
  const { choices } = useQuickAdd.getState();
  if (!choices.length) {
    useUi.getState().notify("No Quick add choices. Add some in Settings → Quick add.");
    return;
  }
  useUi.getState().openPalette({
    placeholder: "Quick add…",
    items: choices.map((c) => ({
      id: choiceCommand(c),
      label: c.name,
      detail:
        c.kind === "capture" ? `to ${c.to === "today" || !c.to ? "today’s note" : c.to}` : c.folder,
      hint: keyLabel(choiceCommand(c)),
      run: () => runChoice(c.name),
    })),
  });
}

/**
 * Asks what a choice needs, then runs it. The project offered first is
 * `opts.project`, else the project view's you're in, else the note's.
 */
export async function runChoice(name: string, opts: { project?: string } = {}) {
  const choice = useQuickAdd.getState().choices.find((c) => c.name === name);
  try {
    const form = await api.quickAddForm(name, whereYouAre());
    const fields: DialogField[] = form.prompts.map((label) => ({ label }));
    if (form.date) fields.push({ label: "Date", type: "date", value: today() });
    if (form.project) {
      if (!useTickets.getState().projects.length) await useTickets.getState().load();
      fields.push({
        label: "Project",
        value:
          opts.project ??
          projectOfView(useWorkspace.getState().activePath) ??
          form.defaultProject ??
          "",
        options: [
          { value: "", label: "No project" },
          ...useTickets.getState().projects.map((p) => ({ value: p.id, label: p.name })),
        ],
      });
    }
    let values: string[] = [];
    if (fields.length) {
      const answered = await formDialog({
        title: choice?.kind === "capture" ? `Add: ${name}` : `New ${name.toLowerCase()}`,
        fields,
        confirmLabel: choice?.kind === "capture" ? "Add" : "Create",
      });
      if (!answered) return;
      values = answered;
    }
    const answers = Object.fromEntries(form.prompts.map((label, i) => [label, values[i] ?? ""]));
    let at = form.prompts.length;
    const date = form.date ? values[at++] || undefined : undefined;
    const project = form.project ? values[at++] || undefined : undefined;
    const added = await api.quickAdd(name, answers, { date, project });
    if (added.created) {
      useVault.getState().revealInTree(added.path);
      useWorkspace.getState().open(added.path, { offset: added.cursor ?? Number.MAX_SAFE_INTEGER });
    } else {
      const title = added.path.split("/").pop()!.replace(/\.md$/, "");
      useUi.getState().notify(`Added to ${title}`, {
        label: "Open",
        run: () => useWorkspace.getState().open(added.path, { offset: Number.MAX_SAFE_INTEGER }),
      });
    }
  } catch (err) {
    useUi.getState().notify(message(err));
  }
}
