interface TokenUsage { input: number; output: number }
type ToolStatus = "queued" | "running" | "complete" | "error" | "timed_out";
interface ToolCall { id: string; name: string; input: Record<string, unknown>; status: ToolStatus; output: string; startedAt?: string; completedAt?: string; durationMs?: number; exitCode?: number | null; workingDirectory?: string; timeoutMs?: number }
interface Message { id: string; role: "user" | "assistant"; content: string; thinking?: string; thinkingSignature?: string; streamingThinking?: boolean; createdAt: string; status: "streaming" | "complete" | "error"; kind?: "chat" | "command" | "fork-banner" | "compact-banner" | "tool-result"; sourceSessionId?: string; forkedSessionId?: string; usage?: TokenUsage; toolCalls?: ToolCall[]; toolUseId?: string; toolError?: boolean }
interface SessionCompaction { summary: string; throughMessageId: string; createdAt: string; coveredMessageCount: number }
interface Session { id: string; title: string; createdAt: string; updatedAt: string; messages: Message[]; compaction?: SessionCompaction; directories?: string[] }
interface Summary { id: string; title: string; updatedAt: string; messageCount: number; preview: string }
interface Config { provider: string; model: string; mode: "live" }
interface CommandDefinition { name: "/add-dir" | "/context" | "/clear" | "/compact" | "/fork" | "/name"; description: string }
interface MarkdownRenderer { render(source: string): string }
declare const markdownit: (options: { html: boolean; linkify: boolean; breaks: boolean; typographer: boolean }) => MarkdownRenderer;

const commands: CommandDefinition[] = [
  { name: "/add-dir", description: "Add a working directory for this session" },
  { name: "/context", description: "Show token usage for the current model context" },
  { name: "/clear", description: "Erase this session's conversation and model context" },
  { name: "/compact", description: "Summarize model context while keeping the full transcript" },
  { name: "/fork", description: "Fork this session with its complete history" },
  { name: "/name", description: "Generate a session name, or pass a title" },
];
const markdown = markdownit({ html: false, linkify: true, breaks: false, typographer: false });
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

  const commandName = content.split(/\s+/, 1)[0]?.toLowerCase();
  if (commands.some((command) => command.name === commandName)) {
    return runCommand(content);
  }

  elements.prompt.value = "";
  hideCommandMenu();
  resetPromptHistory();
  resizePrompt();
  setStreaming(true);
  scrollToBottom(false);
  state.controller = new AbortController();
  let assistantElement: HTMLElement | null = null;
  let assistantMessage: Message | null = null;
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
        assistantMessage = payload.assistantMessage;
        assistantElement = appendMessage(payload.assistantMessage);
        elements.emptyState.hidden = true;
        renderHeader();
        appendMessage(payload.userMessage, assistantElement);
      } else if (event === "delta") {
        const message = assistantMessage;
        if (message?.role === "assistant") {
          message.streamingThinking = false;
          message.content += (data as { text: string }).text;
          updateMessage(assistantElement, message);
        }
      } else if (event === "thinking_delta") {
        const message = assistantMessage;
        if (message?.role === "assistant") {
          message.streamingThinking = true;
          message.thinking = (message.thinking ?? "") + (data as { thinking: string }).thinking;
          updateMessage(assistantElement, message);
        }
      } else if (event === "assistant_complete") {
        const message = (data as { message: Message }).message;
        assistantMessage = message;
        const index = session.messages.findIndex((candidate) => candidate.id === message.id);
        if (index >= 0) session.messages[index] = message;
        updateMessage(assistantElement, message);
      } else if (event === "tool_update") {
        applyToolUpdate(session, data as { messageId: string; toolCall: ToolCall });
      } else if (event === "tool_output") {
        applyToolOutput(session, data as { messageId: string; toolUseId: string; chunk: string });
      } else if (event === "continuation") {
        assistantMessage = (data as { assistantMessage: Message }).assistantMessage;
        session.messages.push(assistantMessage);
        assistantElement = appendMessage(assistantMessage);
      } else if (event === "done") {
        const payload = data as { message: Message; session: Session };
        state.session = payload.session;
        renderSession();
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

function applyToolUpdate(session: Session, payload: { messageId: string; toolCall: ToolCall }): void {
  const message = session.messages.find((candidate) => candidate.id === payload.messageId);
  if (!message) return;
  const calls = (message.toolCalls ??= []);
  const index = calls.findIndex((call) => call.id === payload.toolCall.id);
  if (index >= 0) calls[index] = payload.toolCall;
  else calls.push(payload.toolCall);
  updateMessage(messageElement(message.id), message);
}

function applyToolOutput(session: Session, payload: { messageId: string; toolUseId: string; chunk: string }): void {
  const message = session.messages.find((candidate) => candidate.id === payload.messageId);
  const call = message?.toolCalls?.find((candidate) => candidate.id === payload.toolUseId);
  if (!message || !call) return;
  call.output += payload.chunk;
  updateMessage(messageElement(message.id), message);
}

function messageElement(messageId: string): HTMLElement | null {
  return [...elements.transcript.querySelectorAll<HTMLElement>(".message")]
    .find((element) => element.dataset.messageId === messageId) ?? null;
}

async function runCommand(command: string): Promise<void> {
  const session = state.session;
  if (!session || state.streaming) return;
  if (command.split(/\s+/, 1)[0]?.toLowerCase() === "/compact") return runCompactCommand(command);
  elements.prompt.value = "";
  hideCommandMenu();
  resetPromptHistory();
  resizePrompt();
  setBusy(true);
  scrollToBottom(false);
  try {
    const result = await api<{ command: "add-dir" | "context" | "clear" | "compact" | "fork" | "name"; session: Session; directory?: string; previousSessionId?: string }>(
      `/api/sessions/${session.id}/commands`,
      { method: "POST", body: JSON.stringify({ command }) },
    );
    state.session = result.session;
    if (result.command === "add-dir") {
      notify(`Directory added · ${result.directory}`);
    } else if (result.command === "clear") {
      notify("Session cleared");
    } else if (result.command === "compact") {
      notify("Context compacted · full history retained");
    } else if (result.command === "fork") {
      history.pushState({}, "", `/s/${result.session.id}`);
      notify(`Session forked · ${result.session.id}`);
    } else if (result.command === "name") {
      notify(`Session named · ${result.session.title}`);
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

async function runCompactCommand(command: string): Promise<void> {
  const session = state.session;
  if (!session || state.streaming) return;
  elements.prompt.value = "";
  hideCommandMenu();
  resetPromptHistory();
  resizePrompt();
  setStreaming(true);
  state.controller = new AbortController();

  const progressMessage: Message = {
    id: `compact-progress-${Date.now()}`,
    role: "assistant",
    content: "Compacting model context…",
    createdAt: new Date().toISOString(),
    status: "streaming",
    kind: "compact-banner",
  };
  session.messages.push(progressMessage);
  const progressElement = appendMessage(progressMessage);
  elements.emptyState.hidden = true;
  scrollToBottom(false);

  let streamError = "";
  try {
    const response = await fetch(`/api/sessions/${session.id}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command }),
      signal: state.controller.signal,
    });
    if (!response.ok) throw new Error(await responseError(response));
    if (!response.body) throw new Error("Server returned no stream");

    await readEventStream(response.body, (event, data) => {
      if (event === "progress") {
        const generatedCharacters = (data as { generatedCharacters: number }).generatedCharacters;
        const generatedTokens = Math.ceil(generatedCharacters / 4);
        progressMessage.content = `Compacting model context… ≈${generatedTokens.toLocaleString()} tokens generated`;
        updateMessage(progressElement, progressMessage);
      } else if (event === "done") {
        state.session = (data as { command: "compact"; session: Session }).session;
        renderSession();
        notify("Context compacted · full history retained");
      } else if (event === "error") {
        streamError = (data as { error: string }).error;
      }
      scrollToBottom();
    });
    if (streamError) throw new Error(streamError);
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
  for (const message of session.messages) {
    if (message.kind !== "tool-result") appendMessage(message);
  }
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
    const item = document.createElement("div");
    item.className = "session-item";
    item.classList.toggle("active", summary.id === state.session?.id);
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "session-item-open";
    openButton.innerHTML = `<span class="session-item-title"></span><span class="session-item-meta"><span></span><span></span></span>`;
    requiredWithin(openButton, ".session-item-title").textContent = summary.title;
    const meta = openButton.querySelectorAll(".session-item-meta span");
    if (meta[0]) meta[0].textContent = `${summary.messageCount} msg`;
    if (meta[1]) meta[1].textContent = relativeTime(summary.updatedAt);
    openButton.addEventListener("click", () => {
      if (summary.id === state.session?.id) return document.body.classList.remove("sidebar-open");
      history.pushState({}, "", `/s/${summary.id}`);
      void loadSession(summary.id);
    });
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "session-delete";
    deleteButton.textContent = "DEL";
    deleteButton.setAttribute("aria-label", `Delete session ${summary.title}`);
    deleteButton.addEventListener("click", () => void deleteSession(summary));
    item.append(openButton, deleteButton);
    elements.sessionList.append(item);
  }
}

async function deleteSession(summary: Summary): Promise<void> {
  if (state.streaming) return notify("Wait for the current response to finish");
  if (!window.confirm(`Delete session “${summary.title}”? This cannot be undone.`)) return;
  const deletingCurrentSession = summary.id === state.session?.id;
  try {
    await api<{ deletedSessionId: string }>(`/api/sessions/${summary.id}`, { method: "DELETE" });
    await loadSessionList();
    if (deletingCurrentSession) {
      const nextSession = summaries[0];
      if (nextSession) {
        history.replaceState({}, "", `/s/${nextSession.id}`);
        await loadSession(nextSession.id);
      } else {
        await createSession(true);
      }
    }
    notify(`Session deleted · ${summary.title}`);
  } catch (error) {
    notify(messageFrom(error));
  }
}

function appendMessage(message: Message, before: HTMLElement | null = null): HTMLElement {
  const article = document.createElement("article");
  const messageClass = message.kind === "command"
    ? " command-message"
    : message.kind === "fork-banner"
      ? " fork-banner"
      : message.kind === "compact-banner"
        ? " compact-banner"
        : "";
  article.className = `message ${message.role}${messageClass}`;
  article.dataset.messageId = message.id;
  article.innerHTML = `
    <div class="message-rail"><span class="role-glyph"></span><span class="rail-line"></span></div>
    <div class="message-main">
      <header><span class="role-name"></span><span class="message-time"></span><span class="message-usage"></span></header>
      <details class="message-thinking"><summary><span>Thinking</span><span class="thinking-status"></span></summary><div class="thinking-content"></div></details>
      <div class="message-content"></div>
      <div class="message-tools"></div>
    </div>`;
  if (before) elements.transcript.insertBefore(article, before);
  else elements.transcript.append(article);
  updateMessage(article, message);
  return article;
}

function updateMessage(element: HTMLElement | null, message: Message): void {
  if (!element) return;
  const wasStreaming = element.classList.contains("streaming");
  element.classList.toggle("streaming", message.status === "streaming");
  element.classList.toggle("error", message.status === "error");
  requiredWithin(element, ".role-glyph").textContent = message.role === "user" ? ">" : "●";
  requiredWithin(element, ".role-name").textContent = message.role === "user" ? "" : "agent";
  requiredWithin(element, ".message-time").textContent = formatTime(message.createdAt);
  requiredWithin(element, ".message-usage").textContent = message.usage ? `${message.usage.input} in / ${message.usage.output} out` : "";
  const content = requiredWithin(element, ".message-content");
  const thinking = requiredWithin(element, ".message-thinking") as HTMLDetailsElement;
  const thinkingContent = requiredWithin(thinking, ".thinking-content");
  const thinkingStatus = requiredWithin(thinking, ".thinking-status");
  renderToolCalls(requiredWithin(element, ".message-tools"), message.toolCalls ?? []);
  const hasThinking = Boolean(message.thinking);
  thinking.hidden = !hasThinking;
  if (hasThinking) {
    const wasOpen = thinking.open;
    thinkingContent.innerHTML = markdown.render(message.thinking ?? "")
      + (message.status === "streaming" && message.streamingThinking ? '<span class="cursor-block"></span>' : "");
    thinking.open = message.status === "streaming" ? true : wasStreaming ? false : wasOpen;
    const thinkingTokens = Math.ceil((message.thinking?.length ?? 0) / 4).toLocaleString();
    thinkingStatus.textContent = message.status === "streaming"
      ? `≈${thinkingTokens} tokens · streaming`
      : `≈${thinkingTokens} tokens · click to expand`;
  }
  if (message.kind === "fork-banner") {
    const linkedSessionId = message.sourceSessionId ?? message.forkedSessionId;
    const label = message.sourceSessionId ? "Forked from session: " : "Forked to session: ";
    content.replaceChildren(document.createTextNode(label));
    if (linkedSessionId) {
      const link = document.createElement("a");
      link.href = `/s/${linkedSessionId}`;
      link.textContent = linkedSessionId;
      content.append(link);
    } else {
      content.replaceChildren(document.createTextNode(message.content));
    }
    return;
  }
  if (message.kind === "compact-banner") {
    content.replaceChildren(document.createTextNode(message.content));
    if (message.status === "streaming") {
      const cursor = document.createElement("span");
      cursor.className = "cursor-block";
      content.append(cursor);
    }
    return;
  }
  content.innerHTML = markdown.render(message.content) + (message.status === "streaming" ? '<span class="cursor-block"></span>' : "");
  content.querySelectorAll<HTMLAnchorElement>("a").forEach((link) => {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  });
}

function renderToolCalls(container: HTMLElement, calls: ToolCall[]): void {
  const openOutputs = new Set(
    [...container.querySelectorAll<HTMLDetailsElement>(".tool-output-details[open]")]
      .map((details) => details.dataset.toolUseId)
      .filter((id): id is string => Boolean(id)),
  );
  container.replaceChildren();
  container.hidden = calls.length === 0;
  for (const call of calls) {
    const card = document.createElement("section");
    card.className = `tool-call ${call.status}`;
    card.dataset.toolUseId = call.id;

    const header = document.createElement("div");
    header.className = "tool-call-header";
    const name = document.createElement("strong");
    name.textContent = call.name;
    const status = document.createElement("span");
    status.className = "tool-call-status";
    status.textContent = toolStatusLabel(call);
    header.append(name, status);

    const command = document.createElement("code");
    command.className = "tool-command";
    command.textContent = typeof call.input.command === "string" ? call.input.command : "Preparing tool input…";
    card.append(header, command);

    const metadata = toolMetadata(call);
    if (metadata) {
      const meta = document.createElement("div");
      meta.className = "tool-call-meta";
      meta.textContent = metadata;
      card.append(meta);
    }
    if (call.output) {
      const details = document.createElement("details");
      details.className = "tool-output-details";
      details.dataset.toolUseId = call.id;
      details.open = openOutputs.has(call.id);
      const summary = document.createElement("summary");
      const lineCount = call.output.split("\n").length;
      summary.textContent = `Output · ${lineCount.toLocaleString()} ${lineCount === 1 ? "line" : "lines"}`;
      const output = document.createElement("pre");
      output.className = "tool-output";
      output.textContent = call.output;
      details.append(summary, output);
      card.append(details);
    }
    container.append(card);
  }
}

function toolStatusLabel(call: ToolCall): string {
  if (call.status === "running") return "RUNNING…";
  if (call.status === "timed_out") return "TIMED OUT";
  if (call.status === "complete") return "COMPLETE";
  if (call.status === "error") return "FAILED";
  return "QUEUED";
}

function toolMetadata(call: ToolCall): string {
  const values: string[] = [];
  if (call.workingDirectory) values.push(call.workingDirectory);
  if (call.timeoutMs !== undefined) values.push(`timeout ${formatDuration(call.timeoutMs)}`);
  if (call.durationMs !== undefined) values.push(`ran ${formatDuration(call.durationMs)}`);
  if (call.exitCode !== undefined && call.exitCode !== null) values.push(`exit ${call.exitCode}`);
  return values.join(" · ");
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 1000 ? `${milliseconds}ms` : `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
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
  if (!/^\/[a-z-]*$/.test(value)) return hideCommandMenu();
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
  elements.prompt.value = command.name === "/add-dir" ? `${command.name} ` : command.name;
  hideCommandMenu();
  resizePrompt();
  if (execute && command.name !== "/add-dir") elements.composer.requestSubmit();
  else elements.prompt.focus();
}

function hideCommandMenu(): void {
  matchingCommands = [];
  selectedCommand = 0;
  elements.commandMenu.hidden = true;
}

function sessionPromptHistory(): string[] {
  if (!state.session) return [];
  return state.session.messages
    .filter((message) => message.role === "user" && message.kind !== "tool-result")
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
