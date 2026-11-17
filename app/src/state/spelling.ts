import { create } from "zustand";
import { api } from "../api/client";

/**
 * Spell checking (PLAN §5.18): whether it's on (this machine's settings; on
 * unless turned off), and what the backend has said about each word, shared
 * by every open editor. The backend knows the dictionary and the vault's own
 * words (`.groundwork/dictionary.txt`); this only remembers its answers.
 */
interface SpellingSettings {
  enabled: boolean;
  setEnabled(enabled: boolean): void;
}

export const useSpelling = create<SpellingSettings>((set) => ({
  enabled: true,
  setEnabled(enabled) {
    set({ enabled });
    void api
      .settings()
      .then((current) => api.saveSettings({ ...current, spellcheck: enabled }))
      .catch(() => {});
    spellingChanged();
  },
}));

/** Reads whether to check spelling from this machine's settings. */
export async function loadSpellingSettings() {
  try {
    const settings = await api.settings();
    if (settings.spellcheck !== undefined) useSpelling.setState({ enabled: settings.spellcheck });
  } catch {
    // The default stands.
  }
}

/** Whether each word is known, for the vault they were asked about. */
let verdicts = new Map<string, boolean>();
let verdictsVault: string | null = null;
const listeners = new Set<() => void>();

/** The cache for `vault`, emptied when the vault changes. */
function cacheFor(vault: string): Map<string, boolean> {
  if (verdictsVault !== vault) {
    verdicts = new Map();
    verdictsVault = vault;
  }
  return verdicts;
}

/** What's known about `word`: true if it's a word, false if not, undefined if not asked yet. */
export function verdict(vault: string, word: string): boolean | undefined {
  return cacheFor(vault).get(word);
}

/** Asks the backend about words not asked about yet. */
export async function checkWords(vault: string, words: string[]): Promise<void> {
  const cache = cacheFor(vault);
  const unknown = [...new Set(words)].filter((w) => !cache.has(w));
  if (unknown.length === 0) return;
  const misspelled = new Set(await api.misspelled(unknown));
  // The vault may have changed while asking; the answers are for the old one.
  if (verdictsVault !== vault) return;
  for (const w of unknown) cache.set(w, !misspelled.has(w));
}

/** Adds a word to the vault's dictionary and takes its underlines away. */
export async function addToDictionary(word: string): Promise<void> {
  await api.addToDictionary(word);
  forgetMisspellings();
}

/** Takes a word out of the vault's dictionary; it's underlined again. */
export async function removeFromDictionary(word: string): Promise<void> {
  await api.removeFromDictionary(word);
  verdicts.clear();
  spellingChanged();
}

/**
 * Forgets the words found misspelled, so they're asked about again: the
 * vault's dictionary may have gained them (here, or edited or synced from
 * elsewhere while the window was in the background).
 */
export function forgetMisspellings() {
  for (const [w, known] of verdicts) if (!known) verdicts.delete(w);
  spellingChanged();
}

/** Called when underlines may need redrawing. */
export function onSpellingChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function spellingChanged() {
  for (const l of listeners) l();
}

if (typeof window !== "undefined") window.addEventListener("focus", forgetMisspellings);
