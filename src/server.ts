import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { SessionStore } from "./store.js";
import { createProvider } from "./provider.js";
import { loadSettings } from "./settings.js";
import { buildProviderHistory, isModelMessage } from "./history.js";
import { generateSessionTitle, shouldAutoNameSession } from "./session-title.js";
import { estimateHistoryTokens, formatCompactionBanner, generateCompactionSummary } from "./compaction.js";
import { BASH_TOOL, BashExecutor, parseBashInput } from "./bash-tool.js";
import { BackgroundTaskManager } from "./background-tasks.js";
import {
  TASK_OUTPUT_TOOL,
  TASK_STOP_TOOL,
  executeTaskOutput,
  executeTaskStop,
  parseTaskOutputInput,
  parseTaskStopInput,
} from "./task-tools.js";
import { executePlanningTaskTool, PLANNING_TASK_TOOLS } from "./planning-task-tools.js";
import { executeFileTool, FILE_TOOLS } from "./file-tools.js";
import { executeGrep, GREP_TOOL, parseGrepInput } from "./grep-tool.js";
import { executeGlob, GLOB_TOOL, parseGlobInput } from "./glob-tool.js";
import { completeDirectories, completeDirectoryRoots } from "./directory-completion.js";
import { ToolLoopTracker, formatToolLoopError } from "./tool-loop-tracker.js";
import { AGENT_TOOL_NAME, getAgentDefinition, parseAgentInput, startAgentRuns } from "./agent-tool.js";
import { ActiveSessionRuns, abortSessionOperations } from "./session-aborts.js";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  AskUserQuestionManager,
  formatAskUserQuestionResult,
  parseAskUserQuestionInput,
} from "./ask-user-question-tool.js";
import {
  buildClaudeCodeAgentSystemPrompt,
  buildClaudeCodeSystemPrompt,
  CLAUDE_CODE_AGENT_TOOLS,
  createClaudeCodeTools,
  injectClaudeCodeUserContext,
  structureClaudeCodeUserMessages,
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
import type { LlmProvider, ToolDefinition } from "./types.js";
import type { Message, Session, TokenUsage, ToolCall } from "./types.js";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(sourceDirectory, "../..");
const workspaceRoot = await realpath(projectRoot);
const publicDirectory = join(projectRoot, "public");
const clientScript = join(sourceDirectory, "client.js");
const clientFormattersScript = join(sourceDirectory, "client-formatters.js");
const streamingThinkingScript = join(sourceDirectory, "streaming-thinking.js");
const toolDisplayScript = join(sourceDirectory, "tool-display.js");
const markdownScript = join(projectRoot, "node_modules", "markdown-it", "dist", "browser", "markdown-it.umd.min.js");
const dataDirectory = resolve(process.env.DATA_DIR ?? join(projectRoot, "data", "sessions"));
const planDirectory = join(homedir(), ".amber", "plans");
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const store = new SessionStore(dataDirectory, planDirectory);
const settings = await loadSettings();
const agentDefinitions = settings.agents;
const provider = createProvider(process.env, settings);
const agentProviders = new Map(agentDefinitions.map((definition) => [
  definition.type,
  createProvider(process.env, settings, definition),
]));
const claudeCodeTools = createClaudeCodeTools(agentDefinitions);
const activeSessions = new ActiveSessionRuns();
const backgroundTasks = new BackgroundTaskManager();
const askUserQuestions = new AskUserQuestionManager();
const planModeApprovals = new PlanModeApprovalManager();
const agentRunToken = randomUUID();
const SESSION_PATH_ID = "([a-z0-9.-]+)";

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
  console.log(`\n  AMBER agent online at http://${host}:${port}`);
  console.log(`  provider: ${provider.name} / ${provider.model} (${provider.mode})\n`);
});

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  activeSessions.abortAll();
  backgroundTasks.stopAll();
  askUserQuestions.stopAll();
  planModeApprovals.stopAll();
  for (const run of automaticNameRuns.values()) run.controller.abort();
  automaticNameRuns.clear();
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
      mode: provider.mode,
      homeDirectory: homedir(),
      workspaceRoot,
    });
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
  if (method === "DELETE" && sessionMatch?.[1]) {
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
  if (method === "GET" && url.pathname === "/streaming-thinking.js") {
    return serveFile(response, streamingThinkingScript, "text/javascript; charset=utf-8", "no-cache");
  }
  if (method === "GET" && url.pathname === "/tool-display.js") {
    return serveFile(response, toolDisplayScript, "text/javascript; charset=utf-8", "no-cache");
  }
  if (method === "GET" && url.pathname === "/vendor/markdown-it.js") {
    return serveFile(response, markdownScript, "text/javascript; charset=utf-8", "public, max-age=31536000, immutable");
  }
  if (method === "GET" && url.pathname === "/styles.css") {
    return serveFile(response, join(publicDirectory, "styles.css"), "text/css; charset=utf-8", "no-cache");
  }
  if (method === "GET" && (url.pathname === "/" || /^\/s\/[a-z0-9.-]+$/.test(url.pathname))) {
    return serveFile(response, join(publicDirectory, "index.html"), "text/html; charset=utf-8", "no-cache");
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

  const body = await readJson(request);
  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!content || content.length > 32_000) return json(response, 400, { error: "Message must contain 1–32,000 characters" });
  automaticNameRuns.get(sessionId)?.sessions.add(session);
  const shouldAutoName = shouldAutoNameSession(session);

  const controller = new AbortController();
  const now = new Date().toISOString();
  const userMessage: Message = { id: randomUUID(), role: "user", content, createdAt: now, status: "complete" };
  let assistantMessage = createAssistantMessage(now);
  session.messages.push(userMessage, assistantMessage);
  await store.save(session);

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  sendEvent(response, "start", { userMessage, assistantMessage });
  const bashExecutor = new BashExecutor();
  activeSessions.register(sessionId, session.parentSessionId, controller, session);
  const onAutomaticName = (title: string) => {
    if (!response.destroyed && !response.writableEnded) sendEvent(response, "session_named", { title });
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
    const activeProvider = providerForSession(session);
    const toolLoopTracker = new ToolLoopTracker();
    for (;;) {
      const baseHistory = buildProviderHistory(session.messages, assistantMessage.id, session.compaction);
      const history = session.agentType
        ? structureClaudeCodeUserMessages(baseHistory)
        : injectClaudeCodeUserContext(baseHistory);
      const toolDrafts = new Map<number, { call: ToolCall; inputJson: string }>();
      let usage: Partial<TokenUsage> = {};
      for await (const event of activeProvider.stream(history, controller.signal, {
        tools: sessionTools(session, approvalCapable),
        system: sessionSystemPrompt(session, currentDirectory, activeProvider.model),
        ...(session.agentType ? { temperature: 1, thinking: false } : {}),
      })) {
        if (event.type === "delta") {
          assistantMessage.content += event.text;
          sendEvent(response, "delta", { text: event.text });
          await checkpointSession();
        } else if (event.type === "thinking_delta") {
          assistantMessage.thinking = (assistantMessage.thinking ?? "") + event.thinking;
          sendEvent(response, "thinking_delta", { thinking: event.thinking });
          await checkpointSession();
        } else if (event.type === "thinking_signature_delta") {
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
          sendEvent(response, "tool_update", { messageId: assistantMessage.id, toolCall: call });
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
      sendEvent(response, "assistant_complete", { message: assistantMessage });
      throwIfSessionAborted(controller.signal);

      if (toolDrafts.size === 0) {
        if (session.parentSessionId) {
          session.agentStatus = "complete";
          await store.save(session);
        }
        sendEvent(response, "done", { message: assistantMessage, session });
        return;
      }

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
      let agentLinkSaveChain = Promise.resolve();
      const persistAgentLinks = (): Promise<void> => {
        const pending = agentLinkSaveChain.then(() => store.save(session));
        agentLinkSaveChain = pending.catch(() => undefined);
        return pending;
      };
      const agentRuns = startAgentRuns(
        orderedCalls.filter((call) => call.name === AGENT_TOOL_NAME && call.status !== "error"),
        (call) => executeAgentCall(
          session,
          call,
          controller.signal,
          persistAgentLinks,
          (updatedCall) => sendEvent(response, "tool_update", {
            messageId: assistantMessage.id,
            toolCall: updatedCall,
          }),
        ),
      );

      for (const call of orderedCalls) {
        throwIfSessionAborted(controller.signal);
        let resultText = call.output;
        let resultBlocks: Array<{ type: "text"; text: string }> | undefined;
        let abortAfterResult: Error | undefined;
        let endTurnAfterResult = false;
        if (call.status !== "error") {
          if (call.name === ENTER_PLAN_MODE_TOOL_NAME) {
            const started = Date.now();
            try {
              if (!approvalCapable || session.agentType) throw new Error("EnterPlanMode is unavailable in this session");
              parseEnterPlanModeInput(call.input);
              if (session.planMode?.active) throw new Error("Plan mode is already active");
              call.status = "running";
              call.startedAt = new Date(started).toISOString();
              call.statusDisplay = { text: "AWAITING APPROVAL" };
              await store.save(session);
              sendEvent(response, "tool_update", { messageId: assistantMessage.id, toolCall: call });
              const decisionPromise = planModeApprovals.waitForDecision(
                sessionId,
                call.id,
                "enter",
                controller.signal,
              );
              sendEvent(response, "plan_mode_request", { toolUseId: call.id, kind: "enter" });
              const decision = await decisionPromise;
              if (decision.approved) {
                const filePath = session.planMode?.planFilePath ?? planFilePath(planDirectory, session.id);
                await ensurePlanFile(filePath);
                session.planMode = { active: true, planFilePath: filePath };
                allowedDirectories = sessionDirectories(session);
                sendEvent(response, "plan_mode_state", { planMode: session.planMode });
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
              sendEvent(response, "tool_update", { messageId: assistantMessage.id, toolCall: call });
              const decisionPromise = planModeApprovals.waitForDecision(
                sessionId,
                call.id,
                "exit",
                controller.signal,
              );
              sendEvent(response, "plan_mode_request", {
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
                sendEvent(response, "plan_mode_state", { planMode: session.planMode });
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
                sendEvent(response, "plan_mode_state", { planMode: session.planMode });
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
            sendEvent(response, "tool_update", { messageId: assistantMessage.id, toolCall: call });
            try {
              const { questions } = parseAskUserQuestionInput(call.input);
              const answersPromise = askUserQuestions.waitForAnswers(sessionId, call.id, questions, controller.signal);
              sendEvent(response, "ask_user_question", { toolUseId: call.id, questions });
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
              sendEvent(response, "tool_update", { messageId: assistantMessage.id, toolCall: call });
              if (input.runInBackground) {
                const started = Date.now();
                call.status = "running";
                call.startedAt = new Date(started).toISOString();
                call.timeoutMs = input.timeoutMs;
                call.statusDisplay = { text: "STARTING", appendElapsed: true };
                sendEvent(response, "tool_update", { messageId: assistantMessage.id, toolCall: call });
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
                    sendEvent(response, "tool_update", { messageId: assistantMessage.id, toolCall: call });
                    await store.save(session);
                  },
                  onOutput: (chunk) => {
                    call.output += chunk;
                    sendEvent(response, "tool_output", { messageId: assistantMessage.id, toolUseId: call.id, chunk });
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
            sendEvent(response, "tool_update", { messageId: assistantMessage.id, toolCall: call });
            try {
              const result = await executeTaskOutput(
                backgroundTasks,
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
            sendEvent(response, "tool_update", { messageId: assistantMessage.id, toolCall: call });
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
            sendEvent(response, "tool_update", { messageId: assistantMessage.id, toolCall: call });
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
            sendEvent(response, "planning_tasks_update", {
              tasks: session.planningTasks ?? [],
              archiveHighWaterMark: session.planningTaskArchiveHighWaterMark ?? 0,
            });
          } else if (FILE_TOOLS.some((tool) => tool.name === call.name)) {
            const started = Date.now();
            call.status = "running";
            call.startedAt = new Date(started).toISOString();
            if (typeof call.input.file_path === "string") call.filePath = call.input.file_path;
            sendEvent(response, "tool_update", { messageId: assistantMessage.id, toolCall: call });
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
            sendEvent(response, "tool_update", { messageId: assistantMessage.id, toolCall: call });
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
            sendEvent(response, "tool_update", { messageId: assistantMessage.id, toolCall: call });
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
          } else {
            call.status = "error";
            call.output = `Unknown tool: ${call.name}`;
          }
        }
        sendEvent(response, "tool_update", { messageId: assistantMessage.id, toolCall: call });
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
        });
        await store.save(session);
        if (abortAfterResult) throw abortAfterResult;
        throwIfSessionAborted(controller.signal);
        if (endTurnAfterResult) {
          sendEvent(response, "done", { message: assistantMessage, session });
          return;
        }
      }

      const loop = planModeCalls.length > 0 ? null : toolLoopTracker.record([...toolDrafts.values()].map(({ call }) => ({
          name: call.name,
          input: call.input,
          status: call.status,
          output: call.output,
        })));
      if (loop) throw new Error(formatToolLoopError(loop));
      assistantMessage = createAssistantMessage();
      session.messages.push(assistantMessage);
      await store.save(session);
      sendEvent(response, "continuation", { assistantMessage });
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
    if (!response.writableEnded) sendEvent(response, "error", { error: message, message: assistantMessage });
  } finally {
    automaticNameRuns.get(sessionId)?.listeners.delete(onAutomaticName);
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
      const title = await generateSessionTitle(provider, messages, controller.signal, compaction);
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
    return session.planMode?.active || definition.readOnly
      ? CLAUDE_CODE_AGENT_TOOLS.filter((tool) =>
        tool.name === "Bash" || tool.name === "Glob" || tool.name === "Grep" || tool.name === "Read"
      )
      : CLAUDE_CODE_AGENT_TOOLS;
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
  if (!session.agentType) return provider;
  const agentProvider = agentProviders.get(session.agentType);
  if (!agentProvider) throw new Error(`Agent type '${session.agentType}' is no longer configured`);
  return agentProvider;
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
    child = await store.createAgentSession(parent, input.subagentType, input.description);
    throwIfSessionAborted(signal);
    call.agentSessionId = child.id;
    call.agentType = input.subagentType;
    call.agentModel = providerForSession(child).model;
    await persistParent();
    onUpdate(call);
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
  } catch (error) {
    call.status = "error";
    call.output = errorMessage(error);
    call.statusDisplay = { text: "AGENT FAILED" };
    resultText = call.output;
    if (error instanceof Error && error.name === "AbortError") abortAfterResult = error;
    if (abortAfterResult && child) {
      child.agentStatus = "error";
      try { await store.save(child); } catch { /* preserve the original abort */ }
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
  if (command !== "cwd" && command !== "add-dir") {
    return json(response, 400, { error: "Directory completion requires command=cwd or command=add-dir" });
  }
  const fragment = url.searchParams.get("path") ?? "";
  if (fragment.includes("\0") || fragment.includes("\n") || fragment.length > 4_096) {
    return json(response, 400, { error: "Invalid directory completion path" });
  }
  const currentDirectory = sessionWorkingDirectory(session);
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

async function executeCommand(request: IncomingMessage, response: ServerResponse, sessionId: string): Promise<void> {
  if (activeSessions.has(sessionId)) return json(response, 409, { error: "Wait for the current response to finish" });
  const session = await store.get(sessionId);
  if (!session) return json(response, 404, { error: "Session not found" });
  if (session.parentSessionId) return json(response, 403, { error: "Agent sub-sessions are read-only" });
  const body = await readJson(request);
  const rawCommand = typeof body.command === "string" ? body.command.trim() : "";
  const firstWhitespace = rawCommand.search(/\s/);
  const command = (firstWhitespace === -1 ? rawCommand : rawCommand.slice(0, firstWhitespace)).toLowerCase();
  const argument = firstWhitespace === -1 ? "" : rawCommand.slice(firstWhitespace).trim();

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
    activeSessions.register(sessionId, undefined, controller);
    try {
      const title = await generateSessionTitle(provider, session.messages, controller.signal, session.compaction);
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
    const previousBoundary = session.compaction
      ? session.messages.findIndex((message) => message.id === session.compaction?.throughMessageId)
      : -1;
    const newModelMessages = session.messages
      .slice(previousBoundary + 1)
      .filter((message) => message.status === "complete" && isModelMessage(message));
    const throughMessage = newModelMessages.at(-1);
    if (!throughMessage) {
      return json(response, 400, { error: session.compaction ? "No new conversation to compact" : "No conversation to compact" });
    }

    const controller = new AbortController();
    request.once("aborted", () => controller.abort());
    response.on("close", () => {
      if (!response.writableEnded) controller.abort();
    });
    activeSessions.register(sessionId, undefined, controller);
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    sendEvent(response, "start", { message: "Compacting model context…" });
    try {
      const history = buildProviderHistory(session.messages, undefined, session.compaction);
      const beforeTokens = estimateHistoryTokens(history);
      const summary = await generateCompactionSummary(provider, history, controller.signal, (generatedCharacters) => {
        if (!response.destroyed && !response.writableEnded) {
          sendEvent(response, "progress", { generatedCharacters });
        }
      });
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
      const afterTokens = estimateHistoryTokens(buildProviderHistory(session.messages, undefined, compaction));
      session.compaction = compaction;
      session.messages.push({
        id: randomUUID(),
        role: "assistant",
        content: formatCompactionBanner(beforeTokens, afterTokens, coveredMessageCount),
        createdAt: now,
        status: "complete",
        kind: "compact-banner",
      });
      await store.save(session);
      if (!response.destroyed && !response.writableEnded) sendEvent(response, "done", { command: "compact", session });
    } catch (error) {
      if (!response.destroyed && !response.writableEnded) sendEvent(response, "error", { error: errorMessage(error) });
    } finally {
      activeSessions.unregister(sessionId, controller);
      response.end();
    }
    return;
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

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error("Request body too large");
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

function sendEvent(response: ServerResponse, event: string, data: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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
  return {
    session,
    active: activeSessions.has(session.id),
    ...(question ? { questionRequest: question } : {}),
    ...(planModeRequest ? { planModeRequest } : {}),
  };
}

async function serveFile(
  response: ServerResponse,
  path: string,
  contentType: string,
  cacheControl = "public, max-age=3600",
): Promise<void> {
  const content = await readFile(path);
  response.writeHead(200, {
    "content-type": contentType,
    "cache-control": cacheControl,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'",
  });
  response.end(content);
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
