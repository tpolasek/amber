import { elements, state } from "./client-state.js";

// Clearing reuses runCommand in client.ts, which owns busy-state, snapshots,
// and notifications; registered like the git dialog's commit sender so this
// module never imports client.ts.
let clearGoal: (() => Promise<void>) | null = null;

export function setGoalClearer(clear: () => Promise<void>): void {
  clearGoal = clear;
}

export function openGoalDialog(): void {
  const goal = state.session?.goal;
  if (!goal) return;
  const text = document.createElement("div");
  text.className = "tasks-empty goal-dialog-text";
  text.textContent = goal;
  elements.goalDialogBody.replaceChildren(text);
  elements.goalDialog.hidden = false;
  elements.goalContinue.focus();
}

export function closeGoalDialog(): void {
  elements.goalDialog.hidden = true;
  elements.prompt.focus();
}

export async function clearGoalFromDialog(): Promise<void> {
  if (!clearGoal || !state.session?.goal) return;
  closeGoalDialog();
  await clearGoal();
}

export function handleGoalDialogKeydown(event: KeyboardEvent): boolean {
  if (elements.goalDialog.hidden) return false;
  if (event.key === "Escape") {
    event.preventDefault();
    closeGoalDialog();
    return true;
  }
  return false;
}
