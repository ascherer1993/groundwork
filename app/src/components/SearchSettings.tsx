import { useEffect } from "react";
import { api } from "../api/client";
import { openExternalUrl } from "../lib/fileUrl";
import { useSmart } from "../state/smart";

/** Settings › Search: smart search through qmd. */
export function SearchSettings() {
  const status = useSmart((s) => s.status);
  const change = useSmart((s) => s.change);
  useEffect(() => {
    void useSmart.getState().load();
  }, []);

  return (
    <>
      <div className="settings-head">
        <h2>Search</h2>
      </div>
      <p className="muted">
        Search (⇧⌘F) finds notes by their words. <strong>Smart search</strong> finds them by meaning
        too, so “what did we decide about auth” finds the note that says “we’ll keep sessions in
        Redis”. It runs through{" "}
        <a
          className="smart-link"
          href="https://github.com/tobi/qmd"
          onClick={(e) => {
            e.preventDefault();
            void openExternalUrl("https://github.com/tobi/qmd");
          }}
        >
          qmd
        </a>
        , on this Mac. Agents use it with <code>groundwork search --smart</code> and{" "}
        <code>groundwork who</code>.
      </p>
      <div className="settings-scroll">
        <section className="smart-status" aria-label="Smart search">
          {!status ? (
            <p className="muted">Checking for qmd…</p>
          ) : !status.installed ? (
            <>
              <p>qmd isn’t installed. Install it in a terminal (it needs Node 22 or later):</p>
              <pre className="smart-command">npm install -g @tobilu/qmd</pre>
              <button type="button" onClick={() => void useSmart.getState().load()}>
                Check again
              </button>
            </>
          ) : !status.collection ? (
            <>
              <p>
                qmd is installed. Setting up adds the vault’s notes to qmd’s index. The first time,
                qmd downloads its models (about 2 GB), so it takes a while.
              </p>
              {status.path && <p className="muted small">Found qmd at {status.path}</p>}
              <button type="button" className="primary" onClick={() => void change(api.qmdSetup)}>
                Set up smart search
              </button>
            </>
          ) : (
            <>
              <p>
                <strong>On.</strong> The vault is qmd collection <code>{status.collection}</code>.
              </p>
              {status.path && <p className="muted small">qmd: {status.path}</p>}
              <p className="muted" role="status">
                {status.updating
                  ? "Updating the index…"
                  : status.lastError
                    ? `The last update failed: ${status.lastError}`
                    : status.lastUpdate
                      ? `Last updated ${status.lastUpdate}.`
                      : "Not indexed yet."}
              </p>
              <label className="settings-check">
                <input
                  type="checkbox"
                  checked={status.autoUpdate}
                  onChange={(e) => {
                    const on = e.target.checked;
                    void change(() => api.qmdSetAutoUpdate(on));
                  }}
                />
                Update the index as notes change
              </label>
              <div className="smart-buttons">
                <button
                  type="button"
                  disabled={status.updating}
                  onClick={() => void change(api.qmdUpdate)}
                >
                  Update now
                </button>
                <button type="button" onClick={() => void change(api.qmdRemove)}>
                  Turn off
                </button>
              </div>
            </>
          )}
        </section>
      </div>
    </>
  );
}
