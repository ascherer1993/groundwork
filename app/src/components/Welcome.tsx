import { FolderOpen, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { isTauri } from "../api/transport";
import { pickFolder } from "../lib/pickFolder";
import { useVault } from "../state/vault";

export function Welcome() {
  const recent = useVault((s) => s.recent);
  const error = useVault((s) => s.error);
  const openVault = useVault((s) => s.openVault);
  const forgetVault = useVault((s) => s.forgetVault);
  const [path, setPath] = useState("");
  const desktop = isTauri();

  async function browse() {
    const picked = await pickFolder();
    if (picked) await openVault(picked);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (path.trim()) void openVault(path.trim());
  }

  return (
    <main className="welcome">
      <div className="welcome-card">
        <h1>Groundwork</h1>
        <p className="muted">Open a folder of notes to use as a vault.</p>

        {desktop && (
          <button className="primary" onClick={() => void browse()}>
            <FolderOpen size={16} /> Open folder…
          </button>
        )}

        <form className="path-form" onSubmit={submit}>
          <label htmlFor="vault-path" className={desktop ? "muted" : undefined}>
            {desktop ? "Or enter a path" : "Vault path"}
          </label>
          <div className="row">
            <input
              id="vault-path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/Users/you/Notes"
              spellCheck={false}
              autoComplete="off"
            />
            <button type="submit" disabled={!path.trim()}>
              Open
            </button>
          </div>
        </form>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        {recent.length > 0 && (
          <section aria-labelledby="recent-heading">
            <h2 id="recent-heading">Recent</h2>
            <ul className="recent">
              {recent.map((v) => (
                <li key={v.path}>
                  <button
                    className="recent-open"
                    disabled={!v.exists}
                    onClick={() => void openVault(v.path)}
                    title={v.exists ? v.path : `${v.path} (missing)`}
                  >
                    <span className="recent-name">{v.name}</span>
                    <span className="recent-path">{v.exists ? v.path : "Folder not found"}</span>
                  </button>
                  <button
                    className="icon"
                    aria-label={`Remove ${v.name} from recent`}
                    onClick={() => void forgetVault(v.path)}
                  >
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}
