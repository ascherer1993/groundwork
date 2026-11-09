import { api } from "../api/client";
import { ApiCallError } from "../api/transport";
import { flushNote, forgetUnlocked } from "../state/locks";
import { formDialog, useUi } from "../state/ui";
import { message } from "../state/vault";
import { displayName } from "./paths";

function titleOf(path: string) {
  return displayName(path.slice(path.lastIndexOf("/") + 1), "note").base;
}

/** The message for a failed unlock: "Wrong password" or what went wrong. */
export function unlockProblem(err: unknown): string {
  return err instanceof ApiCallError && err.code === "wrong_password"
    ? "Wrong password."
    : message(err);
}

/** Checks a new password and its confirmation (and that the hint isn't it). */
function newPasswordProblem(password: string, confirm: string, hint: string): string | null {
  if (!password) return "Enter a password.";
  if (password !== confirm) return "The passwords don't match.";
  if (hint.trim() && hint.trim() === password) return "The hint can't be the password.";
  return null;
}

const NEW_PASSWORD_FIELDS = [
  { label: "Password", type: "password" as const },
  { label: "Confirm password", type: "password" as const },
  { label: "Hint (optional)", placeholder: "Shown when it's locked" },
];

/** Asks for a password, its confirmation and a hint, then encrypts the note. */
export async function encryptNote(path: string): Promise<void> {
  const values = await formDialog({
    title: `Encrypt “${titleOf(path)}”`,
    message:
      "You'll need the password to open it. If you forget it, the note can't be recovered. " +
      "Its name and hint stay readable; search, todos and Claude won't see the rest.",
    fields: NEW_PASSWORD_FIELDS,
    confirmLabel: "Encrypt",
    validate: async ([password = "", confirm = "", hint = ""]) => {
      const problem = newPasswordProblem(password, confirm, hint);
      if (problem) return problem;
      await flushNote(path);
      await api.encryptNote(path, password, hint.trim());
      return null;
    },
  });
  if (values) useUi.getState().notify(`Encrypted “${titleOf(path)}”`);
}

/** Asks for the password, then writes the note back in the clear. */
export async function removeEncryption(path: string): Promise<void> {
  const values = await formDialog({
    title: `Remove encryption from “${titleOf(path)}”?`,
    message: "Its text will be saved unencrypted, readable by anything that reads the vault.",
    fields: [{ label: "Password", type: "password" }],
    confirmLabel: "Remove encryption",
    danger: true,
    validate: async ([password = ""]) => {
      if (!password) return "Enter the password.";
      await flushNote(path);
      try {
        await api.decryptNote(path, password);
      } catch (err) {
        return unlockProblem(err);
      }
      return null;
    },
  });
  if (!values) return;
  forgetUnlocked(path);
  useUi.getState().notify(`“${titleOf(path)}” is no longer encrypted`);
}

/** Asks for the current password and a new one (and hint). */
export async function changePassword(path: string): Promise<void> {
  const values = await formDialog({
    title: `Change the password of “${titleOf(path)}”`,
    fields: [{ label: "Current password", type: "password" }, ...NEW_PASSWORD_FIELDS],
    confirmLabel: "Change password",
    validate: async ([old = "", password = "", confirm = "", hint = ""]) => {
      if (!old) return "Enter the current password.";
      const problem = newPasswordProblem(password, confirm, hint);
      if (problem) return problem;
      await flushNote(path);
      try {
        await api.changeNotePassword(path, old, password, hint.trim());
      } catch (err) {
        return unlockProblem(err);
      }
      return null;
    },
  });
  if (values) useUi.getState().notify(`Changed the password of “${titleOf(path)}”`);
}
