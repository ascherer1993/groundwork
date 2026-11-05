/**
 * What the CLI asks the window to do (`groundwork open`, `workspace open`,
 * `tab new`, `tab list`). The backend sends a `ui.command` event and waits
 * for the answer (`crates/backend/src/window.rs`).
 */
import { api, transport } from "../api/client";
import type { UiCommand } from "../api/generated/UiCommand";
import { message } from "./vault";
import { useWorkspace } from "./workspace";
import { useWorkspaces } from "./workspaces";

async function run(command: UiCommand): Promise<unknown> {
  const ws = useWorkspace.getState();
  switch (command.kind) {
    case "open":
      ws.open(command.path, { line: command.line });
      return null;
    case "showWorkspace": {
      const workspaces = useWorkspaces.getState();
      // Made a moment ago by the CLI, perhaps.
      if (!workspaces.list.some((w) => w.id === command.id)) await workspaces.refresh();
      if (!(await workspaces.ready(command.id))) throw new Error("that workspace isn't open here");
      useWorkspaces.getState().pick(command.id);
      return null;
    }
    case "newTab":
      return ws.newTerminal(command.cwd, {
        workspace: command.workspace,
        beside: command.beside,
        run: command.run,
        background: command.background,
      });
    case "tabs":
      return ws.tabInfos();
  }
}

let watching = false;

/** Carries out the CLI's commands, and follows workspaces it changes; once. */
export function watchRemote() {
  if (watching) return;
  watching = true;
  transport.listen((event) => {
    if (event.event === "workspaces.changed") {
      void useWorkspaces.getState().refresh();
      return;
    }
    if (event.event !== "ui.command") return;
    const { id, command } = event.payload;
    run(command)
      .then(
        (result) => api.uiReply(id, { result: result ?? null }),
        (err: unknown) => api.uiReply(id, { error: message(err) }),
      )
      .catch(() => {});
  });
}
