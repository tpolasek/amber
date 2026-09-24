import { readEventStream, responseError } from "./client-api.js";
import { markdown } from "./client-markdown.js";
import { elements, state } from "./client-state.js";

let btwController: AbortController | null = null;

export function openBtwDialog(question = ""): void {
  elements.btwDialog.hidden = false;
  resetBtwAnswer();
  elements.btwQuestion.value = question;
  if (question) void askBtwQuestion(question);
  else elements.btwQuestion.focus();
}

export function closeBtwDialog(): void {
  btwController?.abort();
  btwController = null;
  elements.btwDialog.hidden = true;
  elements.btwQuestion.value = "";
  resetBtwAnswer();
  elements.prompt.focus();
}

export function handleBtwDialogKeydown(event: KeyboardEvent): boolean {
  if (elements.btwDialog.hidden) return false;
  if (event.key === "Escape") {
    event.preventDefault();
    closeBtwDialog();
    return true;
  }
  return false;
}

function resetBtwAnswer(): void {
  elements.btwAnswer.hidden = true;
  elements.btwAnswer.replaceChildren();
}

async function askBtwQuestion(question: string): Promise<void> {
  const session = state.session;
  if (!session || btwController) return;
  btwController = new AbortController();
  const controller = btwController;
  elements.btwQuestion.disabled = true;
  elements.btwAsk.disabled = true;
  const answer = document.createElement("article");
  answer.className = "message-content";
  const progress = document.createElement("div");
  progress.className = "btw-progress";
  progress.append(document.createElement("i"));
  const cursor = document.createElement("span");
  cursor.className = "cursor-block";
  elements.btwAnswer.hidden = false;
  elements.btwAnswer.replaceChildren(progress, answer);
  let text = "";
  try {
    const response = await fetch(`/api/sessions/${session.id}/btw`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(await responseError(response));
    if (!response.body) throw new Error("Server returned no stream");
    let failure: string | undefined;
    await readEventStream(response.body, (event, data) => {
      if (event === "delta") {
        text += (data as { text: string }).text;
        answer.replaceChildren(document.createTextNode(text), cursor);
        elements.btwAnswer.scrollTop = elements.btwAnswer.scrollHeight;
      } else if (event === "error") {
        failure = (data as { error: string }).error;
      }
    });
    if (failure) throw new Error(failure);
    if (text.trim()) {
      answer.innerHTML = markdown.render(text);
      answer.querySelectorAll<HTMLAnchorElement>("a").forEach((link) => {
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      });
    }
  } catch (error) {
    // A user abort keeps whatever answer had arrived; anything else surfaces.
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      const failure = document.createElement("div");
      failure.className = "btw-error";
      failure.textContent = text.trim() ? `Answer interrupted: ${error instanceof Error ? error.message : String(error)}`
        : error instanceof Error ? error.message : String(error);
      elements.btwAnswer.append(failure);
    }
  } finally {
    progress.remove();
    cursor.remove();
    if (btwController === controller) btwController = null;
    elements.btwQuestion.disabled = false;
    elements.btwAsk.disabled = false;
    if (!elements.btwDialog.hidden) elements.btwQuestion.focus();
  }
}

export function wireBtwDialog(): void {
  elements.btwForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const question = elements.btwQuestion.value.trim();
    if (question) void askBtwQuestion(question);
  });
  elements.btwClose.addEventListener("click", closeBtwDialog);
  elements.btwDialog.addEventListener("click", (event) => {
    if (event.target === elements.btwDialog) closeBtwDialog();
  });
}
