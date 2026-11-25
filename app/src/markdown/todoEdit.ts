/**
 * Editing a todo's text where it's listed (a `todos` block, the Todos
 * panel, the todo board): a one-line field over the text. Enter or leaving
 * the field saves, Escape cancels. Typing `@date` or `!p1` changes the due
 * date or priority too, as when adding one.
 */
import type { EditorView } from "@codemirror/view";
import { api } from "../api/client";
import type { Todo } from "../api/generated/Todo";
import { todoField } from "../editor/todoField";
import { useUi } from "../state/ui";
import { message } from "../state/vault";
import { parseTodoInput } from "./todos";

/** Saves what was typed for `todo`: its due date and priority first, while its id still holds. */
export async function saveTodoEdit(todo: Todo, input: string): Promise<void> {
  const { text, due, priority } = parseTodoInput(input);
  if (!text) return;
  try {
    if (due && due !== todo.due) await api.updateTodo(todo.id, { kind: "due", date: due });
    if (priority !== undefined && priority !== todo.priority)
      await api.updateTodo(todo.id, { kind: "priority", priority });
    // The id hashes the text, so the text goes last.
    if (text !== todo.text) await api.updateTodo(todo.id, { kind: "text", text });
  } catch (err) {
    useUi.getState().notify(message(err));
  }
}

/**
 * Puts an edit field for `todo` in `parent`, focused with the cursor at the
 * end. `onEnd` runs once, after saving or cancelling. Returns a function
 * that removes the field without saving.
 */
export function mountTodoEdit(parent: HTMLElement, todo: Todo, onEnd: () => void): () => void {
  let done = false;
  let field: EditorView | null = null;
  const end = (save: boolean) => {
    if (done) return;
    done = true;
    const text = field?.state.doc.toString() ?? "";
    field?.destroy();
    field = null;
    const saving = save ? saveTodoEdit(todo, text) : Promise.resolve();
    void saving.finally(onEnd);
  };
  field = todoField(parent, {
    label: "Edit todo",
    placeholder: "Todo…  @date  !priority",
    value: todo.text,
    keep: true,
    onSubmit: () => end(true),
    onCancel: () => end(false),
    onBlur: () => end(true),
  });
  field.focus();
  field.dispatch({ selection: { anchor: field.state.doc.length } });
  return () => {
    if (done) return;
    done = true;
    field?.destroy();
  };
}
