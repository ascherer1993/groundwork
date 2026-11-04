import {
  ArrowLeftRight,
  CalendarDays,
  Columns2,
  FilePlus,
  Files,
  FileText,
  FolderPlus,
  Hash,
  ListTodo,
  PanelRight,
  Search,
  Settings,
  SquareTerminal,
  TextSearch,
  Ticket,
} from "lucide-react";
import { useEffect } from "react";
import { openToday } from "../lib/commands";
import { api } from "../api/client";
import { isTauri } from "../api/transport";
import { useKeyLabel, withKey } from "../state/keys";
import { promptDialog, type SidebarView, useUi } from "../state/ui";
import { message, useVault } from "../state/vault";
import { watchTerminals } from "../state/terminals";
import { watchFollow } from "../state/follow";
import { watchTickets } from "../state/tickets";
import { useWorkspace, type View } from "../state/workspace";
import { useWorkspaces } from "../state/workspaces";
import { FileTree } from "./FileTree";
import { LinksPanel } from "./LinksPanel";
import { SearchPanel } from "./SearchPanel";
import { checkSetupOnce } from "./SetupDialog";
import { TagsPanel } from "./TagsPanel";
import { TicketsPanel } from "./TicketsPanel";
import { TodosPanel } from "./TodosPanel";
import { Workspace } from "./Workspace";
import { WorkspacesPanel } from "./WorkspacesPanel";

async function newFolder() {
  const name = await promptDialog({
    title: "New folder",
    value: "Untitled",
    confirmLabel: "Create",
  });
  if (!name?.trim()) return;
  try {
    await api.createFolder(name.trim());
  } catch (err) {
    useUi.getState().notify(message(err));
  }
}

const MAIN_VIEWS: { id: View; label: string; title: string; icon: typeof Files }[] = [
  { id: "note", label: "Notes", title: "Notes only", icon: FileText },
  { id: "split", label: "Split", title: "Notes and terminals", icon: Columns2 },
  { id: "terminal", label: "Terminals", title: "Terminals only", icon: SquareTerminal },
];

function ViewButton({ id, label, title, icon: Icon }: (typeof MAIN_VIEWS)[number]) {
  const pressed = useWorkspace((s) => s.view === id);
  const key = useKeyLabel(`view-${id}`);
  return (
    <button
      type="button"
      className="icon"
      aria-label={label}
      title={withKey(title, key)}
      aria-pressed={pressed}
      onClick={() => useWorkspace.getState().setView(id)}
    >
      <Icon size={14} />
    </button>
  );
}

/**
 * Across the top of the window (under the title bar on macOS, which is
 * transparent): the view, the links panel, settings. Drags the window.
 */
function TopBar({ notesShown, rightOpen }: { notesShown: boolean; rightOpen: boolean }) {
  const linksKey = useKeyLabel("toggle-right");
  const settingsKey = useKeyLabel("settings");
  return (
    <header className={`topbar${isTauri() ? " desktop" : ""}`} data-tauri-drag-region>
      <span className="topbar-fill" data-tauri-drag-region />
      <div className="view-switch segmented" role="group" aria-label="Main view">
        {MAIN_VIEWS.map((v) => (
          <ViewButton key={v.id} {...v} />
        ))}
      </div>
      <span className="topbar-fill" data-tauri-drag-region />
      {notesShown && (
        <button
          className="icon"
          aria-label="Toggle links panel"
          title={withKey("Toggle links panel", linksKey)}
          aria-pressed={rightOpen}
          onClick={() => useUi.getState().toggleRightPanel()}
        >
          <PanelRight size={14} />
        </button>
      )}
      <button
        className="icon"
        aria-label="Settings"
        title={withKey("Settings", settingsKey)}
        onClick={() => useUi.getState().setSettingsOpen(true)}
      >
        <Settings size={14} />
      </button>
    </header>
  );
}

const VIEWS: { id: SidebarView; label: string; icon: typeof Files }[] = [
  { id: "files", label: "Files", icon: Files },
  { id: "search", label: "Search", icon: TextSearch },
  { id: "tags", label: "Tags", icon: Hash },
  { id: "todos", label: "Todos", icon: ListTodo },
  { id: "workspaces", label: "Workspaces", icon: SquareTerminal },
  { id: "tickets", label: "Tickets", icon: Ticket },
];

function SidebarTabs() {
  const view = useUi((s) => s.sidebarView);
  const searchKey = useKeyLabel("search");
  return (
    <div className="sidebar-tabs" role="tablist" aria-label="Sidebar">
      {VIEWS.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          role="tab"
          className="icon"
          aria-label={label}
          title={id === "search" ? withKey(label, searchKey) : label}
          aria-selected={view === id}
          onClick={() =>
            id === "search" ? useUi.getState().searchFor() : useUi.getState().setSidebarView(id)
          }
        >
          <Icon size={15} />
        </button>
      ))}
    </div>
  );
}

export function VaultView() {
  const sidebarView = useUi((s) => s.sidebarView);
  const vault = useVault((s) => s.vault);
  const tree = useVault((s) => s.tree);
  const closeVault = useVault((s) => s.closeVault);
  const newNote = useWorkspace((s) => s.newNote);
  // The links panel is about notes, so it isn't shown beside terminals alone.
  const notesShown = useWorkspace((s) => s.view !== "terminal");
  const rightOpen = useUi((s) => s.rightPanelOpen) && notesShown;
  const setSwitcher = useUi((s) => s.setSwitcher);
  const switcherKey = useKeyLabel("switcher");
  const dailyKey = useKeyLabel("daily-today");
  const newNoteKey = useKeyLabel("new-note");

  useEffect(checkSetupOnce, []);
  useEffect(() => {
    watchTerminals();
    watchTickets();
    watchFollow();
    void useWorkspaces.getState().load();
  }, [vault?.path]);

  return (
    <div className="window">
      <TopBar notesShown={notesShown} rightOpen={rightOpen} />
      <div className={`vault${rightOpen ? " with-right" : ""}`}>
        <aside className="sidebar">
          <header className="sidebar-header">
            <span className="vault-name" title={vault?.path}>
              {vault?.name}
            </span>
            <button
              className="icon"
              aria-label="Quick switcher"
              title={withKey("Quick switcher", switcherKey)}
              onClick={() => setSwitcher(true)}
            >
              <Search size={14} />
            </button>
            <button
              className="icon"
              aria-label="Today’s daily note"
              title={withKey("Today’s daily note", dailyKey)}
              onClick={() => void openToday()}
            >
              <CalendarDays size={14} />
            </button>
            <button
              className="icon"
              aria-label="New note"
              title={withKey("New note", newNoteKey)}
              onClick={() => void newNote()}
            >
              <FilePlus size={14} />
            </button>
            <button
              className="icon"
              aria-label="New folder"
              title="New folder"
              onClick={() => void newFolder()}
            >
              <FolderPlus size={14} />
            </button>
            <button
              className="icon"
              aria-label="Switch vault"
              title="Switch vault"
              onClick={() => void closeVault()}
            >
              <ArrowLeftRight size={14} />
            </button>
          </header>
          {notesShown ? (
            <>
              <SidebarTabs />
              <div className="sidebar-body" role="tabpanel">
                {sidebarView === "files" && tree && (
                  <nav aria-label="File tree">
                    <FileTree root={tree} />
                  </nav>
                )}
                {sidebarView === "search" && <SearchPanel />}
                {sidebarView === "tags" && <TagsPanel />}
                {sidebarView === "todos" && <TodosPanel />}
                {sidebarView === "workspaces" && <WorkspacesPanel />}
                {sidebarView === "tickets" && <TicketsPanel />}
              </div>
            </>
          ) : (
            // Terminals alone: the sidebar is the workspaces, as in a terminal app.
            <div className="sidebar-body">
              <WorkspacesPanel />
            </div>
          )}
        </aside>
        <main className="content">
          <Workspace key={vault?.path} />
        </main>
        {rightOpen && (
          <aside className="right-panel" aria-label="Links">
            <LinksPanel />
          </aside>
        )}
      </div>
    </div>
  );
}
