import {
  BottomScrollPin,
  STREAMING_THINKING_BOTTOM_THRESHOLD_PX,
  StreamingThinkingReveal,
} from "./streaming-thinking.js";
import {
  compactHeaderPath,
  formatDuration,
  formatTime,
  formatTokenCountInThousands,
  gitCommandSuggestions,
  messageFrom,
  parseGitCommand,
  promptFileReferenceAt,
  relativeTime,
  replacePromptFileReference,
  skillCommandSuggestions,
  taskRuntime,
  type PromptFileReference,
} from "./client-formatters.js";
import { BUILT_IN_COMMANDS, builtInCommand, type BuiltInCommand } from "./built-in-commands.js";
import { nextThinkingLevel, type ThinkingLevel } from "./thinking-level.js";
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
interface ToolReadRange { startLine: number; endLine: number; totalLines: number }
interface ToolCall { id: string; name: string; input: Record<string, unknown>; status: ToolStatus; output: string; startedAt?: string; completedAt?: string; durationMs?: number; exitCode?: number | null; workingDirectory?: string; timeoutMs?: number; filePath?: string; readRange?: ToolReadRange; statusDisplay?: ToolStatusDisplay; agentSessionId?: string; agentType?: string; agentModel?: string; agentThinkingLevel?: ThinkingLevel; agentNotificationDeliveredAt?: string; skillModel?: string; skillEffort?: string }
interface Message { id: string; role: "user" | "assistant"; content: string; thinking?: string; thinkingSignature?: string; thinkingProvider?: "anthropic" | "openai"; streamingThinking?: boolean; resyncedThinking?: boolean; createdAt: string; status: "streaming" | "complete" | "error"; kind?: "chat" | "command" | "fork-banner" | "agent-banner" | "plan-banner" | "compact-banner" | "tool-result" | "skill" | "agent-notification"; sourceSessionId?: string; forkedSessionId?: string; usage?: TokenUsage; toolCalls?: ToolCall[]; toolUseId?: string; toolError?: boolean; skillName?: string }
interface SessionCompaction { summary: string; throughMessageId: string; createdAt: string; coveredMessageCount: number }
type PlanningTaskStatus = "pending" | "in_progress" | "completed";
interface PlanningTask { id: string; subject: string; description: string; activeForm: string; status: PlanningTaskStatus; owner: string; blocks: string[]; blockedBy: string[]; metadata: Record<string, unknown> }
interface InvokedSkill { name: string; path: string; content: string; invokedAt: string }
interface Session { id: string; title: string; createdAt: string; updatedAt: string; messages: Message[]; model?: string; thinkingLevel?: ThinkingLevel; compaction?: SessionCompaction; directories?: string[]; cwd?: string; addDirInitialized?: boolean; parentSessionId?: string; agentType?: string; agentDescription?: string; agentStatus?: "running" | "complete" | "error"; planningTasks?: PlanningTask[]; planningTaskArchiveHighWaterMark?: number; contextTokens?: number; planMode?: SessionPlanMode; skillRoots?: string[]; skillTouchedPaths?: string[]; invokedSkills?: InvokedSkill[] }
interface Summary { id: string; title: string; updatedAt: string; messageCount: number; preview: string }
interface AvailableModel { key: string; provider: string; api: "anthropic" | "openai"; model: string; displayName: string; thinkingLevel: ThinkingLevel; compactTokens?: number }
interface Config { provider: string; model: string; defaultModel: string; models: AvailableModel[]; mode: "live"; homeDirectory: string; workspaceRoot: string; authActionToken: string; theme: "dark" | "light" | "light+" | "hacker" }
interface AuthProviderStatus { id: "openai-codex"; name: string; authName: string; configured: boolean; providerConfigured: boolean }
type AuthLoginStatus = { status: "pending" } | { status: "complete" } | { status: "failed"; error: string } | { status: "cancelled" };
type AuthLoginStart =
  | { id: string; method: "browser"; authorizationUrl: string; redirectUri: string; callbackAvailable: boolean }
  | { id: string; method: "device_code"; userCode: string; verificationUri: string; expiresInSeconds: number };
interface ActiveAuthLogin { start: AuthLoginStart; status: AuthLoginStatus }
interface BackgroundTask { id: string; type: "local_bash"; command: string; description: string; workingDirectory: string; status: "running" | "completed" | "failed" | "timed_out" | "killed"; stdout: string; stderr: string; exitCode: number | null; startedAt: string; completedAt?: string; durationMs?: number }
interface AskUserQuestionOption { label: string; description: string; preview?: string }
interface AskUserQuestion { question: string; header: string; options: AskUserQuestionOption[]; multiSelect: boolean }
interface AskUserQuestionRequest { toolUseId: string; questions: AskUserQuestion[] }
interface SessionPlanMode { active: boolean; planFilePath: string }
interface AllowedPlanPrompt { tool: "Bash"; prompt: string }
type PlanModeRequest =
  | { toolUseId: string; kind: "enter" }
  | { toolUseId: string; kind: "exit"; plan: string; planFilePath: string; allowedPrompts: AllowedPlanPrompt[] };
interface SessionSnapshot {
  session: Session;
  active: boolean;
  compaction?: { generatedCharacters: number };
  questionRequest?: AskUserQuestionRequest;
  planModeRequest?: PlanModeRequest;
}
interface QuestionSelection { labels: Set<string>; other: string; otherSelected: boolean; focusIndex: number }
interface DirectoryCompletion { value: string; absolutePath: string; kind?: "directory" | "file" }
interface MarkdownRenderer { render(source: string): string }
declare const markdownit: (options: { html: boolean; linkify: boolean; breaks: boolean; typographer: boolean }) => MarkdownRenderer;

const commands = BUILT_IN_COMMANDS;
const markdown = markdownit({ html: false, linkify: true, breaks: false, typographer: false });
const SESSION_ROUTE = /^\/s\/([a-z0-9.-]+)$/;
let matchingCommands: BuiltInCommand[] = [];
let selectedCommand = 0;
let directoryCompletions: DirectoryCompletion[] = [];
let directoryCompletionCommand: "/add-dir" | "/cwd" | null = null;
let fileReferenceCompletion: PromptFileReference | null = null;
let directoryCompletionRequest = 0;
let historyPosition = -1;
let historyDraft = "";
let historyMatches: string[] = [];
let selectedHistoryMatch = 0;
const toolOutputDisclosurePreferences = new Map<string, boolean>();
interface StreamingThinkingState {
  reveal: StreamingThinkingReveal;
  container: HTMLElement;
  onScroll: () => void;
}
interface SessionStreamContext {
  session: Session;
  assistantMessage: Message | null;
  assistantElement: HTMLElement | null;
}
const streamingThinkingStates = new WeakMap<HTMLElement, StreamingThinkingState>();
const transcriptScrollPin = new BottomScrollPin();
// Shared by the transcript and the streaming thinking containers: scrolling up
// inside any of them must unpin bottom-following for the whole transcript.
let userScrollUpIntent = false;
let renderedTranscriptSessionId: string | null = null;
let tasksDialogTasks: BackgroundTask[] = [];
let tasksDialogSelection = 0;
let tasksDialogDetailId: string | null = null;
let tasksDialogSkippedList = false;
let tasksDialogPollTimer: number | undefined;
let gitDialogRequest = 0;
let sessionDialogSelection = 0;
let sessionDialogQuery = "";
let sessionDialogReturnsToLanding = false;
let modelDialogSelection = 0;
let modelDialogQuery = "";
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
let authProviders: AuthProviderStatus[] = [];
let activeAuthLogin: ActiveAuthLogin | null = null;
let authBusy = false;
let authPollTimer: number | undefined;
let sessionRunController: AbortController | null = null;
let sessionRunId: string | null = null;
let sessionRunReconnectTimer: number | undefined;
let queuedMessage: { sessionId: string; content: string; kind: "message" | "command"; queuedAt: number } | null = null;
let pendingPlanHandoff: { sessionId: string; prompt: string } | null = null;

const ESC_ABORT_WINDOW_MS = 500;
let lastEscapeForAbortAt = 0;

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
  queue: required<HTMLButtonElement>("queue-button"),
  queuedMessage: required<HTMLElement>("queued-message"),
  queuedMessageContent: required<HTMLElement>("queued-message-content"),
  submit: required<HTMLButtonElement>("submit-button"),
  newSession: required<HTMLButtonElement>("new-session"),
  selectSession: required<HTMLButtonElement>("select-session"),
  toggleSidebar: required<HTMLButtonElement>("toggle-sidebar"),
  closeSidebar: required<HTMLButtonElement>("close-sidebar"),
  sessionTitle: required<HTMLElement>("session-title"),
  sessionDirectories: required<HTMLElement>("session-directories"),
  model: required<HTMLElement>("model-label"),
  modelSelector: required<HTMLButtonElement>("model-selector"),
  thinkingLevel: required<HTMLElement>("thinking-level-label"),
  thinkingLevelButton: required<HTMLButtonElement>("thinking-level-button"),
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
  modelDialog: required<HTMLElement>("model-dialog"),
  modelDialogClose: required<HTMLButtonElement>("model-dialog-close"),
  modelSearch: required<HTMLInputElement>("model-search"),
  modelList: required<HTMLElement>("model-list"),
  authSettings: required<HTMLButtonElement>("auth-settings"),
  authDialog: required<HTMLElement>("auth-dialog"),
  authClose: required<HTMLButtonElement>("auth-close"),
  authDialogBody: required<HTMLElement>("auth-dialog-body"),
  tasksDialog: required<HTMLElement>("tasks-dialog"),
  tasksDialogTitle: required<HTMLElement>("tasks-dialog-title"),
  tasksDialogBody: required<HTMLElement>("tasks-dialog-body"),
  tasksDialogHints: required<HTMLElement>("tasks-dialog-hints"),
  tasksBack: required<HTMLButtonElement>("tasks-back"),
  tasksClose: required<HTMLButtonElement>("tasks-close"),
  tasksStop: required<HTMLButtonElement>("tasks-stop"),
  gitDialog: required<HTMLElement>("git-dialog"),
  gitDialogTitle: required<HTMLElement>("git-dialog-title"),
  gitDialogBody: required<HTMLElement>("git-dialog-body"),
  gitDialogHints: required<HTMLElement>("git-dialog-hints"),
  gitClose: required<HTMLButtonElement>("git-close"),
  gitCommit: required<HTMLButtonElement>("git-commit"),
  gitCommitPush: required<HTMLButtonElement>("git-commit-push"),
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
  planModeNewSession: required<HTMLButtonElement>("plan-mode-new-session"),
  toast: required<HTMLElement>("toast"),
};

void initialize();
window.setInterval(updateElapsedToolStatuses, 1_000);

async function initialize(): Promise<void> {
  wireEvents();
  try {
    state.config = await api<Config>("/api/config");
    document.documentElement.dataset.theme = state.config.theme;
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
    if (handleAuthDialogKeydown(event)) return;
    if (handlePlanModeDialogKeydown(event)) return;
    if (handleNewSessionDialogKeydown(event)) return;
    if (handleQuestionDialogKeydown(event)) return;
    if (handleTasksDialogKeydown(event)) return;
    if (handleGitDialogKeydown(event)) return;
    if (handleSessionDialogKeydown(event)) return;
    if (handleModelDialogKeydown(event)) return;
    if (event.key === "Escape" && state.streaming && !state.session?.parentSessionId) {
      event.preventDefault();
      handleEscapeAbort();
      return;
    }
    if (event.key === "Escape" && !event.defaultPrevented && state.session && !state.session.parentSessionId) {
      event.preventDefault();
      handleEscapeAbort();
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
  elements.gitClose.addEventListener("click", closeGitDialog);
  elements.gitCommit.addEventListener("click", () => runGitDialogCommit(false));
  elements.gitCommitPush.addEventListener("click", () => runGitDialogCommit(true));
  elements.gitDialog.addEventListener("click", (event) => {
    if (event.target === elements.gitDialog) closeGitDialog();
  });
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
  elements.planModeNewSession.addEventListener("click", () => void submitPlanModeNewSessionDecision());
  elements.tasksDialog.addEventListener("click", (event) => {
    if (event.target === elements.tasksDialog) closeTasksDialog();
  });
  elements.sessionDialog.addEventListener("click", (event) => {
    if (event.target === elements.sessionDialog) closeSessionDialog();
  });
  elements.modelSelector.addEventListener("click", openModelDialog);
  elements.thinkingLevelButton.addEventListener("click", () => void cycleThinkingLevel());
  elements.modelDialogClose.addEventListener("click", closeModelDialog);
  elements.authSettings.addEventListener("click", () => void openAuthDialog());
  elements.authClose.addEventListener("click", () => void closeAuthDialog());
  elements.authDialog.addEventListener("click", (event) => {
    if (event.target === elements.authDialog) void closeAuthDialog();
  });
  elements.modelSearch.addEventListener("input", () => {
    modelDialogQuery = elements.modelSearch.value;
    modelDialogSelection = 0;
    renderModelList();
  });
  elements.modelDialog.addEventListener("click", (event) => {
    if (event.target === elements.modelDialog) closeModelDialog();
  });
  elements.questionDialog.addEventListener("click", (event) => {
    if (event.target === elements.questionDialog) void declineQuestions();
  });
  elements.planModeDialog.addEventListener("click", (event) => {
    if (event.target === elements.planModeDialog) void submitPlanModeDecision(false);
  });
  elements.toggleSidebar.addEventListener("click", () => document.body.classList.add("sidebar-open"));
  elements.closeSidebar.addEventListener("click", () => document.body.classList.remove("sidebar-open"));
  let lastTranscriptScrollTop = elements.transcript.scrollTop;
  let lastTouchY = 0;
  elements.transcript.addEventListener("scroll", () => {
    const { scrollTop, clientHeight, scrollHeight } = elements.transcript;
    const scrolledUp = scrollTop < lastTranscriptScrollTop - 1;
    lastTranscriptScrollTop = scrollTop;
    // Only an explicit user scroll upwards may unpin following; programmatic
    // scrolls and layout growth (loaded diffs, anchoring) must stay snapped.
    if (scrollHeight - scrollTop - clientHeight <= STREAMING_THINKING_BOTTOM_THRESHOLD_PX) userScrollUpIntent = false;
    transcriptScrollPin.update(scrollTop, clientHeight, scrollHeight, scrolledUp && userScrollUpIntent);
  }, { passive: true });
  elements.transcript.addEventListener("wheel", (event) => {
    userScrollUpIntent = event.deltaY < 0;
  }, { passive: true });
  elements.transcript.addEventListener("touchstart", (event) => {
    lastTouchY = event.touches[0]?.clientY ?? 0;
  }, { passive: true });
  elements.transcript.addEventListener("touchmove", (event) => {
    const touchY = event.touches[0]?.clientY;
    if (touchY !== undefined) userScrollUpIntent = touchY > lastTouchY;
    lastTouchY = touchY ?? lastTouchY;
  }, { passive: true });
  elements.transcript.addEventListener("mousedown", (event) => {
    // Scrollbar drags: the press landed inside a scrollable element's gutter.
    const scroller = event.target instanceof Element
      ? event.target.closest(".thinking-content") ?? elements.transcript
      : elements.transcript;
    const bounds = scroller.getBoundingClientRect();
    if (event.clientX > bounds.left + scroller.clientWidth) userScrollUpIntent = true;
  });
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("input, textarea, [contenteditable='true'], [contenteditable='']")) return;
    if (event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home") userScrollUpIntent = true;
  });
  elements.prompt.addEventListener("focus", stickScrollToBottom);
  elements.composer.addEventListener("submit", (event) => {
    event.preventDefault();
    if (state.streaming) abortCurrentSession();
    else void sendMessage();
  });
  elements.queue.addEventListener("click", () => void queueCurrentMessage());
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
        if (directory && (directoryCompletionCommand || fileReferenceCompletion)) {
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
      if (state.streaming) void queueCurrentMessage();
      else elements.composer.requestSubmit();
    }
  });
  elements.prompt.addEventListener("input", () => {
    historyPosition = -1;
    resizePrompt();
    updateCommandMenu();
  });
  elements.prompt.addEventListener("click", updateCommandMenu);
  elements.prompt.addEventListener("keyup", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End") {
      updateCommandMenu();
    }
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
  renderModelStatus();
  renderPlanMode();
  sessionDialogReturnsToLanding = false;
  newSessionReturnsToLanding = false;
  elements.newSessionDialog.hidden = true;
  elements.sessionDialog.hidden = true;
  elements.landingDialog.hidden = false;
  syncSessionRunUpdates();
  elements.landingNewSession.focus();
}

function openNewSessionFromLanding(): void {
  elements.landingDialog.hidden = true;
  openNewSessionDialog(true, true);
}

function openNewSessionDialog(replace: boolean, returnToLanding = false): void {
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
  // From a session context the new session opens in its own tab so the current
  // session (and any in-flight run) keeps this tab untouched. The tab is opened
  // synchronously with the click so pop-up blockers allow it.
  const sessionTab = state.session !== null ? window.open("", "_blank") : null;
  if (state.session !== null && !sessionTab) {
    notify("Allow pop-ups to open new sessions in a tab");
    return;
  }
  newSessionCreating = true;
  updateNewSessionSubmitState();
  try {
    const { session } = await api<{ session: Session }>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ name: elements.newSessionName.value, path }),
    });
    newSessionReturnsToLanding = false;
    elements.landingDialog.hidden = true;
    elements.newSessionDialog.hidden = true;
    hideNewSessionCompletions();
    if (sessionTab) {
      sessionTab.location.href = `/s/${session.id}`;
      await loadSessionList();
    } else {
      state.session = session;
      history[newSessionReplace ? "replaceState" : "pushState"]({}, "", `/s/${session.id}`);
      renderSession();
      await loadSessionList();
    }
    elements.prompt.focus();
  } catch (error) {
    sessionTab?.close();
    notify(messageFrom(error));
  } finally {
    newSessionCreating = false;
    updateNewSessionSubmitState();
  }
}

async function loadSession(id: string): Promise<void> {
  if (state.streaming) return;
  const snapshot = await api<SessionSnapshot>(`/api/sessions/${id}`);
  decorateStreamingMessage(snapshot);
  state.session = snapshot.session;
  if (!snapshot.session.parentSessionId) setStreaming(snapshot.active);
  syncPendingInteraction(snapshot);
  renderSession();
  syncCompactionProgress(snapshot);
  renderSessionList();
  document.body.classList.remove("sidebar-open");
}

function syncSessionRunUpdates(): void {
  const session = state.session;
  const shouldObserve = Boolean(session) && state.controller === null && (session!.parentSessionId
    ? session!.agentStatus === "running" || session!.messages.some((message) => message.status === "streaming")
    : state.streaming);
  if (!shouldObserve) {
    stopSessionRunUpdates();
    return;
  }
  if (sessionRunId === session!.id && sessionRunController) return;
  stopSessionRunUpdates();
  sessionRunId = session!.id;
  sessionRunController = new AbortController();
  void observeSessionRun(session!.id, sessionRunController);
}

function stopSessionRunUpdates(): void {
  if (sessionRunReconnectTimer !== undefined) {
    window.clearTimeout(sessionRunReconnectTimer);
    sessionRunReconnectTimer = undefined;
  }
  sessionRunController?.abort();
  sessionRunController = null;
  sessionRunId = null;
}

async function observeSessionRun(sessionId: string, controller: AbortController): Promise<void> {
  try {
    const response = await fetch(`/api/sessions/${sessionId}/events`, { signal: controller.signal });
    if (!response.ok) throw new Error(await responseError(response));
    if (!response.body) throw new Error("Server returned no event stream");
    const current = state.session;
    if (!current || current.id !== sessionId) return;
    const context = createSessionStreamContext(current);
    await readEventStream(response.body, (event, data) => applySessionEvent(context, event, data));
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      // A short reconnect covers transient network failures without reverting to polling.
      if (state.session?.id === sessionId) {
        sessionRunReconnectTimer = window.setTimeout(() => {
          sessionRunReconnectTimer = undefined;
          sessionRunController = null;
          sessionRunId = null;
          syncSessionRunUpdates();
        }, 750);
      }
    }
  } finally {
    if (sessionRunController === controller) {
      sessionRunController = null;
      sessionRunId = null;
    }
  }
}

function syncPendingInteraction(snapshot: SessionSnapshot): void {
  if (snapshot.questionRequest) {
    if (questionRequest?.toolUseId !== snapshot.questionRequest.toolUseId) {
      openQuestionDialog(snapshot.questionRequest);
    }
  } else if (questionRequest) {
    closeQuestionDialog();
  }
  if (snapshot.planModeRequest) {
    if (planModeRequest?.toolUseId !== snapshot.planModeRequest.toolUseId) {
      openPlanModeDialog(snapshot.planModeRequest);
    }
  } else if (planModeRequest) {
    closePlanModeDialog();
  }
}

function decorateStreamingMessage(snapshot: SessionSnapshot): void {
  if (!snapshot.active) return;
  const message = snapshot.session.messages.slice().reverse().find((candidate) =>
    candidate.role === "assistant" && candidate.status === "streaming",
  );
  if (message) {
    message.streamingThinking = Boolean(message.thinking) && !message.content;
    message.resyncedThinking = message.streamingThinking;
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
  if (summary.id === state.session?.id) return closeSessionDialog();
  if (state.session !== null) {
    // From a session context the archive selection opens in its own tab so the
    // current session (and any in-flight run) keeps this tab untouched.
    const tab = window.open(`/s/${summary.id}`, "_blank");
    if (!tab) return notify("Allow pop-ups to open sessions in a tab");
    sessionDialogReturnsToLanding = false;
    closeSessionDialog();
    return;
  }
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

async function openAuthDialog(): Promise<void> {
  elements.authDialog.hidden = false;
  document.body.classList.remove("sidebar-open");
  renderAuthDialog();
  try {
    await loadAuthProviders();
  } catch (error) {
    notify(messageFrom(error));
  }
}

async function closeAuthDialog(): Promise<void> {
  elements.authDialog.hidden = true;
  stopAuthPolling();
  if (activeAuthLogin?.status.status === "pending") {
    const loginId = activeAuthLogin.start.id;
    activeAuthLogin = null;
    renderAuthDialog();
    await authMutation(`/api/auth/openai-codex/logins/${loginId}`, { method: "DELETE" }).catch(() => undefined);
  }
  elements.prompt.focus();
}

function handleAuthDialogKeydown(event: KeyboardEvent): boolean {
  if (elements.authDialog.hidden) return false;
  if (event.key === "Escape") {
    event.preventDefault();
    void closeAuthDialog();
  }
  return true;
}

async function loadAuthProviders(): Promise<void> {
  const response = await api<{ providers: AuthProviderStatus[] }>("/api/auth");
  authProviders = response.providers;
  renderAuthDialog();
}

function renderAuthDialog(): void {
  elements.authDialogBody.replaceChildren();
  const provider = authProviders.find((candidate) => candidate.id === "openai-codex");
  if (!provider) {
    const loading = document.createElement("div");
    loading.className = "tasks-empty";
    loading.textContent = "Loading authentication status…";
    elements.authDialogBody.append(loading);
    return;
  }

  const card = document.createElement("section");
  card.className = "auth-provider-card";
  const heading = document.createElement("div");
  heading.className = "auth-provider-heading";
  const identity = document.createElement("div");
  const title = document.createElement("h2");
  title.textContent = provider.name;
  const subtitle = document.createElement("p");
  subtitle.textContent = provider.authName;
  identity.append(title, subtitle);
  const status = document.createElement("span");
  status.className = `auth-status${provider.configured ? "" : " disconnected"}`;
  status.textContent = provider.configured ? "Connected" : "Not connected";
  heading.append(identity, status);
  card.append(heading);

  if (!provider.providerConfigured) {
    const note = document.createElement("p");
    note.className = "auth-note";
    note.textContent = "Add an api=\"openai\", auth=\"openai-codex\" provider in ~/.amber/settings.toml to expose Codex models.";
    card.append(note);
  }

  if (activeAuthLogin) {
    renderActiveAuthFlow(card, activeAuthLogin);
  } else {
    const actions = document.createElement("div");
    actions.className = "auth-actions";
    if (provider.configured) {
      actions.append(authButton("DISCONNECT", "danger", () => void logoutOpenAICodex()));
    } else {
      actions.append(
        authButton("BROWSER LOGIN", "", () => void startAuthLogin("browser")),
        authButton("DEVICE CODE", "secondary", () => void startAuthLogin("device_code")),
      );
    }
    card.append(actions);
  }
  elements.authDialogBody.append(card);
}

function renderActiveAuthFlow(card: HTMLElement, login: ActiveAuthLogin): void {
  const flow = document.createElement("div");
  flow.className = "auth-flow";
  if (login.status.status === "failed" || login.status.status === "cancelled") {
    const error = document.createElement("p");
    error.className = "auth-error";
    error.textContent = login.status.status === "failed" ? login.status.error : "Login cancelled";
    const back = authButton("TRY AGAIN", "secondary", () => {
      activeAuthLogin = null;
      renderAuthDialog();
    });
    flow.append(error, back);
    card.append(flow);
    return;
  }

  const label = document.createElement("strong");
  label.textContent = login.start.method === "browser"
    ? "Waiting for browser authorization…"
    : "Waiting for device authorization…";
  flow.append(label);
  if (login.start.method === "browser") {
    const link = externalLink(login.start.authorizationUrl, "Open the OpenAI authorization page");
    const note = document.createElement("p");
    note.textContent = login.start.callbackAvailable
      ? "The local callback will finish automatically. For remote access, paste the final redirect URL or authorization code below."
      : "The local callback port is unavailable. Paste the final redirect URL or authorization code below.";
    const form = document.createElement("form");
    form.className = "auth-manual-form";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = login.start.redirectUri;
    input.autocomplete = "off";
    input.spellcheck = false;
    const submit = authButton("SUBMIT CODE", "", () => undefined);
    submit.type = "submit";
    form.append(input, submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void submitManualAuth(input.value);
    });
    flow.append(link, note, form);
  } else {
    const code = document.createElement("code");
    code.textContent = login.start.userCode;
    const link = externalLink(login.start.verificationUri, "Open the OpenAI device authorization page");
    flow.append(code, link);
  }
  const actions = document.createElement("div");
  actions.className = "auth-actions";
  actions.append(authButton("CANCEL", "secondary", () => void cancelActiveAuthLogin()));
  flow.append(actions);
  card.append(flow);
}

function authButton(label: string, variant: string, action: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `auth-button${variant ? ` ${variant}` : ""}`;
  button.textContent = label;
  button.disabled = authBusy;
  button.addEventListener("click", action);
  return button;
}

function externalLink(url: string, label: string): HTMLAnchorElement {
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = label;
  return link;
}

async function startAuthLogin(method: "browser" | "device_code"): Promise<void> {
  if (authBusy) return;
  const popup = method === "browser" ? window.open("about:blank", "_blank") : null;
  authBusy = true;
  renderAuthDialog();
  try {
    const start = await authMutation<AuthLoginStart>("/api/auth/openai-codex/login", {
      method: "POST",
      body: JSON.stringify({ method }),
    });
    activeAuthLogin = { start, status: { status: "pending" } };
    if (start.method === "browser" && popup) popup.location.href = start.authorizationUrl;
    renderAuthDialog();
    scheduleAuthPoll();
  } catch (error) {
    popup?.close();
    notify(messageFrom(error));
  } finally {
    authBusy = false;
    renderAuthDialog();
  }
}

function scheduleAuthPoll(): void {
  stopAuthPolling();
  authPollTimer = window.setTimeout(() => void pollAuthLogin(), 2_000);
}

function stopAuthPolling(): void {
  if (authPollTimer !== undefined) window.clearTimeout(authPollTimer);
  authPollTimer = undefined;
}

async function pollAuthLogin(): Promise<void> {
  const login = activeAuthLogin;
  if (!login || login.status.status !== "pending") return;
  try {
    const status = await api<AuthLoginStatus>(`/api/auth/openai-codex/logins/${login.start.id}`);
    if (activeAuthLogin?.start.id !== login.start.id) return;
    activeAuthLogin.status = status;
    if (status.status === "pending") {
      scheduleAuthPoll();
    } else if (status.status === "complete") {
      await completeAuthLogin();
    } else {
      renderAuthDialog();
    }
  } catch (error) {
    if (activeAuthLogin?.start.id === login.start.id) {
      activeAuthLogin.status = { status: "failed", error: messageFrom(error) };
      renderAuthDialog();
    }
  }
}

async function submitManualAuth(input: string): Promise<void> {
  const login = activeAuthLogin;
  if (!login || login.start.method !== "browser" || authBusy) return;
  authBusy = true;
  renderAuthDialog();
  try {
    const status = await authMutation<AuthLoginStatus>(
      `/api/auth/openai-codex/logins/${login.start.id}/manual`,
      { method: "POST", body: JSON.stringify({ input }) },
    );
    if (status.status === "complete") await completeAuthLogin();
  } catch (error) {
    notify(messageFrom(error));
  } finally {
    authBusy = false;
    renderAuthDialog();
  }
}

async function completeAuthLogin(): Promise<void> {
  activeAuthLogin = null;
  stopAuthPolling();
  await loadAuthProviders();
  await refreshConfig();
  notify("OpenAI Codex connected");
}

async function refreshConfig(): Promise<void> {
  try {
    state.config = await api<Config>("/api/config");
    renderConfig();
  } catch {
    // Keep the previous config; reopening the page refetches it.
  }
}

async function cancelActiveAuthLogin(): Promise<void> {
  const login = activeAuthLogin;
  if (!login || authBusy) return;
  authBusy = true;
  stopAuthPolling();
  try {
    await authMutation(`/api/auth/openai-codex/logins/${login.start.id}`, { method: "DELETE" });
    activeAuthLogin = null;
  } catch (error) {
    notify(messageFrom(error));
  } finally {
    authBusy = false;
    renderAuthDialog();
  }
}

async function logoutOpenAICodex(): Promise<void> {
  if (authBusy) return;
  authBusy = true;
  renderAuthDialog();
  try {
    await authMutation("/api/auth/openai-codex", { method: "DELETE" });
    await loadAuthProviders();
    notify("OpenAI Codex disconnected");
  } catch (error) {
    notify(messageFrom(error));
  } finally {
    authBusy = false;
    renderAuthDialog();
  }
}

function openModelDialog(): void {
  const session = state.session;
  const config = state.config;
  if (!session || !config || session.parentSessionId || state.streaming) return;
  modelDialogQuery = "";
  elements.modelSearch.value = "";
  const currentModel = session.model ?? config.defaultModel;
  const currentIndex = config.models.findIndex((model) => model.key === currentModel);
  modelDialogSelection = currentIndex >= 0 ? currentIndex : 0;
  renderModelList();
  elements.modelDialog.hidden = false;
  elements.modelSearch.focus();
  elements.modelList.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
}

function closeModelDialog(): void {
  elements.modelDialog.hidden = true;
  elements.prompt.focus();
}

function filteredModels(): AvailableModel[] {
  const models = state.config?.models ?? [];
  const query = modelDialogQuery.trim().toLocaleLowerCase();
  if (!query) return models;
  return models.filter((model) => [model.key, model.provider, model.model, model.displayName, model.thinkingLevel]
    .some((value) => value.toLocaleLowerCase().includes(query)));
}

function renderModelList(): void {
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
  const activeModel = state.session?.model ?? state.config?.defaultModel;
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

async function selectModel(model: AvailableModel): Promise<void> {
  const session = state.session;
  if (!session || session.parentSessionId || state.streaming) return;
  if ((session.model ?? state.config?.defaultModel) === model.key) return closeModelDialog();
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

function effectiveThinkingLevel(session: Session, config: Config): ThinkingLevel {
  if (session.thinkingLevel) return session.thinkingLevel;
  const model = config.models.find((candidate) => candidate.key === (session.model ?? config.defaultModel));
  return model?.thinkingLevel ?? "none";
}

async function cycleThinkingLevel(): Promise<void> {
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

function handleModelDialogKeydown(event: KeyboardEvent): boolean {
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

async function sendMessage(queuedContent?: string): Promise<void> {
  const session = state.session;
  const content = (queuedContent ?? elements.prompt.value).trim();
  if (!session || !content || state.streaming) return;

  const commandName = content.split(/\s+/, 1)[0]?.toLowerCase();
  if (commands.some((command) => command.name === commandName) || commandName === "/bashes") {
    return runCommand(content, queuedContent === undefined);
  }

  if (queuedContent === undefined) clearPrompt();
  setStreaming(true);
  state.controller = new AbortController();
  const context = createSessionStreamContext(session);
  let detachedActive = false;
  try {
    const response = await fetch(`/api/sessions/${session.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
      signal: state.controller.signal,
    });
    if (!response.ok) throw new Error(await responseError(response));
    if (!response.body) throw new Error("Server returned no stream");

    await readEventStream(response.body, (event, data) => applySessionEvent(context, event, data));
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) notify(messageFrom(error));
    detachedActive = await refreshCurrentSession();
  } finally {
    state.controller = null;
    setStreaming(detachedActive);
    if (!detachedActive) {
      closeQuestionDialog();
      closePlanModeDialog();
      if (pendingPlanHandoff) {
        const handoff = pendingPlanHandoff;
        pendingPlanHandoff = null;
        void executePlanHandoff(handoff);
      } else {
        sendQueuedMessage(session.id);
      }
    }
    syncSessionRunUpdates();
    await loadSessionList();
    elements.prompt.focus();
  }
}

function createSessionStreamContext(session: Session): SessionStreamContext {
  const assistantMessage = [...session.messages].reverse().find((message) =>
    message.role === "assistant" && message.status === "streaming",
  ) ?? null;
  return {
    session,
    assistantMessage,
    assistantElement: assistantMessage
      ? elements.transcript.querySelector<HTMLElement>(`.message[data-message-id="${CSS.escape(assistantMessage.id)}"]`)
      : null,
  };
}

function setStreamAssistant(context: SessionStreamContext, message: Message | null): void {
  context.assistantMessage = message;
  context.assistantElement = message
    ? elements.transcript.querySelector<HTMLElement>(`.message[data-message-id="${CSS.escape(message.id)}"]`)
    : null;
}

interface CompactProgress { message: Message; element: HTMLElement }

/** Tracks the in-transcript progress banner shared by /compact and server auto-compaction. */
let compactProgress: CompactProgress | null = null;

/** Returns the live progress banner, creating or re-attaching to a rendered one as needed. */
function ensureCompactProgress(session: Session): CompactProgress {
  const rendered = session.messages.find((message) => message.kind === "compact-banner" && message.status === "streaming");
  const tracked = compactProgress?.message.status === "streaming" ? compactProgress : undefined;
  const message = tracked?.message ?? rendered;
  if (message) {
    const element = elements.transcript.querySelector<HTMLElement>(`.message[data-message-id="${CSS.escape(message.id)}"]`);
    if (element) {
      compactProgress = { message, element };
      return compactProgress;
    }
  }
  return compactProgress = startCompactProgress(session, "compact-progress");
}

function startCompactProgress(session: Session, idPrefix: string): CompactProgress {
  const message: Message = {
    id: `${idPrefix}-${Date.now()}`,
    role: "assistant",
    content: "Compacting model context…",
    createdAt: new Date().toISOString(),
    status: "streaming",
    kind: "compact-banner",
  };
  session.messages.push(message);
  const progress: CompactProgress = { message, element: appendMessage(message) };
  elements.emptyState.hidden = true;
  return progress;
}

function updateCompactProgress(progress: CompactProgress, generatedCharacters: number): void {
  const generatedTokens = Math.ceil(generatedCharacters / 4);
  progress.message.content = `Compacting model context… ≈${generatedTokens.toLocaleString()} tokens generated`;
  updateMessage(progress.element, progress.message);
}

function removeCompactProgress(progress: CompactProgress, session: Session): void {
  progress.element.remove();
  session.messages = session.messages.filter((message) => message.id !== progress.message.id);
}

/** Re-creates or removes the compaction banner after a transcript (re)render. */
function syncCompactionProgress(snapshot: SessionSnapshot): void {
  const session = state.session;
  if (!session || session.id !== snapshot.session.id) return;
  if (snapshot.compaction) {
    compactProgress = ensureCompactProgress(session);
    updateCompactProgress(compactProgress, snapshot.compaction.generatedCharacters);
    return;
  }
  const stale = session.messages.filter((message) => message.kind === "compact-banner" && message.status === "streaming");
  if (stale.length === 0) return;
  session.messages = session.messages.filter((message) => !stale.includes(message));
  for (const message of stale) {
    elements.transcript.querySelector<HTMLElement>(`.message[data-message-id="${CSS.escape(message.id)}"]`)?.remove();
  }
  if (compactProgress && stale.includes(compactProgress.message)) compactProgress = null;
}

function applySessionEvent(context: SessionStreamContext, event: string, data: unknown): void {
  if (state.session?.id !== context.session.id) return;
  if (event === "snapshot") {
    const snapshot = data as SessionSnapshot;
    const wasStreaming = state.streaming;
    decorateStreamingMessage(snapshot);
    context.session = snapshot.session;
    if (!snapshot.session.parentSessionId) setStreaming(snapshot.active);
    syncPendingInteraction(snapshot);
    updateRenderedSession(snapshot.session);
    syncCompactionProgress(snapshot);
    setStreamAssistant(context, createSessionStreamContext(snapshot.session).assistantMessage);
    if (!snapshot.session.parentSessionId && wasStreaming && !snapshot.active) sendQueuedMessage(snapshot.session.id);
  } else if (event === "start") {
    const payload = data as { session?: Session; userMessage: Message; assistantMessage: Message };
    if (payload.session) {
      context.session = payload.session;
      updateRenderedSession(payload.session);
      const streamedAssistant = payload.session.messages.find((message) => message.id === payload.assistantMessage.id)
        ?? payload.assistantMessage;
      setStreamAssistant(context, streamedAssistant);
      elements.emptyState.hidden = true;
      renderHeader();
      scrollTranscriptToBottom();
      return;
    }
    if (!context.session.messages.some((message) => message.id === payload.userMessage.id)) {
      context.session.messages.push(payload.userMessage, payload.assistantMessage);
      context.assistantElement = appendMessage(payload.assistantMessage);
      appendMessage(payload.userMessage, context.assistantElement);
    }
    context.assistantMessage = payload.assistantMessage;
    context.assistantElement ??= elements.transcript.querySelector<HTMLElement>(
      `.message[data-message-id="${CSS.escape(payload.assistantMessage.id)}"]`,
    );
    elements.emptyState.hidden = true;
    renderHeader();
  } else if (event === "delta" || event === "thinking_delta") {
    const message = context.assistantMessage;
    if (message?.role === "assistant") {
      if (event === "delta") {
        message.streamingThinking = false;
        message.content += (data as { text: string }).text;
      } else {
        message.streamingThinking = true;
        message.thinking = (message.thinking ?? "") + (data as { thinking: string }).thinking;
      }
      updateMessage(context.assistantElement, message);
    }
  } else if (event === "assistant_complete") {
    const message = (data as { message: Message }).message;
    const index = context.session.messages.findIndex((candidate) => candidate.id === message.id);
    if (index >= 0) context.session.messages[index] = message;
    if (message.usage) context.session.contextTokens = message.usage.input;
    setStreamAssistant(context, message);
    updateMessage(context.assistantElement, message);
    renderContextMeter();
  } else if (event === "compaction_start") {
    compactProgress = ensureCompactProgress(context.session);
  } else if (event === "compaction_progress") {
    compactProgress = ensureCompactProgress(context.session);
    updateCompactProgress(compactProgress, (data as { generatedCharacters: number }).generatedCharacters);
  } else if (event === "compaction_complete") {
    compactProgress = null;
    const session = (data as { session: Session }).session;
    context.session = session;
    updateRenderedSession(session);
    renderContextMeter();
    consumeQueuedManualCompaction(session.id);
  } else if (event === "compaction_error") {
    if (compactProgress) {
      removeCompactProgress(compactProgress, context.session);
      compactProgress = null;
    }
    notify(`Compaction failed · ${(data as { error: string }).error}`);
  } else if (event === "tool_update") {
    applyToolUpdate(context.session, data as { messageId: string; toolCall: ToolCall });
  } else if (event === "tool_output") {
    applyToolOutput(context.session, data as { messageId: string; toolUseId: string; chunk: string });
  } else if (event === "planning_tasks_update") {
    const payload = data as { tasks: PlanningTask[]; archiveHighWaterMark: number };
    context.session.planningTasks = payload.tasks;
    context.session.planningTaskArchiveHighWaterMark = payload.archiveHighWaterMark;
    renderPlanningTasks();
  } else if (event === "ask_user_question") {
    openQuestionDialog(data as AskUserQuestionRequest);
  } else if (event === "plan_mode_request") {
    openPlanModeDialog(data as PlanModeRequest);
  } else if (event === "plan_mode_state") {
    context.session.planMode = (data as { planMode: SessionPlanMode }).planMode;
    renderPlanMode();
  } else if (event === "continuation") {
    const message = (data as { assistantMessage: Message }).assistantMessage;
    context.session.messages.push(message);
    context.assistantMessage = message;
    context.assistantElement = appendMessage(message);
  } else if (event === "user_message") {
    const message = (data as { message: Message }).message;
    if (!context.session.messages.some((candidate) => candidate.id === message.id)) {
      context.session.messages.push(message);
      appendMessage(message);
    }
    consumeQueuedMessage(message);
  } else if (event === "session_named") {
    context.session.title = (data as { title: string }).title;
    renderHeader();
  } else if (event === "done") {
    const session = (data as { session: Session }).session;
    context.session = session;
    if (!session.parentSessionId && state.controller === null) setStreaming(false);
    updateRenderedSession(session);
    setStreamAssistant(context, null);
    if (!session.parentSessionId && state.controller === null) sendQueuedMessage(session.id);
  } else if (event === "error") {
    const payload = data as { error: string; message?: Message; session?: Session };
    if (payload.session) {
      context.session = payload.session;
      if (!payload.session.parentSessionId && state.controller === null) setStreaming(false);
      updateRenderedSession(payload.session);
    } else if (payload.message) {
      const index = context.session.messages.findIndex((message) => message.id === payload.message!.id);
      if (index >= 0) context.session.messages[index] = payload.message;
      updateMessage(context.assistantElement, payload.message);
    }
    setStreamAssistant(context, null);
    notify(payload.error);
  }
  scrollTranscriptToBottom();
}

async function executePlanHandoff(handoff: { sessionId: string; prompt: string }): Promise<void> {
  try {
    history.pushState({}, "", `/s/${handoff.sessionId}`);
    await loadSession(handoff.sessionId);
    notify(`Plan implementation session · ${handoff.sessionId}`);
    void sendMessage(handoff.prompt);
  } catch (error) {
    notify(messageFrom(error));
  }
}

async function queueCurrentMessage(): Promise<void> {
  const session = state.session;
  const content = elements.prompt.value.trim();
  if (!session || !state.streaming || !content) return;
  const command = builtInCommand(content);
  if (command?.runsDuringResponse) {
    await runCommand(content);
    return;
  }
  const kind: "command" | "message" = command ? "command" : "message";
  const previousQueued = queuedMessage;
  const pending = { sessionId: session.id, content, kind, queuedAt: Date.now() };
  queuedMessage = pending;
  renderQueuedMessage();
  let serverRunUnavailable = false;
  try {
    const response = await fetch(`/api/sessions/${session.id}/queued-message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, kind }),
    });
    // Keep the input queued locally when the interruptible server run has
    // already ended (or has not registered yet). The stream-finalizer will
    // dispatch it once the client observes that the session is ready.
    serverRunUnavailable = response.status === 409;
    if (!response.ok && !serverRunUnavailable) throw new Error(await responseError(response));
  } catch (error) {
    if (queuedMessage === pending) {
      queuedMessage = previousQueued;
      renderQueuedMessage();
    }
    notify(messageFrom(error));
    return;
  }
  if (elements.prompt.value.trim() === content) clearPrompt();
  // The stream may have finalized while the queue request was in flight, before
  // the server reported whether it could accept the queued input.
  if (serverRunUnavailable && !state.streaming && queuedMessage === pending) sendQueuedMessage(session.id);
}

function sendQueuedMessage(sessionId: string): void {
  const queued = queuedMessage;
  if (!queued || queued.sessionId !== sessionId || state.session?.id !== sessionId) return;
  if (queued.kind === "command") {
    queuedMessage = null;
    renderQueuedMessage();
    void runCommand(queued.content, false);
    return;
  }
  // The server may have injected the message mid-run even if that event never
  // reached us (for example after a dropped connection).
  const alreadyDelivered = state.session.messages.some((message) =>
    message.role === "user"
    && (!message.kind || message.kind === "chat")
    && message.content === queued.content
    && Date.parse(message.createdAt) + 1_000 >= queued.queuedAt);
  queuedMessage = null;
  renderQueuedMessage();
  if (!alreadyDelivered) void sendMessage(queued.content);
}

/** Stops tracking a queued message the server injected mid-run. */
function consumeQueuedMessage(message: Message): void {
  if (!queuedMessage || queuedMessage.kind !== "message" || message.role !== "user" || message.content !== queuedMessage.content) return;
  queuedMessage = null;
  renderQueuedMessage();
}

/** Automatic compaction satisfies a queued manual /compact command. */
function consumeQueuedManualCompaction(sessionId: string): void {
  if (queuedMessage?.sessionId !== sessionId
    || queuedMessage.kind !== "command"
    || queuedMessage.content.trim().toLowerCase() !== "/compact") return;
  queuedMessage = null;
  renderQueuedMessage();
}

function renderQueuedMessage(): void {
  const queued = queuedMessage?.sessionId === state.session?.id ? queuedMessage : null;
  elements.queuedMessage.hidden = queued === null;
  elements.queuedMessageContent.textContent = queued?.content ?? "";
}

function clearPrompt(): void {
  elements.prompt.value = "";
  hideCommandMenu();
  resetPromptHistory();
  resizePrompt();
}

function handleEscapeAbort(): void {
  const now = performance.now();
  if (now - lastEscapeForAbortAt > ESC_ABORT_WINDOW_MS) {
    lastEscapeForAbortAt = now;
    notify("Press Esc again to stop");
    return;
  }
  lastEscapeForAbortAt = 0;
  abortCurrentSession();
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
  elements.planModeApprove.textContent = request.kind === "enter" ? "ENTER PLAN MODE" : "IMPLEMENT";
  elements.planModeNewSession.hidden = request.kind !== "exit";
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
  elements.planModeNewSession.disabled = planModeSubmitting;
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

async function submitPlanModeNewSessionDecision(): Promise<void> {
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
      pendingPlanHandoff = {
        sessionId: result.decision.newSessionId,
        prompt: `Execute the plan: ${request.planFilePath}`,
      };
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

async function runCommand(command: string, clearComposer = true): Promise<void> {
  const session = state.session;
  const duringResponse = state.streaming;
  if (!session || (duringResponse && !builtInCommand(command)?.runsDuringResponse)) return;
  if (command.split(/\s+/, 1)[0]?.toLowerCase() === "/compact") return runCompactCommand(command, clearComposer);
  if (command.split(/\s+/, 1)[0]?.toLowerCase() === "/git") {
    const request = parseGitCommand(command);
    if (!request) {
      notify("Usage: /git diff | /git show | /git status | /git commit [push]");
      elements.prompt.focus();
      return;
    }
    if (request.kind === "commit") {
      if (clearComposer) clearPrompt();
      return sendMessage(request.push ? "/commit push" : "/commit");
    }
    if (clearComposer) clearPrompt();
    void openGitDialog(request.view);
    return;
  }
  if (clearComposer) clearPrompt();
  if (!duringResponse) setBusy(true);
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
    if (!duringResponse) setBusy(false);
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

type GitView = "diff" | "show" | "status";

async function openGitDialog(view: GitView): Promise<void> {
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

function renderGitDialogBody(view: GitView, output: string, exitCode: number | null): void {
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

function closeGitDialog(): void {
  gitDialogRequest += 1;
  elements.gitDialog.hidden = true;
  elements.prompt.focus();
}

function runGitDialogCommit(push: boolean): void {
  if (state.streaming) {
    notify("Wait for the current response to finish");
    return;
  }
  closeGitDialog();
  void sendMessage(push ? "/commit push" : "/commit");
}

function handleGitDialogKeydown(event: KeyboardEvent): boolean {
  if (elements.gitDialog.hidden) return false;
  if (event.key === "Escape") {
    event.preventDefault();
    closeGitDialog();
    return true;
  }
  return false;
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

async function runCompactCommand(command: string, clearComposer = true): Promise<void> {
  const session = state.session;
  if (!session || state.streaming) return;
  if (clearComposer) clearPrompt();
  setStreaming(true);
  compactProgress = ensureCompactProgress(session);
  // Open the /events observe stream; progress arrives via compaction_* broadcasts.
  syncSessionRunUpdates();

  try {
    const result = await api<{ command: "compact"; session: Session }>(`/api/sessions/${session.id}/commands`, {
      method: "POST",
      body: JSON.stringify({ command }),
    });
    state.session = result.session;
    renderSession();
    notify("Context compacted · full history retained");
  } catch (error) {
    notify(messageFrom(error));
    await refreshCurrentSession();
  } finally {
    // The banner lifecycle is finished by the event/response render.
    compactProgress = null;
    if (state.controller === null) setStreaming(false);
    sendQueuedMessage(session.id);
    await loadSessionList();
    elements.prompt.focus();
  }
}

function renderConfig(): void {
  if (!state.config) return;
  elements.providerDot.classList.remove("demo");
  renderModelStatus();
  renderPlanMode();
}

function renderSession(): void {
  const session = state.session;
  const sameSession = session?.id === renderedTranscriptSessionId;
  const previousScrollTop = elements.transcript.scrollTop;
  const wasFollowingBottom = transcriptScrollPin.shouldFollowBottom();
  elements.transcript.querySelectorAll<HTMLElement>(".message").forEach((element) => {
    stopStreamingThinkingReveal(element);
    element.remove();
  });
  if (!session) {
    renderedTranscriptSessionId = null;
    transcriptScrollPin.reset();
    return;
  }
  if (!sameSession) {
    renderedTranscriptSessionId = session.id;
    transcriptScrollPin.reset();
  }
  elements.composerShell.hidden = Boolean(session.parentSessionId);
  elements.emptyState.hidden = session.messages.length > 0;
  for (const message of session.messages) {
    if (message.kind !== "tool-result" && message.kind !== "skill" && message.kind !== "agent-notification") {
      appendMessage(message);
    }
  }
  resetPromptHistory();
  closeHistorySearch(false);
  renderHeader();
  renderPlanMode();
  renderPlanningTasks();
  renderContextMeter();
  renderQueuedMessage();
  syncSessionRunUpdates();
  if (sameSession && !wasFollowingBottom) elements.transcript.scrollTop = previousScrollTop;
  else transcriptScrollPin.scrollToBottom(elements.transcript);
}

function updateRenderedSession(session: Session): void {
  if (renderedTranscriptSessionId !== session.id) {
    state.session = session;
    renderSession();
    return;
  }

  const previousScrollTop = elements.transcript.scrollTop;
  const wasFollowingBottom = transcriptScrollPin.shouldFollowBottom();
  state.session = session;
  const visibleMessages = session.messages.filter((message) =>
    message.kind !== "tool-result" && message.kind !== "skill" && message.kind !== "agent-notification"
  );
  const visibleIds = new Set(visibleMessages.map((message) => message.id));
  elements.transcript.querySelectorAll<HTMLElement>(".message").forEach((element) => {
    if (element.dataset.messageId && visibleIds.has(element.dataset.messageId)) return;
    stopStreamingThinkingReveal(element);
    element.remove();
  });
  for (const message of visibleMessages) {
    let element = elements.transcript.querySelector<HTMLElement>(
      `.message[data-message-id="${CSS.escape(message.id)}"]`,
    );
    if (element) updateMessage(element, message);
    else element = appendMessage(message);
  }
  const renderedMessages = [...elements.transcript.querySelectorAll<HTMLElement>(".message")];
  const orderChanged = renderedMessages.some((element, index) =>
    element.dataset.messageId !== visibleMessages[index]?.id);
  if (orderChanged) {
    // Moving an existing node preserves its streaming reveal state while also
    // keeping newly discovered messages in exact transcript order.
    for (const message of visibleMessages) {
      const element = elements.transcript.querySelector<HTMLElement>(
        `.message[data-message-id="${CSS.escape(message.id)}"]`,
      );
      if (element) elements.transcript.append(element);
    }
  }

  elements.composerShell.hidden = Boolean(session.parentSessionId);
  elements.emptyState.hidden = session.messages.length > 0;
  renderHeader();
  renderPlanMode();
  renderPlanningTasks();
  renderContextMeter();
  renderQueuedMessage();
  syncSessionRunUpdates();
  if (wasFollowingBottom) transcriptScrollPin.scrollToBottom(elements.transcript);
  else elements.transcript.scrollTop = previousScrollTop;
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

function renderModelStatus(): void {
  const config = state.config;
  const session = state.session;
  if (!config) return;
  const model = session?.model ?? config.defaultModel;
  elements.model.textContent = model;
  elements.model.title = model;
  elements.modelSelector.disabled = !session || Boolean(session.parentSessionId) || state.streaming;
  const thinkingLevel = session ? effectiveThinkingLevel(session, config) : "none";
  elements.thinkingLevel.textContent = thinkingLevel;
  elements.thinkingLevelButton.title = `Thinking level: ${thinkingLevel}. Click to select the next level.`;
  elements.thinkingLevelButton.setAttribute("aria-label", elements.thinkingLevelButton.title);
  elements.thinkingLevelButton.disabled = !session || Boolean(session.parentSessionId) || state.streaming;
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
    const copy = document.createElement("span");
    copy.className = "planning-task-copy";
    const subject = document.createElement("strong");
    subject.textContent = task.status === "in_progress" ? task.activeForm : task.subject;
    const meta = document.createElement("small");
    const marker = task.status === "completed" ? "[✓]" : task.status === "in_progress" ? "[~]" : "[ ]";
    const status = task.status.replace("_", " ");
    const activeBlockers = task.blockedBy.filter((id) => !completedIds.has(id));
    const blockedBy = activeBlockers.length > 0 ? ` · blocked by ${activeBlockers.map((id) => `#${id}`).join(", ")}` : "";
    const owner = task.owner ? ` · ${task.owner}` : "";
    meta.textContent = `${marker} #${task.id} · ${status}${blockedBy}${owner}`;
    copy.append(meta, subject);
    item.append(copy);
    elements.planningTaskList.append(item);
  }
}

function renderContextMeter(): void {
  const session = state.session;
  const tokens = session?.contextTokens
    ?? session?.messages.reduce((largest, message) => Math.max(largest, message.usage?.input ?? 0), 0)
    ?? 0;
  const activeModel = state.config?.models.find((model) => model.key === (session?.model ?? state.config?.defaultModel));
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
    : message.kind === "fork-banner" || message.kind === "agent-banner" || message.kind === "plan-banner"
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
      updateStreamingThinkingReveal(
        element,
        thinkingContent,
        message.thinking ?? "",
        message.resyncedThinking === true,
      );
    } else {
      stopStreamingThinkingReveal(element);
      thinkingContent.innerHTML = markdown.render(message.thinking ?? "");
    }
    thinking.open = activelyThinking ? true : wasStreaming ? false : wasOpen;
    const thinkingTokens = Math.ceil((message.thinking?.length ?? 0) / 4).toLocaleString();
    thinkingStatus.textContent = `${thinkingTokens}/toks`;
  } else {
    stopStreamingThinkingReveal(element);
  }
  if (message.kind === "fork-banner" || message.kind === "agent-banner" || message.kind === "plan-banner") {
    const linkedSessionId = message.sourceSessionId ?? message.forkedSessionId;
    const label = message.kind === "agent-banner"
      ? "Agent sub-session of: "
      : message.kind === "plan-banner"
        ? (message.sourceSessionId ? "Plan from session: " : "Plan implementation session: ")
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

function updateStreamingThinkingReveal(
  element: HTMLElement,
  container: HTMLElement,
  thinking: string,
  resumeExisting: boolean,
): void {
  let state = streamingThinkingStates.get(element);
  if (!state) {
    container.replaceChildren();
    let lastThinkingScrollTop = container.scrollTop;
    const onScroll = () => {
      const { scrollTop, clientHeight, scrollHeight } = container;
      const scrolledUp = scrollTop < lastThinkingScrollTop - 1;
      lastThinkingScrollTop = scrollTop;
      // Same rule as the transcript: only an explicit user scroll upwards may
      // unpin; reveal-driven snaps and content growth must stay pinned.
      if (scrollHeight - scrollTop - clientHeight <= STREAMING_THINKING_BOTTOM_THRESHOLD_PX) userScrollUpIntent = false;
      transcriptScrollPin.update(scrollTop, clientHeight, scrollHeight, scrolledUp && userScrollUpIntent);
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    const reveal = new StreamingThinkingReveal((displayed) => {
      if (!element.isConnected) {
        stopStreamingThinkingReveal(element);
        return;
      }
      container.innerHTML = markdown.render(displayed) + '<span class="cursor-block"></span>';
      scrollTranscriptToBottom();
    });
    state = { reveal, container, onScroll };
    streamingThinkingStates.set(element, state);
    if (resumeExisting) reveal.resume(thinking);
    else reveal.update(thinking);
    reveal.start();
    return;
  }
  state.reveal.update(thinking);
}

function stopStreamingThinkingReveal(element: HTMLElement): void {
  const state = streamingThinkingStates.get(element);
  if (!state) return;
  state.reveal.stop();
  state.container.removeEventListener("scroll", state.onScroll);
  streamingThinkingStates.delete(element);
}

function toolStatusText(call: ToolCall): string {
  const label = toolStatusLabel(call);
  const tokens = Math.ceil(call.output.length / 4);
  return tokens > 0 ? `${tokens.toLocaleString()}/toks · ${label}` : label;
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
    status.textContent = toolStatusText(call);
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
      const range = !isDiff ? call.readRange : undefined;
      const count = range ? (range.startLine > 0 ? range.endLine - range.startLine + 1 : 0) : lineCount;
      const rangeText = range
        ? (range.startLine === 0 ? "[0]" : range.startLine === range.endLine ? `[${range.startLine}]` : `[${range.startLine}-${range.endLine}]`)
        : undefined;
      const totalText = range
        ? (range.startLine === 0 ? "Empty" : `${range.totalLines.toLocaleString()} total lines`)
        : undefined;
      summary.textContent = [isDiff ? diffSummary(call.output) : "Output", `${count.toLocaleString()} ${count === 1 ? "line" : "lines"}`, rangeText, totalText]
        .filter(Boolean)
        .join(" · ");
      details.open = toolOutputDisclosurePreferences.get(call.id)
        ?? previousOutputStates.get(call.id)
        ?? shouldExpandToolOutput(isDiff);
      summary.addEventListener("click", () => {
        setTimeout(() => toolOutputDisclosurePreferences.set(call.id, details.open), 0);
      });
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
      if (status) status.textContent = toolStatusText(call);
    }
  }
}

async function refreshCurrentSession(): Promise<boolean> {
  if (!state.session) return false;
  try {
    const snapshot = await api<SessionSnapshot>(`/api/sessions/${state.session.id}`);
    decorateStreamingMessage(snapshot);
    syncPendingInteraction(snapshot);
    updateRenderedSession(snapshot.session);
    syncCompactionProgress(snapshot);
    return snapshot.active;
  } catch {
    // Preserve the last visible state and keep polling: the server may still be running.
    return state.streaming;
  }
}

function setStreaming(streaming: boolean): void {
  state.streaming = streaming;
  if (!streaming) state.aborting = false;
  elements.queue.hidden = !streaming;
  elements.submit.classList.toggle("stop", streaming);
  elements.submit.querySelector("span")!.textContent = streaming ? "STOP" : "SEND";
  elements.prompt.disabled = false;
  renderModelStatus();
  renderPlanMode();
}

function setBusy(busy: boolean): void {
  state.streaming = busy;
  if (!busy) state.aborting = false;
  elements.queue.hidden = true;
  elements.submit.classList.remove("stop");
  elements.submit.querySelector("span")!.textContent = busy ? "WAIT" : "SEND";
  elements.prompt.disabled = busy;
  renderModelStatus();
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

async function authMutation<T = unknown>(path: string, init: RequestInit): Promise<T> {
  const token = state.config?.authActionToken;
  if (!token) throw new Error("Authentication settings are not initialized");
  return api<T>(path, {
    ...init,
    headers: { ...init.headers, "x-amber-auth-action-token": token },
  });
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
  const fileReference = promptFileReferenceAt(elements.prompt.value, elements.prompt.selectionStart);
  if (fileReference) {
    matchingCommands = [];
    void updateFileCompletions(fileReference);
    return;
  }
  directoryCompletionRequest += 1;
  directoryCompletions = [];
  directoryCompletionCommand = null;
  fileReferenceCompletion = null;
  const gitMatches = gitCommandSuggestions(elements.prompt.value);
  if (gitMatches) {
    matchingCommands = gitMatches.map((suggestion) => ({
      name: suggestion.value,
      description: suggestion.description,
      runsDuringResponse: false,
    }));
    selectedCommand = 0;
    if (matchingCommands.length === 0) return hideCommandMenu();
    renderCommandMenu();
    return;
  }
  const value = elements.prompt.value.trim().toLowerCase();
  if (!/^\/[a-z:-]*$/.test(value)) return hideCommandMenu();
  const session = state.session;
  const skillMatches = session
    ? skillCommandSuggestions(sessionSkillCache.get(session.id) ?? [], value, commands)
    : [];
  if (session && value === "/") void refreshSessionSkills(session.id);
  matchingCommands = [
    ...commands.filter((command) => command.name.startsWith(value)),
    ...skillMatches.map((suggestion) => ({
      name: suggestion.value,
      description: suggestion.description,
      runsDuringResponse: false,
    })),
  ];
  selectedCommand = 0;
  if (matchingCommands.length === 0) return hideCommandMenu();
  renderCommandMenu();
}

const sessionSkillCache = new Map<string, { name: string; description: string }[]>();
const sessionSkillFetchMs = new Map<string, number>();

/** Refreshes the cached skill list when the command menu is opened from a bare "/". */
async function refreshSessionSkills(sessionId: string): Promise<void> {
  if (Date.now() - (sessionSkillFetchMs.get(sessionId) ?? 0) < 5_000) return;
  sessionSkillFetchMs.set(sessionId, Date.now());
  try {
    const result = await api<{ skills: { name: string; description: string }[] }>(
      `/api/sessions/${sessionId}/skills`,
    );
    sessionSkillCache.set(sessionId, result.skills);
  } catch {
    sessionSkillFetchMs.delete(sessionId);
    return;
  }
  if (/^\/[a-z:-]*$/.test(elements.prompt.value.trim().toLowerCase())) updateCommandMenu();
}

async function updateDirectoryCompletions(command: "/add-dir" | "/cwd", path: string): Promise<void> {
  const session = state.session;
  if (!session) return hideCommandMenu();
  const sourceValue = elements.prompt.value;
  const request = ++directoryCompletionRequest;
  directoryCompletions = [];
  directoryCompletionCommand = command;
  fileReferenceCompletion = null;
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

async function updateFileCompletions(reference: PromptFileReference): Promise<void> {
  const session = state.session;
  if (!session) return hideCommandMenu();
  const sourceValue = elements.prompt.value;
  const sourceCaret = elements.prompt.selectionStart;
  const request = ++directoryCompletionRequest;
  directoryCompletions = [];
  directoryCompletionCommand = null;
  fileReferenceCompletion = reference;
  selectedCommand = 0;
  elements.commandMenu.hidden = true;
  try {
    const query = new URLSearchParams({ command: "file", path: reference.path });
    const result = await api<{ directories: DirectoryCompletion[] }>(
      `/api/sessions/${session.id}/directory-completions?${query}`,
    );
    if (request !== directoryCompletionRequest
      || elements.prompt.value !== sourceValue
      || elements.prompt.selectionStart !== sourceCaret) return;
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
    button.append(value);
    if (directory.absolutePath !== directory.value) {
      const absolutePath = document.createElement("span");
      absolutePath.textContent = directory.absolutePath;
      button.append(absolutePath);
    }
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => acceptDirectoryCompletion(directory));
    elements.commandMenu.append(button);
  });
  elements.commandMenu.hidden = false;
  elements.commandMenu.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
}

function acceptDirectoryCompletion(directory: DirectoryCompletion): void {
  if (fileReferenceCompletion) {
    const result = replacePromptFileReference(elements.prompt.value, fileReferenceCompletion, directory.value);
    elements.prompt.value = result.value;
    elements.prompt.setSelectionRange(result.caret, result.caret);
    resizePrompt();
    if (directory.kind === "directory") updateCommandMenu();
    else hideCommandMenu();
  } else if (directoryCompletionCommand) {
    setPromptValue(`${directoryCompletionCommand} ${directory.value}`);
    hideCommandMenu();
  } else {
    return;
  }
  elements.prompt.focus();
}

function selectCommand(command: BuiltInCommand, execute: boolean): void {
  const continuesTyping = command.name === "/add-dir" || command.name === "/cwd" || command.name === "/git";
  elements.prompt.value = continuesTyping ? `${command.name} ` : command.name;
  if (continuesTyping) updateCommandMenu();
  else hideCommandMenu();
  resizePrompt();
  if (execute && !continuesTyping) {
    if (state.streaming) void queueCurrentMessage();
    else elements.composer.requestSubmit();
  }
  else elements.prompt.focus();
}

function hideCommandMenu(): void {
  directoryCompletionRequest += 1;
  matchingCommands = [];
  directoryCompletions = [];
  directoryCompletionCommand = null;
  fileReferenceCompletion = null;
  selectedCommand = 0;
  elements.commandMenu.hidden = true;
}

function sessionPromptHistory(): string[] {
  if (!state.session) return [];
  return state.session.messages
    .filter((message) =>
      message.role === "user"
      && message.kind !== "tool-result"
      && message.kind !== "skill"
      && message.kind !== "agent-notification"
    )
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
  if (!transcriptScrollPin.shouldFollowBottom()) return;
  requestAnimationFrame(() => {
    if (!transcriptScrollPin.shouldFollowBottom()) return;
    transcriptScrollPin.scrollToBottom(elements.transcript);
    elements.transcript.querySelectorAll<HTMLElement>(".streaming-thinking .thinking-content").forEach((container) => {
      transcriptScrollPin.scrollToBottom(container);
    });
  });
}

function stickScrollToBottom(): void {
  transcriptScrollPin.reset();
  scrollTranscriptToBottom();
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
