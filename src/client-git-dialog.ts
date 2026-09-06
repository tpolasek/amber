import { api, notify } from "./client-api.js";
import { renderDiff } from "./client-diff.js";
import { messageFrom } from "./client-formatters.js";
import { elements, state } from "./client-state.js";

type GitView = "diff" | "show" | "status";

let gitDialogRequest = 0;

// Sending a commit hands control back to the messaging loop in client.ts.
let sendCommit: ((content: string) => Promise<void>) | null = null;

export function setCommitSender(send: (content: string) => Promise<void>): void {
  sendCommit = send;
}

export async function openGitDialog(view: GitView): Promise<void> {
  const session = state.session;
  if (!session) return;
  gitDialogRequest += 1;
  const request = gitDialogRequest;
  elements.gitDialogTitle.textContent = `Git ${view}`;
  elements.gitDialogHints.textContent = view === "diff" ? "Commit · Commit + Push · Esc close" : "Esc close";
  elements.gitCommit.hidden = view !== "diff";
  elements.gitCommitPush.hidden = view !== "diff";
  elements.gitDialog.querySelector(".git-dialog")?.classList.toggle("git-dialog-tall", view === "diff" || view === "show");
  elements.gitDialog.hidden = false;
  const loading = document.createElement("div");
  loading.className = "tasks-empty";
  loading.textContent = `Running git ${view}…`;
  elements.gitDialogBody.replaceChildren(loading);
  elements.gitClose.focus();
  try {
    const result = await api<{ output: string; exitCode: number | null }>(
      `/api/sessions/${session.id}/git?command=${view}`,
    );
    if (request !== gitDialogRequest || elements.gitDialog.hidden) return;
    renderGitDialogBody(view, result.output, result.exitCode);
  } catch (error) {
    if (request !== gitDialogRequest) return;
    const failure = document.createElement("div");
    failure.className = "tasks-empty";
    failure.textContent = messageFrom(error);
    elements.gitDialogBody.replaceChildren(failure);
  }
}

export function renderGitDialogBody(view: GitView, output: string, exitCode: number | null): void {
  if (!output.trim() || output === "(no output)") {
    const empty = document.createElement("div");
    empty.className = "tasks-empty";
    empty.textContent = view === "diff" ? "No unstaged changes" : "No output";
    elements.gitDialogBody.replaceChildren(empty);
    return;
  }
  const pre = document.createElement("pre");
  pre.className = "git-dialog-output tool-output";
  if (view !== "status" && exitCode === 0) {
    pre.classList.add("tool-diff");
    renderDiff(pre, output);
  } else {
    pre.textContent = output;
  }
  elements.gitDialogBody.replaceChildren(pre);
}

export function closeGitDialog(): void {
  gitDialogRequest += 1;
  elements.gitDialog.hidden = true;
  elements.prompt.focus();
}

export function runGitDialogCommit(push: boolean): void {
  if (state.streaming) {
    notify("Wait for the current response to finish");
    return;
  }
  closeGitDialog();
  void sendCommit?.(push ? "/commit push" : "/commit");
}

export function handleGitDialogKeydown(event: KeyboardEvent): boolean {
  if (elements.gitDialog.hidden) return false;
  if (event.key === "Escape") {
    event.preventDefault();
    closeGitDialog();
    return true;
  }
  return false;
}
