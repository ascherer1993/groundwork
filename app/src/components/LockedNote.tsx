import { Lock } from "lucide-react";
import { useState } from "react";
import { unlockProblem } from "../lib/encryption";
import { useLocks } from "../state/locks";

/** In place of an encrypted note's text while it's locked: its hint and a password field. */
export function LockedNote({ path, hint }: { path: string; hint: string }) {
  const [password, setPassword] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function unlock() {
    if (!password || busy) return;
    setBusy(true);
    try {
      await useLocks.getState().unlock(path, password);
    } catch (err) {
      setProblem(unlockProblem(err));
      setBusy(false);
    }
  }

  return (
    <form
      className="locked-note"
      aria-label="Encrypted note"
      onSubmit={(e) => {
        e.preventDefault();
        void unlock();
      }}
    >
      <Lock size={28} className="locked-note-icon" aria-hidden />
      <p className="locked-note-title">This note is encrypted</p>
      {hint && (
        <p className="muted locked-note-hint">
          Hint: <span>{hint}</span>
        </p>
      )}
      <div className="locked-note-row">
        <input
          type="password"
          aria-label="Password"
          placeholder="Password"
          autoComplete="off"
          autoFocus
          value={password}
          disabled={busy}
          onChange={(e) => {
            setPassword(e.target.value);
            setProblem(null);
          }}
        />
        <button type="submit" className="primary" disabled={!password || busy}>
          {busy ? "Unlocking…" : "Unlock"}
        </button>
      </div>
      {problem && (
        <p className="locked-note-problem" role="alert">
          {problem}
        </p>
      )}
    </form>
  );
}
