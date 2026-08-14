import { StreamingThinkingReveal } from "./streaming-thinking.js";
import {
  compactHeaderPath,
  formatDuration,
  formatTime,
  formatTokenCountInThousands,
  messageFrom,
  relativeTime,
  taskRuntime,
} from "./client-formatters.js";
import {
  diffLineClass,
  diffSummary,
  isDiffOutput,
  shouldExpandToolOutput,
  shouldInlineToolSubject,
  shouldRenderToolOutput,
  toolMetadata,
  toolStatusLabel,
  toolSubject,
} from "./tool-display.js";

interface TokenUsage { input: number; output: number }
type ToolStatus = "queued" | "running" | "complete" | "error" | "timed_out";
interface ToolStatusDisplay { text: string; appendElapsed?: boolean }
interface ToolCall { id: string; name: string; input: Record<string, unknown>; status: ToolStatus; output: string; startedAt?: string; completedAt?: string; durationMs?: number; exitCode?: number | null; workingDirectory?: string; timeoutMs?: number; filePath?: string; statusDisplay?: ToolStatusDisplay; agentSessionId?: string; agentType?: string }
interface Message { id: string; role: "user" | "assistant"; content: string; thinking?: string; thinkingSignature?: string; streamingThinking?: boolean; createdAt: string; status: "streaming" | "complete" | "error"; kind?: "chat" | "command" | "fork-banner" | "agent-banner" | "compact-banner" | "tool-result"; sourceSessionId?: string; forkedSessionId?: string; usage?: TokenUsage; toolCalls?: ToolCall[]; toolUseId?: string; toolError?: boolean }
interface SessionCompaction { summary: string; throughMessageId: string; createdAt: string; coveredMessageCount: number }
type PlanningTaskStatus = "pending" | "in_progress" | "completed";
interface PlanningTask { id: string; subject: string; description: string; activeForm: string; status: PlanningTaskStatus; owner: string; blocks: string[]; blockedBy: string[]; metadata: Record<string, unknown> }
interface Session { id: string; title: string; createdAt: string; updatedAt: string; messages: Message[]; compaction?: SessionCompaction; directories?: string[]; cwd?: string; addDirInitialized?: boolean; parentSessionId?: string; agentType?: string; agentDescription?: string; agentStatus?: "running" | "complete" | "error"; planningTasks?: PlanningTask[]; planningTaskArchiveHighWaterMark?: number; contextTokens?: number; planMode?: SessionPlanMode }
interface Summary { id: string; title: string; updatedAt: string; messageCount: number; preview: string }
interface Config { provider: string; model: string; mode: "live"; homeDirectory: string; workspaceRoot: string }
interface BackgroundTask { id: string; type: "local_bash"; command: string; description: string; workingDirectory: string; status: "running" | "completed" | "failed" | "timed_out" | "killed"; stdout: string; stderr: string; exitCode: number | null; startedAt: string; completedAt?: string; durationMs?: number }
interface AskUserQuestionOption { label: string; description: string; preview?: string }
interface AskUserQuestion { question: string; header: string; options: AskUserQuestionOption[]; multiSelect: boolean }
interface AskUserQuestionRequest { toolUseId: string; questions: AskUserQuestion[] }
interface SessionPlanMode { active: boolean; planFilePath: string }
interface AllowedPlanPrompt { tool: "Bash"; prompt: string }
type PlanModeRequest =
  | { toolUseId: string; kind: "enter" }
  | { toolUseId: string; kind: "exit"; plan: string; planFilePath: string; allowedPrompts: AllowedPlanPrompt[] };
interface QuestionSelection { labels: Set<string>; other: string; otherSelected: boolean; focusIndex: number }
interface CommandDefinition { name: "/add-dir" | "/cwd" | "/context" | "/clear" | "/compact" | "/fork" | "/name" | "/tasks"; description: string }
interface DirectoryCompletion { value: string; absolutePath: string }
interface MarkdownRenderer { render(source: string): string }
declare const markdownit: (options: { html: boolean; linkify: boolean; breaks: boolean; typographer: boolean }) => MarkdownRenderer;

const commands: CommandDefinition[] = [
  { name: "/add-dir", description: "Add a working directory for this session" },
  { name: "/cwd", description: "Show or change the current working directory" },
  { name: "/context", description: "Show token usage for the current model context" },
  { name: "/clear", description: "Erase this session's conversation and model context" },
  { name: "/compact", description: "Summarize model context while keeping the full transcript" },
  { name: "/fork", description: "Fork this session with its complete history" },
  { name: "/name", description: "Generate a session name, or pass a title" },
  { name: "/tasks", description: "List and manage background tasks" },
];
const markdown = markdownit({ html: false, linkify: true, breaks: false, typographer: false });
const SESSION_ROUTE = /^\/s\/([a-z0-9.-]+)$/;
let matchingCommands: CommandDefinition[] = [];
let selectedCommand = 0;
let directoryCompletions: DirectoryCompletion[] = [];
let directoryCompletionCommand: "/add-dir" | "/cwd" | null = null;
let directoryCompletionRequest = 0;
let historyPosition = -1;
let historyDraft = "";
let historyMatches: string[] = [];
let selectedHistoryMatch = 0;
const toolOutputDisclosurePreferences = new Map<string, boolean>();
const streamingThinkingReveals = new WeakMap<HTMLElement, StreamingThinkingReveal>();
let tasksDialogTasks: BackgroundTask[] = [];
let tasksDialogSelection = 0;
let tasksDialogDetailId: string | null = null;
let tasksDialogSkippedList = false;
let tasksDialogPollTimer: number | undefined;
let sessionDialogSelection = 0;
let sessionDialogQuery = "";
let sessionDialogReturnsToLanding = false;
let newSessionReplace = false;
let newSessionCreating = false;
let newSessionReturnsToLanding = false;
let newSessionCompletions: DirectoryCompletion[] = [];
let newSessionCompletionSelection = 0;
let newSessionCompletionRequest = 0;
let questionRequest: AskUserQuestionRequest | null = null;
let questionIndex = 0;
let questionSelections = new Map<string, QuestionSelection>();
let questionSubmitting = false;
let planModeRequest: PlanModeRequest | null = null;
let planModeSubmitting = false;
let agentSessionPollTimer: number | undefined;
let agentSessionRefreshPending = false;

const state: { session: Session | null; config: Config | null; streaming: boolean; aborting: boolean; controller: AbortController | null } = {
  session: null,
  config: null,
  streaming: false,
  aborting: false,
  controller: null,
};

const elements = {
  app: required<HTMLElement>("app"),
  terminal: required<HTMLElement>("terminal"),
  sessionList: required<HTMLElement>("session-list"),
  planningTaskList: required<HTMLElement>("planning-task-list"),
  transcript: required<HTMLElement>("transcript"),
  emptyState: required<HTMLElement>("empty-state"),
  composer: required<HTMLFormElement>("composer"),
  composerShell: required<HTMLElement>("composer-shell"),
  commandMenu: required<HTMLElement>("command-menu"),
  historySearch: required<HTMLElement>("history-search"),
  historyQuery: required<HTMLInputElement>("history-query"),
  historyResults: required<HTMLElement>("history-results"),
  prompt: required<HTMLTextAreaElement>("prompt"),
  submit: required<HTMLButtonElement>("submit-button"),
  newSession: required<HTMLButtonElement>("new-session"),
  selectSession: required<HTMLButtonElement>("select-session"),
  toggleSidebar: required<HTMLButtonElement>("toggle-sidebar"),
  closeSidebar: required<HTMLButtonElement>("close-sidebar"),
  sessionTitle: required<HTMLElement>("session-title"),
  sessionDirectories: required<HTMLElement>("session-directories"),
  model: required<HTMLElement>("model-label"),
  providerDot: required<HTMLElement>("provider-dot"),
  modeBanner: required<HTMLElement>("mode-banner"),
  modePlan: required<HTMLInputElement>("mode-plan"),
  modeNormal: required<HTMLInputElement>("mode-normal"),
  contextMeter: required<HTMLElement>("context-meter"),
  contextMeterBar: required<HTMLElement>("context-meter-bar"),
  contextMeterValue: required<HTMLElement>("context-meter-value"),
  landingDialog: required<HTMLElement>("landing-dialog"),
  landingNewSession: required<HTMLButtonElement>("landing-new-session"),
  landingSelectSession: required<HTMLButtonElement>("landing-select-session"),
  newSessionDialog: required<HTMLElement>("new-session-dialog"),
  newSessionForm: required<HTMLFormElement>("new-session-form"),
  newSessionClose: required<HTMLButtonElement>("new-session-close"),
  newSessionName: required<HTMLInputElement>("new-session-name"),
  newSessionPath: required<HTMLInputElement>("new-session-path"),
  newSessionCompletions: required<HTMLElement>("new-session-completions"),
  newSessionSubmit: required<HTMLButtonElement>("new-session-submit"),
  sessionDialog: required<HTMLElement>("session-dialog"),
  sessionDialogClose: required<HTMLButtonElement>("session-dialog-close"),
  sessionSearch: required<HTMLInputElement>("session-search"),
  tasksDialog: required<HTMLElement>("tasks-dialog"),
  tasksDialogTitle: required<HTMLElement>("tasks-dialog-title"),
  tasksDialogBody: required<HTMLElement>("tasks-dialog-body"),
  tasksDialogHints: required<HTMLElement>("tasks-dialog-hints"),
  tasksBack: required<HTMLButtonElement>("tasks-back"),
  tasksClose: required<HTMLButtonElement>("tasks-close"),
  tasksStop: required<HTMLButtonElement>("tasks-stop"),
  questionDialog: required<HTMLElement>("question-dialog"),
  questionDialogTitle: required<HTMLElement>("question-dialog-title"),
  questionDialogBody: required<HTMLElement>("question-dialog-body"),
  questionDialogHints: required<HTMLElement>("question-dialog-hints"),
  questionClose: required<HTMLButtonElement>("question-close"),
  questionSubmit: required<HTMLButtonElement>("question-submit"),
  planModeDialog: required<HTMLElement>("plan-mode-dialog"),
  planModeDialogTitle: required<HTMLElement>("plan-mode-dialog-title"),
  planModeDialogBody: required<HTMLElement>("plan-mode-dialog-body"),
  planModeDialogHints: required<HTMLElement>("plan-mode-dialog-hints"),
  planModeClose: required<HTMLButtonElement>("plan-mode-close"),
  planModeDecline: required<HTMLButtonElement>("plan-mode-decline"),
  planModeApprove: required<HTMLButtonElement>("plan-mode-approve"),
  toast: required<HTMLElement>("toast"),
};

void initialize();
window.setInterval(updateElapsedToolStatuses, 1_000);

async function initialize(): Promise<void> {
  wireEvents();
  try {
    state.config = await api<Config>("/api/config");
    renderConfig();
    await loadSessionList();
    const id = location.pathname.match(SESSION_ROUTE)?.[1];
    if (id) await loadSession(id);
    else openLandingDialog();
  } catch (error) {
    notify(messageFrom(error));
  } finally {
    elements.app.classList.remove("booting");
  }
}

function wireEvents(): void {
  document.addEventListener("keydown", (event) => {
    if (handlePlanModeDialogKeydown(event)) return;
    if (event.key === "Escape" && state.streaming && !state.session?.parentSessionId) {
      event.preventDefault();
      abortCurrentSession();
      return;
    }
    if (handleNewSessionDialogKeydown(event)) return;
    if (handleQuestionDialogKeydown(event)) return;
    if (handleTasksDialogKeydown(event)) return;
    if (handleSessionDialogKeydown(event)) return;
    if (event.key === "Escape" && !event.defaultPrevented && state.session && !state.session.parentSessionId) {
      event.preventDefault();
      abortCurrentSession();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r"
      && document.activeElement !== elements.prompt && document.activeElement !== elements.historyQuery) {
      event.preventDefault();
      openHistorySearch();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
      event.preventDefault();
      if (elements.landingDialog.hidden) openNewSessionDialog(false);
      else openNewSessionFromLanding();
    }
  });
  elements.landingNewSession.addEventListener("click", openNewSessionFromLanding);
  elements.landingSelectSession.addEventListener("click", () => {
    elements.landingDialog.hidden = true;
    sessionDialogReturnsToLanding = true;
    openSessionDialog();
  });
  elements.newSession.addEventListener("click", () => openNewSessionDialog(false));
  elements.newSessionForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitNewSession();
  });
  elements.newSessionClose.addEventListener("click", closeNewSessionDialog);
  elements.newSessionDialog.addEventListener("click", (event) => {
    if (event.target === elements.newSessionDialog) closeNewSessionDialog();
  });
  elements.newSessionPath.addEventListener("input", () => {
    updateNewSessionSubmitState();
    void updateNewSessionCompletions();
  });
  elements.newSessionPath.addEventListener("keydown", handleNewSessionPathKeydown);
  elements.selectSession.addEventListener("click", () => {
    sessionDialogReturnsToLanding = false;
    openSessionDialog();
  });
  elements.sessionDialogClose.addEventListener("click", closeSessionDialog);
  elements.sessionSearch.addEventListener("input", () => {
    sessionDialogQuery = elements.sessionSearch.value;
    sessionDialogSelection = 0;
    renderSessionList();
  });
  elements.tasksClose.addEventListener("click", closeTasksDialog);
  elements.tasksBack.addEventListener("click", showTasksList);
  elements.tasksStop.addEventListener("click", () => void stopSelectedTask());
  elements.questionClose.addEventListener("click", () => void declineQuestions());
  elements.questionSubmit.addEventListener("click", advanceOrSubmitQuestions);
  elements.modePlan.addEventListener("change", () => {
    if (elements.modePlan.checked) void changePlanMode(true);
  });
  elements.modeNormal.addEventListener("change", () => {
    if (elements.modeNormal.checked) void changePlanMode(false);
  });
  elements.planModeClose.addEventListener("click", () => void cancelPlanModeRequest());
  elements.planModeDecline.addEventListener("click", () => void submitPlanModeDecision(false));
  elements.planModeApprove.addEventListener("click", () => void submitPlanModeDecision(true));
  elements.tasksDialog.addEventListener("click", (event) => {
    if (event.target === elements.tasksDialog) closeTasksDialog();
  });
  elements.sessionDialog.addEventListener("click", (event) => {
    if (event.target === elements.sessionDialog) closeSessionDialog();
  });
  elements.questionDialog.addEventListener("click", (event) => {
    if (event.target === elements.questionDialog) void declineQuestions();
  });
  elements.planModeDialog.addEventListener("click", (event) => {
    if (event.target === elements.planModeDialog) void submitPlanModeDecision(false);
  });
  elements.toggleSidebar.addEventListener("click", () => document.body.classList.add("sidebar-open"));
  elements.closeSidebar.addEventListener("click", () => document.body.classList.remove("sidebar-open"));
  elements.composer.addEventListener("submit", (event) => {
    event.preventDefault();
    if (state.streaming) abortCurrentSession();
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
        const optionCount = directoryCompletions.length || matchingCommands.length;
        selectedCommand = (selectedCommand + direction + optionCount) % optionCount;
        if (directoryCompletions.length) renderDirectoryMenu();
        else renderCommandMenu();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        hideCommandMenu();
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const directory = directoryCompletions[selectedCommand];
        if (directory && directoryCompletionCommand) {
          event.preventDefault();
          acceptDirectoryCompletion(directory);
          return;
        }
        if (matchingCommands[selectedCommand]) {
          event.preventDefault();
          selectCommand(matchingCommands[selectedCommand]!, event.key === "Enter");
          return;
        }
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
  window.addEventListener("popstate", () => {
    const id = location.pathname.match(SESSION_ROUTE)?.[1];
    if (id) void loadSession(id);
    else if (!state.streaming) openLandingDialog();
  });
}

function openLandingDialog(): void {
  if (state.streaming) return;
  state.session = null;
  renderPlanMode();
  sessionDialogReturnsToLanding = false;
  newSessionReturnsToLanding = false;
  elements.newSessionDialog.hidden = true;
  elements.sessionDialog.hidden = true;
  elements.landingDialog.hidden = false;
  syncAgentSessionPolling();
  elements.landingNewSession.focus();
}

function openNewSessionFromLanding(): void {
  elements.landingDialog.hidden = true;
  openNewSessionDialog(true, true);
}

function openNewSessionDialog(replace: boolean, returnToLanding = false): void {
  if (state.streaming) return notify("Wait for the current response to finish");
  newSessionReplace = replace;
  newSessionCreating = false;
  newSessionReturnsToLanding = returnToLanding;
  elements.newSessionName.value = "";
  elements.newSessionPath.value = state.config?.homeDirectory ?? "";
  elements.newSessionClose.hidden = state.session === null && !newSessionReturnsToLanding;
  hideNewSessionCompletions();
  updateNewSessionSubmitState();
  elements.sessionDialog.hidden = true;
  elements.newSessionDialog.hidden = false;
  document.body.classList.remove("sidebar-open");
  elements.newSessionName.focus();
}

function closeNewSessionDialog(): void {
  if (newSessionCreating || (state.session === null && !newSessionReturnsToLanding)) return;
  elements.newSessionDialog.hidden = true;
  hideNewSessionCompletions();
  if (newSessionReturnsToLanding) {
    newSessionReturnsToLanding = false;
    elements.landingDialog.hidden = false;
    return elements.landingNewSession.focus();
  }
  elements.prompt.focus();
}

function handleNewSessionDialogKeydown(event: KeyboardEvent): boolean {
  if (elements.newSessionDialog.hidden) return false;
  if (event.key === "Escape") {
    event.preventDefault();
    closeNewSessionDialog();
  }
  return true;
}

function handleNewSessionPathKeydown(event: KeyboardEvent): void {
  if (elements.newSessionCompletions.hidden) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    event.stopPropagation();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    newSessionCompletionSelection = (newSessionCompletionSelection + direction + newSessionCompletions.length)
      % newSessionCompletions.length;
    renderNewSessionCompletions();
  } else if (event.key === "Enter" || event.key === "Tab") {
    const completion = newSessionCompletions[newSessionCompletionSelection];
    if (!completion) return;
    event.preventDefault();
    event.stopPropagation();
    acceptNewSessionCompletion(completion);
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    hideNewSessionCompletions();
  }
}

async function updateNewSessionCompletions(): Promise<void> {
  const sourceValue = elements.newSessionPath.value;
  const request = ++newSessionCompletionRequest;
  newSessionCompletions = [];
  newSessionCompletionSelection = 0;
  elements.newSessionCompletions.hidden = true;
  if (!sourceValue.trim()) return;
  try {
    const query = new URLSearchParams({ path: sourceValue });
    const result = await api<{ directories: DirectoryCompletion[] }>(`/api/directory-completions?${query}`);
    if (request !== newSessionCompletionRequest || elements.newSessionPath.value !== sourceValue) return;
    newSessionCompletions = result.directories;
    if (newSessionCompletions.length > 0) renderNewSessionCompletions();
  } catch {
    if (request === newSessionCompletionRequest) hideNewSessionCompletions();
  }
}

function renderNewSessionCompletions(): void {
  elements.newSessionCompletions.replaceChildren();
  newSessionCompletions.forEach((directory, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "command-option directory-option";
    button.classList.toggle("selected", index === newSessionCompletionSelection);
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(index === newSessionCompletionSelection));
    const value = document.createElement("strong");
    value.textContent = directory.value;
    const absolutePath = document.createElement("span");
    absolutePath.textContent = directory.absolutePath;
    button.append(value, absolutePath);
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => acceptNewSessionCompletion(directory));
    elements.newSessionCompletions.append(button);
  });
  elements.newSessionCompletions.hidden = false;
  elements.newSessionCompletions.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
}

function acceptNewSessionCompletion(directory: DirectoryCompletion): void {
  elements.newSessionPath.value = directory.value;
  hideNewSessionCompletions();
  updateNewSessionSubmitState();
  elements.newSessionPath.focus();
}

function hideNewSessionCompletions(): void {
  newSessionCompletionRequest += 1;
  newSessionCompletions = [];
  newSessionCompletionSelection = 0;
  elements.newSessionCompletions.replaceChildren();
  elements.newSessionCompletions.hidden = true;
}

function updateNewSessionSubmitState(): void {
  elements.newSessionSubmit.disabled = newSessionCreating || !elements.newSessionPath.value.trim();
}

async function submitNewSession(): Promise<void> {
  if (newSessionCreating) return;
  const path = elements.newSessionPath.value.trim();
  if (!path) {
    notify("A working path is required");
    return elements.newSessionPath.focus();
  }
  newSessionCreating = true;
  updateNewSessionSubmitState();
  try {
    const { session } = await api<{ session: Session }>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ name: elements.newSessionName.value, path }),
    });
    state.session = session;
    history[newSessionReplace ? "replaceState" : "pushState"]({}, "", `/s/${session.id}`);
    newSessionReturnsToLanding = false;
    elements.landingDialog.hidden = true;
    elements.newSessionDialog.hidden = true;
    hideNewSessionCompletions();
    renderSession();
    await loadSessionList();
    elements.prompt.focus();
  } catch (error) {
    notify(messageFrom(error));
  } finally {
    newSessionCreating = false;
    updateNewSessionSubmitState();
  }
}

async function loadSession(id: string): Promise<void> {
  if (state.streaming) return;
  const { session } = await api<{ session: Session }>(`/api/sessions/${id}`);
  state.session = session;
  renderSession();
  renderSessionList();
  document.body.classList.remove("sidebar-open");
}

function syncAgentSessionPolling(): void {
  const session = state.session;
  const shouldPoll = Boolean(session?.parentSessionId)
    && (session!.agentStatus === "running" || session!.messages.some((message) => message.status === "streaming"));
  if (shouldPoll && agentSessionPollTimer === undefined) {
    agentSessionPollTimer = window.setInterval(() => void refreshAgentSession(), 750);
  } else if (!shouldPoll && agentSessionPollTimer !== undefined) {
    window.clearInterval(agentSessionPollTimer);
    agentSessionPollTimer = undefined;
  }
}

async function refreshAgentSession(): Promise<void> {
  const current = state.session;
  if (!current?.parentSessionId || agentSessionRefreshPending) return;
  agentSessionRefreshPending = true;
  try {
    const { session } = await api<{ session: Session }>(`/api/sessions/${current.id}`);
    if (state.session?.id !== current.id) return;
    if (session.updatedAt !== current.updatedAt) {
      const distanceFromBottom = elements.transcript.scrollHeight
        - elements.transcript.scrollTop - elements.transcript.clientHeight;
      state.session = session;
      renderSession();
      if (distanceFromBottom < 80) scrollTranscriptToBottom();
    } else {
      syncAgentSessionPolling();
    }
  } catch {
    // Keep the current snapshot visible during a transient refresh failure.
  } finally {
    agentSessionRefreshPending = false;
  }
}

let summaries: Summary[] = [];
async function loadSessionList(): Promise<void> {
  const response = await api<{ sessions: Summary[] }>("/api/sessions");
  summaries = response.sessions;
  sessionDialogSelection = Math.min(sessionDialogSelection, Math.max(0, filteredSessionSummaries().length - 1));
  renderSessionList();
}

function openSessionDialog(): void {
  sessionDialogQuery = "";
  elements.sessionSearch.value = "";
  const currentIndex = filteredSessionSummaries().findIndex((summary) => summary.id === state.session?.id);
  sessionDialogSelection = currentIndex >= 0 ? currentIndex : 0;
  renderSessionList();
  elements.sessionDialog.hidden = false;
  document.body.classList.remove("sidebar-open");
  elements.sessionList.focus();
  elements.sessionList.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
}

function closeSessionDialog(): void {
  elements.sessionDialog.hidden = true;
  if (sessionDialogReturnsToLanding) {
    sessionDialogReturnsToLanding = false;
    elements.landingDialog.hidden = false;
    return elements.landingSelectSession.focus();
  }
  elements.prompt.focus();
}

async function selectArchivedSession(summary: Summary): Promise<void> {
  if (state.streaming) return notify("Wait for the current response to finish");
  if (summary.id === state.session?.id) return closeSessionDialog();
  history.pushState({}, "", `/s/${summary.id}`);
  try {
    await loadSession(summary.id);
    sessionDialogReturnsToLanding = false;
    elements.landingDialog.hidden = true;
    closeSessionDialog();
  } catch (error) {
    notify(messageFrom(error));
  }
}

function handleSessionDialogKeydown(event: KeyboardEvent): boolean {
  if (elements.sessionDialog.hidden) return false;
  const filtered = filteredSessionSummaries();
  if (event.key === "Escape") {
    event.preventDefault();
    closeSessionDialog();
  } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    event.preventDefault();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    sessionDialogSelection = Math.max(0, Math.min(filtered.length - 1, sessionDialogSelection + direction));
    renderSessionList();
    elements.sessionList.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
  } else if (event.key === "Enter"
    && document.activeElement !== elements.sessionDialogClose
    && !document.activeElement?.classList.contains("session-delete")) {
    const summary = filtered[sessionDialogSelection];
    if (summary) {
      event.preventDefault();
      void selectArchivedSession(summary);
    }
  } else if (document.activeElement !== elements.sessionSearch
    && !event.ctrlKey && !event.metaKey && !event.altKey
    && /^[\p{L}\p{N}]$/u.test(event.key)) {
    event.preventDefault();
    elements.sessionSearch.focus();
    elements.sessionSearch.value += event.key;
    sessionDialogQuery = elements.sessionSearch.value;
    sessionDialogSelection = 0;
    renderSessionList();
  } else if (document.activeElement !== elements.sessionSearch && event.key === "Backspace" && sessionDialogQuery) {
    event.preventDefault();
    elements.sessionSearch.focus();
    elements.sessionSearch.value = sessionDialogQuery.slice(0, -1);
    sessionDialogQuery = elements.sessionSearch.value;
    sessionDialogSelection = 0;
    renderSessionList();
  }
  return true;
}

async function sendMessage(): Promise<void> {
  const session = state.session;
  const content = elements.prompt.value.trim();
  if (!session || !content || state.streaming) return;

  const commandName = content.split(/\s+/, 1)[0]?.toLowerCase();
  if (commands.some((command) => command.name === commandName) || commandName === "/bashes") {
    return runCommand(content);
  }

  elements.prompt.value = "";
  hideCommandMenu();
  resetPromptHistory();
  resizePrompt();
  setStreaming(true);
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
        if (message.usage) session.contextTokens = message.usage.input;
        updateMessage(assistantElement, message);
        renderContextMeter();
      } else if (event === "tool_update") {
        applyToolUpdate(session, data as { messageId: string; toolCall: ToolCall });
      } else if (event === "tool_output") {
        applyToolOutput(session, data as { messageId: string; toolUseId: string; chunk: string });
      } else if (event === "planning_tasks_update") {
        const payload = data as { tasks: PlanningTask[]; archiveHighWaterMark: number };
        session.planningTasks = payload.tasks;
        session.planningTaskArchiveHighWaterMark = payload.archiveHighWaterMark;
        renderPlanningTasks();
      } else if (event === "ask_user_question") {
        openQuestionDialog(data as AskUserQuestionRequest);
      } else if (event === "plan_mode_request") {
        openPlanModeDialog(data as PlanModeRequest);
      } else if (event === "plan_mode_state") {
        session.planMode = (data as { planMode: SessionPlanMode }).planMode;
        renderPlanMode();
      } else if (event === "continuation") {
        assistantMessage = (data as { assistantMessage: Message }).assistantMessage;
        session.messages.push(assistantMessage);
        assistantElement = appendMessage(assistantMessage);
      } else if (event === "session_named") {
        if (state.session?.id === session.id) {
          state.session.title = (data as { title: string }).title;
          renderHeader();
        }
      } else if (event === "done") {
        const payload = data as { message: Message; session: Session };
        state.session = payload.session;
        renderSession();
      } else if (event === "error") {
        const payload = data as { error: string; message?: Message };
        if (payload.message) updateMessage(assistantElement, payload.message);
        notify(payload.error);
      }
      scrollTranscriptToBottom();
    });
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) notify(messageFrom(error));
    await refreshCurrentSession();
  } finally {
    closeQuestionDialog();
    closePlanModeDialog();
    state.controller = null;
    setStreaming(false);
    await loadSessionList();
    elements.prompt.focus();
  }
}

function abortCurrentSession(): void {
  const session = state.session;
  if (!session || session.parentSessionId || state.aborting) return;
  const wasStreaming = state.streaming;
  state.aborting = true;
  void fetch(`/api/sessions/${session.id}/abort`, { method: "POST" })
    .then(async (response) => {
      if (!response.ok) throw new Error(await responseError(response));
      const result = await response.json() as { aborted: boolean };
      if (!result.aborted) state.controller?.abort();
    })
    .catch((error) => {
      state.controller?.abort();
      notify(`Could not stop session: ${messageFrom(error)}`);
    })
    .finally(() => {
      if (!wasStreaming) state.aborting = false;
    });
}

function openQuestionDialog(request: AskUserQuestionRequest): void {
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

function closeQuestionDialog(): void {
  elements.questionDialog.hidden = true;
  questionRequest = null;
  questionSelections.clear();
  questionIndex = 0;
  questionSubmitting = false;
}

function renderQuestionDialog(): void {
  const request = questionRequest;
  const question = request?.questions[questionIndex];
  if (!request || !question) return;
  const selection = questionSelections.get(question.question)!;
  const completeCount = request.questions.filter(questionIsAnswered).length;
  elements.questionDialogTitle.textContent = request.questions.length === 1
    ? "Claude has a question"
    : `Claude has questions · ${completeCount}/${request.questions.length} answered`;
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

function selectQuestionOption(index: number): void {
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

function questionIsAnswered(question: AskUserQuestion): boolean {
  const selection = questionSelections.get(question.question);
  if (!selection || (selection.otherSelected && !selection.other.trim())) return false;
  return selection.labels.size > 0 || (selection.otherSelected && Boolean(selection.other.trim()));
}

function updateQuestionActionState(): void {
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
    ? "Claude has a question"
    : `Claude has questions · ${completeCount}/${request.questions.length} answered`;
}

function focusCurrentQuestionOption(): void {
  const question = questionRequest?.questions[questionIndex];
  if (!question) return;
  const selection = questionSelections.get(question.question)!;
  if (selection.focusIndex === question.options.length) {
    elements.questionDialogBody.querySelector<HTMLElement>(".question-other")?.focus();
    return;
  }
  elements.questionDialogBody.querySelectorAll<HTMLButtonElement>(".question-option:not(.question-other)")[selection.focusIndex]?.focus();
}

function focusOtherInput(): void {
  elements.questionDialogBody.querySelector<HTMLInputElement>(".question-other-input")?.focus();
}

function handleQuestionDialogKeydown(event: KeyboardEvent): boolean {
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

function advanceOrSubmitQuestions(): void {
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

async function submitQuestionAnswers(): Promise<void> {
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

async function declineQuestions(): Promise<void> {
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

function openPlanModeDialog(request: PlanModeRequest): void {
  planModeRequest = request;
  planModeSubmitting = false;
  elements.planModeDialog.hidden = false;
  elements.planModeDialogBody.replaceChildren();
  elements.planModeDialogTitle.textContent = request.kind === "enter"
    ? "Enter plan mode?"
    : "Review implementation plan";
  elements.planModeDecline.textContent = request.kind === "enter" ? "DECLINE" : "KEEP PLANNING";
  elements.planModeApprove.textContent = request.kind === "enter" ? "ENTER PLAN MODE" : "APPROVE & IMPLEMENT";
  elements.planModeDialogHints.textContent = request.kind === "enter"
    ? "Ctrl/Cmd+Enter approve · Esc decline"
    : "Feedback enables Keep Planning · Ctrl/Cmd+Enter approve · Esc close and wait";

  if (request.kind === "enter") {
    const content = document.createElement("section");
    content.className = "plan-mode-entry";
    const heading = document.createElement("h2");
    heading.textContent = "Claude wants to plan before making changes";
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

    if (request.allowedPrompts.length > 0) {
      const permissions = document.createElement("section");
      permissions.className = "plan-mode-prompts";
      const title = document.createElement("strong");
      title.textContent = "REQUESTED BASH CATEGORIES · INFORMATIONAL ONLY";
      const list = document.createElement("ul");
      for (const allowed of request.allowedPrompts) {
        const item = document.createElement("li");
        const tool = document.createElement("code");
        tool.textContent = allowed.tool;
        item.append(tool, document.createTextNode(` · ${allowed.prompt}`));
        list.append(item);
      }
      permissions.append(title, list);
      elements.planModeDialogBody.append(permissions);
    }

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

function closePlanModeDialog(): void {
  elements.planModeDialog.hidden = true;
  elements.planModeDialogBody.replaceChildren();
  planModeRequest = null;
  planModeSubmitting = false;
}

function updatePlanModeDialogState(): void {
  const feedback = elements.planModeDialogBody
    .querySelector<HTMLTextAreaElement>("#plan-mode-feedback")?.value.trim() ?? "";
  const feedbackRequired = planModeRequest?.kind === "exit";
  const canKeepPlanning = !feedbackRequired || Boolean(feedback);
  elements.planModeClose.disabled = planModeSubmitting;
  elements.planModeDecline.disabled = planModeSubmitting || !canKeepPlanning;
  elements.planModeDecline.classList.toggle("ready", feedbackRequired && canKeepPlanning && !planModeSubmitting);
  elements.planModeApprove.disabled = planModeSubmitting;
}

async function cancelPlanModeRequest(): Promise<void> {
  const request = planModeRequest;
  if (!request) return;
  await submitPlanModeDecision(false, request.kind === "exit");
}

async function submitPlanModeDecision(approved: boolean, cancelled = false): Promise<void> {
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

function handlePlanModeDialogKeydown(event: KeyboardEvent): boolean {
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
  try {
    const result = await api<{ command: "add-dir" | "cwd" | "context" | "clear" | "compact" | "fork" | "name" | "tasks"; session: Session; directory?: string; cwdChanged?: boolean; previousSessionId?: string; tasks?: BackgroundTask[] }>(
      `/api/sessions/${session.id}/commands`,
      { method: "POST", body: JSON.stringify({ command }) },
    );
    state.session = result.session;
    if (result.command === "add-dir") {
      notify(`${result.cwdChanged ? "Directory added and CWD changed" : "Directory added"} · ${result.directory}`);
    } else if (result.command === "cwd") {
      notify(`CWD · ${result.directory}`);
    } else if (result.command === "clear") {
      notify("Session cleared");
    } else if (result.command === "compact") {
      notify("Context compacted · full history retained");
    } else if (result.command === "fork") {
      history.pushState({}, "", `/s/${result.session.id}`);
      notify(`Session forked · ${result.session.id}`);
    } else if (result.command === "name") {
      notify(`Session named · ${result.session.title}`);
    } else if (result.command === "tasks") {
      openTasksDialog(result.tasks ?? []);
    }
    renderSession();
    await loadSessionList();
  } catch (error) {
    notify(messageFrom(error));
  } finally {
    setBusy(false);
    elements.prompt.focus();
  }
}

function openTasksDialog(tasks: BackgroundTask[]): void {
  tasksDialogTasks = tasks;
  tasksDialogSelection = 0;
  tasksDialogSkippedList = tasks.length === 1;
  tasksDialogDetailId = tasksDialogSkippedList ? tasks[0]?.id ?? null : null;
  elements.tasksDialog.hidden = false;
  renderTasksDialog();
  startTasksDialogPolling();
  elements.tasksClose.focus();
}

function closeTasksDialog(): void {
  elements.tasksDialog.hidden = true;
  tasksDialogTasks = [];
  tasksDialogDetailId = null;
  tasksDialogSkippedList = false;
  if (tasksDialogPollTimer !== undefined) window.clearInterval(tasksDialogPollTimer);
  tasksDialogPollTimer = undefined;
  elements.prompt.focus();
}

function showTasksList(): void {
  if (tasksDialogSkippedList) return closeTasksDialog();
  tasksDialogDetailId = null;
  renderTasksDialog();
}

function startTasksDialogPolling(): void {
  if (tasksDialogPollTimer !== undefined) window.clearInterval(tasksDialogPollTimer);
  tasksDialogPollTimer = window.setInterval(() => void refreshTasksDialog(), 1_000);
}

async function refreshTasksDialog(): Promise<void> {
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

function renderTasksDialog(): void {
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

function renderTaskDetail(task: BackgroundTask): void {
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
  output.textContent = [
    ...(task.stdout ? [task.stdout] : []),
    ...(task.stderr ? [`stderr:\n${task.stderr}`] : []),
  ].join("\n") || "(no output yet)";
  detail.append(outputLabel, output);
  elements.tasksDialogBody.append(detail);
  output.scrollTop = output.scrollHeight;
}

function taskDetailField(label: string, value: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "tasks-detail-field";
  const name = document.createElement("strong");
  name.textContent = `${label}:`;
  const content = document.createElement("span");
  content.textContent = value;
  row.append(name, content);
  return row;
}

async function stopSelectedTask(): Promise<void> {
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

function handleTasksDialogKeydown(event: KeyboardEvent): boolean {
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
  elements.model.textContent = state.config.model;
  elements.providerDot.classList.remove("demo");
  renderPlanMode();
}

function renderSession(): void {
  elements.transcript.querySelectorAll<HTMLElement>(".message").forEach((element) => {
    stopStreamingThinkingReveal(element);
    element.remove();
  });
  const session = state.session;
  if (!session) return;
  elements.composerShell.hidden = Boolean(session.parentSessionId);
  elements.emptyState.hidden = session.messages.length > 0;
  for (const message of session.messages) {
    if (message.kind !== "tool-result") appendMessage(message);
  }
  resetPromptHistory();
  closeHistorySearch(false);
  renderHeader();
  renderPlanMode();
  renderPlanningTasks();
  renderContextMeter();
  syncAgentSessionPolling();
}

function renderPlanMode(): void {
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

async function changePlanMode(active: boolean): Promise<void> {
  const session = state.session;
  if (!session || session.parentSessionId || state.streaming) return renderPlanMode();
  setBusy(true);
  try {
    const result = await api<{ session: Session }>(`/api/sessions/${session.id}/plan-mode`, {
      method: "POST",
      body: JSON.stringify({ active }),
    });
    state.session = result.session;
    renderPlanMode();
    await loadSessionList();
    notify(active ? "Plan mode enabled" : "Normal mode enabled");
  } catch (error) {
    renderPlanMode();
    notify(messageFrom(error));
  } finally {
    setBusy(false);
    elements.prompt.focus();
  }
}

function renderHeader(): void {
  const session = state.session;
  const config = state.config;
  if (!session || !config) return;
  elements.sessionTitle.textContent = session.title;
  elements.sessionTitle.title = session.title;
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

function renderPlanningTasks(): void {
  elements.planningTaskList.replaceChildren();
  const session = state.session;
  const archiveHighWaterMark = session?.planningTaskArchiveHighWaterMark ?? 0;
  const allTasks = (session?.planningTasks ?? [])
    .filter((task) => Number(task.id) > archiveHighWaterMark)
    .sort((left, right) => Number(left.id) - Number(right.id));
  const tasks = allTasks.length > 0 && allTasks.every((task) => task.status === "completed") ? [] : allTasks;
  if (tasks.length === 0) {
    const empty = document.createElement("div");
    empty.className = "planning-task-empty";
    empty.textContent = "No active tasks in this session";
    elements.planningTaskList.append(empty);
    return;
  }
  const completedIds = new Set(allTasks.filter((task) => task.status === "completed").map((task) => task.id));
  for (const task of tasks) {
    const item = document.createElement("div");
    item.className = `planning-task-item ${task.status}`;
    item.title = task.description;
    const marker = document.createElement("span");
    marker.className = "planning-task-marker";
    marker.textContent = task.status === "completed" ? "[✓]" : task.status === "in_progress" ? "[~]" : "[ ]";
    const copy = document.createElement("span");
    copy.className = "planning-task-copy";
    const subject = document.createElement("strong");
    subject.textContent = task.status === "in_progress" ? task.activeForm : task.subject;
    const meta = document.createElement("small");
    const status = task.status.replace("_", " ");
    const activeBlockers = task.blockedBy.filter((id) => !completedIds.has(id));
    const blockedBy = activeBlockers.length > 0 ? ` · blocked by ${activeBlockers.map((id) => `#${id}`).join(", ")}` : "";
    const owner = task.owner ? ` · ${task.owner}` : "";
    meta.textContent = `#${task.id} · ${status}${blockedBy}${owner}`;
    copy.append(subject, meta);
    item.append(marker, copy);
    elements.planningTaskList.append(item);
  }
}

function renderContextMeter(): void {
  const session = state.session;
  const tokens = session?.contextTokens
    ?? session?.messages.reduce((largest, message) => Math.max(largest, message.usage?.input ?? 0), 0)
    ?? 0;
  const level = tokens < 100_000 ? "green" : tokens <= 150_000 ? "yellow" : "red";
  elements.contextMeter.classList.remove("context-green", "context-yellow", "context-red");
  elements.contextMeter.classList.add(`context-${level}`);
  elements.contextMeterBar.style.width = `${Math.min(100, tokens / 2_000)}%`;
  elements.contextMeterValue.textContent = `${formatTokenCountInThousands(tokens)}k`;
  elements.contextMeter.title = `${tokens.toLocaleString()} cached + uncached input tokens`;
}

function renderSessionList(): void {
  elements.sessionList.replaceChildren();
  const filtered = filteredSessionSummaries();
  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "session-archive-empty";
    empty.textContent = sessionDialogQuery.trim() ? "No matching sessions" : "No archived sessions";
    elements.sessionList.append(empty);
    return;
  }
  filtered.forEach((summary, index) => {
    const item = document.createElement("div");
    item.className = "session-item";
    item.classList.toggle("active", summary.id === state.session?.id);
    item.classList.toggle("selected", index === sessionDialogSelection);
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "session-item-open";
    openButton.setAttribute("aria-label", `Open session ${summary.title}`);
    openButton.innerHTML = `<span class="session-item-title"></span><span class="session-item-meta"><span></span><span></span></span>`;
    requiredWithin(openButton, ".session-item-title").textContent = summary.title;
    const meta = openButton.querySelectorAll(".session-item-meta span");
    if (meta[0]) meta[0].textContent = `${summary.messageCount} msg`;
    if (meta[1]) meta[1].textContent = relativeTime(summary.updatedAt);
    openButton.addEventListener("mouseenter", () => {
      if (sessionDialogSelection === index) return;
      sessionDialogSelection = index;
      renderSessionList();
    });
    item.addEventListener("focusin", () => {
      if (sessionDialogSelection === index) return;
      elements.sessionList.querySelector(".session-item.selected")?.classList.remove("selected");
      sessionDialogSelection = index;
      item.classList.add("selected");
    });
    openButton.addEventListener("click", () => void selectArchivedSession(summary));
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "session-delete";
    deleteButton.textContent = "DEL";
    deleteButton.setAttribute("aria-label", `Delete session ${summary.title}`);
    deleteButton.addEventListener("click", () => void deleteSession(summary));
    item.append(openButton, deleteButton);
    elements.sessionList.append(item);
  });
}

function filteredSessionSummaries(): Summary[] {
  const query = sessionDialogQuery.trim().toLocaleLowerCase();
  if (!query) return summaries;
  return summaries.filter((summary) => [summary.title, summary.id, summary.preview, String(summary.messageCount)]
    .some((value) => value.toLocaleLowerCase().includes(query)));
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
        state.session = null;
        history.replaceState({}, "", "/");
        closeSessionDialog();
        openLandingDialog();
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
    : message.kind === "fork-banner" || message.kind === "agent-banner"
      ? " fork-banner"
      : message.kind === "compact-banner"
        ? " compact-banner"
        : "";
  article.className = `message ${message.role}${messageClass}`;
  article.dataset.messageId = message.id;
  article.innerHTML = `
    <div class="message-rail"><span class="role-name"></span><span class="role-glyph"></span><span class="rail-line"></span></div>
    <div class="message-main">
      <header><span class="message-time"></span><span class="message-usage"></span></header>
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
  requiredWithin(element, ".role-glyph").textContent = message.role === "user" ? "◆" : "●";
  requiredWithin(element, ".role-name").textContent = message.role;
  requiredWithin(element, ".message-time").textContent = formatTime(message.createdAt);
  requiredWithin(element, ".message-usage").textContent = message.usage ? `${message.usage.input} in / ${message.usage.output} out` : "";
  const content = requiredWithin(element, ".message-content");
  const thinking = requiredWithin(element, ".message-thinking") as HTMLDetailsElement;
  const thinkingContent = requiredWithin(thinking, ".thinking-content");
  const thinkingLabel = requiredWithin(thinking, "summary span:first-child");
  const thinkingStatus = requiredWithin(thinking, ".thinking-status");
  renderToolCalls(requiredWithin(element, ".message-tools"), message.toolCalls ?? []);
  const hasThinking = Boolean(message.thinking);
  thinking.hidden = !hasThinking;
  if (hasThinking) {
    const wasOpen = thinking.open;
    const activelyThinking = message.status === "streaming" && Boolean(message.streamingThinking);
    thinking.classList.toggle("streaming-thinking", activelyThinking);
    thinkingLabel.textContent = activelyThinking ? "Thinking…" : "Thinking";
    if (activelyThinking) {
      updateStreamingThinkingReveal(element, thinkingContent, message.thinking ?? "");
    } else {
      stopStreamingThinkingReveal(element);
      thinkingContent.innerHTML = markdown.render(message.thinking ?? "");
    }
    thinking.open = activelyThinking ? true : wasStreaming ? false : wasOpen;
    const thinkingTokens = Math.ceil((message.thinking?.length ?? 0) / 4).toLocaleString();
    thinkingStatus.textContent = activelyThinking
      ? `≈${thinkingTokens} tokens · streaming`
      : `≈${thinkingTokens} tokens · click to expand`;
  } else {
    stopStreamingThinkingReveal(element);
  }
  if (message.kind === "fork-banner" || message.kind === "agent-banner") {
    const linkedSessionId = message.sourceSessionId ?? message.forkedSessionId;
    const label = message.kind === "agent-banner"
      ? "Agent sub-session of: "
      : message.sourceSessionId ? "Forked from session: " : "Forked to session: ";
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

function updateStreamingThinkingReveal(element: HTMLElement, container: HTMLElement, thinking: string): void {
  let reveal = streamingThinkingReveals.get(element);
  if (!reveal) {
    container.replaceChildren();
    reveal = new StreamingThinkingReveal((displayed) => {
      if (!element.isConnected) {
        stopStreamingThinkingReveal(element);
        return;
      }
      container.innerHTML = markdown.render(displayed) + '<span class="cursor-block"></span>';
      scrollTranscriptToBottom();
    });
    streamingThinkingReveals.set(element, reveal);
    reveal.start();
  }
  reveal.update(thinking);
}

function stopStreamingThinkingReveal(element: HTMLElement): void {
  const reveal = streamingThinkingReveals.get(element);
  if (!reveal) return;
  reveal.stop();
  streamingThinkingReveals.delete(element);
}

function renderToolCalls(container: HTMLElement, calls: ToolCall[]): void {
  const previousOutputStates = new Map(
    [...container.querySelectorAll<HTMLDetailsElement>(".tool-output-details")]
      .flatMap((details) => details.dataset.toolUseId ? [[details.dataset.toolUseId, details.open] as const] : []),
  );
  container.replaceChildren();
  container.hidden = calls.length === 0;
  for (const call of calls) {
    const subject = toolSubject(call);
    const compactSubject = shouldInlineToolSubject(subject);
    const card = document.createElement("section");
    card.className = `tool-call ${call.status}${compactSubject ? " compact" : ""}`;
    card.dataset.toolUseId = call.id;

    const header = document.createElement("div");
    header.className = "tool-call-header";
    const title = document.createElement("div");
    title.className = "tool-call-title";
    const name = document.createElement("strong");
    name.textContent = `${call.name}${compactSubject ? ":" : ""}`;
    title.append(name);
    if (compactSubject) {
      const inlineSubject = document.createElement("code");
      inlineSubject.className = "tool-inline-subject";
      inlineSubject.textContent = subject;
      inlineSubject.title = subject;
      title.append(inlineSubject);
    }
    const status = document.createElement("span");
    status.className = "tool-call-status";
    status.textContent = toolStatusLabel(call);
    header.append(title, status);
    card.append(header);
    if (!compactSubject) {
      const command = document.createElement("code");
      command.className = "tool-command";
      command.textContent = subject;
      card.append(command);
    }

    if (call.name === "Agent" && call.agentSessionId) {
      const link = document.createElement("a");
      link.className = "agent-session-link";
      link.href = `/s/${call.agentSessionId}`;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = `OPEN SUB-SESSION · ${call.agentSessionId}`;
      card.append(link);
    }

    const metadata = toolMetadata(call);
    if (metadata) {
      const meta = document.createElement("div");
      meta.className = "tool-call-meta";
      meta.textContent = metadata;
      card.append(meta);
    }
    if (shouldRenderToolOutput(call)) {
      const details = document.createElement("details");
      details.className = "tool-output-details";
      details.dataset.toolUseId = call.id;
      const summary = document.createElement("summary");
      const lineCount = call.output.split("\n").length;
      const isDiff = isDiffOutput(call);
      details.open = toolOutputDisclosurePreferences.get(call.id)
        ?? previousOutputStates.get(call.id)
        ?? shouldExpandToolOutput(isDiff);
      summary.addEventListener("click", () => {
        setTimeout(() => toolOutputDisclosurePreferences.set(call.id, details.open), 0);
      });
      summary.textContent = `${isDiff ? diffSummary(call.output) : "Output"} · ${lineCount.toLocaleString()} ${lineCount === 1 ? "line" : "lines"}`;
      const output = document.createElement("pre");
      output.className = `tool-output${isDiff ? " tool-diff" : ""}`;
      if (isDiff) renderDiff(output, call.output);
      else output.textContent = call.output;
      details.append(summary, output);
      card.append(details);
    }
    container.append(card);
  }
}

function renderDiff(container: HTMLElement, diff: string): void {
  const lines = diff.split("\n");
  lines.forEach((line, index) => {
    const span = document.createElement("span");
    span.className = diffLineClass(line);
    span.textContent = line || " ";
    container.append(span);
    if (index < lines.length - 1) container.append("\n");
  });
}

function updateElapsedToolStatuses(): void {
  const session = state.session;
  if (!session) return;
  for (const message of session.messages) {
    for (const call of message.toolCalls ?? []) {
      if (call.status !== "running" || !call.statusDisplay?.appendElapsed || !call.startedAt) continue;
      const card = elements.transcript.querySelector<HTMLElement>(`.tool-call[data-tool-use-id="${CSS.escape(call.id)}"]`);
      const status = card?.querySelector<HTMLElement>(".tool-call-status");
      if (status) status.textContent = toolStatusLabel(call);
    }
  }
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
  if (!streaming) state.aborting = false;
  elements.submit.classList.toggle("stop", streaming);
  elements.submit.querySelector("span")!.textContent = streaming ? "STOP" : "SEND";
  elements.prompt.disabled = streaming;
  renderPlanMode();
}

function setBusy(busy: boolean): void {
  state.streaming = busy;
  if (!busy) state.aborting = false;
  elements.submit.classList.remove("stop");
  elements.submit.querySelector("span")!.textContent = busy ? "WAIT" : "SEND";
  elements.prompt.disabled = busy;
  renderPlanMode();
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
  const directoryMatch = elements.prompt.value.match(/^\/(cwd|add-dir)[ \t]+([^\n]*)$/i);
  if (directoryMatch?.[1] && directoryMatch[2] !== undefined) {
    matchingCommands = [];
    void updateDirectoryCompletions(`/${directoryMatch[1].toLowerCase()}` as "/add-dir" | "/cwd", directoryMatch[2]);
    return;
  }
  directoryCompletionRequest += 1;
  directoryCompletions = [];
  directoryCompletionCommand = null;
  const value = elements.prompt.value.trim().toLowerCase();
  if (!/^\/[a-z-]*$/.test(value)) return hideCommandMenu();
  matchingCommands = commands.filter((command) => command.name.startsWith(value));
  selectedCommand = 0;
  if (matchingCommands.length === 0) return hideCommandMenu();
  renderCommandMenu();
}

async function updateDirectoryCompletions(command: "/add-dir" | "/cwd", path: string): Promise<void> {
  const session = state.session;
  if (!session) return hideCommandMenu();
  const sourceValue = elements.prompt.value;
  const request = ++directoryCompletionRequest;
  directoryCompletions = [];
  directoryCompletionCommand = command;
  selectedCommand = 0;
  elements.commandMenu.hidden = true;
  try {
    const query = new URLSearchParams({ command: command.slice(1), path });
    const result = await api<{ directories: DirectoryCompletion[] }>(
      `/api/sessions/${session.id}/directory-completions?${query}`,
    );
    if (request !== directoryCompletionRequest || elements.prompt.value !== sourceValue) return;
    directoryCompletions = result.directories;
    if (directoryCompletions.length === 0) return hideCommandMenu();
    renderDirectoryMenu();
  } catch {
    if (request === directoryCompletionRequest) hideCommandMenu();
  }
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

function renderDirectoryMenu(): void {
  elements.commandMenu.replaceChildren();
  directoryCompletions.forEach((directory, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "command-option directory-option";
    button.classList.toggle("selected", index === selectedCommand);
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(index === selectedCommand));
    const value = document.createElement("strong");
    value.textContent = directory.value;
    const absolutePath = document.createElement("span");
    absolutePath.textContent = directory.absolutePath;
    button.append(value, absolutePath);
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => acceptDirectoryCompletion(directory));
    elements.commandMenu.append(button);
  });
  elements.commandMenu.hidden = false;
  elements.commandMenu.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
}

function acceptDirectoryCompletion(directory: DirectoryCompletion): void {
  if (!directoryCompletionCommand) return;
  setPromptValue(`${directoryCompletionCommand} ${directory.value}`);
  hideCommandMenu();
  elements.prompt.focus();
}

function selectCommand(command: CommandDefinition, execute: boolean): void {
  const acceptsPath = command.name === "/add-dir" || command.name === "/cwd";
  elements.prompt.value = acceptsPath ? `${command.name} ` : command.name;
  hideCommandMenu();
  resizePrompt();
  if (execute && !acceptsPath) elements.composer.requestSubmit();
  else elements.prompt.focus();
}

function hideCommandMenu(): void {
  directoryCompletionRequest += 1;
  matchingCommands = [];
  directoryCompletions = [];
  directoryCompletionCommand = null;
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

function scrollTranscriptToBottom(): void {
  requestAnimationFrame(() => {
    elements.transcript.scrollTop = elements.transcript.scrollHeight;
  });
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
