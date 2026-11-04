import {
  ArrowLeftRight,
  CalendarDays,
  FilePlus,
  Files,
  FolderPlus,
  Hash,
  ListTodo,
  PanelRight,
  Search,
  SquareTerminal,
  TextSearch,
  Ticket,
} from "lucide-react";
import { useEffect } from "react";
import { openToday } from "../lib/commands";
import { api } from "../api/client";
import { promptDialog, type SidebarView, useUi } from "../state/ui";
import { message, useVault } from "../state/vault";
import { watchTerminals } from "../state/terminals";
import { watchTickets } from "../state/tickets";
import { useWorkspace } from "../state/workspace";
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

const VIEWS: { id: SidebarView; label: string; icon: typeof Files }[] = [
  { id: "files", label: "Files", icon: Files },
  { id: "search", label: "Search (⌘⇧F)", icon: TextSearch },
  { id: "tags", label: "Tags", icon: Hash },
  { id: "todos", label: "Todos", icon: ListTodo },
  { id: "workspaces", label: "Workspaces", icon: SquareTerminal },
  { id: "tickets", label: "Tickets", icon: Ticket },
];

function SidebarTabs() {
  const view = useUi((s) => s.sidebarView);
  return (
    <div className="sidebar-tabs" role="tablist" aria-label="Sidebar">
      {VIEWS.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          role="tab"
          className="icon"
          aria-label={label.replace(/ \(.*/, "")}
          title={label}
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
  const rightOpen = useUi((s) => s.rightPanelOpen);
  const toggleRight = useUi((s) => s.toggleRightPanel);
  const setSwitcher = useUi((s) => s.setSwitcher);

  useEffect(checkSetupOnce, []);
  useEffect(() => {
    watchTerminals();
    watchTickets();
    void useWorkspaces.getState().load();
  }, [vault?.path]);

  return (
    <div className={`vault${rightOpen ? " with-right" : ""}`}>
      <aside className="sidebar">
        <header className="sidebar-header">
          <span className="vault-name" title={vault?.path}>
            {vault?.name}
          </span>
          <button
            className="icon"
            aria-label="Quick switcher"
            title="Quick switcher (⌘O)"
            onClick={() => setSwitcher(true)}
          >
            <Search size={14} />
          </button>
          <button
            className="icon"
            aria-label="Today’s daily note"
            title="Today’s daily note (⌘⇧D)"
            onClick={() => void openToday()}
          >
            <CalendarDays size={14} />
          </button>
          <button
            className="icon"
            aria-label="New note"
            title="New note (⌘N)"
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
      </aside>
      <main className="content">
        <Workspace key={vault?.path} />
      </main>
      {rightOpen && (
        <aside className="right-panel" aria-label="Links">
          <LinksPanel />
        </aside>
      )}
      <button
        className="icon right-toggle"
        aria-label="Toggle links panel"
        title="Toggle links panel (⌘⇧B)"
        aria-pressed={rightOpen}
        onClick={toggleRight}
      >
        <PanelRight size={14} />
      </button>
    </div>
  );
}
