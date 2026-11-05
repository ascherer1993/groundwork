/**
 * Smart search (PLAN §5.9): qmd finds notes by meaning. Its status (is qmd
 * installed, is the vault set up, is it updating) for Settings and the
 * search panel, checked again every few seconds while it's updating.
 */
import { create } from "zustand";
import { api } from "../api/client";
import type { QmdStatus } from "../api/generated/QmdStatus";
import { useUi } from "./ui";
import { message } from "./vault";

interface SmartState {
  status: QmdStatus | null;
  /** Checks again. */
  load(): Promise<void>;
  /** Runs a change (set up, update, remove…) that answers with the new status. */
  change(call: () => Promise<QmdStatus>): Promise<void>;
}

let polling: ReturnType<typeof setTimeout> | null = null;

export const useSmart = create<SmartState>((set, get) => {
  const show = (status: QmdStatus) => {
    set({ status });
    if (polling) clearTimeout(polling);
    polling = status.updating ? setTimeout(() => void get().load(), 2000) : null;
  };
  return {
    status: null,

    async load() {
      try {
        show(await api.qmdStatus());
      } catch {
        set({ status: null });
      }
    },

    async change(call) {
      try {
        show(await call());
      } catch (err) {
        useUi.getState().notify(message(err));
        await get().load();
      }
    },
  };
});

/** Whether the vault is set up for smart search. */
export function useSmartReady(): boolean {
  return useSmart((s) => !!s.status?.collection);
}
