import {
  ChevronRight,
  File,
  FileText,
  Folder,
  FolderKanban,
  FolderOpen,
  Globe,
  LayoutList,
  Lock,
  PanelsTopLeft,
  type LucideIcon,
} from "lucide-react";
import { type DragEvent, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { NodeKind } from "../api/generated/NodeKind";
import type { TreeNode } from "../api/generated/TreeNode";
import type { ProjectInfo } from "../api/generated/ProjectInfo";
import { displayName, projectViewPath } from "../lib/paths";
import { allSubnotes, type Grouped, groupSubnotes } from "../lib/subnotes";
import { openNoteWorkspace } from "../lib/commands";
import { changePassword, encryptNote, removeEncryption } from "../lib/encryption";
import { isEncrypted, isUnlocked, useEncrypted, useLocks } from "../state/locks";
import { createProject, openProjectView, projectAt, ticketAt, useTickets } from "../state/tickets";
import { confirmDialog, formDialog, type MenuEntry, promptDialog, useUi } from "../state/ui";
import { message, useVault } from "../state/vault";
import { useWorkspace } from "../state/workspace";
import { renameWithUndo } from "./NoteView";

const ICONS: Record<Exclude<NodeKind, "folder">, LucideIcon> = {
  note: FileText,
  page: Globe,
  pageBundle: PanelsTopLeft,
  asset: File,
};

const DRAG_TYPE = "application/x-groundwork-path";

function nameOf(path: string) {
  return path.slice(path.lastIndexOf("/") + 1);
}

function join(folder: string, name: string) {
  return folder ? `${folder}/${name}` : name;
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    useUi.getState().notify("Copied to clipboard");
  } catch (err) {
    useUi.getState().notify(message(err));
  }
}

async function run(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (err) {
    useUi.getState().notify(message(err));
  }
}

async function moveInto(from: string, folder: string) {
  const to = join(folder, nameOf(from));
  if (to === from || folder === from || folder.startsWith(`${from}/`)) return;
  await renameWithUndo(from, to);
}

/** Makes `<note>.<key>.md` beside a note and opens it. */
async function newSubnote(node: TreeNode) {
  const key = await promptDialog({
    title: "New subnote",
    message: `Listed under “${displayName(node.name, node.kind).base}” and moved with it.`,
    value: "notes",
    confirmLabel: "Create",
  });
  const clean = key?.trim();
  if (!clean) return;
  const path = node.path.replace(/\.md$/i, `.${clean}.md`);
  await run(async () => {
    await api.createFile(path, "");
    useVault.getState().revealInTree(path);
    useWorkspace.getState().open(path, { offset: 0 });
  });
}

function menuFor(node: TreeNode, subnotes: TreeNode[] = []): MenuEntry[] {
  const ws = useWorkspace.getState();
  const ui = useUi.getState();
  const vault = useVault.getState().vault;
  const absolute = vault ? `${vault.path}/${node.path}` : node.path;
  const isFolder = node.kind === "folder";
  const isRoot = node.path === "";
  const entries: MenuEntry[] = [];

  if (isFolder) {
    entries.push(
      { label: "New note", action: () => void ws.newNote(node.path) },
      {
        label: "New folder",
        action: () =>
          void promptDialog({
            title: "New folder",
            value: "Untitled",
            confirmLabel: "Create",
          }).then(async (name) => {
            if (!name?.trim()) return;
            await run(async () => {
              await api.createFolder(join(node.path, name.trim()));
              useVault.getState().toggleFolder(node.path, true);
            });
          }),
      },
      {
        label: "New project…",
        action: () =>
          void formDialog({
            title: "New project",
            message: "A folder with an overview note, for its tickets and workspaces.",
            fields: [{ label: "Name", placeholder: "Name" }],
            confirmLabel: "Create",
          }).then((values) => {
            const name = values?.[0]?.trim();
            if (name) void createProject(join(node.path, name));
          }),
      },
      { label: "Open terminal here", action: () => void ws.openTerminal(absolute) },
    );
    const project = projectAt(node.path);
    if (project) {
      entries.push({ label: "Open project view", action: () => openProjectView(project.id) });
      entries.push({
        label: "New ticket…",
        action: () => void useTickets.getState().newTicket({ projects: [project.id] }),
      });
    } else if (!isRoot) {
      entries.push({ label: "Make this a project", action: () => void createProject(node.path) });
    }
    entries.push("separator");
  } else {
    entries.push(
      { label: "Open in new tab", action: () => ws.open(node.path, { newTab: true }) },
      { label: "Open to the right", action: () => ws.open(node.path, { split: "right" }) },
    );
    if (node.kind === "note") {
      entries.push({ label: "New subnote…", action: () => void newSubnote(node) });
      entries.push({ label: "Open workspace", action: () => void openNoteWorkspace(node.path) });
      if (!ticketAt(node.path)) {
        entries.push({
          label: "Add worktree…",
          action: () => void useTickets.getState().newTicket({ note: node.path }),
        });
      }
      entries.push("separator");
      if (isEncrypted(node.path)) {
        if (isUnlocked(node.path)) {
          entries.push({
            label: "Lock",
            action: () => void useLocks.getState().lock(node.path),
          });
        }
        entries.push(
          { label: "Change password…", action: () => void changePassword(node.path) },
          { label: "Remove encryption…", action: () => void removeEncryption(node.path) },
        );
      } else {
        entries.push({ label: "Encrypt…", action: () => void encryptNote(node.path) });
      }
    }
    entries.push("separator");
  }
  if (!isRoot) {
    entries.push({ label: "Rename…", action: () => ui.setRenaming(node.path) });
  }
  entries.push(
    { label: "Reveal in Finder", action: () => void run(() => api.reveal(node.path)) },
    { label: "Copy relative path", action: () => void copy(node.path || ".") },
    { label: "Copy absolute path", action: () => void copy(absolute) },
  );
  if (!isFolder) {
    entries.push({
      label: "Open in default app",
      action: () => void run(() => api.openExternally(node.path)),
    });
  }
  if (!isRoot) {
    entries.push("separator", {
      label: "Delete",
      danger: true,
      action: () =>
        void confirmDialog({
          title: `Delete “${displayName(node.name, node.kind).base}”?`,
          message: isFolder
            ? "The folder and everything in it will be moved to the Trash."
            : subnotes.length
              ? `It and its ${subnotes.length === 1 ? "subnote" : `${subnotes.length} subnotes`} will be moved to the Trash.`
              : "It will be moved to the Trash.",
          confirmLabel: "Delete",
          danger: true,
        }).then(async (ok) => {
          if (!ok) return;
          await run(async () => {
            for (const sub of subnotes) await api.deleteFile(sub.path);
            await api.deleteFile(node.path);
          });
        }),
    });
  }
  return entries;
}

export function FileTree({ root }: { root: TreeNode }) {
  const [dropRoot, setDropRoot] = useState(false);
  return (
    <ul
      role="tree"
      aria-label="Files"
      className={`tree${dropRoot ? " drop-target" : ""}`}
      onContextMenu={(e) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        useUi.getState().showMenu(e.clientX, e.clientY, menuFor(root));
      }}
      onDragOver={(e) => {
        if (e.target !== e.currentTarget || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
        e.preventDefault();
        setDropRoot(true);
      }}
      onDragLeave={() => setDropRoot(false)}
      onDrop={(e) => {
        setDropRoot(false);
        if (e.target !== e.currentTarget) return;
        const from = e.dataTransfer.getData(DRAG_TYPE);
        if (from) void moveInto(from, "");
      }}
    >
      {groupSubnotes(root.children ?? []).map((g) => (
        <TreeItem key={g.node.path} node={g.node} depth={0} subnotes={g.subnotes} />
      ))}
    </ul>
  );
}

function RenameInput({ node }: { node: TreeNode }) {
  const { base, ext } = displayName(node.name, node.kind);
  const [value, setValue] = useState(base);
  const ref = useRef<HTMLInputElement>(null);
  const setRenaming = useUi((s) => s.setRenaming);
  const done = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  async function commit() {
    if (done.current) return;
    done.current = true;
    setRenaming(null);
    const name = value.trim();
    if (!name || name === base) return;
    const suffix = node.kind === "note" ? ".md" : ext;
    const folder = node.path.slice(0, Math.max(0, node.path.lastIndexOf("/")));
    await renameWithUndo(node.path, join(folder, name + suffix));
  }

  return (
    <input
      ref={ref}
      className="tree-rename"
      aria-label="New name"
      value={value}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === "Enter") void commit();
        if (e.key === "Escape") {
          done.current = true;
          setRenaming(null);
        }
      }}
    />
  );
}

/**
 * A folder's entries, subnotes under their notes. A project's view is a
 * subnote of its overview note; without one it comes first after the folders.
 */
function entriesOf(
  children: TreeNode[],
  project: ProjectInfo | undefined,
): (Grouped | ProjectInfo)[] {
  const groups = groupSubnotes(children);
  if (!project || groups.some((g) => g.node.path === project.overview)) return groups;
  const firstFile = groups.findIndex((g) => g.node.kind !== "folder");
  const at = firstFile >= 0 ? firstFile : groups.length;
  return [...groups.slice(0, at), project, ...groups.slice(at)];
}

/** A project's view, listed under its overview note like a subnote. */
function ProjectViewItem({
  project,
  depth,
  subnote,
}: {
  project: ProjectInfo;
  depth: number;
  subnote?: boolean;
}) {
  const path = projectViewPath(project.id);
  const selected = useWorkspace((s) => s.activePath === path);
  const ws = useWorkspace.getState;
  return (
    <li role="treeitem" aria-selected={selected} aria-label={`${project.name} project view`}>
      <button
        className={`tree-row${selected ? " selected" : ""}${subnote ? " subnote" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        title="This project’s events, people and tickets"
        onClick={(e) => openProjectView(project.id, { newTab: e.metaKey || e.ctrlKey })}
        onAuxClick={(e) => {
          if (e.button === 1) openProjectView(project.id, { newTab: true });
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          useUi.getState().showMenu(e.clientX, e.clientY, [
            {
              label: "Open in new tab",
              action: () => openProjectView(project.id, { newTab: true }),
            },
            { label: "Open to the right", action: () => ws().open(path, { split: "right" }) },
          ]);
        }}
      >
        <span className="chevron" />
        <LayoutList size={14} className="kind-icon kind-project" />
        {subnote ? (
          <span className="tree-label subnote-key">project view</span>
        ) : (
          <span className="tree-label">
            {project.name}
            <span className="ext"> project view</span>
          </span>
        )}
      </button>
    </li>
  );
}

function TreeItem({
  node,
  depth,
  subkey,
  subnotes = [],
  projectView,
}: {
  node: TreeNode;
  depth: number;
  /** As a subnote: its key under the note above ("transcript"). */
  subkey?: string;
  subnotes?: Grouped[];
  /** A project's overview note lists the project's view under it. */
  projectView?: ProjectInfo;
}) {
  const isFolder = node.kind === "folder";
  const hasSubnotes = subnotes.length > 0 || !!projectView;
  const expanded = useVault((s) =>
    isFolder ? s.expanded.has(node.path) : hasSubnotes && !s.folded.has(node.path),
  );
  const toggleFolder = useVault((s) => s.toggleFolder);
  const selected = useWorkspace((s) => s.activePath === node.path);
  const open = useWorkspace((s) => s.open);
  const renaming = useUi((s) => s.renaming === node.path);
  const [dropping, setDropping] = useState(false);
  const { base, ext } = displayName(node.name, node.kind);
  const encrypted = useEncrypted(node.path);
  const project = useTickets((s) =>
    isFolder ? s.projects.find((p) => p.folder === node.path) : undefined,
  );
  const isProject = !!project;
  const projectFor = (path: string) => (project?.overview === path ? project : undefined);
  const Icon = isProject
    ? FolderKanban
    : node.kind === "folder"
      ? expanded
        ? FolderOpen
        : Folder
      : ICONS[node.kind];

  const dropProps = isFolder
    ? {
        onDragOver: (e: DragEvent) => {
          if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
          e.preventDefault();
          e.stopPropagation();
          setDropping(true);
        },
        onDragLeave: () => setDropping(false),
        onDrop: (e: DragEvent) => {
          e.preventDefault();
          e.stopPropagation();
          setDropping(false);
          const from = e.dataTransfer.getData(DRAG_TYPE);
          if (from) void moveInto(from, node.path);
        },
      }
    : {};

  return (
    <li
      role="treeitem"
      aria-expanded={isFolder || hasSubnotes ? expanded : undefined}
      aria-selected={selected}
      aria-label={base}
    >
      {renaming ? (
        <div className="tree-row" style={{ paddingLeft: 8 + depth * 14 }}>
          <span className="chevron" />
          <Icon size={14} className={`kind-icon kind-${node.kind}`} />
          <RenameInput node={node} />
        </div>
      ) : (
        <button
          className={`tree-row${selected ? " selected" : ""}${dropping ? " drop-target" : ""}${subkey ? " subnote" : ""}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(DRAG_TYPE, node.path);
            e.dataTransfer.setData("text/plain", node.path);
            e.dataTransfer.effectAllowed = "move";
          }}
          {...dropProps}
          onClick={(e) => {
            if (isFolder) toggleFolder(node.path);
            else open(node.path, { newTab: e.metaKey || e.ctrlKey });
          }}
          onAuxClick={(e) => {
            if (e.button === 1 && !isFolder) open(node.path, { newTab: true });
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const subs = allSubnotes({ node, subnotes });
            useUi.getState().showMenu(e.clientX, e.clientY, menuFor(node, subs));
          }}
          onKeyDown={(e) => {
            if (e.key === "F2" || (e.key === "Enter" && e.shiftKey)) {
              e.preventDefault();
              useUi.getState().setRenaming(node.path);
            }
            // → shows a note's subnotes, ← hides them.
            const fold =
              (e.key === "ArrowLeft" && expanded) || (e.key === "ArrowRight" && !expanded);
            if (!isFolder && hasSubnotes && fold) {
              e.preventDefault();
              useVault.getState().toggleSubnotes(node.path);
            }
          }}
          title={node.path}
        >
          {hasSubnotes ? (
            // A note's own chevron folds its subnotes; the rest of the row opens it.
            <span
              className={`chevron${expanded ? " open" : ""}`}
              role="button"
              aria-label={expanded ? "Hide subnotes" : "Show subnotes"}
              onClick={(e) => {
                e.stopPropagation();
                useVault.getState().toggleSubnotes(node.path);
              }}
            >
              <ChevronRight size={12} />
            </span>
          ) : (
            <span className={`chevron${expanded ? " open" : ""}`}>
              {isFolder && <ChevronRight size={12} />}
            </span>
          )}
          <Icon
            size={14}
            className={`kind-icon kind-${node.kind}${isProject ? " kind-project" : ""}`}
            aria-label={isProject ? "Project" : undefined}
          />
          <span className={`tree-label${subkey ? " subnote-key" : ""}`}>
            {subkey ?? base}
            {ext && <span className="ext">{ext}</span>}
          </span>
          {encrypted && <Lock size={11} className="tree-lock" aria-hidden />}
        </button>
      )}
      {isFolder && expanded && node.children && node.children.length > 0 && (
        <ul role="group">
          {entriesOf(node.children, project).map((child) =>
            "id" in child ? (
              <ProjectViewItem key="project-view" project={child} depth={depth + 1} />
            ) : (
              <TreeItem
                key={child.node.path}
                node={child.node}
                depth={depth + 1}
                subnotes={child.subnotes}
                projectView={projectFor(child.node.path)}
              />
            ),
          )}
        </ul>
      )}
      {!isFolder && expanded && (
        <ul role="group" className="subnotes">
          {projectView && <ProjectViewItem project={projectView} depth={depth + 1} subnote />}
          {subnotes.map((sub) => (
            <TreeItem
              key={sub.node.path}
              node={sub.node}
              depth={depth + 1}
              subkey={sub.key}
              subnotes={sub.subnotes}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
