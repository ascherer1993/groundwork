import type { AppInfo } from "./generated/AppInfo";
import type { Context } from "./generated/Context";
import type { CreatedTicket } from "./generated/CreatedTicket";
import type { GitState } from "./generated/GitState";
import type { NewTicket } from "./generated/NewTicket";
import type { ProjectInfo } from "./generated/ProjectInfo";
import type { AgentInfo } from "./generated/AgentInfo";
import type { InboxItem } from "./generated/InboxItem";
import type { RepoInfo } from "./generated/RepoInfo";
import type { RepoLocation } from "./generated/RepoLocation";
import type { StrayWorktree } from "./generated/StrayWorktree";
import type { Ticket } from "./generated/Ticket";
import type { TicketFilter } from "./generated/TicketFilter";
import type { CreatedNote } from "./generated/CreatedNote";
import type { DayView } from "./generated/DayView";
import type { Backlinks } from "./generated/Backlinks";
import type { FileContent } from "./generated/FileContent";
import type { FileSummary } from "./generated/FileSummary";
import type { LinkSettings } from "./generated/LinkSettings";
import type { Mention } from "./generated/Mention";
import type { OutgoingLink } from "./generated/OutgoingLink";
import type { ParsedNote } from "./generated/ParsedNote";
import type { AppSettings } from "./generated/AppSettings";
import type { RecentVault } from "./generated/RecentVault";
import type { RenameOutcome } from "./generated/RenameOutcome";
import type { RenderedTemplate } from "./generated/RenderedTemplate";
import type { SearchResult } from "./generated/SearchResult";
import type { SetupStatus } from "./generated/SetupStatus";
import type { TagCount } from "./generated/TagCount";
import type { TaskChange } from "./generated/TaskChange";
import type { TerminalInfo } from "./generated/TerminalInfo";
import type { TerminalSnapshot } from "./generated/TerminalSnapshot";
import type { Todo } from "./generated/Todo";
import type { TodoFilter } from "./generated/TodoFilter";
import type { Request } from "./generated/Request";
import type { TreeNode } from "./generated/TreeNode";
import type { VaultInfo } from "./generated/VaultInfo";
import type { Workspace } from "./generated/Workspace";
import type { WriteResult } from "./generated/WriteResult";
import { isTauri, TauriTransport, type Transport, WebSocketTransport } from "./transport";

/** What each method resolves to. Keep in sync with `groundwork_protocol::Request`. */
interface Results {
  "app.info": AppInfo;
  "vault.recent": RecentVault[];
  "settings.get": AppSettings;
  "settings.set": null;
  "vault.forget": null;
  "vault.open": VaultInfo;
  "vault.current": VaultInfo | null;
  "vault.close": null;
  "vault.tree": TreeNode;
  "index.files": FileSummary[];
  "index.note": ParsedNote | null;
  "index.settings": LinkSettings;
  "links.resolve": (string | null)[];
  "links.backlinks": Backlinks[];
  "links.outgoing": OutgoingLink[];
  "links.unlinked": Mention[];
  "links.linkMention": null;
  "links.format": string;
  "page.state": unknown;
  "page.setState": null;
  "file.read": FileContent;
  "file.write": WriteResult;
  "file.create": string;
  "file.createUntitled": string;
  "file.createFromLink": string;
  "file.createFromTemplate": CreatedNote;
  "template.list": string[];
  "template.prompts": string[];
  "template.render": RenderedTemplate;
  "daily.open": string;
  "index.tags": TagCount[];
  "setup.status": SetupStatus;
  "setup.installCli": SetupStatus;
  "setup.installPlugin": SetupStatus;
  "setup.useVault": SetupStatus;
  "search.query": SearchResult[];
  "todo.list": Todo[];
  "todo.day": DayView;
  "todo.update": null;
  "todo.add": string;
  "file.rename": RenameOutcome;
  "file.delete": null;
  "folder.create": null;
  "history.peek": string | null;
  "history.undo": string;
  "task.toggle": null;
  "os.reveal": null;
  "os.open": null;
  "terminal.create": TerminalInfo;
  "terminal.list": TerminalInfo[];
  "terminal.attach": TerminalSnapshot;
  "terminal.input": null;
  "terminal.resize": null;
  "terminal.kill": null;
  "workspace.list": Workspace[];
  "workspace.create": Workspace;
  "workspace.update": Workspace;
  "workspace.saveLayout": null;
  "workspace.delete": null;
  "workspace.forNote": Workspace;
  "repo.list": RepoInfo[];
  "repo.locate": RepoLocation;
  "project.list": ProjectInfo[];
  "inbox.list": InboxItem[];
  "inbox.ask": InboxItem;
  "inbox.notify": InboxItem;
  "inbox.wait": InboxItem;
  "inbox.answer": null;
  "agent.hook": null;
  "agent.list": AgentInfo[];
  "project.create": ProjectInfo;
  "ticket.list": Ticket[];
  "ticket.git": GitState;
  "ticket.create": CreatedTicket;
  "ticket.close": Ticket;
  "ticket.restore": CreatedTicket;
  "ticket.strays": StrayWorktree[];
  "context.get": Context;
  "action.run": null;
}

type Method = Request["method"];
type ParamsOf<M extends Method> =
  Extract<Request, { method: M }> extends { params: infer P } ? [params: P] : [];

const DEV_SERVER_URL: string = import.meta.env.VITE_GROUNDWORK_BACKEND ?? "ws://127.0.0.1:1430";

export const transport: Transport = isTauri()
  ? new TauriTransport()
  : new WebSocketTransport(DEV_SERVER_URL);

export function call<M extends Method>(method: M, ...params: ParamsOf<M>): Promise<Results[M]> {
  const request = (params.length ? { method, params: params[0] } : { method }) as Request;
  return transport.call(request) as Promise<Results[M]>;
}

export const api = {
  appInfo: () => call("app.info"),

  recentVaults: () => call("vault.recent"),
  settings: () => call("settings.get"),
  saveSettings: (settings: AppSettings) => call("settings.set", { settings }),
  forgetVault: (path: string) => call("vault.forget", { path }),
  openVault: (path: string) => call("vault.open", { path }),
  currentVault: () => call("vault.current"),
  closeVault: () => call("vault.close"),
  tree: () => call("vault.tree"),

  files: () => call("index.files"),
  note: (path: string) => call("index.note", { path }),
  linkSettings: () => call("index.settings"),

  resolveLinks: (source: string, targets: string[]) => call("links.resolve", { source, targets }),
  backlinks: (path: string) => call("links.backlinks", { path }),
  outgoing: (path: string) => call("links.outgoing", { path }),
  unlinked: (path: string) => call("links.unlinked", { path }),
  linkMention: (source: string, start: number, end: number, text: string, target: string) =>
    call("links.linkMention", { source, start, end, text, target }),
  formatLink: (
    source: string,
    target: string,
    opts: { subpath?: string; alias?: string; embed?: boolean } = {},
  ) => call("links.format", { source, target, ...opts }),

  pageState: (path: string) => call("page.state", { path }),
  setPageState: (path: string, state: unknown) => call("page.setState", { path, state }),

  readFile: (path: string) => call("file.read", { path }),
  writeFile: (path: string, text: string) => call("file.write", { path, text }),
  createFile: (path: string, text?: string) => call("file.create", { path, text }),
  createUntitled: (folder: string) => call("file.createUntitled", { folder }),
  createFromLink: (source: string, target: string) =>
    call("file.createFromLink", { source, target }),
  rename: (from: string, to: string) => call("file.rename", { from, to }),
  deleteFile: (path: string) => call("file.delete", { path }),
  createFolder: (path: string) => call("folder.create", { path }),

  undoLabel: () => call("history.peek"),
  undo: () => call("history.undo"),

  toggleTask: (path: string, line: number) => call("task.toggle", { path, line }),
  templates: () => call("template.list"),
  templatePrompts: (template: string) => call("template.prompts", { template }),
  renderTemplate: (template: string, path: string, answers: Record<string, string>) =>
    call("template.render", { template, path, answers }),
  createFromTemplate: (template: string, path: string, answers: Record<string, string>) =>
    call("file.createFromTemplate", { template, path, answers }),
  tags: () => call("index.tags"),
  setupStatus: () => call("setup.status"),
  installCli: () => call("setup.installCli"),
  installPlugin: () => call("setup.installPlugin"),
  useVaultForCli: () => call("setup.useVault"),
  todos: (filter: TodoFilter = { tags: [] }) => call("todo.list", { filter }),
  todoDay: (path: string) => call("todo.day", { path }),
  updateTodo: (id: string, change: TaskChange) => call("todo.update", { id, change }),
  addTodo: (todo: { path?: string; text: string; due?: string; priority?: number }) =>
    call("todo.add", todo),
  search: (query: string, limit?: number) => call("search.query", { query, limit }),
  /** Today's daily note (or `date`'s, `YYYY-MM-DD`), created if missing. */
  openDaily: (date?: string) => call("daily.open", { date }),

  reveal: (path: string) => call("os.reveal", { path }),
  openExternally: (path: string) => call("os.open", { path }),

  /** Starts a shell in `cwd` (absolute; the vault root by default). */
  createTerminal: (size: { cols: number; rows: number }, cwd?: string, workspace?: string) =>
    call("terminal.create", { ...size, cwd, workspace }),
  terminals: () => call("terminal.list"),
  attachTerminal: (id: string, cols: number, rows: number) =>
    call("terminal.attach", { id, cols, rows }),
  terminalInput: (id: string, data: string) => call("terminal.input", { id, data }),
  resizeTerminal: (id: string, cols: number, rows: number) =>
    call("terminal.resize", { id, cols, rows }),
  killTerminal: (id: string) => call("terminal.kill", { id }),

  workspaces: () => call("workspace.list"),
  /** `cwd` is absolute; the vault root by default. */
  createWorkspace: (name: string, cwd?: string) => call("workspace.create", { name, cwd }),
  updateWorkspace: (id: string, change: { name?: string; cwd?: string }) =>
    call("workspace.update", { id, ...change }),
  saveWorkspaceLayout: (id: string, layout: unknown) =>
    call("workspace.saveLayout", { id, layout }),
  deleteWorkspace: (id: string) => call("workspace.delete", { id }),
  /** The note's workspace, made and linked if it hasn't one. */
  noteWorkspace: (path: string) => call("workspace.forNote", { path }),

  repos: () => call("repo.list"),
  locateRepo: (id: string, path: string, worktrees?: string) =>
    call("repo.locate", { id, path, worktrees }),
  projects: () => call("project.list"),
  inbox: () => call("inbox.list"),
  answerInbox: (id: string, answer?: string) => call("inbox.answer", { id, answer }),
  agents: () => call("agent.list"),
  createProject: (folder: string) => call("project.create", { folder }),
  tickets: (filter: TicketFilter = {}) => call("ticket.list", { filter }),
  ticketGit: (path: string) => call("ticket.git", { path }),
  createTicket: (ticket: NewTicket) => call("ticket.create", { ticket }),
  closeTicket: (path: string, force?: boolean) => call("ticket.close", { path, force }),
  restoreTicket: (path: string) => call("ticket.restore", { path }),
  strayWorktrees: () => call("ticket.strays"),
  /** For a note, or an absolute folder. */
  context: (where: { note?: string; cwd?: string }) => call("context.get", where),
  runAction: (id: string, where: { note?: string; cwd?: string }) =>
    call("action.run", { id, ...where }),
};

export { ApiCallError } from "./transport";
