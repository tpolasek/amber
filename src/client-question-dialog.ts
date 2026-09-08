import { api, notify } from "./client-api.js";
import { messageFrom } from "./client-formatters.js";
import { markdown } from "./client-markdown.js";
import { elements, state } from "./client-state.js";
import type { AskUserQuestion, AskUserQuestionRequest, QuestionSelection } from "./client-types.js";

export let questionRequest: AskUserQuestionRequest | null = null;
let questionIndex = 0;
let questionSelections = new Map<string, QuestionSelection>();
let questionSubmitting = false;

export function openQuestionDialog(request: AskUserQuestionRequest): void {
  questionRequest = request;
  questionIndex = 0;
  questionSubmitting = false;
  questionSelections = new Map(request.questions.map((question) => [
    question.question,
    { labels: new Set<string>(), other: "", otherSelected: false, focusIndex: 0 },
  ]));
  elements.questionDialog.hidden = false;
  renderQuestionDialog();
  focusCurrentQuestionOption();
}

export function closeQuestionDialog(): void {
  elements.questionDialog.hidden = true;
  questionRequest = null;
  questionSelections.clear();
  questionIndex = 0;
  questionSubmitting = false;
}

export function renderQuestionDialog(): void {
  const request = questionRequest;
  const question = request?.questions[questionIndex];
  if (!request || !question) return;
  const selection = questionSelections.get(question.question)!;
  const completeCount = request.questions.filter(questionIsAnswered).length;
  elements.questionDialogTitle.textContent = request.questions.length === 1
    ? "Amber has a question"
    : `Amber has questions · ${completeCount}/${request.questions.length} answered`;
  elements.questionDialogHints.textContent = question.multiSelect
    ? "↑/↓ focus · Space toggle · Enter action · ←/→ question · Esc decline"
    : "↑/↓ focus · Space select · Enter action · ←/→ question · Esc decline";
  updateQuestionActionState();
  elements.questionClose.toggleAttribute("disabled", questionSubmitting);
  elements.questionDialogBody.replaceChildren();

  if (request.questions.length > 1) {
    const navigation = document.createElement("nav");
    navigation.className = "question-tabs";
    navigation.setAttribute("aria-label", "Questions");
    request.questions.forEach((candidate, index) => {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "question-tab";
      tab.classList.toggle("active", index === questionIndex);
      tab.classList.toggle("answered", questionIsAnswered(candidate));
      tab.textContent = `${questionIsAnswered(candidate) ? "◆" : "◇"} ${candidate.header}`;
      tab.addEventListener("click", () => {
        questionIndex = index;
        renderQuestionDialog();
        focusCurrentQuestionOption();
      });
      navigation.append(tab);
    });
    elements.questionDialogBody.append(navigation);
  }

  const content = document.createElement("div");
  const hasPreview = !question.multiSelect && question.options.some((option) => option.preview !== undefined);
  content.className = `question-content${hasPreview ? " has-preview" : ""}`;
  const choices = document.createElement("section");
  choices.className = "question-choices";
  const chip = document.createElement("span");
  chip.className = "question-chip";
  chip.textContent = question.header;
  const prompt = document.createElement("h2");
  prompt.textContent = question.question;
  const guidance = document.createElement("p");
  guidance.className = "question-guidance";
  guidance.textContent = question.multiSelect ? "Select all that apply." : "Select one option.";
  choices.append(chip, prompt, guidance);

  const list = document.createElement("div");
  list.className = "question-options";
  question.options.forEach((option, index) => {
    const selected = selection.labels.has(option.label);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "question-option";
    row.classList.toggle("focused", selection.focusIndex === index);
    row.classList.toggle("selected", selected);
    row.setAttribute("role", question.multiSelect ? "checkbox" : "radio");
    row.setAttribute("aria-checked", String(selected));
    row.addEventListener("mouseenter", () => {
      if (selection.focusIndex === index) return;
      selection.focusIndex = index;
      renderQuestionDialog();
    });
    row.addEventListener("click", () => selectQuestionOption(index));
    const marker = document.createElement("span");
    marker.className = "question-option-marker";
    marker.textContent = question.multiSelect ? (selected ? "[×]" : "[ ]") : (selected ? "●" : "○");
    const copy = document.createElement("span");
    copy.className = "question-option-copy";
    const label = document.createElement("strong");
    label.textContent = option.label;
    const description = document.createElement("small");
    description.textContent = option.description;
    copy.append(label, description);
    row.append(marker, copy);
    list.append(row);
  });

  const otherIndex = question.options.length;
  const otherRow = document.createElement("div");
  otherRow.className = "question-option question-other";
  otherRow.tabIndex = -1;
  otherRow.setAttribute("role", question.multiSelect ? "checkbox" : "radio");
  otherRow.setAttribute("aria-checked", String(selection.otherSelected));
  otherRow.classList.toggle("focused", selection.focusIndex === otherIndex);
  otherRow.classList.toggle("selected", selection.otherSelected);
  otherRow.addEventListener("mouseenter", () => {
    if (selection.focusIndex === otherIndex) return;
    selection.focusIndex = otherIndex;
    renderQuestionDialog();
  });
  otherRow.addEventListener("click", () => selectQuestionOption(otherIndex));
  const otherMarker = document.createElement("span");
  otherMarker.className = "question-option-marker";
  otherMarker.textContent = question.multiSelect
    ? (selection.otherSelected ? "[×]" : "[ ]")
    : (selection.otherSelected ? "●" : "○");
  const otherCopy = document.createElement("label");
  otherCopy.className = "question-option-copy";
  const otherLabel = document.createElement("strong");
  otherLabel.textContent = "Other";
  const otherInput = document.createElement("input");
  otherInput.className = "question-other-input";
  otherInput.type = "text";
  otherInput.placeholder = "Type something…";
  otherInput.value = selection.other;
  otherInput.maxLength = 32_000;
  otherInput.addEventListener("focus", () => {
    selection.focusIndex = otherIndex;
    selection.otherSelected = true;
    otherRow.classList.add("selected");
    otherRow.setAttribute("aria-checked", "true");
    otherMarker.textContent = question.multiSelect ? "[×]" : "●";
    if (!question.multiSelect) {
      selection.labels.clear();
      list.querySelectorAll<HTMLButtonElement>("button.question-option").forEach((optionRow) => {
        optionRow.classList.remove("selected");
        optionRow.setAttribute("aria-checked", "false");
        const marker = optionRow.querySelector<HTMLElement>(".question-option-marker");
        if (marker) marker.textContent = "○";
      });
    }
    otherRow.classList.add("focused");
    updateQuestionActionState();
  });
  otherInput.addEventListener("click", (event) => event.stopPropagation());
  otherInput.addEventListener("input", () => {
    selection.other = otherInput.value;
    updateQuestionActionState();
  });
  otherCopy.append(otherLabel, otherInput);
  otherRow.append(otherMarker, otherCopy);
  list.append(otherRow);
  choices.append(list);
  content.append(choices);

  if (hasPreview) {
    const preview = document.createElement("aside");
    preview.className = "question-preview";
    const previewTitle = document.createElement("strong");
    previewTitle.textContent = "PREVIEW";
    const previewBody = document.createElement("div");
    previewBody.className = "question-preview-body";
    const focused = question.options[selection.focusIndex];
    const previewSource = focused?.preview;
    if (previewSource) previewBody.innerHTML = markdown.render(previewSource);
    else previewBody.textContent = selection.focusIndex === otherIndex ? "Custom response" : "No preview for this option";
    preview.append(previewTitle, previewBody);
    content.append(preview);
  }
  elements.questionDialogBody.append(content);
}

export function selectQuestionOption(index: number): void {
  const question = questionRequest?.questions[questionIndex];
  if (!question) return;
  const selection = questionSelections.get(question.question)!;
  selection.focusIndex = index;
  const option = question.options[index];
  if (!option) {
    if (question.multiSelect && selection.otherSelected) {
      selection.otherSelected = false;
      renderQuestionDialog();
      focusCurrentQuestionOption();
      return;
    }
    selection.otherSelected = true;
    if (!question.multiSelect) selection.labels.clear();
    renderQuestionDialog();
    focusOtherInput();
    return;
  }
  if (question.multiSelect) {
    if (selection.labels.has(option.label)) selection.labels.delete(option.label);
    else selection.labels.add(option.label);
  } else {
    selection.labels.clear();
    selection.labels.add(option.label);
    selection.other = "";
    selection.otherSelected = false;
  }
  renderQuestionDialog();
  focusCurrentQuestionOption();
}

export function questionIsAnswered(question: AskUserQuestion): boolean {
  const selection = questionSelections.get(question.question);
  if (!selection || (selection.otherSelected && !selection.other.trim())) return false;
  return selection.labels.size > 0 || (selection.otherSelected && Boolean(selection.other.trim()));
}

export function updateQuestionActionState(): void {
  const request = questionRequest;
  const question = request?.questions[questionIndex];
  if (!request || !question) return;
  const completeCount = request.questions.filter(questionIsAnswered).length;
  const isLastQuestion = questionIndex === request.questions.length - 1;
  elements.questionSubmit.disabled = isLastQuestion
    ? completeCount !== request.questions.length || questionSubmitting
    : !questionIsAnswered(question);
  elements.questionSubmit.textContent = isLastQuestion
    ? (questionSubmitting ? "SUBMITTING…" : "SUBMIT ANSWERS")
    : "NEXT";
  elements.questionDialogTitle.textContent = request.questions.length === 1
    ? "Amber has a question"
    : `Amber has questions · ${completeCount}/${request.questions.length} answered`;
}

export function focusCurrentQuestionOption(): void {
  const question = questionRequest?.questions[questionIndex];
  if (!question) return;
  const selection = questionSelections.get(question.question)!;
  if (selection.focusIndex === question.options.length) {
    elements.questionDialogBody.querySelector<HTMLElement>(".question-other")?.focus();
    return;
  }
  elements.questionDialogBody.querySelectorAll<HTMLButtonElement>(".question-option:not(.question-other)")[selection.focusIndex]?.focus();
}

export function focusOtherInput(): void {
  elements.questionDialogBody.querySelector<HTMLInputElement>(".question-other-input")?.focus();
}

export function handleQuestionDialogKeydown(event: KeyboardEvent): boolean {
  const request = questionRequest;
  const question = request?.questions[questionIndex];
  if (!request || !question || elements.questionDialog.hidden) return false;
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    advanceOrSubmitQuestions();
    return true;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    advanceOrSubmitQuestions();
    return true;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    void declineQuestions();
    return true;
  }
  if (document.activeElement instanceof HTMLInputElement) return true;
  const selection = questionSelections.get(question.question)!;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    questionIndex = (questionIndex + direction + request.questions.length) % request.questions.length;
    renderQuestionDialog();
    focusCurrentQuestionOption();
  } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    event.preventDefault();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    const optionCount = question.options.length + 1;
    selection.focusIndex = (selection.focusIndex + direction + optionCount) % optionCount;
    renderQuestionDialog();
    focusCurrentQuestionOption();
  } else if (event.key === " ") {
    event.preventDefault();
    selectQuestionOption(selection.focusIndex);
  } else if (/^[1-5]$/.test(event.key)) {
    event.preventDefault();
    const index = Number(event.key) - 1;
    if (index <= question.options.length) {
      selection.focusIndex = index;
      renderQuestionDialog();
      focusCurrentQuestionOption();
    }
  } else {
    event.preventDefault();
  }
  return true;
}

export function advanceOrSubmitQuestions(): void {
  const request = questionRequest;
  const question = request?.questions[questionIndex];
  if (!request || !question || questionSubmitting) return;
  if (questionIndex < request.questions.length - 1) {
    if (!questionIsAnswered(question)) return;
    questionIndex += 1;
    renderQuestionDialog();
    focusCurrentQuestionOption();
    return;
  }
  void submitQuestionAnswers();
}

export async function submitQuestionAnswers(): Promise<void> {
  const session = state.session;
  const request = questionRequest;
  if (!session || !request || questionSubmitting || request.questions.some((question) => !questionIsAnswered(question))) return;
  questionSubmitting = true;
  renderQuestionDialog();
  const answers: Record<string, string> = {};
  for (const question of request.questions) {
    const selection = questionSelections.get(question.question)!;
    const selectedLabels = question.options
      .filter((option) => selection.labels.has(option.label))
      .map((option) => option.label);
    answers[question.question] = [
      ...selectedLabels,
      ...(selection.otherSelected && selection.other.trim() ? [selection.other.trim()] : []),
    ].join(", ");
  }
  try {
    await api<{ answers: Record<string, string> }>(
      `/api/sessions/${session.id}/questions/${encodeURIComponent(request.toolUseId)}/answers`,
      { method: "POST", body: JSON.stringify({ answers }) },
    );
    closeQuestionDialog();
  } catch (error) {
    questionSubmitting = false;
    renderQuestionDialog();
    notify(messageFrom(error));
  }
}

export async function declineQuestions(): Promise<void> {
  const session = state.session;
  const request = questionRequest;
  if (!session || !request || questionSubmitting) return;
  questionSubmitting = true;
  renderQuestionDialog();
  try {
    await api<{ cancelled: true }>(
      `/api/sessions/${session.id}/questions/${encodeURIComponent(request.toolUseId)}/answers`,
      { method: "POST", body: JSON.stringify({ cancelled: true }) },
    );
    closeQuestionDialog();
  } catch (error) {
    questionSubmitting = false;
    renderQuestionDialog();
    notify(messageFrom(error));
  }
}
