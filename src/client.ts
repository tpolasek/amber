interface TokenUsage { input: number; output: number }
interface Message { id: string; role: "user" | "assistant"; content: string; createdAt: string; status: "streaming" | "complete" | "error"; kind?: "chat" | "command"; usage?: TokenUsage }
interface Session { id: string; title: string; createdAt: string; updatedAt: string; messages: Message[] }
interface Summary { id: string; title: string; updatedAt: string; messageCount: number; preview: string }
interface Config { provider: string; model: string; mode: "live" }
interface CommandDefinition { name: "/context" | "/clear"; description: string }

const commands: CommandDefinition[] = [
  { name: "/context", description: "Show token usage for the current model context" },
  { name: "/clear", description: "Clear context and create a numbered session revision" },
];
const SESSION_ROUTE = /^\/s\/([a-z0-9.-]+)$/;
let matchingCommands: CommandDefinition[] = [];
let selectedCommand = 0;
let historyPosition = -1;
let historyDraft = "";
let historyMatches: string[] = [];
let selectedHistoryMatch = 0;

const state: { session: Session | null; config: Config | null; streaming: boolean; controller: AbortController | null } = {
  session: null,
  config: null,
  streaming: false,
  controller: null,
};

const elements = {
  app: required<HTMLElement>("app"),
  terminal: required<HTMLElement>("terminal"),
  sessionList: required<HTMLElement>("session-list"),
  transcript: required<HTMLElement>("transcript"),
  emptyState: required<HTMLElement>("empty-state"),
  composer: required<HTMLFormElement>("composer"),
  commandMenu: required<HTMLElement>("command-menu"),
  historySearch: required<HTMLElement>("history-search"),
  historyQuery: required<HTMLInputElement>("history-query"),
  historyResults: required<HTMLElement>("history-results"),
  prompt: required<HTMLTextAreaElement>("prompt"),
  submit: required<HTMLButtonElement>("submit-button"),
  newSession: required<HTMLButtonElement>("new-session"),
  toggleSidebar: required<HTMLButtonElement>("toggle-sidebar"),
  closeSidebar: required<HTMLButtonElement>("close-sidebar"),
  sessionTitle: required<HTMLElement>("session-title"),
  sessionId: required<HTMLElement>("session-id"),
  provider: required<HTMLElement>("provider-label"),
  providerDot: required<HTMLElement>("provider-dot"),
  modeBanner: required<HTMLElement>("mode-banner"),
  toast: required<HTMLElement>("toast"),
};

void initialize();

async function initialize(): Promise<void> {
  wireEvents();
  try {
    state.config = await api<Config>("/api/config");
    renderConfig();
    await loadSessionList();
    const id = location.pathname.match(SESSION_ROUTE)?.[1];
    if (id) await loadSession(id);
    else await createSession(true);
  } catch (error) {
    notify(messageFrom(error));
  } finally {
    elements.app.classList.remove("booting");
  }
}

function wireEvents(): void {
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r"
      && document.activeElement !== elements.prompt && document.activeElement !== elements.historyQuery) {
      event.preventDefault();
      openHistorySearch();
    }
  });
  elements.newSession.addEventListener("click", () => void createSession(false));
  elements.toggleSidebar.addEventListener("click", () => document.body.classList.add("sidebar-open"));
  elements.closeSidebar.addEventListener("click", () => document.body.classList.remove("sidebar-open"));
  elements.composer.addEventListener("submit", (event) => {
    event.preventDefault();
    if (state.streaming) state.controller?.abort();
    else void sendMessage();
  });
  elements.prompt.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r") {
      event.preventDefault();
      openHistorySearch();
      return;
    }
    if (!elements.commandMenu.hidden) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        selectedCommand = (selectedCommand + direction + matchingCommands.length) % matchingCommands.length;
        renderCommandMenu();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        hideCommandMenu();
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && matchingCommands[selectedCommand]) {
        event.preventDefault();
        selectCommand(matchingCommands[selectedCommand]!, event.key === "Enter");
        return;
      }
    }
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
      const direction = event.key === "ArrowUp" ? -1 : 1;
      if (navigatePromptHistory(direction)) {
        event.preventDefault();
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      elements.composer.requestSubmit();
    }
  });
  elements.prompt.addEventListener("input", () => {
    historyPosition = -1;
    resizePrompt();
    updateCommandMenu();
  });
  elements.historyQuery.addEventListener("input", updateHistorySearch);
  elements.historyQuery.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r") {
      event.preventDefault();
      moveHistorySelection(1);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveHistorySelection(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      acceptHistoryMatch();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeHistorySearch(true);
    }
  });
  document.querySelectorAll<HTMLButtonElement>("[data-prompt]").forEach((button) => {
    button.addEventListener("click", () => {
      elements.prompt.value = button.dataset.prompt ?? "";
      resizePrompt();
      elements.prompt.focus();
    });
  });
  window.addEventListener("popstate", () => {
    const id = location.pathname.match(SESSION_ROUTE)?.[1];
    if (id) void loadSession(id);
  });
}

async function createSession(replace: boolean): Promise<void> {
  if (state.streaming) return;
  const { session } = await api<{ session: Session }>("/api/sessions", { method: "POST" });
  state.session = session;
  history[replace ? "replaceState" : "pushState"]({}, "", `/s/${session.id}`);
  renderSession();
  await loadSessionList();
  elements.prompt.focus();
  document.body.classList.remove("sidebar-open");
}

async function loadSession(id: string): Promise<void> {
  if (state.streaming) return;
  const { session } = await api<{ session: Session }>(`/api/sessions/${id}`);
  state.session = session;
  renderSession();
  renderSessionList();
  document.body.classList.remove("sidebar-open");
}

let summaries: Summary[] = [];
async function loadSessionList(): Promise<void> {
  const response = await api<{ sessions: Summary[] }>("/api/sessions");
  summaries = response.sessions;
  renderSessionList();
}

async function sendMessage(): Promise<void> {
  const session = state.session;
  const content = elements.prompt.value.trim();
  if (!session || !content || state.streaming) return;

  if (commands.some((command) => command.name === content.toLowerCase())) {
    return runCommand(content.toLowerCase() as CommandDefinition["name"]);
  }

  elements.prompt.value = "";
  hideCommandMenu();
  resetPromptHistory();
  resizePrompt();
  setStreaming(true);
  scrollToBottom(false);
  state.controller = new AbortController();
  let assistantElement: HTMLElement | null = null;
  try {
    const response = await fetch(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
      signal: state.controller.signal,
    });
    if (!response.ok) throw new Error(await responseError(response));
    if (!response.body) throw new Error("Server returned no stream");

    await readEventStream(response.body, (event, data) => {
      if (event === "start") {
        const payload = data as { userMessage: Message; assistantMessage: Message };
        session.messages.push(payload.userMessage, payload.assistantMessage);
        assistantElement = appendMessage(payload.assistantMessage);
        elements.emptyState.hidden = true;
        renderHeader();
        appendMessage(payload.userMessage, assistantElement);
      } else if (event === "delta") {
        const message = session.messages.at(-1);
        if (message?.role === "assistant") {
          message.content += (data as { text: string }).text;
          updateMessage(assistantElement, message);
        }
      } else if (event === "done") {
        const payload = data as { message: Message; session: Session };
        state.session = payload.session;
        updateMessage(assistantElement, payload.message);
      } else if (event === "error") {
        const payload = data as { error: string; message?: Message };
        if (payload.message) updateMessage(assistantElement, payload.message);
        notify(payload.error);
      }
      scrollToBottom();
    });
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) notify(messageFrom(error));
    await refreshCurrentSession();
  } finally {
    state.controller = null;
    setStreaming(false);
    await loadSessionList();
    elements.prompt.focus();
  }
}

async function runCommand(command: CommandDefinition["name"]): Promise<void> {
  const session = state.session;
  if (!session || state.streaming) return;
  elements.prompt.value = "";
  hideCommandMenu();
  resetPromptHistory();
  resizePrompt();
  setBusy(true);
  scrollToBottom(false);
  try {
    const result = await api<{ command: "context" | "clear"; session: Session; previousSessionId?: string }>(
      `/api/sessions/${session.id}/commands`,
      { method: "POST", body: JSON.stringify({ command }) },
    );
    state.session = result.session;
    if (result.command === "clear") {
      history.pushState({}, "", `/s/${result.session.id}`);
      notify(`Context cleared · ${result.session.id}`);
    }
    renderSession();
    scrollToBottom(false);
    await loadSessionList();
  } catch (error) {
    notify(messageFrom(error));
  } finally {
    setBusy(false);
    elements.prompt.focus();
  }
}

function renderConfig(): void {
  if (!state.config) return;
  elements.provider.textContent = `${state.config.provider} · ${state.config.model}`;
  elements.providerDot.classList.remove("demo");
  elements.modeBanner.hidden = true;
}

function renderSession(): void {
  elements.transcript.querySelectorAll(".message").forEach((element) => element.remove());
  const session = state.session;
  if (!session) return;
  elements.emptyState.hidden = session.messages.length > 0;
  for (const message of session.messages) appendMessage(message);
  resetPromptHistory();
  closeHistorySearch(false);
  renderHeader();
  scrollToBottom(false);
}

function renderHeader(): void {
  if (!state.session) return;
  elements.sessionTitle.textContent = state.session.title;
  elements.sessionId.textContent = state.session.id.slice(0, 8);
  document.title = `${state.session.title} · AMBER`;
}

function renderSessionList(): void {
  elements.sessionList.replaceChildren();
  for (const summary of summaries) {
    const button = document.createElement("button");
    button.className = "session-item";
    button.classList.toggle("active", summary.id === state.session?.id);
    button.innerHTML = `<span class="session-item-title"></span><span class="session-item-meta"><span></span><span></span></span>`;
    requiredWithin(button, ".session-item-title").textContent = summary.title;
    const meta = button.querySelectorAll(".session-item-meta span");
    if (meta[0]) meta[0].textContent = `${summary.messageCount} msg`;
    if (meta[1]) meta[1].textContent = relativeTime(summary.updatedAt);
    button.addEventListener("click", () => {
      if (summary.id === state.session?.id) return document.body.classList.remove("sidebar-open");
      history.pushState({}, "", `/s/${summary.id}`);
      void loadSession(summary.id);
    });
    elements.sessionList.append(button);
  }
}

function appendMessage(message: Message, before: HTMLElement | null = null): HTMLElement {
  const article = document.createElement("article");
  article.className = `message ${message.role}${message.kind === "command" ? " command-message" : ""}`;
  article.dataset.messageId = message.id;
  article.innerHTML = `
    <div class="message-rail"><span class="role-glyph"></span><span class="rail-line"></span></div>
    <div class="message-main">
      <header><span class="role-name"></span><span class="message-time"></span><span class="message-usage"></span></header>
      <div class="message-content"></div>
    </div>`;
  if (before) elements.transcript.insertBefore(article, before);
  else elements.transcript.append(article);
  updateMessage(article, message);
  return article;
}

function updateMessage(element: HTMLElement | null, message: Message): void {
  if (!element) return;
  element.classList.toggle("streaming", message.status === "streaming");
  element.classList.toggle("error", message.status === "error");
  requiredWithin(element, ".role-glyph").textContent = message.role === "user" ? ">" : "●";
  requiredWithin(element, ".role-name").textContent = message.role === "user" ? "" : "agent";
  requiredWithin(element, ".message-time").textContent = formatTime(message.createdAt);
  requiredWithin(element, ".message-usage").textContent = message.usage ? `${message.usage.input} in / ${message.usage.output} out` : "";
  requiredWithin(element, ".message-content").innerHTML = renderMarkdown(message.content) + (message.status === "streaming" ? '<span class="cursor-block"></span>' : "");
}

async function refreshCurrentSession(): Promise<void> {
  if (!state.session) return;
  try {
    const { session } = await api<{ session: Session }>(`/api/sessions/${state.session.id}`);
    state.session = session;
    renderSession();
  } catch { /* preserve the last visible state */ }
}

function setStreaming(streaming: boolean): void {
  state.streaming = streaming;
  elements.submit.classList.toggle("stop", streaming);
  elements.submit.querySelector("span")!.textContent = streaming ? "STOP" : "SEND";
  elements.prompt.disabled = streaming;
}

function setBusy(busy: boolean): void {
  state.streaming = busy;
  elements.submit.classList.remove("stop");
  elements.submit.querySelector("span")!.textContent = busy ? "WAIT" : "SEND";
  elements.prompt.disabled = busy;
}

async function readEventStream(stream: ReadableStream<Uint8Array>, onEvent: (event: string, data: unknown) => void): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      let event = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data) onEvent(event, JSON.parse(data));
    }
  }
}

function renderMarkdown(source: string): string {
  const escaped = escapeHtml(source);
  const blocks = escaped.split(/\n{2,}/).map((block) => {
    if (block.startsWith("```")) {
      const match = block.match(/^```[^\n]*\n?([\s\S]*?)```$/);
      return match ? `<pre><code>${match[1]}</code></pre>` : `<pre><code>${block.slice(3)}</code></pre>`;
    }
    const lines = block.split("\n");
    if (lines.every((line) => /^[-*] /.test(line))) return `<ul>${lines.map((line) => `<li>${inline(line.slice(2))}</li>`).join("")}</ul>`;
    if (/^#{1,3} /.test(lines[0] ?? "")) {
      const level = (lines[0]?.match(/^#+/)?.[0].length ?? 2) + 2;
      return `<h${level}>${inline((lines[0] ?? "").replace(/^#+ /, ""))}</h${level}>${lines.slice(1).map(inline).join("<br>")}`;
    }
    return `<p>${lines.map(inline).join("<br>")}</p>`;
  });
  return blocks.join("");
}

function inline(value: string): string {
  return value
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character] ?? character);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  if (!response.ok) throw new Error(await responseError(response));
  return response.json() as Promise<T>;
}

async function responseError(response: Response): Promise<string> {
  try { return ((await response.json()) as { error?: string }).error ?? `Request failed (${response.status})`; }
  catch { return `Request failed (${response.status})`; }
}

function notify(message: string): void {
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  window.setTimeout(() => elements.toast.classList.remove("visible"), 4200);
}

function resizePrompt(): void {
  elements.prompt.style.height = "auto";
  elements.prompt.style.height = `${Math.min(elements.prompt.scrollHeight, 180)}px`;
}

function updateCommandMenu(): void {
  const value = elements.prompt.value.trim().toLowerCase();
  if (!/^\/[a-z]*$/.test(value)) return hideCommandMenu();
  matchingCommands = commands.filter((command) => command.name.startsWith(value));
  selectedCommand = 0;
  if (matchingCommands.length === 0) return hideCommandMenu();
  renderCommandMenu();
}

function renderCommandMenu(): void {
  elements.commandMenu.replaceChildren();
  matchingCommands.forEach((command, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "command-option";
    button.classList.toggle("selected", index === selectedCommand);
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(index === selectedCommand));
    const name = document.createElement("strong");
    name.textContent = command.name;
    const description = document.createElement("span");
    description.textContent = command.description;
    button.append(name, description);
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => selectCommand(command, true));
    elements.commandMenu.append(button);
  });
  elements.commandMenu.hidden = false;
}

function selectCommand(command: CommandDefinition, execute: boolean): void {
  elements.prompt.value = command.name;
  hideCommandMenu();
  resizePrompt();
  if (execute) elements.composer.requestSubmit();
}

function hideCommandMenu(): void {
  matchingCommands = [];
  selectedCommand = 0;
  elements.commandMenu.hidden = true;
}

function sessionPromptHistory(): string[] {
  if (!state.session) return [];
  return state.session.messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .reverse();
}

function navigatePromptHistory(direction: -1 | 1): boolean {
  if (historyPosition === -1 && elements.prompt.value.includes("\n")) return false;
  const history = sessionPromptHistory();
  if (history.length === 0) return false;
  if (direction === -1) {
    if (historyPosition === -1) historyDraft = elements.prompt.value;
    if (historyPosition >= history.length - 1) return false;
    historyPosition += 1;
    setPromptValue(history[historyPosition] ?? "");
    return true;
  }
  if (historyPosition === -1) return false;
  historyPosition -= 1;
  setPromptValue(historyPosition === -1 ? historyDraft : (history[historyPosition] ?? ""));
  return true;
}

function resetPromptHistory(): void {
  historyPosition = -1;
  historyDraft = "";
}

function openHistorySearch(): void {
  hideCommandMenu();
  if (elements.historySearch.hidden) {
    elements.historySearch.hidden = false;
    elements.historyQuery.value = "";
    selectedHistoryMatch = 0;
    updateHistorySearch();
  } else {
    moveHistorySelection(1);
  }
  elements.historyQuery.focus();
  scrollToBottom(false);
}

function updateHistorySearch(): void {
  const query = elements.historyQuery.value.toLocaleLowerCase();
  historyMatches = sessionPromptHistory().filter((prompt) => prompt.toLocaleLowerCase().includes(query));
  selectedHistoryMatch = Math.min(selectedHistoryMatch, Math.max(0, historyMatches.length - 1));
  renderHistoryResults();
}

function renderHistoryResults(): void {
  elements.historyResults.replaceChildren();
  if (historyMatches.length === 0) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = "no matching prompts";
    elements.historyResults.append(empty);
    return;
  }
  historyMatches.forEach((prompt, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "history-result";
    button.classList.toggle("selected", index === selectedHistoryMatch);
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(index === selectedHistoryMatch));
    button.textContent = prompt.replace(/\s+/g, " ");
    button.title = prompt;
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      selectedHistoryMatch = index;
      acceptHistoryMatch();
    });
    elements.historyResults.append(button);
  });
  elements.historyResults.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
}

function moveHistorySelection(direction: -1 | 1): void {
  if (historyMatches.length === 0) return;
  selectedHistoryMatch = (selectedHistoryMatch + direction + historyMatches.length) % historyMatches.length;
  renderHistoryResults();
}

function acceptHistoryMatch(): void {
  const match = historyMatches[selectedHistoryMatch];
  if (!match) return;
  setPromptValue(match);
  resetPromptHistory();
  closeHistorySearch(true);
}

function closeHistorySearch(focusPrompt: boolean): void {
  elements.historySearch.hidden = true;
  historyMatches = [];
  selectedHistoryMatch = 0;
  if (focusPrompt) elements.prompt.focus();
}

function setPromptValue(value: string): void {
  elements.prompt.value = value;
  resizePrompt();
  elements.prompt.setSelectionRange(value.length, value.length);
}

function scrollToBottom(smooth = true): void {
  requestAnimationFrame(() => {
    elements.terminal.scrollTo({
      top: elements.terminal.scrollHeight,
      behavior: smooth ? "smooth" : "auto",
    });
  });
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function relativeTime(value: string): string {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const unit: Intl.RelativeTimeFormatUnit = Math.abs(seconds) < 60 ? "second" : Math.abs(seconds) < 3600 ? "minute" : Math.abs(seconds) < 86400 ? "hour" : "day";
  const divisor = unit === "second" ? 1 : unit === "minute" ? 60 : unit === "hour" ? 3600 : 86400;
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(Math.round(seconds / divisor), unit);
}

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}

function requiredWithin(parent: ParentNode, selector: string): HTMLElement {
  const element = parent.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}

function messageFrom(error: unknown): string { return error instanceof Error ? error.message : "Something went wrong"; }
