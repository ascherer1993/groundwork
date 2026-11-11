import { api } from "../api/client";
import { promptDialog, useUi } from "../state/ui";
import { message, useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { CANVAS_EXT, displayName } from "./paths";

/** Making canvases (PLAN §5.17), from the file tree's menus and the palette. */

function join(folder: string, name: string) {
  return folder ? `${folder}/${name}` : name;
}

/** Creates `path` (an empty drawing), shows it in the tree and opens it. */
async function createAndOpen(path: string) {
  try {
    await api.createFile(path);
    useVault.getState().revealInTree(path);
    useWorkspace.getState().open(path);
  } catch (err) {
    useUi.getState().notify(message(err));
  }
}

/** Asks for a name and makes a canvas in `folder`. */
export async function newCanvas(folder: string) {
  const name = await promptDialog({
    title: "New canvas",
    message: "An infinite canvas to draw on, saved in the vault.",
    value: "Untitled canvas",
    confirmLabel: "Create",
  });
  const clean = name?.trim().replace(/\.excalidraw$/i, "");
  if (clean) await createAndOpen(join(folder, `${clean}${CANVAS_EXT}`));
}

/** Asks for a key and makes `<note>.<key>.excalidraw` beside the note, listed and moved with it. */
export async function newCanvasSubnote(note: string) {
  const name = note.slice(note.lastIndexOf("/") + 1);
  const key = await promptDialog({
    title: "New canvas subnote",
    message: `A canvas listed under “${displayName(name, "note").base}” and moved with it.`,
    value: "diagram",
    confirmLabel: "Create",
  });
  const clean = key?.trim().replace(/\.excalidraw$/i, "");
  if (clean) await createAndOpen(note.replace(/\.md$/i, `.${clean}${CANVAS_EXT}`));
}
