import { api, notify } from "./client-api.js";
import {
  effectiveModelKey,
  effectiveThinkingLevel,
  renderContextMeter,
  renderHeader,
  setBusy,
} from "./client-chrome.js";
import { messageFrom } from "./client-formatters.js";
import { elements, state } from "./client-state.js";
import type { AvailableModel, Session } from "./client-types.js";
import { nextThinkingLevel } from "./thinking-level.js";

let modelDialogSelection = 0;
let modelDialogQuery = "";

export function handleModelSearchInput(): void {
  modelDialogQuery = elements.modelSearch.value;
  modelDialogSelection = 0;
  renderModelList();
}

export function openModelDialog(): void {
  const session = state.session;
  const config = state.config;
  if (!session || !config || session.parentSessionId || state.streaming) return;
  modelDialogQuery = "";
  elements.modelSearch.value = "";
  const currentModel = effectiveModelKey(session, config);
  const currentIndex = config.models.findIndex((model) => model.key === currentModel);
  modelDialogSelection = currentIndex >= 0 ? currentIndex : 0;
  renderModelList();
  elements.modelDialog.hidden = false;
  elements.modelSearch.focus();
  elements.modelList.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
}

export function closeModelDialog(): void {
  elements.modelDialog.hidden = true;
  elements.prompt.focus();
}

export function filteredModels(): AvailableModel[] {
  const models = state.config?.models ?? [];
  const query = modelDialogQuery.trim().toLocaleLowerCase();
  if (!query) return models;
  return models.filter((model) => [model.key, model.provider, model.model, model.displayName, model.thinkingLevel]
    .some((value) => value.toLocaleLowerCase().includes(query)));
}

export function renderModelList(): void {
  elements.modelList.replaceChildren();
  const models = filteredModels();
  modelDialogSelection = Math.min(modelDialogSelection, Math.max(0, models.length - 1));
  if (models.length === 0) {
    const empty = document.createElement("div");
    empty.className = "session-archive-empty";
    empty.textContent = "No matching models";
    elements.modelList.append(empty);
    return;
  }
  const activeModel = state.session && state.config ? effectiveModelKey(state.session, state.config) : state.config?.defaultModel;
  models.forEach((model, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tasks-row";
    button.classList.toggle("selected", index === modelDialogSelection);
    const marker = document.createElement("span");
    marker.className = "tasks-row-marker";
    marker.textContent = model.key === activeModel ? "●" : "○";
    const main = document.createElement("span");
    main.className = "tasks-row-main";
    const title = document.createElement("strong");
    title.textContent = `${model.provider}/${model.displayName}`;
    const details = document.createElement("small");
    details.textContent = `${model.model} · thinking ${model.thinkingLevel}`
      + (model.compactTokens ? ` · auto-compact ${model.compactTokens.toLocaleString()} tokens` : "");
    main.append(title, details);
    const status = document.createElement("span");
    status.className = "tasks-row-status";
    status.textContent = model.key === activeModel ? "ACTIVE" : "";
    button.append(marker, main, status);
    button.addEventListener("click", () => void selectModel(model));
    elements.modelList.append(button);
  });
}

export async function selectModel(model: AvailableModel): Promise<void> {
  const session = state.session;
  if (!session || session.parentSessionId || state.streaming) return;
  if (state.config && effectiveModelKey(session, state.config) === model.key) return closeModelDialog();
  setBusy(true);
  try {
    const result = await api<{ session: Session }>(`/api/sessions/${session.id}/model`, {
      method: "POST",
      body: JSON.stringify({ model: model.key }),
    });
    state.session = result.session;
    renderHeader();
    renderContextMeter();
    closeModelDialog();
    notify(`Model selected · ${model.key}`);
  } catch (error) {
    notify(messageFrom(error));
  } finally {
    setBusy(false);
    if (elements.modelDialog.hidden) elements.prompt.focus();
    else elements.modelSearch.focus();
  }
}

export async function cycleThinkingLevel(): Promise<void> {
  const session = state.session;
  const config = state.config;
  if (!session || !config || session.parentSessionId || state.streaming) return;
  const thinkingLevel = nextThinkingLevel(effectiveThinkingLevel(session, config));
  setBusy(true);
  try {
    const result = await api<{ session: Session }>(`/api/sessions/${session.id}/thinking-level`, {
      method: "POST",
      body: JSON.stringify({ thinkingLevel }),
    });
    state.session = result.session;
    renderHeader();
    notify(`Thinking level · ${thinkingLevel}`);
  } catch (error) {
    notify(messageFrom(error));
  } finally {
    setBusy(false);
    elements.prompt.focus();
  }
}

export function handleModelDialogKeydown(event: KeyboardEvent): boolean {
  if (elements.modelDialog.hidden) return false;
  const models = filteredModels();
  if (event.key === "Escape") {
    event.preventDefault();
    closeModelDialog();
  } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    event.preventDefault();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    modelDialogSelection = Math.max(0, Math.min(models.length - 1, modelDialogSelection + direction));
    renderModelList();
    elements.modelList.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
  } else if (event.key === "Enter") {
    const model = models[modelDialogSelection];
    if (model) {
      event.preventDefault();
      void selectModel(model);
    }
  } else if (document.activeElement !== elements.modelSearch
    && !event.ctrlKey && !event.metaKey && !event.altKey
    && /^[\p{L}\p{N}]$/u.test(event.key)) {
    event.preventDefault();
    elements.modelSearch.focus();
    elements.modelSearch.value += event.key;
    modelDialogQuery = elements.modelSearch.value;
    modelDialogSelection = 0;
    renderModelList();
  }
  return true;
}
