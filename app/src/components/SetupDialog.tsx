import { AlertTriangle, CheckCircle2, Circle, Copy, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { SetupItem } from "../api/generated/SetupItem";
import type { SetupState } from "../api/generated/SetupState";
import type { SetupStatus } from "../api/generated/SetupStatus";
import { useUi } from "../state/ui";
import { message } from "../state/vault";

let checked = false;
/** Set once the dialog has been opened, which ends the first-run prompt. */
const SEEN_KEY = "groundwork.setupSeen";

function seen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Once per launch: if anything set up earlier (the command, the plugin, the
 * default vault) has gone stale, e.g. after a pull or a move, offers to fix
 * it. Until the dialog has been opened once, also offers to set up from
 * scratch when the command isn't installed.
 */
export function checkSetupOnce() {
  if (checked) return;
  checked = true;
  const { notify, openSetup } = useUi.getState();
  api
    .setupStatus()
    .then((status) => {
      const stale = [status.cli, status.plugin, status.vault].some((i) => i.state === "stale");
      if (stale) {
        notify("Claude Code setup is out of date.", { label: "Fix…", run: openSetup });
      } else if (status.cli.state === "missing" && status.plugin.state !== "ok" && !seen()) {
        notify("Let Claude Code work with your notes, from any terminal.", {
          label: "Set up…",
          run: openSetup,
        });
      }
    })
    .catch(() => {});
}

const ICONS: Record<SetupState, typeof Circle> = {
  ok: CheckCircle2,
  missing: Circle,
  stale: AlertTriangle,
  unavailable: XCircle,
};

type Action = "cli" | "plugin" | "vault";

export function SetupDialog() {
  const open = useUi((s) => s.setupOpen);
  return open ? <SetupDialogBody /> : null;
}

function SetupDialogBody() {
  const close = useUi((s) => s.closeSetup);
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [errors, setErrors] = useState<Partial<Record<Action, string>>>({});

  useEffect(() => {
    try {
      localStorage.setItem(SEEN_KEY, "1");
    } catch {
      // Not remembered; the prompt shows again next launch.
    }
    api
      .setupStatus()
      .then(setStatus)
      .catch((err) => setErrors({ cli: message(err) }));
  }, []);

  const run = (action: Action) => {
    setBusy(action);
    setErrors((e) => ({ ...e, [action]: undefined }));
    const call =
      action === "cli"
        ? api.installCli()
        : action === "plugin"
          ? api.installPlugin()
          : api.useVaultForCli();
    call
      .then(setStatus)
      .catch((err) => setErrors((e) => ({ ...e, [action]: message(err) })))
      .finally(() => setBusy(null));
  };

  const row = (
    action: Action,
    title: string,
    item: SetupItem | undefined,
    button: string | null,
  ) => (
    <Row
      title={title}
      item={item}
      button={button}
      busy={busy === action}
      disabled={busy !== null}
      error={errors[action]}
      onRun={() => run(action)}
    />
  );

  return (
    <div className="overlay" onMouseDown={close}>
      <div
        className="dialog setup-dialog"
        role="dialog"
        aria-label="Set up Claude Code"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && close()}
      >
        <h2>Set up Claude Code</h2>
        <p className="muted">
          Lets Claude Code, in any terminal, work on your notes with the <code>groundwork</code>{" "}
          command and follow this vault’s conventions.
        </p>
        {row("cli", "The groundwork command", status?.cli, cliButton(status?.cli.state))}
        {row("plugin", "Claude Code plugin", status?.plugin, pluginButton(status?.plugin.state))}
        {row(
          "vault",
          "Default vault for the command",
          status?.vault,
          status?.vault.state === "ok" ? null : "Use this vault",
        )}
        <p className="muted setup-footnote">
          Updating Groundwork updates both the command and the plugin. If either gets out of step,
          Groundwork tells you when it starts.
        </p>
        <div className="dialog-buttons">
          <button className="primary" autoFocus onClick={close}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function cliButton(state?: SetupState): string | null {
  if (state === "missing") return "Install";
  if (state === "stale") return "Fix";
  if (state === "ok") return "Reinstall";
  return null;
}

function pluginButton(state?: SetupState): string | null {
  if (state === "missing") return "Install";
  if (state === "stale") return "Fix";
  return null;
}

function Row(props: {
  title: string;
  item: SetupItem | undefined;
  button: string | null;
  busy: boolean;
  disabled: boolean;
  error?: string;
  onRun: () => void;
}) {
  const { title, item, button, busy, disabled, error, onRun } = props;
  const Icon = item ? ICONS[item.state] : Circle;
  return (
    <section className="setup-row" aria-label={title} data-state={item?.state ?? "loading"}>
      <Icon size={16} className="setup-icon" aria-hidden />
      <div className="setup-text">
        <h3>{title}</h3>
        <p>{item ? withCode(item.summary) : "Checking…"}</p>
        {item?.note && <p className="muted">{withCode(item.note)}</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {item?.state === "unavailable" && item.manual.length > 0 && (
          <Manual commands={item.manual} />
        )}
      </div>
      {button && item && (
        <button onClick={onRun} disabled={disabled}>
          {busy ? "Working…" : button}
        </button>
      )}
    </section>
  );
}

/** `Backticked` commands in the backend's messages, as code. */
function withCode(text: string) {
  return text.split(/`([^`]+)`/).map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part));
}

function Manual({ commands }: { commands: string[] }) {
  const text = commands.join("\n");
  return (
    <div className="setup-manual">
      <span className="muted">To do it by hand:</span>
      <pre>{text}</pre>
      <button
        className="icon"
        aria-label="Copy commands"
        title="Copy"
        onClick={() => {
          void navigator.clipboard.writeText(text);
          useUi.getState().notify("Copied.");
        }}
      >
        <Copy size={14} />
      </button>
    </div>
  );
}
