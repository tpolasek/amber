import { api, notify } from "./client-api.js";
import { renderPlanMode } from "./client-chrome.js";
import { messageFrom } from "./client-formatters.js";
import { markdown } from "./client-markdown.js";
import type { PlanHandoffDispatcher } from "./plan-handoff.js";
import { elements, state } from "./client-state.js";
import type { PlanModeRequest } from "./client-types.js";

export let planModeRequest: PlanModeRequest | null = null;
let planModeSubmitting = false;

// The dispatcher is owned by client.ts (its handoff handler drives session
// loading and messaging) and registered here at startup.
let planHandoffs: PlanHandoffDispatcher | null = null;

export function setPlanHandoffDispatcher(dispatcher: PlanHandoffDispatcher): void {
  planHandoffs = dispatcher;
}

export function openPlanModeDialog(request: PlanModeRequest): void {
  planModeRequest = request;
  planModeSubmitting = false;
  elements.planModeDialog.hidden = false;
  elements.planModeDialogBody.replaceChildren();
  elements.planModeDialogTitle.textContent = request.kind === "enter"
    ? "Enter plan mode?"
    : "Review implementation plan";
  elements.planModeDecline.textContent = request.kind === "enter" ? "DECLINE" : "KEEP PLANNING";
  elements.planModeApprove.textContent = request.kind === "enter" ? "ENTER PLAN MODE" : "IMPLEMENT";
  elements.planModeNewSession.hidden = request.kind !== "exit";
  elements.planModeDialogHints.textContent = request.kind === "enter"
    ? "Ctrl/Cmd+Enter approve · Esc decline"
    : "Feedback enables Keep Planning · Ctrl/Cmd+Enter approve · Esc close and wait";

  if (request.kind === "enter") {
    const content = document.createElement("section");
    content.className = "plan-mode-entry";
    const heading = document.createElement("h2");
    heading.textContent = "Amber wants to plan before making changes";
    const copy = document.createElement("p");
    copy.textContent = "Plan mode permits codebase exploration and limits Amber’s Write and Edit tools to a session-specific plan file. You’ll review the completed plan before implementation begins.";
    content.append(heading, copy);
    elements.planModeDialogBody.append(content);
  } else {
    const metadata = document.createElement("div");
    metadata.className = "plan-mode-path";
    const label = document.createElement("span");
    label.textContent = "PLAN FILE";
    const path = document.createElement("code");
    path.textContent = request.planFilePath;
    metadata.append(label, path);

    const plan = document.createElement("article");
    plan.className = "plan-mode-review-markdown message-content";
    plan.innerHTML = markdown.render(request.plan);
    plan.querySelectorAll<HTMLAnchorElement>("a").forEach((link) => {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    });
    elements.planModeDialogBody.append(metadata, plan);

    const feedback = document.createElement("label");
    feedback.className = "plan-mode-feedback";
    feedback.append(document.createTextNode("FEEDBACK REQUIRED TO KEEP PLANNING"));
    const input = document.createElement("textarea");
    input.id = "plan-mode-feedback";
    input.rows = 3;
    input.maxLength = 32_000;
    input.placeholder = "What should change in the plan?";
    input.addEventListener("input", updatePlanModeDialogState);
    feedback.append(input);
    elements.planModeDialogBody.append(feedback);
  }
  updatePlanModeDialogState();
  elements.planModeApprove.focus();
}

export function closePlanModeDialog(): void {
  elements.planModeDialog.hidden = true;
  elements.planModeDialogBody.replaceChildren();
  planModeRequest = null;
  planModeSubmitting = false;
}

export function updatePlanModeDialogState(): void {
  const feedback = elements.planModeDialogBody
    .querySelector<HTMLTextAreaElement>("#plan-mode-feedback")?.value.trim() ?? "";
  const feedbackRequired = planModeRequest?.kind === "exit";
  const canKeepPlanning = !feedbackRequired || Boolean(feedback);
  elements.planModeClose.disabled = planModeSubmitting;
  elements.planModeDecline.disabled = planModeSubmitting || !canKeepPlanning;
  elements.planModeDecline.classList.toggle("ready", feedbackRequired && canKeepPlanning && !planModeSubmitting);
  elements.planModeApprove.disabled = planModeSubmitting;
  elements.planModeNewSession.disabled = planModeSubmitting;
}

export async function cancelPlanModeRequest(): Promise<void> {
  const request = planModeRequest;
  if (!request) return;
  await submitPlanModeDecision(false, request.kind === "exit");
}

export async function submitPlanModeDecision(approved: boolean, cancelled = false): Promise<void> {
  const session = state.session;
  const request = planModeRequest;
  if (!session || !request || planModeSubmitting) return;
  const feedback = request.kind === "exit"
    ? elements.planModeDialogBody.querySelector<HTMLTextAreaElement>("#plan-mode-feedback")?.value.trim()
    : undefined;
  if (!approved && !cancelled && request.kind === "exit" && !feedback) {
    elements.planModeDialogBody.querySelector<HTMLTextAreaElement>("#plan-mode-feedback")?.focus();
    return;
  }
  planModeSubmitting = true;
  updatePlanModeDialogState();
  try {
    await api<{ decision: { approved: boolean; feedback?: string } }>(
      `/api/sessions/${session.id}/plan-mode/${encodeURIComponent(request.toolUseId)}/decision`,
      {
        method: "POST",
        body: JSON.stringify({ approved, ...(feedback ? { feedback } : {}), ...(cancelled ? { cancelled: true } : {}) }),
      },
    );
    if (approved && request.kind === "exit" && session.planMode) {
      session.planMode.active = false;
      renderPlanMode();
    }
    closePlanModeDialog();
  } catch (error) {
    planModeSubmitting = false;
    updatePlanModeDialogState();
    notify(messageFrom(error));
  }
}

export async function submitPlanModeNewSessionDecision(): Promise<void> {
  const session = state.session;
  const request = planModeRequest;
  if (!session || !request || planModeSubmitting || request.kind !== "exit") return;
  planModeSubmitting = true;
  updatePlanModeDialogState();
  try {
    const result = await api<{ decision: { approved: boolean; newSessionId?: string } }>(
      `/api/sessions/${session.id}/plan-mode/${encodeURIComponent(request.toolUseId)}/decision`,
      { method: "POST", body: JSON.stringify({ approved: true, newSession: true }) },
    );
    if (session.planMode) {
      session.planMode.active = false;
      renderPlanMode();
    }
    if (result.decision.newSessionId) {
      // The run ends the moment this decision settles, so the event stream may
      // already be closed by the time this response arrives: offer() dispatches
      // immediately when nothing is streaming and defers to the stream's
      // finally otherwise.
      planHandoffs?.offer({
        sessionId: result.decision.newSessionId,
        prompt: `Execute the plan: ${request.planFilePath}`,
      });
    }
    closePlanModeDialog();
  } catch (error) {
    planModeSubmitting = false;
    updatePlanModeDialogState();
    notify(messageFrom(error));
  }
}

export function handlePlanModeDialogKeydown(event: KeyboardEvent): boolean {
  if (elements.planModeDialog.hidden) return false;
  if (event.key === "Escape") {
    event.preventDefault();
    void cancelPlanModeRequest();
  } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    void submitPlanModeDecision(true);
  }
  return true;
}
