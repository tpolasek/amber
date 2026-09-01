import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { browserUrl, openBrowser } from "./browser-launch.js";
import { builtInCommand } from "./built-in-commands.js";
import { SessionStore } from "./store.js";
import { ProviderCatalog } from "./provider-catalog.js";
import { loadSettings } from "./settings.js";
import { AuthStorage } from "./auth-storage.js";
import { OpenAICodexAuth } from "./openai-codex-oauth.js";
import { buildProviderHistory, isModelMessage, isProviderMessage } from "./history.js";
import { generateSessionTitle, shouldAutoNameSession } from "./session-title.js";
import { estimateHistoryTokens, formatCompactionBanner, generateCompactionSummary, shouldAutoCompact } from "./compaction.js";
import { BASH_TOOL, BashExecutor, parseBashInput } from "./bash-tool.js";
import { BackgroundTaskManager } from "./background-tasks.js";
import {
  TASK_OUTPUT_TOOL,
  TASK_STOP_TOOL,
  executeTaskOutput,
  executeTaskStop,
  parseTaskOutputInput,
  parseTaskStopInput,
  type BackgroundAgentSource,
} from "./task-tools.js";
import { executePlanningTaskTool, PLANNING_TASK_TOOLS } from "./planning-task-tools.js";
import {
  discoverNestedProjectRoots,
  discoverSkills,
  expandSkill,
  invocableSkills,
  parseSkillInput,
  renderSkillReminder,
  resolveSkill,
  resolveSkillModel,
  skillInvocationPreview,
  SKILL_TOOL_NAME,
  type SkillDefinition,
  type SkillDiscoveryContext,
} from "./skill-tool.js";
import { clearImageReadCache, executeFileTool, FILE_TOOLS } from "./file-tools.js";
import { executeGrep, GREP_TOOL, parseGrepInput } from "./grep-tool.js";
import { executeGlob, GLOB_TOOL, parseGlobInput } from "./glob-tool.js";
import { completeDirectories, completeDirectoryRoots, completeFiles } from "./directory-completion.js";
import { ToolLoopTracker, formatToolLoopError } from "./tool-loop-tracker.js";
import { AGENT_TOOL_NAME, getAgentDefinition, parseAgentInput, resolveAgentModel, startAgentRuns } from "./agent-tool.js";
import { ActiveSessionRuns, abortSessionOperations } from "./session-aborts.js";
import { SessionInputPriorityQueue } from "./session-queue.js";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  AskUserQuestionManager,
  formatAskUserQuestionResult,
  parseAskUserQuestionInput,
} from "./ask-user-question-tool.js";
import {
  buildClaudeCodeAgentSystemPrompt,
  buildClaudeCodeSystemPrompt,
  createClaudeCodeTools,
  injectClaudeCodeUserContext,
  structureClaudeCodeUserMessages,
  toolsForAgentMode,
  toolsForPlanMode,
} from "./claude-code-compatibility.js";
import {
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  PlanModeApprovalManager,
  ensurePlanFile,
  formatEnterPlanModeDeclinedResult,
  formatEnterPlanModeResult,
  formatExitPlanModeApprovedResult,
  formatExitPlanModeCancelledResult,
  formatExitPlanModeNewSessionResult,
  formatExitPlanModeRejectedResult,
  parseEnterPlanModeInput,
  parseExitPlanModeInput,
  parsePlanModeDecision,
  parsePlanModeToggleInput,
  planFilePath,
  planModeSystemBlock,
  readPlanSnapshot,
} from "./plan-mode.js";
import type { LlmProvider, ThinkingLevel, ToolDefinition } from "./types.js";
import type { Message, MessageImage, Session, SessionInvokedSkill, TokenUsage, ToolCall } from "./types.js";
import { MAX_MESSAGE_BODY_BYTES, parseMessageImages, providerImageLimitError } from "./message-images.js";
import { parseThinkingLevel } from "./thinking-level.js";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(sourceDirectory, "../..");
const isPackaged = Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg);
const workspaceRoot = await realpath(isPackaged ? process.cwd() : projectRoot);
const publicDirectory = join(projectRoot, "public");
const buildVersion = await resolveBuildVersion();
const clientScript = join(sourceDirectory, "client.js");
const clientFormattersScript = join(sourceDirectory, "client-formatters.js");
const builtInCommandsScript = join(sourceDirectory, "built-in-commands.js");
const streamingThinkingScript = join(sourceDirectory, "streaming-thinking.js");
const toolDisplayScript = join(sourceDirectory, "tool-display.js");
const thinkingLevelScript = join(sourceDirectory, "thinking-level.js");
const planHandoffScript = join(sourceDirectory, "plan-handoff.js");
const markdownScript = join(projectRoot, "node_modules", "markdown-it", "dist", "browser", "markdown-it.umd.min.js");
const amberDirectory = join(homedir(), ".amber");
const defaultDataDirectory = join(amberDirectory, "data", "sessions");
const dataDirectory = resolve(process.env.DATA_DIR ?? defaultDataDirectory);
const planDirectory = join(amberDirectory, "plans");
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const store = new SessionStore(dataDirectory, planDirectory);
const authStorage = new AuthStorage(join(amberDirectory, "auth.json"));
const openAICodexAuth = new OpenAICodexAuth({ storage: authStorage });
const authActionToken = randomUUID();
const settings = await loadSettings();
const agentDefinitions = settings.agents;
let providerCatalog = await loadProviderCatalog();
let provider = providerCatalog.provider(undefined);
validateAgentModels(providerCatalog);
const loginCatalogActivations = new Map<string, Promise<void>>();
const claudeCodeTools = createClaudeCodeTools(agentDefinitions);
const activeSessions = new ActiveSessionRuns();
const queuedSessionMessages = new SessionInputPriorityQueue();
const interruptibleSessions = new Set<string>();
const backgroundTasks = new BackgroundTaskManager();
const askUserQuestions = new AskUserQuestionManager();
const planModeApprovals = new PlanModeApprovalManager();
const agentRunToken = randomUUID();
const SESSION_PATH_ID = "([a-z0-9.-]+)";
const sessionEventSubscribers = new Map<string, Set<ServerResponse>>();

interface AutomaticNameRun {
  controller: AbortController;
  sessions: Set<Session>;
  listeners: Set<(title: string) => void>;
  completion: Promise<void>;
}

const automaticNameRuns = new Map<string, AutomaticNameRun>();

await store.initialize();

const server = createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
    console.error(error);
    if (!response.headersSent) json(response, 500, { error: "Internal server error" });
    else response.end();
  }
});

server.listen(port, host, () => {
  const url = browserUrl(host, port);
  console.log(`\n  AMBER agent online at ${url}`);
  console.log(`  provider: ${provider.name} / ${provider.model} (${provider.mode})\n`);
  openBrowser(url);
});

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  activeSessions.abortAll();
  for (const run of compactionRuns.values()) run.controller.abort();
  backgroundTasks.stopAll();
  askUserQuestions.stopAll();
  planModeApprovals.stopAll();
  openAICodexAuth.dispose();
  for (const run of automaticNameRuns.values()) run.controller.abort();
  automaticNameRuns.clear();
  for (const subscribers of sessionEventSubscribers.values()) {
    for (const response of subscribers) response.end();
  }
  sessionEventSubscribers.clear();
  server.close();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (method === "GET" && url.pathname === "/api/config") {
    return json(response, 200, {
      provider: provider.name,
      model: provider.model,
      defaultModel: providerCatalog.defaultModel,
      models: providerCatalog.models,
      mode: provider.mode,
      homeDirectory: homedir(),
      workspaceRoot,
      authActionToken,
      theme: settings.theme ?? "dark",
    });
  }
  if (method === "GET" && url.pathname === "/api/auth") {
    return json(response, 200, {
      providers: [{
        id: "openai-codex",
        name: "OpenAI Codex",
        authName: "ChatGPT Plus/Pro",
        configured: await openAICodexAuth.configured(),
        providerConfigured: Object.values(settings.providers).some((candidate) => candidate.auth === "openai-codex"),
      }],
    });
  }
  if (method === "POST" && url.pathname === "/api/auth/openai-codex/login") {
    if (!authorizeAuthMutation(request, response)) return;
    const body = await readJson(request);
    try {
      if (body.method === "browser") return json(response, 201, await openAICodexAuth.beginBrowserLogin());
      if (body.method === "device_code") return json(response, 201, await openAICodexAuth.beginDeviceLogin());
      return json(response, 400, { error: "Login method must be browser or device_code" });
    } catch (error) {
      return json(response, 409, { error: errorMessage(error) });
    }
  }
  const authLoginMatch = url.pathname.match(/^\/api\/auth\/openai-codex\/logins\/([a-z0-9-]+)$/);
  if (method === "GET" && authLoginMatch?.[1]) {
    try {
      const status = openAICodexAuth.loginStatus(authLoginMatch[1]);
      await activateCompletedLogin(authLoginMatch[1], status);
      return json(response, 200, status);
    } catch (error) {
      return json(response, 404, { error: errorMessage(error) });
    }
  }
  const authManualMatch = url.pathname.match(/^\/api\/auth\/openai-codex\/logins\/([a-z0-9-]+)\/manual$/);
  if (method === "POST" && authManualMatch?.[1]) {
    if (!authorizeAuthMutation(request, response)) return;
    const body = await readJson(request);
    if (typeof body.input !== "string" || !body.input.trim()) {
      return json(response, 400, { error: "Authorization code or redirect URL is required" });
    }
    try {
      await openAICodexAuth.completeBrowserLogin(authManualMatch[1], body.input);
      const status = openAICodexAuth.loginStatus(authManualMatch[1]);
      await activateCompletedLogin(authManualMatch[1], status);
      return json(response, 200, status);
    } catch (error) {
      return json(response, 400, { error: errorMessage(error) });
    }
  }
  if (method === "DELETE" && authLoginMatch?.[1]) {
    if (!authorizeAuthMutation(request, response)) return;
    openAICodexAuth.cancelLogin(authLoginMatch[1]);
    return json(response, 200, { cancelled: true });
  }
  if (method === "DELETE" && url.pathname === "/api/auth/openai-codex") {
    if (!authorizeAuthMutation(request, response)) return;
    await openAICodexAuth.logout();
    return json(response, 200, { configured: false });
  }
  if (method === "POST" && url.pathname === "/api/run") {
    return runPrompt(request, response);
  }
  if (method === "GET" && url.pathname === "/api/sessions") {
    return json(response, 200, { sessions: await store.list() });
  }
  if (method === "POST" && url.pathname === "/api/sessions") {
    const body = await readJson(request);
    const rawName = body.name;
    const name = typeof rawName === "string" ? rawName.replace(/\s+/g, " ").trim() : "";
    if (rawName !== undefined && typeof rawName !== "string") {
      return json(response, 400, { error: "Session name must be a string" });
    }
    if (name.length > 80) return json(response, 400, { error: "Session names must be 80 characters or fewer" });
    const path = typeof body.path === "string" ? body.path.trim() : "";
    if (!path) return json(response, 400, { error: "A working path is required" });
    try {
      const directory = await resolveAddedDirectory(path);
      const session = await store.create();
      session.model = providerCatalog.defaultModel;
      if (name) session.title = name;
      if (directory !== workspaceRoot) session.directories = [directory];
      session.cwd = directory;
      session.addDirInitialized = true;
      await store.save(session);
      return json(response, 201, { session });
    } catch (error) {
      return json(response, 400, { error: `Could not add directory: ${errorMessage(error)}` });
    }
  }
  if (method === "GET" && url.pathname === "/api/directory-completions") {
    const fragment = url.searchParams.get("path") ?? "";
    if (fragment.includes("\0") || fragment.includes("\n") || fragment.length > 4_096) {
      return json(response, 400, { error: "Invalid directory completion path" });
    }
    return json(response, 200, { directories: await completeDirectories(fragment, workspaceRoot) });
  }

  const sessionMatch = url.pathname.match(new RegExp(`^/api/sessions/${SESSION_PATH_ID}$`));
  if (method === "GET" && sessionMatch?.[1]) {
    const session = activeSessions.session(sessionMatch[1]) ?? await store.get(sessionMatch[1]);
    return session
      ? json(response, 200, await sessionSnapshot(session))
      : json(response, 404, { error: "Session not found" });
  }

  const sessionModelMatch = url.pathname.match(new RegExp(`^/api/sessions/${SESSION_PATH_ID}/model$`));
  if (method === "POST" && sessionModelMatch?.[1]) {
    if (activeSessions.has(sessionModelMatch[1])) {
      return json(response, 409, { error: "Wait for the current response to finish" });
    }
    const session = await store.get(sessionModelMatch[1]);
    if (!session) return json(response, 404, { error: "Session not found" });
    if (session.parentSessionId) return json(response, 403, { error: "Agent sub-sessions are read-only" });
    const body = await readJson(request);
    const model = typeof body.model === "string" ? body.model.trim() : "";
    if (!providerCatalog.has(model)) return json(response, 400, { error: `Model '${model}' is not configured` });
    session.model = model;
    await store.save(session);
    return json(response, 200, { session });
  }

  const sessionThinkingLevelMatch = url.pathname.match(new RegExp(`^/api/sessions/${SESSION_PATH_ID}/thinking-level$`));
  if (method === "POST" && sessionThinkingLevelMatch?.[1]) {
    if (activeSessions.has(sessionThinkingLevelMatch[1])) {
      return json(response, 409, { error: "Thinking level can only be changed when the session is ready for a new prompt" });
    }
    const session = await store.get(sessionThinkingLevelMatch[1]);
    if (!session) return json(response, 404, { error: "Session not found" });
    if (session.parentSessionId) return json(response, 403, { error: "Agent sub-sessions are read-only" });
    try {
      session.thinkingLevel = parseThinkingLevel((await readJson(request)).thinkingLevel);
      await store.save(session);
      return json(response, 200, { session });
    } catch (error) {
      return json(response, 400, { error: errorMessage(error) });
    }
  }

  const sessionEventsMatch = url.pathname.match(new RegExp(`^/api/sessions/${SESSION_PATH_ID}/events$`));
  if (method === "GET" && sessionEventsMatch?.[1]) {
    return observeSessionEvents(request, response, sessionEventsMatch[1]);
  }
  if (method === "DELETE" && sessionMatch?.[1]) {
    // Finish abort cleanup before checking active state so deleting during an
    // already-registered compaction does not require a second attempt.
    const compaction = compactionRuns.get(sessionMatch[1]);
    if (compaction) {
      compaction.controller.abort();
      await compaction.completion;
    }
    if (activeSessions.has(sessionMatch[1])) return json(response, 409, { error: "Wait for the current response to finish" });
    await stopAutomaticSessionName(sessionMatch[1]);
    const removed = await store.remove(sessionMatch[1]);
    if (removed) backgroundTasks.stopSession(sessionMatch[1]);
    return removed
      ? json(response, 200, { deletedSessionId: sessionMatch[1] })
      : json(response, 404, { error: "Session not found" });
  }

  const abortMatch = url.pathname.match(new RegExp(`^/api/sessions/${SESSION_PATH_ID}/abort$`));
  if (method === "POST" && abortMatch?.[1]) {
    const session = await store.get(abortMatch[1]);
    if (!session) return json(response, 404, { error: "Session not found" });
    if (session.parentSessionId) return json(response, 403, { error: "Agent sub-sessions are read-only" });
    const { sessionIds, backgroundTaskIds } = await abortSessionOperations(
      session.id,
      activeSessions,
      backgroundTasks,
      () => store.family(session.id),
      (sessionId) => compactionRuns.get(sessionId)?.controller.abort(),
    );
    return json(response, 200, {
      aborted: sessionIds.length > 0 || backgroundTaskIds.length > 0,
      sessionIds,
      backgroundTaskIds,
    });
  }

  const planModeToggleMatch = url.pathname.match(new RegExp(`^/api/sessions/${SESSION_PATH_ID}/plan-mode$`));
  if (method === "POST" && planModeToggleMatch?.[1]) {
    if (activeSessions.has(planModeToggleMatch[1])) {
      return json(response, 409, { error: "Plan mode can only be changed when the session is ready for a new prompt" });
    }
    const session = await store.get(planModeToggleMatch[1]);
    if (!session) return json(response, 404, { error: "Session not found" });
    if (session.parentSessionId) return json(response, 403, { error: "Agent sub-sessions are read-only" });
    try {
      const { active } = parsePlanModeToggleInput(await readJson(request));
      if (active) {
        const filePath = session.planMode?.planFilePath ?? planFilePath(planDirectory, session.id);
        await ensurePlanFile(filePath);
        session.planMode = { active: true, planFilePath: filePath };
      } else if (session.planMode) {
        session.planMode.active = false;
      }
      await store.save(session);
      return json(response, 200, { session });
    } catch (error) {
      return json(response, 400, { error: errorMessage(error) });
    }
  }

  const messageMatch = url.pathname.match(new RegExp(`^/api/sessions/${SESSION_PATH_ID}/messages$`));
  if (method === "POST" && messageMatch?.[1]) {
    return streamMessage(request, response, messageMatch[1]);
  }

  const queuedMessageMatch = url.pathname.match(new RegExp(`^/api/sessions/${SESSION_PATH_ID}/queued-message$`));
  if (method === "POST" && queuedMessageMatch?.[1]) {
    const session = await store.get(queuedMessageMatch[1]);
    if (!session) return json(response, 404, { error: "Session not found" });
    if (session.parentSessionId) return json(response, 403, { error: "Agent sub-sessions are read-only" });
    const body = await readJson(request, MAX_MESSAGE_BODY_BYTES);
    const content = typeof body.content === "string" ? body.content.trim() : "";
    const kind = body.kind === "command" ? "command" : body.kind === "message" ? "message" : undefined;
    const parsedImages = parseMessageImages(body.images);
    if ("error" in parsedImages) return json(response, 400, { error: parsedImages.error });
    const images = parsedImages.images;
    if ((!content && images.length === 0) || content.length > 32_000) {
      return json(response, 400, { error: "Message must contain text or images; text is limited to 32,000 characters" });
    }
    if (!kind) return json(response, 400, { error: "Queued input kind must be message or command" });
    if (kind === "command" && images.length > 0) {
      return json(response, 400, { error: "Queued commands cannot include images" });
    }
    if (kind === "command" && !builtInCommand(content)) {
      return json(response, 400, { error: "Queued command is not a built-in command" });
    }
    if (kind === "message") {
      const limitError = sessionImageLimitError(session, {
        id: randomUUID(), role: "user", content, createdAt: new Date().toISOString(), status: "complete",
        ...(images.length ? { images } : {}),
      });
      if (limitError) return json(response, 400, { error: limitError });
    }
    if (!interruptibleSessions.has(queuedMessageMatch[1])) {
      return json(response, 409, { error: "The session is not streaming" });
    }
    queuedSessionMessages.enqueueUser(queuedMessageMatch[1], { content, kind, ...(images.length ? { images } : {}) });
    return json(response, 202, { queued: true });
  }

  const commandMatch = url.pathname.match(new RegExp(`^/api/sessions/${SESSION_PATH_ID}/commands$`));
  if (method === "POST" && commandMatch?.[1]) {
    return executeCommand(request, response, commandMatch[1]);
  }

  const tasksMatch = url.pathname.match(new RegExp(`^/api/sessions/${SESSION_PATH_ID}/tasks$`));
  if (method === "GET" && tasksMatch?.[1]) {
    const session = await store.get(tasksMatch[1]);
    return session
      ? json(response, 200, { tasks: backgroundTasks.list(tasksMatch[1]) })
      : json(response, 404, { error: "Session not found" });
  }

  const skillsMatch = url.pathname.match(new RegExp(`^/api/sessions/${SESSION_PATH_ID}/skills$`));
  if (method === "GET" && skillsMatch?.[1]) {
    const session = activeSessions.session(skillsMatch[1]) ?? await store.get(skillsMatch[1]);
    if (!session) return json(response, 404, { error: "Session not found" });
    const skills = invocableSkills(
      await sessionSkills(session),
      session.skillTouchedPaths ?? [],
      sessionWorkingDirectory(session),
    ).filter((skill) => skill.userInvocable);
    return json(response, 200, {
      skills: skills.map((skill) => ({ name: skill.name, description: skill.description })),
    });
  }

  const gitMatch = url.pathname.match(new RegExp(`^/api/sessions/${SESSION_PATH_ID}/git$`));
  if (method === "GET" && gitMatch?.[1]) {
    const session = await store.get(gitMatch[1]);
    if (!session) return json(response, 404, { error: "Session not found" });
    const gitCommand = url.searchParams.get("command");
    if (gitCommand !== "diff" && gitCommand !== "show" && gitCommand !== "status") {
      return json(response, 400, { error: "git command must be diff, show, or status" });
    }
    const controller = new AbortController();
    request.once("aborted", () => controller.abort());
    try {
      const result = await new BashExecutor().run(
        { command: `git ${gitCommand}`, timeoutMs: 30_000 },
        sessionDirectories(session),
        controller.signal,
        { onRunning: () => undefined, onOutput: () => undefined },
      );
      return json(response, 200, {
        command: gitCommand,
        output: result.output,
        exitCode: result.exitCode,
        status: result.status,
      });
    } catch (error) {
      return json(response, 500, { error: errorMessage(error) });
    }
  }

  const questionAnswerMatch = url.pathname.match(
    new RegExp(`^/api/sessions/${SESSION_PATH_ID}/questions/([^/]+)/answers$`),
  );
  if (method === "POST" && questionAnswerMatch?.[1] && questionAnswerMatch[2]) {
    const session = await store.get(questionAnswerMatch[1]);
    if (!session) return json(response, 404, { error: "Session not found" });
    const body = await readJson(request);
    const toolUseId = decodeURIComponent(questionAnswerMatch[2]);
    try {
      if (body.cancelled === true) {
        askUserQuestions.decline(questionAnswerMatch[1], toolUseId);
        return json(response, 200, { cancelled: true });
      }
      const answers = askUserQuestions.answer(questionAnswerMatch[1], toolUseId, body.answers);
      return json(response, 200, { answers });
    } catch (error) {
      return json(response, 400, { error: errorMessage(error) });
    }
  }

  const planModeDecisionMatch = url.pathname.match(
    new RegExp(`^/api/sessions/${SESSION_PATH_ID}/plan-mode/([^/]+)/decision$`),
  );
  if (method === "POST" && planModeDecisionMatch?.[1] && planModeDecisionMatch[2]) {
    const session = await store.get(planModeDecisionMatch[1]);
    if (!session) return json(response, 404, { error: "Session not found" });
    if (session.parentSessionId) return json(response, 403, { error: "Agent sub-sessions are read-only" });
    const body = await readJson(request);
    const toolUseId = decodeURIComponent(planModeDecisionMatch[2]);
    try {
      const decision = parsePlanModeDecision(body);
      if (decision.newSession) {
        if (planModeApprovals.pendingKind(planModeDecisionMatch[1], toolUseId) !== "exit") {
          throw new Error("Implementing in a new session requires a plan review request");
        }
        const implementationBanner: Message = {
          id: randomUUID(),
          role: "assistant",
          content: `Plan from session: ${session.id}`,
          createdAt: new Date().toISOString(),
          status: "complete",
          kind: "plan-banner",
          sourceSessionId: session.id,
        };
        const implementation = await store.createPlanImplementation(session, implementationBanner);
        const settled = planModeApprovals.decideParsed(planModeDecisionMatch[1], toolUseId, {
          ...decision,
          newSessionId: implementation.id,
        });
        return json(response, 200, { decision: settled });
      }
      return json(response, 200, { decision: planModeApprovals.decideParsed(planModeDecisionMatch[1], toolUseId, decision) });
    } catch (error) {
      return json(response, 400, { error: errorMessage(error) });
    }
  }

  const taskStopMatch = url.pathname.match(new RegExp(`^/api/sessions/${SESSION_PATH_ID}/tasks/([a-z0-9]+)/stop$`));
  if (method === "POST" && taskStopMatch?.[1] && taskStopMatch[2]) {
    const session = await store.get(taskStopMatch[1]);
    if (!session) return json(response, 404, { error: "Session not found" });
    try {
      return json(response, 200, { task: backgroundTasks.stop(taskStopMatch[1], taskStopMatch[2]) });
    } catch (error) {
      return json(response, 400, { error: errorMessage(error) });
    }
  }

  const completionMatch = url.pathname.match(new RegExp(`^/api/sessions/${SESSION_PATH_ID}/directory-completions$`));
  if (method === "GET" && completionMatch?.[1]) {
    return listDirectoryCompletions(response, completionMatch[1], url);
  }

  if (method === "GET" && url.pathname === "/app.js") {
    return serveFile(response, clientScript, "text/javascript; charset=utf-8", "no-cache");
  }
  if (method === "GET" && url.pathname === "/client-formatters.js") {
    return serveFile(response, clientFormattersScript, "text/javascript; charset=utf-8", "no-cache");
  }
  if (method === "GET" && url.pathname === "/built-in-commands.js") {
    return serveFile(response, builtInCommandsScript, "text/javascript; charset=utf-8", "no-cache");
  }
  if (method === "GET" && url.pathname === "/streaming-thinking.js") {
    return serveFile(response, streamingThinkingScript, "text/javascript; charset=utf-8", "no-cache");
  }
  if (method === "GET" && url.pathname === "/tool-display.js") {
    return serveFile(response, toolDisplayScript, "text/javascript; charset=utf-8", "no-cache");
  }
  if (method === "GET" && url.pathname === "/thinking-level.js") {
    return serveFile(response, thinkingLevelScript, "text/javascript; charset=utf-8", "no-cache");
  }
  if (method === "GET" && url.pathname === "/plan-handoff.js") {
    return serveFile(response, planHandoffScript, "text/javascript; charset=utf-8", "no-cache");
  }
  if (method === "GET" && url.pathname === "/vendor/markdown-it.js") {
    return serveFile(response, markdownScript, "text/javascript; charset=utf-8", "public, max-age=31536000, immutable");
  }
  if (method === "GET" && url.pathname === "/styles.css") {
    return serveFile(response, join(publicDirectory, "styles.css"), "text/css; charset=utf-8", "no-cache");
  }
  if (method === "GET" && url.pathname === "/themes.css") {
    return serveFile(response, join(publicDirectory, "themes.css"), "text/css; charset=utf-8", "no-cache");
  }
  if (method === "GET" && (url.pathname === "/" || /^\/s\/[a-z0-9.-]+$/.test(url.pathname))) {
    return serveFile(
      response,
      join(publicDirectory, "index.html"),
      "text/html; charset=utf-8",
      "no-cache",
      (html) => html.replace("__BUILD_VERSION__", () => buildVersion),
    );
  }
  json(response, 404, { error: "Not found" });
}

async function runPrompt(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await readJson(request);
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt || prompt.length > 32_000) {
    return json(response, 400, { error: "Prompt must contain 1–32,000 characters" });
  }

  const requestedDirectory = typeof body.cwd === "string" ? body.cwd.trim() : "";
  if (!requestedDirectory || !isAbsolute(requestedDirectory)) {
    return json(response, 400, { error: "cwd must be an absolute directory path" });
  }

  let currentDirectory: string;
  try {
    currentDirectory = await realpath(requestedDirectory);
    if (!(await stat(currentDirectory)).isDirectory()) {
      return json(response, 400, { error: `Not a directory: ${currentDirectory}` });
    }
  } catch (error) {
    return json(response, 400, { error: `Could not use cwd: ${errorMessage(error)}` });
  }

  const session = await store.create();
  session.model = providerCatalog.defaultModel;
  if (currentDirectory !== workspaceRoot) session.directories = [currentDirectory];
  session.cwd = currentDirectory;
  session.addDirInitialized = true;
  await store.save(session);

  const controller = new AbortController();
  request.once("aborted", () => controller.abort());
  response.on("close", () => {
    if (!response.writableEnded) controller.abort();
  });

  try {
    await runSessionPrompt(session.id, prompt, controller.signal);
    if (!response.destroyed && !response.writableEnded) json(response, 200, { sessionId: session.id });
  } catch (error) {
    if (!response.destroyed && !response.writableEnded) {
      json(response, 502, { error: errorMessage(error), sessionId: session.id });
    }
  }
}

async function streamMessage(request: IncomingMessage, response: ServerResponse, sessionId: string): Promise<void> {
  if (activeSessions.has(sessionId)) return json(response, 409, { error: "A response is already streaming" });
  const session = await store.get(sessionId);
  if (!session) return json(response, 404, { error: "Session not found" });
  if (session.parentSessionId && request.headers["x-amber-agent-token"] !== agentRunToken) {
    return json(response, 403, { error: "Agent sub-sessions are read-only" });
  }
  const approvalCapable = request.headers["x-amber-agent-token"] !== agentRunToken;

  const body = await readJson(request, MAX_MESSAGE_BODY_BYTES);
  const content = typeof body.content === "string" ? body.content.trim() : "";
  const parsedImages = parseMessageImages(body.images);
  if ("error" in parsedImages) return json(response, 400, { error: parsedImages.error });
  const images = parsedImages.images;
  if ((!content && images.length === 0) || content.length > 32_000) {
    return json(response, 400, { error: "Message must contain text or images; text is limited to 32,000 characters" });
  }
  // The run is decoupled from this connection: a refresh or closed window
  // leaves it streaming server-side, and clients re-attach through
  // /api/sessions/:id/events. Only an explicit abort (or shutdown) stops it.
  const controller = new AbortController();
  const now = new Date().toISOString();
  const userMessage: Message = {
    id: randomUUID(),
    role: "user",
    content,
    createdAt: now,
    status: "complete",
    ...(images.length ? { images } : {}),
  };
  const limitError = sessionImageLimitError(session, userMessage);
  if (limitError) return json(response, 400, { error: limitError });
  automaticNameRuns.get(sessionId)?.sessions.add(session);
  const shouldAutoName = shouldAutoNameSession(session);
  let assistantMessage = createAssistantMessage(now);
  session.messages.push(userMessage, assistantMessage);
  await store.save(session);

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const bashExecutor = new BashExecutor();
  activeSessions.register(sessionId, session.parentSessionId, controller, session);
  interruptibleSessions.add(sessionId);
  const emit = (event: string, data: unknown) => emitSessionEvent(sessionId, response, event, data);
  emit("start", { session, userMessage, assistantMessage });
  const onAutomaticName = (title: string) => {
    if (!response.destroyed && !response.writableEnded) emit("session_named", { title });
  };
  const existingNameRun = automaticNameRuns.get(sessionId);
  if (existingNameRun) existingNameRun.listeners.add(onAutomaticName);
  else if (shouldAutoName) startAutomaticSessionName(session, onAutomaticName);

  let lastSnapshotAt = 0;
  let snapshotSave = Promise.resolve();
  const checkpointSession = (force = false): Promise<void> => {
    const now = Date.now();
    if (!force && now - lastSnapshotAt < 250) return snapshotSave;
    lastSnapshotAt = now;
    const snapshot = structuredClone(session);
    snapshotSave = snapshotSave.then(() => store.save(snapshot));
    return snapshotSave;
  };
  try {
    let allowedDirectories = sessionDirectories(session);
    const currentDirectory = sessionWorkingDirectory(session);
    const toolLoopTracker = new ToolLoopTracker();
    // Skill model/effort overrides apply only to the model calls of this user turn.
    let turnModel: string | undefined;
    let turnEffort: ThinkingLevel | undefined;
    for (;;) {
      const agentNotifications = await completedBackgroundAgentNotifications(session);
      if (agentNotifications.length > 0) {
        const assistantIndex = session.messages.findIndex((message) => message.id === assistantMessage.id);
        session.messages.splice(assistantIndex < 0 ? session.messages.length : assistantIndex, 0, ...agentNotifications);
        await store.save(session);
      }
      const skills = await sessionSkills(session);
      const activeProvider = turnModel ? providerCatalog.provider(turnModel) : providerForSession(session);
      const thinkingLevel = turnEffort ?? session.thinkingLevel;
      const baseHistory = buildProviderHistory(session.messages, assistantMessage.id, session.compaction, session.invokedSkills);
      const historyLimitError = providerImageLimitError(baseHistory);
      if (historyLimitError) throw new Error(historyLimitError);
      const reminder = renderSkillReminder(invocableSkills(skills, session.skillTouchedPaths ?? [], currentDirectory), session.contextTokens);
      const history = session.agentType
        ? structureClaudeCodeUserMessages(baseHistory, reminder)
        : injectClaudeCodeUserContext(baseHistory, reminder);
      const toolDrafts = new Map<number, { call: ToolCall; inputJson: string }>();
      let usage: Partial<TokenUsage> = {};
      for await (const event of activeProvider.stream(history, controller.signal, {
        tools: sessionTools(session, approvalCapable),
        system: sessionSystemPrompt(session, currentDirectory, activeProvider.model),
        ...(session.agentType ? { temperature: 1 } : {}),
        ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      })) {
        if (event.type === "delta") {
          assistantMessage.content += event.text;
          emit("delta", { text: event.text });
          await checkpointSession();
        } else if (event.type === "thinking_delta") {
          assistantMessage.thinkingProvider = activeProvider.protocol;
          assistantMessage.thinking = (assistantMessage.thinking ?? "") + event.thinking;
          emit("thinking_delta", { thinking: event.thinking });
          await checkpointSession();
        } else if (event.type === "thinking_signature_delta") {
          assistantMessage.thinkingProvider = activeProvider.protocol;
          assistantMessage.thinkingSignature = (assistantMessage.thinkingSignature ?? "") + event.signature;
          await checkpointSession();
        } else if (event.type === "tool_use_start") {
          const call: ToolCall = {
            id: event.id,
            name: event.name,
            input: {},
            status: "queued",
            output: "",
          };
          toolDrafts.set(event.index, { call, inputJson: "" });
          (assistantMessage.toolCalls ??= []).push(call);
          emit("tool_update", { messageId: assistantMessage.id, toolCall: call });
        } else if (event.type === "tool_input_delta") {
          const draft = toolDrafts.get(event.index);
          if (draft) draft.inputJson += event.partialJson;
        } else if (event.type === "usage") {
          usage = { ...usage, ...event.usage };
        }
      }

      assistantMessage.status = "complete";
      if (usage.input !== undefined && usage.output !== undefined) {
        assistantMessage.usage = usage as TokenUsage;
        session.contextTokens = usage.input;
      }
      for (const draft of toolDrafts.values()) {
        try {
          const parsed = JSON.parse(draft.inputJson || "{}") as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Tool input must be an object");
          draft.call.input = parsed as Record<string, unknown>;
        } catch (error) {
          draft.call.status = "error";
          draft.call.output = `Invalid tool input: ${errorMessage(error)}`;
        }
      }
      await store.save(session);
      emit("assistant_complete", { message: assistantMessage });
      throwIfSessionAborted(controller.signal);

      const orderedCalls = [...toolDrafts.values()].map(({ call }) => call);
      const planModeCalls = orderedCalls.filter((call) => isPlanModeTool(call.name));
      if (planModeCalls.length > 0 && orderedCalls.length !== 1) {
        for (const call of orderedCalls) {
          if (call.status === "error") continue;
          call.status = "error";
          call.output = isPlanModeTool(call.name)
            ? `${call.name} must be the sole tool call in its model response`
            : "Tool not executed because plan mode controls must be the sole tool call in a model response";
          call.statusDisplay = { text: "NOT RUN" };
        }
      }
      const pendingSkillMessages: Message[] = [];
      // Read the interruption before starting same-turn Agent calls: agents are
      // eager promises and may have side effects as soon as they are created.
      const interruptions = queuedSessionMessages.takeReady(sessionId);
      const takeReadyInputs = (): void => {
        interruptions.push(...queuedSessionMessages.takeReady(sessionId));
        interruptions.sort((left, right) => left.priority - right.priority);
      };
      if (orderedCalls.length === 0) {
        takeReadyInputs();
      }
      let agentLinkSaveChain = Promise.resolve();
      const persistAgentLinks = (): Promise<void> => {
        const pending = agentLinkSaveChain.then(() => store.save(session));
        agentLinkSaveChain = pending.catch(() => undefined);
        return pending;
      };
      const agentRuns = startAgentRuns(
        orderedCalls.filter((call) => interruptions.length === 0 && call.name === AGENT_TOOL_NAME && call.status !== "error"),
        (call) => executeAgentCall(
          session,
          call,
          controller.signal,
          persistAgentLinks,
          (updatedCall) => emit("tool_update", {
            messageId: assistantMessage.id,
            toolCall: updatedCall,
          }),
        ),
      );

      // Queued input interrupts the run at a tool boundary: the call in flight
      // finishes and everything not started yet is skipped. A message then
      // continues the model turn; a command returns control to the client.
      let endTurnAfterToolResult = false;
      for (const call of orderedCalls) {
        throwIfSessionAborted(controller.signal);
        // Non-blocking /add-dir commands mutate the live session while this run
        // is active, so each newly-started tool sees the latest allowed roots.
        allowedDirectories = sessionDirectories(session);
        let resultText = call.output;
        let resultBlocks: Array<{ type: "text"; text: string }> | undefined;
        let resultImages: MessageImage[] | undefined;
        let abortAfterResult: Error | undefined;
        let endTurnAfterResult = false;
        if (call.status !== "error") {
          if (interruptions.length > 0 && call.status === "queued") {
            call.status = "error";
            call.output = "Tool call skipped because queued input interrupted the run.";
            call.statusDisplay = { text: "NOT RUN" };
            resultText = call.output;
          } else if (call.name === ENTER_PLAN_MODE_TOOL_NAME) {
            const started = Date.now();
            try {
              if (!approvalCapable || session.agentType) throw new Error("EnterPlanMode is unavailable in this session");
              parseEnterPlanModeInput(call.input);
              if (session.planMode?.active) throw new Error("Plan mode is already active");
              call.status = "running";
              call.startedAt = new Date(started).toISOString();
              call.statusDisplay = { text: "AWAITING APPROVAL" };
              await store.save(session);
              emit("tool_update", { messageId: assistantMessage.id, toolCall: call });
              const decisionPromise = planModeApprovals.waitForDecision(
                sessionId,
                call.id,
                "enter",
                controller.signal,
              );
              emit("plan_mode_request", { toolUseId: call.id, kind: "enter" });
              const decision = await decisionPromise;
              if (decision.approved) {
                const filePath = session.planMode?.planFilePath ?? planFilePath(planDirectory, session.id);
                await ensurePlanFile(filePath);
                session.planMode = { active: true, planFilePath: filePath };
                allowedDirectories = sessionDirectories(session);
                emit("plan_mode_state", { planMode: session.planMode });
                call.status = "complete";
                call.output = "";
                call.statusDisplay = { text: "PLAN MODE" };
                resultText = formatEnterPlanModeResult(filePath);
              } else {
                call.status = "error";
                call.output = "";
                call.statusDisplay = { text: "DECLINED" };
                resultText = formatEnterPlanModeDeclinedResult();
                endTurnAfterResult = true;
              }
            } catch (error) {
              call.status = "error";
              call.output = errorMessage(error);
              resultText = call.output;
              if (error instanceof Error && error.name === "AbortError") abortAfterResult = error;
            }
            call.durationMs = Date.now() - started;
            call.completedAt = new Date().toISOString();
          } else if (call.name === EXIT_PLAN_MODE_TOOL_NAME) {
            const started = Date.now();
            try {
              if (!approvalCapable || session.agentType) throw new Error("ExitPlanMode is unavailable in this session");
              const { allowedPrompts } = parseExitPlanModeInput(call.input);
              if (!session.planMode?.active) throw new Error("ExitPlanMode can only be used while plan mode is active");
              const plan = await readPlanSnapshot(session.planMode.planFilePath);
              call.status = "running";
              call.startedAt = new Date(started).toISOString();
              call.statusDisplay = { text: "AWAITING APPROVAL" };
              await store.save(session);
              emit("tool_update", { messageId: assistantMessage.id, toolCall: call });
              const decisionPromise = planModeApprovals.waitForDecision(
                sessionId,
                call.id,
                "exit",
                controller.signal,
              );
              emit("plan_mode_request", {
                toolUseId: call.id,
                kind: "exit",
                plan,
                planFilePath: session.planMode.planFilePath,
                allowedPrompts,
              });
              const decision = await decisionPromise;
              if (decision.approved && !decision.newSession) {
                session.planMode.active = false;
                allowedDirectories = sessionDirectories(session);
                emit("plan_mode_state", { planMode: session.planMode });
                call.status = "complete";
                call.output = "";
                call.statusDisplay = { text: "APPROVED" };
                resultText = formatExitPlanModeApprovedResult(plan);
              } else if (decision.newSession) {
                session.planMode.active = false;
                allowedDirectories = sessionDirectories(session);
                session.messages.push({
                  id: randomUUID(),
                  role: "assistant",
                  content: `Plan implementation session: ${decision.newSessionId ?? ""}`,
                  createdAt: new Date().toISOString(),
                  status: "complete",
                  kind: "plan-banner",
                  ...(decision.newSessionId ? { forkedSessionId: decision.newSessionId } : {}),
                });
                emit("plan_mode_state", { planMode: session.planMode });
                call.status = "complete";
                call.output = "";
                call.statusDisplay = { text: "DELEGATED" };
                resultText = formatExitPlanModeNewSessionResult(decision.newSessionId ?? "");
                endTurnAfterResult = true;
              } else if (decision.cancelled) {
                call.status = "error";
                call.output = "";
                call.statusDisplay = { text: "PLAN MODE" };
                resultText = formatExitPlanModeCancelledResult();
                endTurnAfterResult = true;
              } else {
                call.status = "error";
                call.output = "";
                call.statusDisplay = { text: "REVISE PLAN" };
                resultText = formatExitPlanModeRejectedResult(decision.feedback);
              }
            } catch (error) {
              call.status = "error";
              call.output = errorMessage(error);
              resultText = call.output;
              if (error instanceof Error && error.name === "AbortError") abortAfterResult = error;
            }
            call.durationMs = Date.now() - started;
            call.completedAt = new Date().toISOString();
          } else if (call.name === AGENT_TOOL_NAME) {
            const result = await agentRuns.get(call.id)!;
            resultText = result.resultText;
            resultBlocks = result.resultBlocks;
            abortAfterResult = result.abortAfterResult;
          } else if (call.name === ASK_USER_QUESTION_TOOL_NAME) {
            const started = Date.now();
            call.status = "running";
            call.startedAt = new Date(started).toISOString();
            call.statusDisplay = { text: "AWAITING ANSWER" };
            await store.save(session);
            emit("tool_update", { messageId: assistantMessage.id, toolCall: call });
            try {
              const { questions } = parseAskUserQuestionInput(call.input);
              const answersPromise = askUserQuestions.waitForAnswers(sessionId, call.id, questions, controller.signal);
              emit("ask_user_question", { toolUseId: call.id, questions });
              const answers = await answersPromise;
              call.status = "complete";
              call.output = JSON.stringify({ answers });
              call.statusDisplay = { text: "ANSWERED" };
              resultText = formatAskUserQuestionResult(answers);
            } catch (error) {
              call.status = "error";
              call.output = errorMessage(error);
              call.statusDisplay = { text: "NOT ANSWERED" };
              resultText = call.output;
              if (error instanceof Error && error.name === "AbortError") abortAfterResult = error;
            }
            call.durationMs = Date.now() - started;
            call.completedAt = new Date().toISOString();
          } else if (call.name === BASH_TOOL.name) {
            try {
              const input = parseBashInput(call.input);
              await store.save(session);
              emit("tool_update", { messageId: assistantMessage.id, toolCall: call });
              if (input.runInBackground) {
                const started = Date.now();
                call.status = "running";
                call.startedAt = new Date(started).toISOString();
                call.timeoutMs = input.timeoutMs;
                call.statusDisplay = { text: "STARTING", appendElapsed: true };
                emit("tool_update", { messageId: assistantMessage.id, toolCall: call });
                await store.save(session);
                const task = await backgroundTasks.start(sessionId, input, allowedDirectories, controller.signal);
                const message = `Command running in background with ID: ${task.id}. Use TaskOutput to read its output and status.`;
                call.status = "complete";
                call.output = message;
                call.exitCode = 0;
                call.durationMs = Date.now() - started;
                call.workingDirectory = task.workingDirectory;
                call.statusDisplay = { text: "BACKGROUND" };
                call.completedAt = new Date().toISOString();
                resultText = message;
              } else {
                const result = await bashExecutor.run(input, allowedDirectories, controller.signal, {
                  onRunning: async (workingDirectory, statusDisplay) => {
                    call.status = "running";
                    call.startedAt = new Date().toISOString();
                    call.workingDirectory = workingDirectory;
                    call.timeoutMs = input.timeoutMs;
                    call.statusDisplay = statusDisplay;
                    emit("tool_update", { messageId: assistantMessage.id, toolCall: call });
                    await store.save(session);
                  },
                  onOutput: (chunk) => {
                    call.output += chunk;
                    emit("tool_output", { messageId: assistantMessage.id, toolUseId: call.id, chunk });
                    void checkpointSession().catch((error) => {
                      console.error(`Could not checkpoint session ${sessionId}:`, error);
                    });
                  },
                });
                await snapshotSave;
                call.status = result.status;
                call.output = result.output;
                call.exitCode = result.exitCode;
                call.durationMs = result.durationMs;
                call.workingDirectory = result.workingDirectory;
                call.statusDisplay = result.statusDisplay;
                call.completedAt = new Date().toISOString();
                resultText = result.resultText;
              }
            } catch (error) {
              call.status = "error";
              call.output = errorMessage(error);
              call.completedAt = new Date().toISOString();
              resultText = call.output;
              if (error instanceof Error && error.name === "AbortError") abortAfterResult = error;
            }
          } else if (call.name === TASK_OUTPUT_TOOL.name) {
            const started = Date.now();
            call.status = "running";
            call.startedAt = new Date(started).toISOString();
            emit("tool_update", { messageId: assistantMessage.id, toolCall: call });
            try {
              const result = await executeTaskOutput(
                backgroundTasks,
                backgroundAgentTasks,
                sessionId,
                parseTaskOutputInput(call.input),
                controller.signal,
              );
              call.status = "complete";
              call.output = result.output;
              resultText = result.resultText;
            } catch (error) {
              call.status = "error";
              call.output = errorMessage(error);
              resultText = call.output;
              if (error instanceof Error && error.name === "AbortError") abortAfterResult = error;
            }
            call.durationMs = Date.now() - started;
            call.completedAt = new Date().toISOString();
          } else if (call.name === TASK_STOP_TOOL.name) {
            const started = Date.now();
            call.status = "running";
            call.startedAt = new Date(started).toISOString();
            emit("tool_update", { messageId: assistantMessage.id, toolCall: call });
            try {
              const result = executeTaskStop(backgroundTasks, sessionId, parseTaskStopInput(call.input));
              call.status = "complete";
              call.output = result.output;
              resultText = result.resultText;
            } catch (error) {
              call.status = "error";
              call.output = errorMessage(error);
              resultText = call.output;
            }
            call.durationMs = Date.now() - started;
            call.completedAt = new Date().toISOString();
          } else if (PLANNING_TASK_TOOLS.some((tool) => tool.name === call.name)) {
            const started = Date.now();
            call.status = "running";
            call.startedAt = new Date(started).toISOString();
            emit("tool_update", { messageId: assistantMessage.id, toolCall: call });
            try {
              archiveCompletedPlanningTasks(session);
              const result = executePlanningTaskTool(call.name, call.input, session);
              archiveCompletedPlanningTasks(session);
              call.status = "complete";
              call.output = result.output;
              resultText = result.resultText;
            } catch (error) {
              call.status = "error";
              call.output = errorMessage(error);
              resultText = call.output;
            }
            call.durationMs = Date.now() - started;
            call.completedAt = new Date().toISOString();
            emit("planning_tasks_update", {
              tasks: session.planningTasks ?? [],
              archiveHighWaterMark: session.planningTaskArchiveHighWaterMark ?? 0,
            });
          } else if (FILE_TOOLS.some((tool) => tool.name === call.name)) {
            const started = Date.now();
            call.status = "running";
            call.startedAt = new Date(started).toISOString();
            if (typeof call.input.file_path === "string") call.filePath = call.input.file_path;
            emit("tool_update", { messageId: assistantMessage.id, toolCall: call });
            try {
              const result = await executeFileTool(
                call.name,
                call.input,
                allowedDirectories,
                session,
                currentDirectory,
                controller.signal,
                session.planMode?.active ? { onlyMutationPath: session.planMode.planFilePath } : undefined,
              );
              call.status = "complete";
              call.filePath = result.filePath;
              call.output = result.output;
              if (result.readRange) call.readRange = result.readRange;
              resultText = result.resultText;
              if (result.image) {
                const imageResultMessage: Message = {
                  id: randomUUID(),
                  role: "user",
                  content: result.resultText,
                  createdAt: new Date().toISOString(),
                  status: "complete",
                  kind: "tool-result",
                  toolUseId: call.id,
                  images: [result.image],
                };
                const imageLimitError = sessionImageLimitError(session, imageResultMessage);
                if (imageLimitError) {
                  if (session.fileReadState) delete session.fileReadState[result.filePath];
                  throw new Error(imageLimitError);
                }
                resultImages = [result.image];
              }
              await recordTouchedPath(session, result.filePath);
            } catch (error) {
              call.status = "error";
              call.output = errorMessage(error);
              resultText = call.output;
            }
            call.durationMs = Date.now() - started;
            call.completedAt = new Date().toISOString();
          } else if (call.name === GREP_TOOL.name) {
            const started = Date.now();
            call.status = "running";
            call.startedAt = new Date(started).toISOString();
            emit("tool_update", { messageId: assistantMessage.id, toolCall: call });
            try {
              const result = await executeGrep(
                parseGrepInput(call.input),
                allowedDirectories,
                currentDirectory,
                controller.signal,
              );
              call.status = "complete";
              call.output = result.output;
              call.workingDirectory = result.workingDirectory;
              resultText = result.resultText;
            } catch (error) {
              call.status = "error";
              call.output = errorMessage(error);
              resultText = call.output;
            }
            call.durationMs = Date.now() - started;
            call.completedAt = new Date().toISOString();
          } else if (call.name === GLOB_TOOL.name) {
            const started = Date.now();
            call.status = "running";
            call.startedAt = new Date(started).toISOString();
            emit("tool_update", { messageId: assistantMessage.id, toolCall: call });
            try {
              const result = await executeGlob(
                parseGlobInput(call.input),
                allowedDirectories,
                currentDirectory,
                controller.signal,
              );
              call.status = "complete";
              call.output = result.output;
              call.workingDirectory = result.workingDirectory;
              resultText = result.resultText;
            } catch (error) {
              call.status = "error";
              call.output = errorMessage(error);
              resultText = call.output;
            }
            call.durationMs = Date.now() - started;
            call.completedAt = new Date().toISOString();
          } else if (call.name === SKILL_TOOL_NAME) {
            const started = Date.now();
            call.status = "running";
            call.startedAt = new Date(started).toISOString();
            emit("tool_update", { messageId: assistantMessage.id, toolCall: call });
            try {
              const input = parseSkillInput(call.input);
              const resolved = resolveSkill(
                await sessionSkills(session),
                input.skill,
                session.skillTouchedPaths ?? [],
                currentDirectory,
              );
              if ("error" in resolved) throw new Error(resolved.error);
              const expanded = await expandSkill(resolved.skill, input.args, {
                sessionId: session.id,
                cwd: currentDirectory,
                signal: controller.signal,
              });
              const resolvedModel = resolveSkillModel(expanded.model, providerCatalog.models);
              if (resolvedModel) {
                turnModel = resolvedModel;
                call.skillModel = resolvedModel;
              }
              if (expanded.effort) {
                turnEffort = expanded.effort;
                call.skillEffort = expanded.effort;
              }
              recordInvokedSkill(session, resolved.skill, expanded.content);
              call.status = "complete";
              call.output = skillInvocationPreview(expanded.content);
              call.statusDisplay = { text: "SKILL LOADED" };
              resultText = `Launching skill: ${expanded.name}`;
              pendingSkillMessages.push({
                id: randomUUID(),
                role: "user",
                content: `<command-name>/${expanded.name}</command-name>\n\n${expanded.content}`,
                createdAt: new Date().toISOString(),
                status: "complete",
                kind: "skill",
                skillName: expanded.name,
              });
            } catch (error) {
              call.status = "error";
              call.output = errorMessage(error);
              call.statusDisplay = { text: "SKILL FAILED" };
              resultText = call.output;
              if (error instanceof Error && error.name === "AbortError") abortAfterResult = error;
            }
            call.durationMs = Date.now() - started;
            call.completedAt = new Date().toISOString();
          } else {
            call.status = "error";
            call.output = `Unknown tool: ${call.name}`;
          }
        }
        emit("tool_update", {
          messageId: assistantMessage.id,
          toolCall: resultImages?.length ? { ...call, images: resultImages } : call,
        });
        session.messages.push({
          id: randomUUID(),
          role: "user",
          content: resultText || call.output || "Tool failed without output",
          createdAt: new Date().toISOString(),
          status: "complete",
          kind: "tool-result",
          toolUseId: call.id,
          toolError: call.status !== "complete",
          ...(resultBlocks ? { contentBlocks: resultBlocks } : {}),
          ...(resultImages?.length ? { images: resultImages } : {}),
        });
        session.messages.push(...pendingSkillMessages.splice(0));
        await store.save(session);
        if (abortAfterResult) throw abortAfterResult;
        throwIfSessionAborted(controller.signal);
        takeReadyInputs();
        if (endTurnAfterResult) {
          endTurnAfterToolResult = true;
          break;
        }
      }

      // Crossed the auto-compact threshold: queue the server /compact and take
      // it now that the tool batch has finished.
      if (shouldAutoCompactSession(session)) queuedSessionMessages.enqueueCompaction(sessionId);
      takeReadyInputs();

      const roundWasInterrupted = interruptions.length > 0;
      let interruption = interruptions.shift();
      if (interruption?.priority === 0
        && interruption.kind === "command"
        && interruption.content.trim().toLowerCase() === "/compact") {
        await startSessionCompaction(session, emit, false).completion;
        // Input can be queued while summary generation is in flight. Pull it
        // in now and honor the queue's replaceable-user-slot semantics by
        // taking the newest remaining priority-two entry.
        takeReadyInputs();
        interruption = interruptions.pop();
        // The automatic run also satisfies a manual /compact that was queued
        // during the tool call. Any queued message remains to be injected below.
        if (interruption?.kind === "command" && interruption.content.trim().toLowerCase() === "/compact") {
          interruption = undefined;
        }
      }
      if (interruption?.kind === "message") {
        const queuedUserMessage: Message = {
          id: randomUUID(),
          role: "user",
          content: interruption.content,
          createdAt: new Date().toISOString(),
          status: "complete",
          ...(interruption.images?.length ? { images: interruption.images } : {}),
        };
        session.messages.push(queuedUserMessage);
        // The interruption starts a fresh user turn: skill model/effort
        // overrides from the interrupted turn no longer apply.
        turnModel = undefined;
        turnEffort = undefined;
        await store.save(session);
        emit("user_message", { message: queuedUserMessage });
      } else if (interruption?.kind === "command") {
        if (interruption.content.trim().toLowerCase() === "/compact") {
          await startSessionCompaction(session, emit, false).completion;
        }
        emit("done", { message: assistantMessage, session });
        return;
      }

      if ((orderedCalls.length === 0 || endTurnAfterToolResult) && interruption?.kind !== "message") {
        if (session.parentSessionId) {
          session.agentStatus = "complete";
          await store.save(session);
        }
        emit("done", { message: assistantMessage, session });
        return;
      }

      const loop = !roundWasInterrupted && planModeCalls.length === 0
        ? toolLoopTracker.record([...toolDrafts.values()].map(({ call }) => ({
            name: call.name,
            input: call.input,
            status: call.status,
            output: call.output,
          })))
        : null;
      if (loop) throw new Error(formatToolLoopError(loop));
      assistantMessage = createAssistantMessage();
      session.messages.push(assistantMessage);
      await store.save(session);
      emit("continuation", { assistantMessage });
    }
  } catch (error) {
    // A tool-output checkpoint may still be queued when an abort arrives.
    await snapshotSave;
    if (assistantMessage.status === "streaming") {
      assistantMessage.status = "error";
      if (!assistantMessage.content) assistantMessage.content = "Response interrupted.";
    }
    if (session.parentSessionId) session.agentStatus = "error";
    await store.save(session);
    const message = error instanceof Error && error.name === "AbortError" ? "Generation stopped" : errorMessage(error);
    if (!response.writableEnded) emit("error", { error: message, message: assistantMessage, session });
  } finally {
    automaticNameRuns.get(sessionId)?.listeners.delete(onAutomaticName);
    // Anything still queued was never injected; the client dispatches it once
    // this run has finished.
    queuedSessionMessages.clear(sessionId);
    interruptibleSessions.delete(sessionId);
    activeSessions.unregister(sessionId, controller);
    response.end();
  }
}

function startAutomaticSessionName(session: Session, listener: (title: string) => void): void {
  if (automaticNameRuns.has(session.id)) return;
  const controller = new AbortController();
  const run: AutomaticNameRun = {
    controller,
    sessions: new Set([session]),
    listeners: new Set([listener]),
    completion: Promise.resolve(),
  };
  automaticNameRuns.set(session.id, run);
  const messages = structuredClone(session.messages);
  const compaction = session.compaction ? structuredClone(session.compaction) : undefined;

  run.completion = (async () => {
    try {
      const title = await generateSessionTitle(providerForSession(session), messages, controller.signal, compaction);
      if (automaticNameRuns.get(session.id) !== run) return;
      const persisted = await store.get(session.id);
      if (automaticNameRuns.get(session.id) !== run) return;
      if (!persisted || persisted.title !== persisted.id) {
        if (persisted) {
          for (const observed of run.sessions) observed.title = persisted.title;
        }
        return;
      }

      for (const observed of run.sessions) observed.title = title;
      const currentSession = [...run.sessions].at(-1) ?? session;
      await store.rename(currentSession, title);
      if (automaticNameRuns.get(session.id) !== run) return;
      for (const notify of run.listeners) notify(title);
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) {
        console.error(`Could not automatically name session ${session.id}:`, error);
      }
    } finally {
      if (automaticNameRuns.get(session.id) === run) automaticNameRuns.delete(session.id);
    }
  })();
}

async function stopAutomaticSessionName(sessionId: string): Promise<void> {
  const run = automaticNameRuns.get(sessionId);
  if (!run) return;
  automaticNameRuns.delete(sessionId);
  run.controller.abort();
  await run.completion;
}

function createAssistantMessage(createdAt = new Date().toISOString()): Message {
  return { id: randomUUID(), role: "assistant", content: "", createdAt, status: "streaming" };
}

function sessionDirectories(session: Session): string[] {
  return [...new Set([
    sessionWorkingDirectory(session),
    ...sessionDirectoryRoots(session),
    ...(session.planMode?.active ? [dirname(session.planMode.planFilePath)] : []),
  ])];
}

/** Skills visible to a session, rediscovered so additions take effect immediately. */
async function sessionSkills(session: Session): Promise<SkillDefinition[]> {
  const context: SkillDiscoveryContext = {
    cwd: sessionWorkingDirectory(session),
    homeDirectory: homedir(),
    // Keep skills from every directory the session can access, including the
    // server's original workspace after the user changes the session CWD.
    addDirRoots: sessionDirectoryRoots(session),
    extraProjectRoots: session.skillRoots ?? [],
    touchedPaths: session.skillTouchedPaths ?? [],
  };
  return discoverSkills(context);
}

/** Records a file touched by Read/Write/Edit to activate path-gated and nested skills. */
async function recordTouchedPath(session: Session, filePath: string | undefined): Promise<void> {
  if (!filePath) return;
  const touched = session.skillTouchedPaths ?? [];
  if (!touched.includes(filePath)) {
    touched.push(filePath);
    if (touched.length > 200) touched.splice(0, touched.length - 200);
    session.skillTouchedPaths = touched;
  }
  for (const root of await discoverNestedProjectRoots(filePath)) {
    if (!(session.skillRoots ?? []).includes(root)) (session.skillRoots ??= []).push(root);
  }
}

function recordInvokedSkill(session: Session, skill: SkillDefinition, content: string): void {
  const invoked = session.invokedSkills ?? [];
  const entry: SessionInvokedSkill = {
    name: skill.name,
    path: skill.filePath,
    content,
    invokedAt: new Date().toISOString(),
  };
  const existing = invoked.findIndex((candidate) => candidate.name === skill.name);
  if (existing >= 0) invoked[existing] = entry;
  else invoked.push(entry);
  session.invokedSkills = invoked;
}

function sessionDirectoryRoots(session: Session): string[] {
  return [...new Set([workspaceRoot, ...(session.directories ?? [])])];
}

function sessionWorkingDirectory(session: Session): string {
  const roots = sessionDirectoryRoots(session);
  return session.cwd && directoryAllowed(session.cwd, roots) ? session.cwd : workspaceRoot;
}

function directoryAllowed(directory: string, roots: string[]): boolean {
  return roots.some((root) => {
    const child = relative(root, directory);
    return child === "" || (!child.startsWith("..") && !isAbsolute(child));
  });
}

function archiveCompletedPlanningTasks(session: Session): void {
  const tasks = session.planningTasks ?? [];
  if (tasks.length === 0 || tasks.some((task) => task.status !== "completed")) return;
  const highestTaskId = tasks.reduce((highest, task) => Math.max(highest, Number(task.id) || 0), 0);
  session.planningTaskArchiveHighWaterMark = Math.max(
    session.planningTaskArchiveHighWaterMark ?? 0,
    session.planningTaskHighWaterMark ?? 0,
    highestTaskId,
  );
}

function sessionContextTokens(session: Session): number {
  if (session.contextTokens !== undefined) return session.contextTokens;
  return session.messages.reduce((largest, message) => Math.max(largest, message.usage?.input ?? 0), 0);
}

function sessionTools(session: Session, approvalCapable = true): ToolDefinition[] {
  if (session.agentType) {
    const definition = getAgentDefinition(agentDefinitions, session.agentType);
    return toolsForAgentMode(session.planMode?.active === true || definition.readOnly);
  }
  return toolsForPlanMode(claudeCodeTools, session.planMode?.active === true, approvalCapable);
}

function sessionSystemPrompt(
  session: Session,
  currentDirectory: string,
  model: string,
): string | import("./types.js").ProviderSystemBlock[] {
  const system = !session.agentType
    ? buildClaudeCodeSystemPrompt(currentDirectory, model)
    : buildClaudeCodeAgentSystemPrompt(
        currentDirectory,
        model,
        getAgentDefinition(agentDefinitions, session.agentType).systemPrompt,
      );
  if (session.planMode?.active) system.push(planModeSystemBlock(session.planMode.planFilePath, Boolean(session.agentType)));
  return system;
}

function providerForSession(session: Session): LlmProvider {
  return providerCatalog.provider(session.model);
}

function isPlanModeTool(name: string): boolean {
  return name === ENTER_PLAN_MODE_TOOL_NAME || name === EXIT_PLAN_MODE_TOOL_NAME;
}

interface AgentExecutionResult {
  resultText: string;
  resultBlocks?: Array<{ type: "text"; text: string }>;
  abortAfterResult?: Error;
}

async function executeAgentCall(
  parent: Session,
  call: ToolCall,
  signal: AbortSignal,
  persistParent: () => Promise<void>,
  onUpdate: (call: ToolCall) => void,
): Promise<AgentExecutionResult> {
  const started = Date.now();
  call.status = "running";
  call.startedAt = new Date(started).toISOString();
  call.statusDisplay = { text: "RUNNING AGENT", appendElapsed: true };
  onUpdate(call);
  let resultText = "";
  let resultBlocks: Array<{ type: "text"; text: string }> | undefined;
  let abortAfterResult: Error | undefined;
  let child: Session | undefined;
  try {
    throwIfSessionAborted(signal);
    const input = parseAgentInput(call.input, agentDefinitions);
    const agentModel = resolveAgentModel(
      getAgentDefinition(agentDefinitions, input.subagentType).model,
      providerCatalog.defaultAgentModel,
      parent.model,
      providerCatalog.defaultModel,
    );
    child = await store.createAgentSession(parent, input.subagentType, input.description, agentModel);
    throwIfSessionAborted(signal);
    call.agentSessionId = child.id;
    call.agentType = input.subagentType;
    const agentModelInfo = providerCatalog.model(child.model);
    call.agentModel = agentModelInfo.key;
    call.agentThinkingLevel = agentModelInfo.thinkingLevel;
    await persistParent();
    onUpdate(call);
    if (input.runInBackground) {
      const backgroundController = new AbortController();
      const abortBackground = () => backgroundController.abort();
      signal.addEventListener("abort", abortBackground, { once: true });
      if (signal.aborted) backgroundController.abort();
      const childId = child.id;
      const backgroundRun = runSessionPrompt(childId, input.prompt, backgroundController.signal);
      void backgroundRun.catch(async (error) => {
        try {
          const persistedChild = await store.get(childId);
          if (persistedChild?.agentStatus === "running") {
            persistedChild.agentStatus = "error";
            await store.save(persistedChild);
            broadcastSessionEvent(persistedChild.id, "error", {
              error: errorMessage(error),
              session: persistedChild,
            });
          }
        } catch (persistError) {
          console.error(`Could not persist background agent failure ${childId}:`, persistError);
        }
      }).finally(() => signal.removeEventListener("abort", abortBackground));

      resultText = `Agent running in background with ID: ${child.id}. Use TaskOutput with this ID to check its status or wait for its result; its result is also delivered as a task notification once it finishes.`;
      resultBlocks = [
        { type: "text", text: resultText },
        { type: "text", text: `agentId: ${child.id}` },
      ];
      call.status = "complete";
      call.output = resultText;
      call.statusDisplay = { text: "BACKGROUND" };
      await persistParent();
    } else {
      resultText = await runSessionPrompt(child.id, input.prompt, signal);
      const stats = await agentUsage(child.id);
      resultBlocks = [
        { type: "text", text: resultText },
        {
          type: "text",
          text: `agentId: ${child.id} (use SendMessage with to: '${child.id}' to continue this agent)\n`
            + `<usage>total_tokens: ${stats.totalTokens}\ntool_uses: ${stats.toolUses}\nduration_ms: ${Date.now() - started}</usage>`,
        },
      ];
      call.status = "complete";
      call.output = resultText;
      call.statusDisplay = { text: "AGENT COMPLETE" };
      await persistParent();
    }
  } catch (error) {
    call.status = "error";
    call.output = errorMessage(error);
    call.statusDisplay = { text: "AGENT FAILED" };
    resultText = call.output;
    if (error instanceof Error && error.name === "AbortError") abortAfterResult = error;
    if (child) {
      child.agentStatus = "error";
      try {
        await store.save(child);
        broadcastSessionEvent(child.id, "error", { error: call.output, session: child });
      } catch { /* preserve the original agent failure */ }
    }
    try {
      await persistParent();
    } catch {
      // Preserve the original agent failure in the tool result.
    }
  }
  call.durationMs = Date.now() - started;
  call.completedAt = new Date().toISOString();
  onUpdate(call);
  return {
    resultText,
    ...(resultBlocks ? { resultBlocks } : {}),
    ...(abortAfterResult ? { abortAfterResult } : {}),
  };
}

async function agentUsage(sessionId: string): Promise<{ totalTokens: number; toolUses: number }> {
  const session = await store.get(sessionId);
  if (!session) return { totalTokens: 0, toolUses: 0 };
  return {
    totalTokens: session.messages.reduce(
      (total, message) => total + (message.usage?.input ?? 0) + (message.usage?.output ?? 0),
      0,
    ),
    toolUses: session.messages.filter((message) => message.kind === "tool-result").length,
  };
}

async function completedBackgroundAgentNotifications(session: Session): Promise<Message[]> {
  const notifications: Message[] = [];
  for (const call of session.messages.flatMap((message) => message.toolCalls ?? [])) {
    if (call.name !== AGENT_TOOL_NAME
      || call.input.run_in_background !== true
      || !call.agentSessionId
      || call.agentNotificationDeliveredAt) continue;
    const child = await store.get(call.agentSessionId);
    if (!child || (child.agentStatus !== "complete" && child.agentStatus !== "error")) continue;
    const result = agentFinalMessage(child);
    const deliveredAt = new Date().toISOString();
    call.agentNotificationDeliveredAt = deliveredAt;
    notifications.push({
      id: randomUUID(),
      role: "user",
      content: [
        "<task-notification>",
        `<task-id>${child.id}</task-id>`,
        `<status>${child.agentStatus}</status>`,
        `<summary>${child.agentDescription ?? child.title}</summary>`,
        `<result>${result || (child.agentStatus === "error" ? "Agent failed without a final response." : "Agent completed without a text response.")}</result>`,
        "</task-notification>",
      ].join("\n"),
      createdAt: deliveredAt,
      status: "complete",
      kind: "agent-notification",
    });
  }
  return notifications;
}

/** Resolves background agent sub-sessions launched directly by a session. */
const backgroundAgentTasks: BackgroundAgentSource = {
  async task(parentSessionId, taskId) {
    const child = await store.get(taskId);
    if (!child || child.parentSessionId !== parentSessionId || !child.agentStatus) return null;
    return {
      id: child.id,
      agentType: child.agentType ?? "agent",
      description: child.agentDescription ?? child.title,
      status: child.agentStatus,
      result: agentFinalMessage(child),
      startedAt: child.createdAt,
      ...(child.agentStatus === "running" ? {} : { completedAt: child.updatedAt }),
    };
  },
};

function agentFinalMessage(session: Session): string {
  return session.messages
    .filter((message) => message.role === "assistant" && isModelMessage(message))
    .at(-1)?.content.trim() ?? "";
}

async function runSessionPrompt(sessionId: string, prompt: string, signal: AbortSignal): Promise<string> {
  const loopbackHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
  const response = await fetch(`http://${loopbackHost}:${port}/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-amber-agent-token": agentRunToken },
    body: JSON.stringify({ content: prompt }),
    signal,
  });
  if (!response.ok) throw new Error(`Session failed (${response.status}): ${await response.text()}`);
  if (!response.body) throw new Error("Session returned no stream");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: string | undefined;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        let event = "message";
        let data = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data) continue;
        const payload = JSON.parse(data) as { error?: string; message?: Message };
        if (event === "done") result = payload.message?.content ?? "";
        if (event === "error") throw new Error(payload.error ?? "Session failed");
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
  if (result === undefined) throw new Error("Session ended without a final response");
  return result || "Session completed without a text response.";
}

async function listDirectoryCompletions(response: ServerResponse, sessionId: string, url: URL): Promise<void> {
  const session = await store.get(sessionId);
  if (!session) return json(response, 404, { error: "Session not found" });
  const command = url.searchParams.get("command");
  if (command !== "cwd" && command !== "add-dir" && command !== "file") {
    return json(response, 400, { error: "Path completion requires command=cwd, command=add-dir, or command=file" });
  }
  const fragment = url.searchParams.get("path") ?? "";
  if (fragment.includes("\0") || fragment.includes("\n") || fragment.length > 4_096) {
    return json(response, 400, { error: "Invalid directory completion path" });
  }
  const currentDirectory = sessionWorkingDirectory(session);
  if (command === "file") {
    return json(response, 200, {
      directories: await completeFiles(fragment, currentDirectory, sessionDirectoryRoots(session)),
    });
  }
  if (command === "cwd" && fragment === "") {
    return json(response, 200, { directories: await completeDirectoryRoots(sessionDirectoryRoots(session)) });
  }
  const directories = await completeDirectories(
    fragment,
    command === "cwd" ? currentDirectory : workspaceRoot,
    command === "cwd" ? sessionDirectoryRoots(session) : undefined,
  );
  json(response, 200, { directories });
}

function shouldAutoCompactSession(session: Session): boolean {
  if (!compactionTarget(session)) return false;
  // Agent sub-sessions only compact when the agent opts in; disabled by default.
  if (session.agentType && !agentDefinitions.find((agent) => agent.type === session.agentType)?.compact) return false;
  const compactTokens = providerCatalog.model(session.model).compactTokens;
  const history = buildProviderHistory(session.messages, undefined, session.compaction);
  return shouldAutoCompact(compactTokens, sessionContextTokens(session), history);
}

function sessionImageLimitError(session: Session, appendedMessage?: Message): string | undefined {
  return providerImageLimitError(buildProviderHistory(
    appendedMessage ? [...session.messages, appendedMessage] : session.messages,
    undefined,
    session.compaction,
    session.invokedSkills,
  ));
}

function compactionTarget(session: Session): Message | undefined {
  const previousBoundary = session.compaction
    ? session.messages.findIndex((message) => message.id === session.compaction?.throughMessageId)
    : -1;
  const activeMessages = session.messages.slice(previousBoundary + 1);
  let targetIndex = -1;
  for (let index = 0; index < activeMessages.length; index += 1) {
    const message = activeMessages[index];
    if (message?.status === "complete" && isModelMessage(message)) targetIndex = index;
  }
  if (targetIndex < 0) return undefined;
  for (let index = targetIndex + 1; index < activeMessages.length; index += 1) {
    const message = activeMessages[index];
    if (message?.status === "complete" && isProviderMessage(message)) targetIndex = index;
  }
  return activeMessages[targetIndex];
}

async function compactSession(
  session: Session,
  signal: AbortSignal,
  onProgress?: (generatedCharacters: number) => void,
): Promise<void> {
  const throughMessage = compactionTarget(session);
  if (!throughMessage) {
    throw new Error(session.compaction ? "No new conversation to compact" : "No conversation to compact");
  }

  const history = buildProviderHistory(session.messages, undefined, session.compaction);
  const beforeTokens = estimateHistoryTokens(history);
  const summary = await generateCompactionSummary(providerForSession(session), history, signal, onProgress);
  const now = new Date().toISOString();
  const coveredMessageCount = session.messages
    .slice(0, session.messages.findIndex((message) => message.id === throughMessage.id) + 1)
    .filter((message) => message.status === "complete" && isModelMessage(message)).length;
  const compaction = {
    summary,
    throughMessageId: throughMessage.id,
    createdAt: now,
    coveredMessageCount,
  };
  const afterTokens = estimateHistoryTokens(
    buildProviderHistory(session.messages, undefined, compaction, session.invokedSkills),
  );
  session.compaction = compaction;
  clearImageReadCache(session);
  session.contextTokens = afterTokens;
  session.messages.push({
    id: randomUUID(),
    role: "assistant",
    content: formatCompactionBanner(beforeTokens, afterTokens, coveredMessageCount),
    createdAt: now,
    status: "complete",
    kind: "compact-banner",
  });
  await store.save(session);
}

interface CompactionRun {
  controller: AbortController;
  progress: { generatedCharacters: number };
  registeredActive: boolean;
  completion: Promise<{ compacted: boolean; error?: string }>; // never rejects
}
const compactionRuns = new Map<string, CompactionRun>();

/** Runs /compact server-side, decoupled from any client connection. */
function startSessionCompaction(
  session: Session,
  emit: (event: string, data: unknown) => void = (event, data) => broadcastSessionEvent(session.id, event, data),
  registerActive = true,
): CompactionRun {
  const existing = compactionRuns.get(session.id);
  if (existing) return existing;
  const controller = new AbortController();
  const run: CompactionRun = {
    controller,
    progress: { generatedCharacters: 0 },
    registeredActive: registerActive,
    completion: Promise.resolve({ compacted: false }),
  };
  // Register before notifying so a snapshot taken concurrently always sees the run.
  compactionRuns.set(session.id, run);
  if (run.registeredActive) activeSessions.register(session.id, session.parentSessionId, controller, session);
  emit("compaction_start", {});
  run.completion = (async () => {
    try {
      await compactSession(session, controller.signal, (generatedCharacters) => {
        run.progress.generatedCharacters = generatedCharacters;
        emit("compaction_progress", { generatedCharacters });
      });
      emit("compaction_complete", { session });
      return { compacted: true };
    } catch (error) {
      const error_ = errorMessage(error);
      emit("compaction_error", { error: error_ });
      return { compacted: false, error: error_ };
    } finally {
      if (compactionRuns.get(session.id) === run) compactionRuns.delete(session.id);
      if (run.registeredActive) activeSessions.unregister(session.id, controller);
    }
  })();
  return run;
}

async function executeCommand(request: IncomingMessage, response: ServerResponse, sessionId: string): Promise<void> {
  const body = await readJson(request);
  const rawCommand = typeof body.command === "string" ? body.command.trim() : "";
  const firstWhitespace = rawCommand.search(/\s/);
  const command = (firstWhitespace === -1 ? rawCommand : rawCommand.slice(0, firstWhitespace)).toLowerCase();
  const argument = firstWhitespace === -1 ? "" : rawCommand.slice(firstWhitespace).trim();
  const runsDuringResponse = builtInCommand(rawCommand)?.runsDuringResponse === true;
  const joiningCompaction = command === "/compact" && compactionRuns.has(sessionId);
  if (activeSessions.has(sessionId) && !runsDuringResponse && !joiningCompaction) {
    return json(response, 409, { error: "Wait for the current response to finish" });
  }
  const session = activeSessions.session(sessionId) ?? await store.get(sessionId);
  if (!session) return json(response, 404, { error: "Session not found" });
  if (session.parentSessionId) return json(response, 403, { error: "Agent sub-sessions are read-only" });

  if (command === "/add-dir") {
    if (!argument) return json(response, 400, { error: "Usage: /add-dir <directory>" });
    try {
      const directory = await resolveAddedDirectory(argument);
      const firstAddDir = session.addDirInitialized !== true && (session.directories?.length ?? 0) === 0;
      if (directory !== workspaceRoot && !(session.directories ?? []).includes(directory)) {
        (session.directories ??= []).push(directory);
      }
      session.addDirInitialized = true;
      if (firstAddDir) session.cwd = directory;
      await store.save(session);
      return json(response, 200, { command: "add-dir", directory, cwdChanged: firstAddDir, session });
    } catch (error) {
      return json(response, 400, { error: `Could not add directory: ${errorMessage(error)}` });
    }
  }

  if (command === "/cwd") {
    const currentDirectory = sessionWorkingDirectory(session);
    if (!argument) return json(response, 200, { command: "cwd", directory: currentDirectory, session });
    try {
      const expanded = argument === "~" ? homedir() : argument.startsWith("~/") ? join(homedir(), argument.slice(2)) : argument;
      const directory = await realpath(resolve(currentDirectory, expanded));
      if (!(await stat(directory)).isDirectory()) return json(response, 400, { error: `Not a directory: ${directory}` });
      if (!directoryAllowed(directory, sessionDirectoryRoots(session))) {
        return json(response, 400, { error: `Directory is not in the project or an /add-dir root: ${directory}` });
      }
      session.cwd = directory;
      await store.save(session);
      return json(response, 200, { command: "cwd", directory, session });
    } catch (error) {
      return json(response, 400, { error: `Could not change directory: ${errorMessage(error)}` });
    }
  }

  if (command === "/name") {
    await stopAutomaticSessionName(sessionId);
    if (argument) {
      const title = argument.replace(/\s+/g, " ").trim();
      if (title.length > 80) return json(response, 400, { error: "Session names must be 80 characters or fewer" });
      return json(response, 200, { command: "name", session: await store.rename(session, title) });
    }

    const controller = new AbortController();
    request.once("aborted", () => controller.abort());
    activeSessions.register(sessionId, undefined, controller, session);
    try {
      const title = await generateSessionTitle(providerForSession(session), session.messages, controller.signal, session.compaction);
      return json(response, 200, { command: "name", session: await store.rename(session, title) });
    } catch (error) {
      return json(response, 502, { error: errorMessage(error) });
    } finally {
      activeSessions.unregister(sessionId, controller);
    }
  }

  if (argument) return json(response, 400, { error: `${command} does not accept arguments` });

  if (command === "/tasks" || command === "/bashes") {
    return json(response, 200, { command: "tasks", tasks: backgroundTasks.list(sessionId), session });
  }

  if (command === "/clear") {
    return json(response, 200, { command: "clear", session: await store.clear(session) });
  }
  if (command === "/compact") {
    const existing = compactionRuns.get(sessionId);
    if (!existing && !compactionTarget(session)) {
      return json(response, 400, { error: session.compaction ? "No new conversation to compact" : "No conversation to compact" });
    }
    const result = existing
      ? await existing.completion // join (e.g. client re-dispatch, second window)
      : await startSessionCompaction(session).completion;
    // Standalone command compaction has no message stream to publish a terminal
    // event, so close observers with the final snapshot here. A joined run owns
    // its own terminal event and must not be ended by this request.
    if (!existing) {
      const completed = await store.get(sessionId) ?? session;
      broadcastSessionEvent(sessionId, "done", { session: completed });
    }
    if (!result.compacted) return json(response, 502, { error: result.error });
    return json(response, 200, { command: "compact", session: await store.get(sessionId) ?? session });
  }
  if (command === "/fork") {
    const now = new Date().toISOString();
    const forkBanner: Message = {
      id: randomUUID(),
      role: "assistant",
      content: `Forked from session: ${session.id}`,
      createdAt: now,
      status: "complete",
      kind: "fork-banner",
      sourceSessionId: session.id,
    };
    const fork = await store.createFork(session, forkBanner);
    const sourceBanner: Message = {
      id: randomUUID(),
      role: "assistant",
      content: `Forked to session: ${fork.id}`,
      createdAt: now,
      status: "complete",
      kind: "fork-banner",
      forkedSessionId: fork.id,
    };
    session.messages.push(sourceBanner);
    await store.save(session);
    return json(response, 201, { command: "fork", session: fork, previousSessionId: session.id });
  }
  if (command === "/context") {
    const chatMessages = session.messages.filter(isModelMessage);
    const activeHistory = buildProviderHistory(session.messages, undefined, session.compaction);
    const assistantMessages = chatMessages.filter((message) => message.role === "assistant" && message.status === "complete");
    const latestUsage = assistantMessages.slice().reverse().find((message) => message.usage)?.usage;
    const totalInput = assistantMessages.reduce((total, message) => total + (message.usage?.input ?? 0), 0);
    const totalOutput = assistantMessages.reduce((total, message) => total + (message.usage?.output ?? 0), 0);
    const currentTokens = sessionContextTokens(session);
    const now = new Date().toISOString();
    const userMessage: Message = {
      id: randomUUID(), role: "user", content: command, createdAt: now, status: "complete", kind: "command",
    };
    const assistantMessage: Message = {
      id: randomUUID(),
      role: "assistant",
      content: [
        `**Context · ${session.id}**`,
        "",
        `- Model: \`${providerForSession(session).model}\``,
        `- Active context: **${currentTokens.toLocaleString()} tokens** (cached + uncached input)`,
        `- Latest input / output: **${(latestUsage?.input ?? 0).toLocaleString()} / ${(latestUsage?.output ?? 0).toLocaleString()}**`,
        `- Session input: **${totalInput.toLocaleString()} tokens**`,
        `- Session output: **${totalOutput.toLocaleString()} tokens**`,
        `- Model messages: **${chatMessages.length}**`,
        `- Active provider messages: **${activeHistory.length}**${session.compaction ? ` (summary + messages after compaction)` : ""}`,
        ...(session.compaction ? [`- Compacted messages: **${session.compaction.coveredMessageCount}**`] : []),
      ].join("\n"),
      createdAt: now,
      status: "complete",
      kind: "command",
    };
    session.messages.push(userMessage, assistantMessage);
    await store.save(session);
    return json(response, 200, { command: "context", session });
  }
  return json(response, 400, { error: `Unknown command: ${command || "(empty)"}` });
}

async function resolveAddedDirectory(path: string): Promise<string> {
  const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  const directory = await realpath(resolve(workspaceRoot, expanded));
  if (!(await stat(directory)).isDirectory()) throw new Error(`Not a directory: ${directory}`);
  return directory;
}

async function readJson(request: IncomingMessage, maxBytes = 1_000_000): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function loadProviderCatalog(): Promise<ProviderCatalog> {
  return ProviderCatalog.load(settings, fetch, {
    openAICodexAuth: (signal) => openAICodexAuth.resolveAuth(signal),
  });
}

function validateAgentModels(catalog: ProviderCatalog): void {
  for (const definition of agentDefinitions) {
    if (definition.model && !catalog.has(definition.model)) {
      throw new Error(`Agent type '${definition.type}' references unknown model '${definition.model}'`);
    }
  }
}

async function activateCompletedLogin(loginId: string, status: { status: string }): Promise<void> {
  if (status.status !== "complete") return;
  let activation = loginCatalogActivations.get(loginId);
  if (!activation) {
    activation = (async () => {
      try {
        const nextCatalog = await loadProviderCatalog();
        validateAgentModels(nextCatalog);
        providerCatalog = nextCatalog;
        provider = nextCatalog.provider(undefined);
      } catch (error) {
        // The login itself succeeded; a failed model re-discovery must not
        // report it as failed. Keep the previous catalog and its fallback models.
        console.error(`Model catalog refresh after login failed: ${errorMessage(error)}`);
      }
    })();
    loginCatalogActivations.set(loginId, activation);
  }
  await activation;
}

function authorizeAuthMutation(request: IncomingMessage, response: ServerResponse): boolean {
  if (!isLoopbackWebRequest(request)) {
    json(response, 403, { error: "Provider authentication can only be changed from Amber's local interface" });
    return false;
  }
  if (request.headers["x-amber-auth-action-token"] === authActionToken) return true;
  json(response, 403, { error: "Invalid auth action token" });
  return false;
}

function isLoopbackWebRequest(request: IncomingMessage): boolean {
  try {
    const hostHeader = request.headers.host;
    if (!hostHeader || !isLoopbackHostname(new URL(`http://${hostHeader}`).hostname)) return false;
    const origin = request.headers.origin;
    if (!origin) return true;
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname) && parsed.port === String(port);
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function sendEvent(response: ServerResponse, event: string, data: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function emitSessionEvent(sessionId: string, response: ServerResponse, event: string, data: unknown): void {
  sendEvent(response, event, data);
  broadcastSessionEvent(sessionId, event, data);
}

function broadcastSessionEvent(sessionId: string, event: string, data: unknown): void {
  const subscribers = sessionEventSubscribers.get(sessionId);
  if (!subscribers) return;
  for (const subscriber of subscribers) sendEvent(subscriber, event, data);
  if (event !== "done" && event !== "error") return;
  for (const subscriber of subscribers) subscriber.end();
  sessionEventSubscribers.delete(sessionId);
}

async function observeSessionEvents(
  request: IncomingMessage,
  response: ServerResponse,
  sessionId: string,
): Promise<void> {
  const session = activeSessions.session(sessionId) ?? await store.get(sessionId);
  if (!session) return json(response, 404, { error: "Session not found" });

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  sendEvent(response, "snapshot", await sessionSnapshot(session));
  const waitingForAgentStart = session.agentStatus === "running";
  if (!activeSessions.has(sessionId) && !waitingForAgentStart) {
    response.end();
    return;
  }

  const subscribers = sessionEventSubscribers.get(sessionId) ?? new Set<ServerResponse>();
  subscribers.add(response);
  sessionEventSubscribers.set(sessionId, subscribers);
  const heartbeat = setInterval(() => {
    if (!response.destroyed && !response.writableEnded) response.write(": keep-alive\n\n");
  }, 15_000);
  const cleanup = () => {
    clearInterval(heartbeat);
    subscribers.delete(response);
    if (subscribers.size === 0 && sessionEventSubscribers.get(sessionId) === subscribers) {
      sessionEventSubscribers.delete(sessionId);
    }
  };
  request.once("aborted", cleanup);
  response.once("close", cleanup);

  // The run can finish between the initial snapshot and subscription setup.
  if (!activeSessions.has(sessionId) && !waitingForAgentStart) {
    const completed = await store.get(sessionId);
    if (completed) sendEvent(response, "snapshot", await sessionSnapshot(completed));
    response.end();
  }
}

async function sessionSnapshot(session: Session): Promise<Record<string, unknown>> {
  const question = askUserQuestions.pending(session.id);
  const pendingPlan = planModeApprovals.pending(session.id);
  let planModeRequest: Record<string, unknown> | undefined;
  if (pendingPlan?.kind === "enter") {
    planModeRequest = pendingPlan;
  } else if (pendingPlan?.kind === "exit" && session.planMode) {
    const toolCall = session.messages
      .flatMap((message) => message.toolCalls ?? [])
      .find((call) => call.id === pendingPlan.toolUseId);
    const { allowedPrompts } = parseExitPlanModeInput(toolCall?.input ?? {});
    planModeRequest = {
      ...pendingPlan,
      plan: await readPlanSnapshot(session.planMode.planFilePath),
      planFilePath: session.planMode.planFilePath,
      allowedPrompts,
    };
  }
  const compaction = compactionRuns.get(session.id);
  return {
    session,
    active: activeSessions.has(session.id),
    ...(compaction ? { compaction: compaction.progress } : {}),
    ...(question ? { questionRequest: question } : {}),
    ...(planModeRequest ? { planModeRequest } : {}),
  };
}

async function serveFile(
  response: ServerResponse,
  path: string,
  contentType: string,
  cacheControl = "public, max-age=3600",
  transform?: (content: string) => string,
): Promise<void> {
  let content: Buffer | string = await readFile(path);
  if (transform) content = transform(content.toString("utf8"));
  response.writeHead(200, {
    "content-type": contentType,
    "cache-control": cacheControl,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:",
  });
  response.end(content);
}

async function resolveBuildVersion(): Promise<string> {
  const override = process.env.AMBER_VERSION?.trim();
  if (override) return override;
  try {
    const stored = (await readFile(join(projectRoot, "dist", "build-version.txt"), "utf8")).trim();
    if (stored) return stored;
  } catch {
    // No recorded build version (e.g. compiled directly with tsc).
  }
  return "dev";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown provider error";
}

function throwIfSessionAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error("Session aborted");
  error.name = "AbortError";
  throw error;
}
