import {
  BottomScrollPin,
  STREAMING_THINKING_BOTTOM_THRESHOLD_PX,
  StreamingThinkingReveal,
} from "./streaming-thinking.js";
import {
  formatTime,
  gitCommandSuggestions,
  messageFrom,
  parseGitCommand,
  promptFileReferenceAt,
  replacePromptFileReference,
  skillCommandSuggestions,
  type PromptFileReference,
} from "./client-formatters.js";
import { api, notify, readEventStream, requiredWithin, responseError } from "./client-api.js";
import { markdown } from "./client-markdown.js";
import { elements, state } from "./client-state.js";
import {
  effectiveModelKey,
  effectiveThinkingLevel,
  renderContextMeter,
  renderHeader,
  renderModelStatus,
  renderPlanMode,
  setBusy,
} from "./client-chrome.js";
import {
  addAgent,
  addApiProvider,
  closeSettingsDialog,
  handleSettingsDialogKeydown,
  openSettingsDialog,
  renderConfig,
  saveSettings,
  saveSettingsAndClose,
  settingsDialogIsBlocking,
  setupAndLoginWithCodex,
} from "./client-settings.js";
import { renderDiff } from "./client-diff.js";
import {
  advanceOrSubmitQuestions,
  closeQuestionDialog,
  declineQuestions,
  handleQuestionDialogKeydown,
  openQuestionDialog,
  questionRequest,
} from "./client-question-dialog.js";
import {
  cancelPlanModeRequest,
  closePlanModeDialog,
  handlePlanModeDialogKeydown,
  openPlanModeDialog,
  planModeRequest,
  setPlanHandoffDispatcher,
  submitPlanModeDecision,
  submitPlanModeNewSessionDecision,
} from "./client-plan-mode-dialog.js";
import {
  closeTasksDialog,
  handleTasksDialogKeydown,
  openTasksDialog,
  showTasksList,
  stopSelectedTask,
} from "./client-tasks-dialog.js";
import {
  closeGitDialog,
  handleGitDialogKeydown,
  openGitDialog,
  runGitDialogCommit,
  setCommitSender,
} from "./client-git-dialog.js";
import {
  closeModelDialog,
  cycleThinkingLevel,
  handleModelDialogKeydown,
  handleModelSearchInput,
  openModelDialog,
} from "./client-model-dialog.js";
import {
  closeSessionDialog,
  handleSessionDialogKeydown,
  handleSessionSearchInput,
  loadSessionList,
  openSessionDialog,
  renderSessionList,
  setSessionDialogHost,
} from "./client-session-dialog.js";
import {
  PLANNING_TASK_STATUS_LABELS,
  type AgentSessionSummary,
  type AskUserQuestionRequest,
  type BackgroundTask,
  type Config,
  type DirectoryCompletion,
  type Message,
  type MessageImage,
  type PlanModeRequest,
  type PlanningTask,
  type Session,
  type SessionPlanMode,
  type SessionSnapshot,
  type ToolCall,
} from "./client-types.js";
import { BUILT_IN_COMMANDS, builtInCommand, type BuiltInCommand } from "./built-in-commands.js";
import { PlanHandoffDispatcher } from "./plan-handoff.js";
import {
  diffSummary,
  isDiffOutput,
  shouldExpandToolOutput,
  shouldInlineToolSubject,
  shouldRenderToolOutput,
  toolMetadata,
  toolStatusLabel,
  toolSubject,
} from "./tool-display.js";
import { ComposerScreensaver } from "./screensaver.js";

const commands = BUILT_IN_COMMANDS;
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
let newSessionReplace = false;
let newSessionCreating = false;
let newSessionReturnsToLanding = false;
let newSessionCompletions: DirectoryCompletion[] = [];
let newSessionCompletionSelection = 0;
let newSessionCompletionRequest = 0;
let sessionRunController: AbortController | null = null;
let sessionRunId: string | null = null;
let sessionRunReconnectTimer: number | undefined;
let agentSessions: AgentSessionSummary[] = [];
let agentSessionsOwnerId: string | null = null;
let dismissedAgentSessionIds = new Set<string>();
let agentSessionsRequest = 0;
let agentSessionsPollTimer: number | undefined;
let queuedMessage: { sessionId: string; content: string; kind: "message" | "command"; queuedAt: number; images?: MessageImage[] } | null = null;

const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 7 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_IMAGES_PER_MESSAGE = 100;
interface PendingImage { mediaType: MessageImage["mediaType"]; data: string; name: string; bytes: number }
let pendingImages: PendingImage[] = [];

const ESC_ABORT_WINDOW_MS = 500;
let lastEscapeForAbortAt = 0;

// Deferred until the current response finishes (or immediately when it already
// has): the decision response and the end of the run's event stream race.
const planHandoffs = new PlanHandoffDispatcher(
  (handoff) => void executePlanHandoff(handoff),
  () => state.streaming,
);

// Back-calls into this module's orchestration, registered for the dialog
// modules so they never need to import client.ts.
setPlanHandoffDispatcher(planHandoffs);
setCommitSender((content) => sendMessage(content));
setSessionDialogHost({ loadSession, openLandingDialog });

const composerScreensaver = new ComposerScreensaver(
  elements.composer,
  elements.prompt,
  { isEnabled: () => Boolean(state.session) },
);
composerScreensaver.restartIdle();

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
    if (settingsDialogIsBlocking()) await openSettingsDialog();
  } catch (error) {
    notify(messageFrom(error));
  } finally {
    elements.app.classList.remove("booting");
  }
}

function wireEvents(): void {
  document.addEventListener("keydown", (event) => {
    if (handleSettingsDialogKeydown(event)) return;
    if (handlePlanModeDialogKeydown(event)) return;
    if (handleNewSessionDialogKeydown(event)) return;
    if (handleQuestionDialogKeydown(event)) return;
    if (handleTasksDialogKeydown(event)) return;
    if (handleGitDialogKeydown(event)) return;
    if (handleSessionDialogKeydown(event)) return;
    if (handleModelDialogKeydown(event)) return;
    if (event.key === "Escape" && (state.streaming || isAgentSessionRunning())) {
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
    openSessionDialog(true);
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
  elements.selectSession.addEventListener("click", () => openSessionDialog());
  elements.sessionDialogClose.addEventListener("click", closeSessionDialog);
  elements.sessionSearch.addEventListener("input", handleSessionSearchInput);
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
  elements.settingsButton.addEventListener("click", () => void openSettingsDialog());
  elements.settingsClose.addEventListener("click", () => void closeSettingsDialog());
  elements.settingsCancel.addEventListener("click", () => void closeSettingsDialog());
  elements.settingsSave.addEventListener("click", () => void saveSettings());
  elements.settingsSaveClose.addEventListener("click", () => void saveSettingsAndClose());
  elements.settingsAddProvider.addEventListener("click", addApiProvider);
  elements.settingsLoginCodex.addEventListener("click", () => void setupAndLoginWithCodex());
  elements.settingsAddAgent.addEventListener("click", addAgent);
  elements.settingsDialog.addEventListener("click", (event) => {
    if (event.target === elements.settingsDialog) void closeSettingsDialog();
  });
  elements.modelSearch.addEventListener("input", handleModelSearchInput);
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
    if (state.streaming || isAgentSessionRunning()) abortCurrentSession();
    else void sendMessage();
  });
  elements.queue.addEventListener("click", () => void queueCurrentMessage());
  elements.attachButton.addEventListener("click", () => elements.fileInput.click());
  elements.fileInput.addEventListener("change", () => {
    void attachImageFiles([...elements.fileInput.files ?? []]);
    elements.fileInput.value = "";
  });
  elements.prompt.addEventListener("paste", (event) => {
    const files = [...event.clipboardData?.files ?? []].filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;
    event.preventDefault();
    void attachImageFiles(files);
  });
  for (const dropTarget of [elements.composerShell, elements.transcript]) {
    dropTarget.addEventListener("dragover", (event) => event.preventDefault());
    dropTarget.addEventListener("drop", (event) => {
      event.preventDefault();
      void attachImageFiles([...event.dataTransfer?.files ?? []]);
    });
  }
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
  syncAgentSessionsForCurrentSession();
  renderModelStatus();
  renderPlanMode();
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

async function sendMessage(queuedContent?: string, queuedImages?: MessageImage[]): Promise<void> {
  const session = state.session;
  const content = (queuedContent ?? elements.prompt.value).trim();
  const images = queuedImages ?? pendingImages.map(({ mediaType, data }) => ({ mediaType, data }));
  if (!session || (!content && images.length === 0) || state.streaming) return;

  // An image plus "/compact" is a message for the model, not a command.
  const commandName = content.split(/\s+/, 1)[0]?.toLowerCase();
  if (images.length === 0 && (commands.some((command) => command.name === commandName) || commandName === "/bashes")) {
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
      body: JSON.stringify({ content, ...(images.length ? { images } : {}) }),
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
      if (planHandoffs.pending) planHandoffs.deliver();
      else sendQueuedMessage(session.id);
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
    if (!session.parentSessionId && state.controller === null) {
      // Covers the re-attached observer stream: a detached client's finally
      // never runs, so the settled stream delivers the handoff here.
      if (planHandoffs.pending) planHandoffs.deliver();
      else sendQueuedMessage(session.id);
    }
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
  if (!session || !state.streaming) return;
  if (!content) {
    if (pendingImages.length > 0) notify("Add text to queue a message with images");
    return;
  }
  const images = pendingImages.map(({ mediaType, data }) => ({ mediaType, data }));
  const command = images.length > 0 ? undefined : builtInCommand(content);
  if (command?.runsDuringResponse) {
    await runCommand(content);
    return;
  }
  const kind: "command" | "message" = command ? "command" : "message";
  const previousQueued = queuedMessage;
  const pending = {
    sessionId: session.id,
    content,
    kind,
    queuedAt: Date.now(),
    ...(kind === "message" && images.length ? { images } : {}),
  };
  queuedMessage = pending;
  renderQueuedMessage();
  let serverRunUnavailable = false;
  try {
    const response = await fetch(`/api/sessions/${session.id}/queued-message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, kind, ...(kind === "message" && images.length ? { images } : {}) }),
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
  if (!alreadyDelivered) void sendMessage(queued.content, queued.images);
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
  elements.queuedMessageContent.textContent = queued
    ? (queued.images?.length
      ? `${queued.content} · ${queued.images.length} ${queued.images.length === 1 ? "image" : "images"}`
      : queued.content)
    : "";
}

function clearPrompt(): void {
  elements.prompt.value = "";
  clearAttachments();
  hideCommandMenu();
  resetPromptHistory();
  resizePrompt();
}

async function attachImageFiles(files: File[]): Promise<void> {
  const supported = files.filter((file) => SUPPORTED_IMAGE_TYPES.has(file.type));
  if (supported.length < files.length) notify("Only JPEG, PNG, GIF, and WebP images can be attached");
  const room = MAX_IMAGES_PER_MESSAGE - pendingImages.length;
  if (room <= 0) return notify(`A message accepts at most ${MAX_IMAGES_PER_MESSAGE} images`);
  if (supported.length > room) notify(`A message accepts at most ${MAX_IMAGES_PER_MESSAGE} images`);
  let totalBytes = pendingImages.reduce((total, image) => total + image.bytes, 0);
  for (const file of supported.slice(0, room)) {
    if (file.size > MAX_IMAGE_BYTES) {
      notify(`${file.name} exceeds the 7 MiB per-image limit`);
      continue;
    }
    if (totalBytes + file.size > MAX_TOTAL_IMAGE_BYTES) {
      notify("Images must total at most 16 MiB per message");
      break;
    }
    try {
      const image = await readPendingImage(file);
      pendingImages.push(image);
      totalBytes += image.bytes;
    } catch {
      notify(`Could not read ${file.name}`);
    }
  }
  renderAttachmentChips();
}

function readPendingImage(file: File): Promise<PendingImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read file"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const marker = ";base64,";
      const markerIndex = result.indexOf(marker);
      if (!result.startsWith("data:") || markerIndex === -1) {
        reject(new Error("Could not read file"));
        return;
      }
      resolve({ mediaType: file.type as MessageImage["mediaType"], data: result.slice(markerIndex + marker.length), name: file.name, bytes: file.size });
    };
    reader.readAsDataURL(file);
  });
}

function renderAttachmentChips(): void {
  elements.attachments.replaceChildren();
  elements.attachments.hidden = pendingImages.length === 0;
  pendingImages.forEach((image, index) => {
    const chip = document.createElement("div");
    chip.className = "attachment-chip";
    const thumbnail = document.createElement("img");
    thumbnail.src = `data:${image.mediaType};base64,${image.data}`;
    thumbnail.alt = "";
    const name = document.createElement("span");
    name.className = "attachment-name";
    name.textContent = image.name;
    name.title = image.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "attachment-remove";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove ${image.name}`);
    remove.addEventListener("click", () => {
      pendingImages.splice(index, 1);
      renderAttachmentChips();
    });
    chip.append(thumbnail, name, remove);
    elements.attachments.append(chip);
  });
}

function clearAttachments(): void {
  pendingImages = [];
  renderAttachmentChips();
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

function isAgentSessionRunning(): boolean {
  const session = state.session;
  return Boolean(session?.parentSessionId) && (session!.agentStatus === "running"
    || session!.messages.some((message) => message.status === "streaming"));
}

function abortCurrentSession(): void {
  const session = state.session;
  if (!session || state.aborting) return;
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

function applyToolUpdate(session: Session, payload: { messageId: string; toolCall: ToolCall }): void {
  const message = session.messages.find((candidate) => candidate.id === payload.messageId);
  if (!message) return;
  const calls = (message.toolCalls ??= []);
  const index = calls.findIndex((call) => call.id === payload.toolCall.id);
  if (index >= 0) calls[index] = payload.toolCall;
  else calls.push(payload.toolCall);
  updateMessage(messageElement(message.id), message);
  if (payload.toolCall.name === "Agent" && payload.toolCall.agentSessionId) {
    scheduleAgentSessionsRefresh(0);
  }
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
  elements.emptyState.hidden = session.messages.length > 0;
  for (const message of session.messages) {
    if (message.kind !== "tool-result" && message.kind !== "skill" && message.kind !== "agent-notification") {
      appendMessage(message);
    }
  }
  resetPromptHistory();
  closeHistorySearch(false);
  renderHeader();
  renderComposer();
  renderPlanMode();
  renderPlanningTasks();
  syncAgentSessionsForCurrentSession();
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

  elements.emptyState.hidden = session.messages.length > 0;
  renderHeader();
  renderComposer();
  renderPlanMode();
  renderPlanningTasks();
  syncAgentSessionsForCurrentSession();
  renderContextMeter();
  renderQueuedMessage();
  syncSessionRunUpdates();
  if (wasFollowingBottom) transcriptScrollPin.scrollToBottom(elements.transcript);
  else elements.transcript.scrollTop = previousScrollTop;
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

function renderPlanningTasks(): void {
  elements.planningTaskList.replaceChildren();
  const session = state.session;
  const archiveHighWaterMark = session?.planningTaskArchiveHighWaterMark ?? 0;
  const allTasks = (session?.planningTasks ?? [])
    .filter((task) => Number(task.id) > archiveHighWaterMark)
    .sort((left, right) => {
      const statusOrder = { in_progress: 0, pending: 1, completed: 2 } as const;
      return statusOrder[left.status] - statusOrder[right.status]
        || Number(left.id) - Number(right.id);
    });
  const tasks = allTasks.length > 0 && allTasks.every((task) => task.status === "completed") ? [] : allTasks;
  if (tasks.length === 0) {
    const empty = document.createElement("div");
    empty.className = "planning-task-empty";
    empty.textContent = "No active tasks in this session";
    elements.planningTaskList.append(empty);
    return;
  }
  for (const task of tasks) {
    const item = document.createElement("div");
    item.className = `planning-task-item ${task.status}`;
    item.title = task.description;
    const copy = document.createElement("span");
    copy.className = "planning-task-copy";
    const subject = document.createElement("strong");
    const description = task.status === "in_progress" ? task.activeForm : task.subject;
    const status = document.createElement("span");
    status.className = "planning-task-status";
    status.textContent = `[${PLANNING_TASK_STATUS_LABELS[task.status]}]`;
    subject.append(status, ` ${description.replace(/\s+/g, " ").trim()}`);
    copy.append(subject);
    item.append(copy);
    elements.planningTaskList.append(item);
  }
}

function syncAgentSessionsForCurrentSession(): void {
  const sessionId = state.session?.id ?? null;
  if (agentSessionsOwnerId === sessionId) return;
  agentSessionsRequest += 1;
  if (agentSessionsPollTimer !== undefined) window.clearTimeout(agentSessionsPollTimer);
  agentSessionsPollTimer = undefined;
  agentSessionsOwnerId = sessionId;
  agentSessions = [];
  dismissedAgentSessionIds = new Set();
  renderAgentSessions();
  if (sessionId) scheduleAgentSessionsRefresh(0);
}

function scheduleAgentSessionsRefresh(delayMs = 1_000): void {
  const sessionId = state.session?.id;
  if (!sessionId || agentSessionsOwnerId !== sessionId) return;
  if (agentSessionsPollTimer !== undefined) {
    if (delayMs > 0) return;
    window.clearTimeout(agentSessionsPollTimer);
  }
  agentSessionsPollTimer = window.setTimeout(() => {
    agentSessionsPollTimer = undefined;
    void refreshAgentSessions(sessionId);
  }, delayMs);
}

async function refreshAgentSessions(sessionId: string): Promise<void> {
  const request = ++agentSessionsRequest;
  try {
    const result = await api<{ agents: AgentSessionSummary[] }>(`/api/sessions/${sessionId}/agents`);
    if (request !== agentSessionsRequest || state.session?.id !== sessionId) return;
    const currentCohort = result.agents.filter((agent) => !dismissedAgentSessionIds.has(agent.id));
    if (currentCohort.length > 0 && currentCohort.every((agent) => agent.status !== "running")) {
      for (const agent of currentCohort) dismissedAgentSessionIds.add(agent.id);
      agentSessions = [];
    } else {
      agentSessions = currentCohort;
    }
    renderAgentSessions();
  } catch {
    // Preserve the last snapshot and retry while the session or an agent is active.
  } finally {
    if (request !== agentSessionsRequest || state.session?.id !== sessionId) return;
    if (state.streaming || agentSessions.some((agent) => agent.status === "running")) {
      scheduleAgentSessionsRefresh();
    }
  }
}

function renderAgentSessions(): void {
  elements.activeAgentList.replaceChildren();
  if (agentSessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "active-agent-empty";
    empty.textContent = "No agents spawned";
    elements.activeAgentList.append(empty);
    return;
  }

  for (const agent of agentSessions) {
    const link = document.createElement("a");
    link.className = `active-agent-item ${agent.status}`;
    link.href = `/s/${agent.id}`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.title = agent.description;
    link.setAttribute("aria-label", `${agent.description} · ${agent.status} · open agent session`);

    const description = document.createElement("strong");
    description.className = "active-agent-description";
    description.textContent = shortenAgentDescription(agent.description);
    const meta = document.createElement("span");
    meta.className = "active-agent-meta";
    const session = document.createElement("span");
    session.className = "active-agent-session";
    session.textContent = `↗ ${agent.id.slice(agent.id.lastIndexOf(".") + 1)}`;
    session.title = agent.id;
    const status = document.createElement("span");
    status.className = `active-agent-status ${agent.status}`;
    status.textContent = agent.status;
    meta.append(session, status);
    link.append(description, meta);
    elements.activeAgentList.append(link);
  }
}

function shortenAgentDescription(description: string): string {
  const compact = description.replace(/\s+/g, " ").trim();
  return compact.length <= 42 ? compact : `${compact.slice(0, 41).trimEnd()}…`;
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
      <div class="message-images"></div>
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
  renderMessageImages(requiredWithin(element, ".message-images"), message.images ?? []);
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

function renderMessageImages(container: HTMLElement, images: MessageImage[]): void {
  container.replaceChildren();
  container.hidden = images.length === 0;
  for (const image of images) {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.src = `data:${image.mediaType};base64,${image.data}`;
    img.alt = "Attached image";
    img.addEventListener("click", () => img.classList.toggle("expanded"));
    container.append(img);
  }
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
    const images = call.images?.length ? call.images : persistedToolResultImages(call.id);
    if (images.length) {
      const callImages = document.createElement("div");
      callImages.className = "tool-call-images";
      for (const image of images) {
        const img = document.createElement("img");
        img.loading = "lazy";
        img.src = `data:${image.mediaType};base64,${image.data}`;
        img.alt = "Tool result image";
        callImages.append(img);
      }
      card.append(callImages);
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

function persistedToolResultImages(toolUseId: string): MessageImage[] {
  return state.session?.messages.find((message) =>
    message.kind === "tool-result" && message.toolUseId === toolUseId)?.images ?? [];
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
  if (streaming) {
    syncAgentSessionsForCurrentSession();
    scheduleAgentSessionsRefresh(0);
  }
}

/**
 * Agent sub-sessions are read-only: the prompt is disabled and the composer is
 * hidden except while the agent runs, where the stop button is shown so the
 * user can abort just that agent.
 */
function renderComposer(): void {
  const session = state.session!;
  if (!session.parentSessionId) {
    elements.composerShell.hidden = false;
    elements.attachButton.hidden = false;
    return;
  }
  const running = session.agentStatus === "running"
    || session.messages.some((message) => message.status === "streaming");
  elements.composerShell.hidden = !running;
  elements.attachButton.hidden = true;
  elements.queue.hidden = true;
  elements.prompt.disabled = true;
  elements.submit.classList.toggle("stop", running);
  elements.submit.querySelector("span")!.textContent = running ? "STOP" : "SEND";
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
