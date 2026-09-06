import { compactHeaderPath, formatTokenCountInThousands } from "./client-formatters.js";
import { elements, state } from "./client-state.js";
import type { Config, Session } from "./client-types.js";
import type { ThinkingLevel } from "./thinking-level.js";

export function effectiveThinkingLevel(session: Session, config: Config): ThinkingLevel {
  if (session.thinkingLevel) return session.thinkingLevel;
  const model = config.models.find((candidate) => candidate.key === effectiveModelKey(session, config));
  return model?.thinkingLevel ?? "none";
}

export function effectiveModelKey(session: Session, config: Config): string {
  return session.model && config.models.some((model) => model.key === session.model)
    ? session.model
    : config.defaultModel;
}

export function renderHeader(): void {
  const session = state.session;
  const config = state.config;
  if (!session || !config) return;
  elements.sessionTitle.textContent = session.title;
  elements.sessionTitle.title = session.title;
  renderModelStatus();
  elements.sessionDirectories.replaceChildren();
  const currentDirectory = session.cwd ?? config.workspaceRoot;
  const directories = [...new Set([...(session.directories ?? []), currentDirectory])];
  for (const directory of directories) {
    const item = document.createElement("span");
    item.className = "session-directory";
    item.classList.toggle("cwd", directory === currentDirectory);
    item.title = directory;
    item.append(document.createTextNode(compactHeaderPath(directory, config.homeDirectory)));
    if (directory === currentDirectory) {
      const marker = document.createElement("b");
      marker.textContent = " (CWD)";
      item.append(marker);
    }
    elements.sessionDirectories.append(item);
  }
  document.title = `${session.title} · AMBER`;
}

export function renderModelStatus(): void {
  const config = state.config;
  const session = state.session;
  if (!config) return;
  const model = config.configured
    ? session ? effectiveModelKey(session, config) : config.defaultModel
    : "CONFIGURE";
  elements.model.textContent = model;
  elements.model.title = model;
  elements.modelSelector.disabled = !config.configured || !session || Boolean(session.parentSessionId) || state.streaming;
  const thinkingLevel = session ? effectiveThinkingLevel(session, config) : "none";
  elements.thinkingLevel.textContent = thinkingLevel;
  elements.thinkingLevelButton.title = `Thinking level: ${thinkingLevel}. Click to select the next level.`;
  elements.thinkingLevelButton.setAttribute("aria-label", elements.thinkingLevelButton.title);
  elements.thinkingLevelButton.disabled = !config.configured || !session || Boolean(session.parentSessionId) || state.streaming;
}

export function renderPlanMode(): void {
  const session = state.session;
  const planMode = state.session?.planMode;
  const active = planMode?.active === true;
  const canChange = Boolean(session) && !session?.parentSessionId && !state.streaming;
  elements.modePlan.checked = active;
  elements.modeNormal.checked = !active;
  elements.modePlan.disabled = !canChange;
  elements.modeNormal.disabled = !canChange;
  elements.modeBanner.hidden = !active;
  elements.modeBanner.replaceChildren();
  if (!active || !planMode) return;
  const status = document.createElement("span");
  status.textContent = "◇ PLAN MODE";
  const path = document.createElement("code");
  path.textContent = planMode.planFilePath;
  elements.modeBanner.append(status, path);
}

export function renderContextMeter(): void {
  const session = state.session;
  const config = state.config;
  const tokens = session?.contextTokens
    ?? session?.messages.reduce((largest, message) => Math.max(largest, message.usage?.input ?? 0), 0)
    ?? 0;
  const activeModel = config?.models.find((model) =>
    model.key === (session ? effectiveModelKey(session, config) : config.defaultModel));
  const limit = activeModel?.compactTokens ?? 200_000;
  const ratio = tokens / limit;
  const level = ratio < .5 ? "green" : ratio <= .75 ? "yellow" : "red";
  elements.contextMeter.classList.remove("context-green", "context-yellow", "context-red");
  elements.contextMeter.classList.add(`context-${level}`);
  elements.contextMeterBar.style.width = `${Math.min(100, ratio * 100)}%`;
  elements.contextMeterValue.textContent = `${formatTokenCountInThousands(tokens)}k`;
  elements.contextMeter.title = `${tokens.toLocaleString()} cached + uncached input tokens`
    + (activeModel?.compactTokens ? ` · auto-compacts at ${activeModel.compactTokens.toLocaleString()}` : "");
}

export function setBusy(busy: boolean): void {
  state.streaming = busy;
  if (!busy) state.aborting = false;
  elements.queue.hidden = true;
  elements.submit.classList.remove("stop");
  elements.submit.querySelector("span")!.textContent = busy ? "WAIT" : "SEND";
  elements.prompt.disabled = busy;
  renderModelStatus();
  renderPlanMode();
}
