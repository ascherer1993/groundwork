import { create } from "zustand";
import { api } from "../api/client";
import type { FileSummary } from "../api/generated/FileSummary";
import { onVaultChange, useVault } from "./vault";

/**
 * Encrypted notes the user has unlocked. The backend holds their keys; this
 * tracks which are unlocked so the views agree, and locks them again: with
 * the lock button, when no tab shows the note any more, or after
 * `lockAfterMinutes` without use.
 */
interface LocksState {
  unlocked: Record<string, true>;
  /** Minutes without use before an unlocked note locks; 0 for never. */
  lockAfterMinutes: number;
  unlock(path: string, password: string): Promise<string>;
  lock(path: string): Promise<void>;
  lockAll(): Promise<void>;
  setLockAfterMinutes(minutes: number): void;
}

export const DEFAULT_LOCK_MINUTES = 10;

/** Saves each open view of a note has pending, so locking waits for them. */
const flushers = new Map<string, Set<() => Promise<void>>>();
/** How many views show each note. */
const viewers = new Map<string, number>();
const lastUse = new Map<string, number>();
/** Saves in flight, by note. */
const saving = new Map<string, Set<Promise<unknown>>>();

/** Records a save of `path` in flight, so locking it waits for it. */
export function trackSave<T>(path: string, save: Promise<T>): Promise<T> {
  let set = saving.get(path);
  if (!set) saving.set(path, (set = new Set()));
  set.add(save);
  const done = () => {
    set.delete(save);
    if (!set.size && saving.get(path) === set) saving.delete(path);
  };
  save.then(done, done);
  return save;
}

export const useLocks = create<LocksState>((set, get) => ({
  unlocked: {},
  lockAfterMinutes: DEFAULT_LOCK_MINUTES,

  async unlock(path, password) {
    const text = await api.unlockNote(path, password);
    lastUse.set(path, Date.now());
    set((s) => ({ unlocked: { ...s.unlocked, [path]: true } }));
    return text;
  },

  async lock(path) {
    await flushNote(path);
    forgetUnlocked(path);
    await api.lockNote(path).catch(() => {});
  },

  async lockAll() {
    await Promise.all(Object.keys(get().unlocked).map((p) => flushNote(p)));
    lastUse.clear();
    set({ unlocked: {} });
    await api.lockNote().catch(() => {});
  },

  setLockAfterMinutes(minutes) {
    const lockAfterMinutes = Math.max(0, Math.round(minutes));
    set({ lockAfterMinutes });
    void api
      .settings()
      .then((current) => api.saveSettings({ ...current, lockAfterMinutes }))
      .catch(() => {});
  },
}));

/** Marks a note locked here (the backend has forgotten its key, or will). */
export function forgetUnlocked(path: string) {
  lastUse.delete(path);
  const unlocked = { ...useLocks.getState().unlocked };
  if (!unlocked[path]) return;
  delete unlocked[path];
  useLocks.setState({ unlocked });
}

/** Reads when notes lock from this machine's settings. */
export async function loadLockSettings() {
  try {
    const settings = await api.settings();
    if (settings.lockAfterMinutes !== undefined)
      useLocks.setState({ lockAfterMinutes: settings.lockAfterMinutes });
  } catch {
    // The default stands.
  }
}

export function isUnlocked(path: string): boolean {
  return !!useLocks.getState().unlocked[path];
}

const encryptedSets = new WeakMap<FileSummary[], Set<string>>();

/** The encrypted notes among `files` (worked out once per list). */
export function encryptedPaths(files: FileSummary[]): Set<string> {
  let found = encryptedSets.get(files);
  if (!found) {
    found = new Set(files.filter((f) => f.encrypted).map((f) => f.path));
    encryptedSets.set(files, found);
  }
  return found;
}

/** Whether the index knows `path` as an encrypted note. */
export function isEncrypted(path: string): boolean {
  return encryptedPaths(useVault.getState().files).has(path);
}

/** Whether the index knows `path` as an encrypted note. */
export function useEncrypted(path: string): boolean {
  return useVault((s) => encryptedPaths(s.files).has(path));
}

/** Notes that the note was just used (typed in, clicked, scrolled). */
export function touchNote(path: string) {
  if (isUnlocked(path)) lastUse.set(path, Date.now());
}

/** Registers a view's pending save, run before the note locks or is encrypted. */
export function registerFlush(path: string, flush: () => Promise<void>): () => void {
  let set = flushers.get(path);
  if (!set) flushers.set(path, (set = new Set()));
  set.add(flush);
  return () => {
    set.delete(flush);
    if (!set.size) flushers.delete(path);
  };
}

/** Saves every open view's pending edits to `path`. */
export async function flushNote(path: string): Promise<void> {
  await Promise.all([...(flushers.get(path) ?? [])].map((f) => f().catch(() => {})));
  await Promise.all([...(saving.get(path) ?? [])].map((p) => p.catch(() => {})));
}

/**
 * A view shows `path`. Returns its release: when the last view of an
 * unlocked note goes (its tab closed, or the tab moved to another note), the
 * note locks.
 */
export function retainNote(path: string): () => void {
  viewers.set(path, (viewers.get(path) ?? 0) + 1);
  return () => {
    const left = (viewers.get(path) ?? 1) - 1;
    if (left > 0) {
      viewers.set(path, left);
      return;
    }
    viewers.delete(path);
    // After the view's own save on unmount has started.
    setTimeout(() => {
      if (!viewers.has(path) && isUnlocked(path)) void useLocks.getState().lock(path);
    }, 0);
  };
}

// Locks notes left unused.
setInterval(() => {
  const minutes = useLocks.getState().lockAfterMinutes;
  if (!minutes) return;
  const cutoff = Date.now() - minutes * 60_000;
  for (const path of Object.keys(useLocks.getState().unlocked)) {
    if ((lastUse.get(path) ?? 0) < cutoff) void useLocks.getState().lock(path);
  }
}, 15_000);

// Unlocked notes stay unlocked as they move (the backend's keys follow them).
onVaultChange((changes) => {
  const unlocked = useLocks.getState().unlocked;
  let next: Record<string, true> | null = null;
  for (const c of changes) {
    const from = c.kind === "moved" ? c.from : c.kind === "removed" ? c.path : undefined;
    if (!from || !unlocked[from]) continue;
    next ??= { ...unlocked };
    delete next[from];
    if (c.kind === "moved") {
      next[c.path] = true;
      // Its views follow by themselves (they release the old path and
      // retain the new one).
      lastUse.set(c.path, lastUse.get(from) ?? Date.now());
    }
    lastUse.delete(from);
  }
  if (next) useLocks.setState({ unlocked: next });
});

// A different vault starts with everything locked (the backend forgets too).
useVault.subscribe((s, prev) => {
  if (s.vault?.path !== prev.vault?.path) {
    lastUse.clear();
    useLocks.setState({ unlocked: {} });
  }
});
