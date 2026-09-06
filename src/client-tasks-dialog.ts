import { api, notify } from "./client-api.js";
import { formatDuration, messageFrom, taskRuntime } from "./client-formatters.js";
import { elements, state } from "./client-state.js";
import type { BackgroundTask } from "./client-types.js";

let tasksDialogTasks: BackgroundTask[] = [];
let tasksDialogSelection = 0;
let tasksDialogDetailId: string | null = null;
let tasksDialogSkippedList = false;
let tasksDialogPollTimer: number | undefined;

export function openTasksDialog(tasks: BackgroundTask[]): void {
  tasksDialogTasks = tasks;
  tasksDialogSelection = 0;
  tasksDialogSkippedList = tasks.length === 1;
  tasksDialogDetailId = tasksDialogSkippedList ? tasks[0]?.id ?? null : null;
  elements.tasksDialog.hidden = false;
  renderTasksDialog();
  startTasksDialogPolling();
  elements.tasksClose.focus();
}

export function closeTasksDialog(): void {
  elements.tasksDialog.hidden = true;
  tasksDialogTasks = [];
  tasksDialogDetailId = null;
  tasksDialogSkippedList = false;
  if (tasksDialogPollTimer !== undefined) window.clearInterval(tasksDialogPollTimer);
  tasksDialogPollTimer = undefined;
  elements.prompt.focus();
}

export function showTasksList(): void {
  if (tasksDialogSkippedList) return closeTasksDialog();
  tasksDialogDetailId = null;
  renderTasksDialog();
}

export function startTasksDialogPolling(): void {
  if (tasksDialogPollTimer !== undefined) window.clearInterval(tasksDialogPollTimer);
  tasksDialogPollTimer = window.setInterval(() => void refreshTasksDialog(), 1_000);
}

export async function refreshTasksDialog(): Promise<void> {
  const session = state.session;
  if (!session || elements.tasksDialog.hidden) return;
  try {
    const result = await api<{ tasks: BackgroundTask[] }>(`/api/sessions/${session.id}/tasks`);
    const selectedId = tasksDialogTasks[tasksDialogSelection]?.id;
    tasksDialogTasks = result.tasks;
    if (tasksDialogDetailId && !tasksDialogTasks.some((task) => task.id === tasksDialogDetailId)) {
      closeTasksDialog();
      return;
    }
    const selectedIndex = selectedId ? tasksDialogTasks.findIndex((task) => task.id === selectedId) : -1;
    tasksDialogSelection = selectedIndex >= 0
      ? selectedIndex
      : Math.min(tasksDialogSelection, Math.max(0, tasksDialogTasks.length - 1));
    renderTasksDialog();
  } catch {
    // Leave the current snapshot visible during a transient refresh failure.
  }
}

export function renderTasksDialog(): void {
  const detail = tasksDialogDetailId
    ? tasksDialogTasks.find((task) => task.id === tasksDialogDetailId) ?? null
    : null;
  elements.tasksDialogTitle.textContent = detail
    ? "Shell details"
    : `Background tasks · ${tasksDialogTasks.length} active ${tasksDialogTasks.length === 1 ? "shell" : "shells"}`;
  elements.tasksBack.hidden = !detail;
  elements.tasksStop.hidden = !(detail ?? tasksDialogTasks[tasksDialogSelection]);
  elements.tasksDialogHints.textContent = detail
    ? `${tasksDialogSkippedList ? "" : "← back · "}x stop · Esc close`
    : "↑/↓ select · Enter details · x stop · Esc close";
  elements.tasksDialogBody.replaceChildren();

  if (detail) {
    renderTaskDetail(detail);
    return;
  }
  if (tasksDialogTasks.length === 0) {
    const empty = document.createElement("div");
    empty.className = "tasks-empty";
    empty.textContent = "No tasks currently running";
    elements.tasksDialogBody.append(empty);
    elements.tasksStop.hidden = true;
    return;
  }

  const list = document.createElement("div");
  list.className = "tasks-list";
  const sectionTitle = document.createElement("div");
  sectionTitle.className = "tasks-section-title";
  sectionTitle.textContent = `Shells (${tasksDialogTasks.length})`;
  list.append(sectionTitle);
  tasksDialogTasks.forEach((task, index) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `tasks-row${index === tasksDialogSelection ? " selected" : ""}`;
    row.addEventListener("mouseenter", () => {
      tasksDialogSelection = index;
      renderTasksDialog();
    });
    row.addEventListener("click", () => {
      tasksDialogSelection = index;
      tasksDialogDetailId = task.id;
      renderTasksDialog();
    });
    const marker = document.createElement("span");
    marker.className = "tasks-row-marker";
    marker.textContent = index === tasksDialogSelection ? "❯" : " ";
    const main = document.createElement("span");
    main.className = "tasks-row-main";
    const label = document.createElement("strong");
    label.textContent = task.command;
    label.title = task.description;
    const meta = document.createElement("small");
    meta.textContent = `${task.id} · ${formatDuration(taskRuntime(task))}`;
    main.append(label, meta);
    const status = document.createElement("span");
    status.className = `tasks-row-status ${task.status}`;
    status.textContent = task.status;
    row.append(marker, main, status);
    list.append(row);
  });
  elements.tasksDialogBody.append(list);
}

export function renderTaskDetail(task: BackgroundTask): void {
  const detail = document.createElement("div");
  detail.className = "tasks-detail";
  detail.append(
    taskDetailField("Status", task.status),
    taskDetailField("Runtime", formatDuration(taskRuntime(task))),
    taskDetailField("Task ID", task.id),
    taskDetailField("Starting directory", task.workingDirectory),
  );
  const commandLabel = document.createElement("strong");
  commandLabel.textContent = "Command";
  const command = document.createElement("pre");
  command.textContent = task.command;
  detail.append(commandLabel, command);

  const outputLabel = document.createElement("strong");
  outputLabel.textContent = "Output";
  const output = document.createElement("pre");
  output.className = "tasks-detail-output";
  output.textContent = task.combinedOutput || "(no output yet)";
  detail.append(outputLabel, output);
  elements.tasksDialogBody.append(detail);
  output.scrollTop = output.scrollHeight;
}

export function taskDetailField(label: string, value: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "tasks-detail-field";
  const name = document.createElement("strong");
  name.textContent = `${label}:`;
  const content = document.createElement("span");
  content.textContent = value;
  row.append(name, content);
  return row;
}

export async function stopSelectedTask(): Promise<void> {
  const session = state.session;
  const task = tasksDialogDetailId
    ? tasksDialogTasks.find((candidate) => candidate.id === tasksDialogDetailId)
    : tasksDialogTasks[tasksDialogSelection];
  if (!session || !task) return;
  elements.tasksStop.disabled = true;
  try {
    await api<{ task: BackgroundTask }>(`/api/sessions/${session.id}/tasks/${encodeURIComponent(task.id)}/stop`, {
      method: "POST",
    });
    await refreshTasksDialog();
  } catch (error) {
    notify(messageFrom(error));
  } finally {
    elements.tasksStop.disabled = false;
  }
}

export function handleTasksDialogKeydown(event: KeyboardEvent): boolean {
  if (elements.tasksDialog.hidden) return false;
  if (event.key === "Escape") {
    event.preventDefault();
    closeTasksDialog();
  } else if (event.key === "ArrowLeft" && tasksDialogDetailId) {
    event.preventDefault();
    showTasksList();
  } else if (event.key.toLowerCase() === "x") {
    event.preventDefault();
    void stopSelectedTask();
  } else if (!tasksDialogDetailId && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
    event.preventDefault();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    tasksDialogSelection = Math.max(0, Math.min(tasksDialogTasks.length - 1, tasksDialogSelection + direction));
    renderTasksDialog();
  } else if (!tasksDialogDetailId && event.key === "Enter") {
    const task = tasksDialogTasks[tasksDialogSelection];
    if (task) {
      event.preventDefault();
      tasksDialogDetailId = task.id;
      renderTasksDialog();
    }
  } else {
    event.preventDefault();
  }
  return true;
}
