import type { AppInfo } from "./generated/AppInfo";
import type { CreatedNote } from "./generated/CreatedNote";
import type { DayView } from "./generated/DayView";
import type { Backlinks } from "./generated/Backlinks";
import type { FileContent } from "./generated/FileContent";
import type { FileSummary } from "./generated/FileSummary";
import type { LinkSettings } from "./generated/LinkSettings";
import type { Mention } from "./generated/Mention";
import type { OutgoingLink } from "./generated/OutgoingLink";
import type { ParsedNote } from "./generated/ParsedNote";
import type { RecentVault } from "./generated/RecentVault";
import type { RenameOutcome } from "./generated/RenameOutcome";
import type { RenderedTemplate } from "./generated/RenderedTemplate";
import type { SearchResult } from "./generated/SearchResult";
import type { SetupStatus } from "./generated/SetupStatus";
import type { TagCount } from "./generated/TagCount";
import type { TaskChange } from "./generated/TaskChange";
import type { Todo } from "./generated/Todo";
import type { TodoFilter } from "./generated/TodoFilter";
import type { Request } from "./generated/Request";
import type { TreeNode } from "./generated/TreeNode";
import type { VaultInfo } from "./generated/VaultInfo";
import type { WriteResult } from "./generated/WriteResult";
import { isTauri, TauriTransport, type Transport, WebSocketTransport } from "./transport";

/** What each method resolves to. Keep in sync with `groundwork_protocol::Request`. */
interface Results {
  "app.info": AppInfo;
  "vault.recent": RecentVault[];
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
};

export { ApiCallError } from "./transport";
