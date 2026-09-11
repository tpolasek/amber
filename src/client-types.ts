import type { ThinkingLevel } from "./thinking-level.js";

export interface TokenUsage { input: number; output: number }
export type ToolStatus = "queued" | "running" | "complete" | "error" | "timed_out";
export interface ToolStatusDisplay { text: string; appendElapsed?: boolean }
export interface ToolReadRange { startLine: number; endLine: number; totalLines: number }
export interface MessageImage { mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string }
export interface ToolCall { id: string; name: string; input: Record<string, unknown>; status: ToolStatus; output: string; startedAt?: string; completedAt?: string; durationMs?: number; exitCode?: number | null; workingDirectory?: string; timeoutMs?: number; filePath?: string; readRange?: ToolReadRange; statusDisplay?: ToolStatusDisplay; agentSessionId?: string; agentType?: string; agentModel?: string; agentThinkingLevel?: ThinkingLevel; agentNotificationDeliveredAt?: string; skillModel?: string; skillEffort?: string; images?: MessageImage[] }
export interface Message { id: string; role: "user" | "assistant"; content: string; thinking?: string; thinkingSignature?: string; thinkingProvider?: "anthropic" | "openai"; streamingThinking?: boolean; resyncedThinking?: boolean; createdAt: string; status: "streaming" | "complete" | "error"; kind?: "chat" | "command" | "fork-banner" | "agent-banner" | "plan-banner" | "compact-banner" | "tool-result" | "skill" | "agent-notification"; sourceSessionId?: string; forkedSessionId?: string; usage?: TokenUsage; toolCalls?: ToolCall[]; toolUseId?: string; toolError?: boolean; skillName?: string; images?: MessageImage[] }
export interface SessionCompaction { summary: string; throughMessageId: string; createdAt: string; coveredMessageCount: number }
export type PlanningTaskStatus = "pending" | "in_progress" | "completed";
export const PLANNING_TASK_STATUS_LABELS: Record<PlanningTaskStatus, string> = {
  pending: "WAIT",
  in_progress: "WORK",
  completed: "DONE",
};
export interface PlanningTask { id: string; subject: string; description: string; activeForm: string; status: PlanningTaskStatus; owner: string; blocks: string[]; blockedBy: string[]; metadata: Record<string, unknown> }
export interface InvokedSkill { name: string; path: string; content: string; invokedAt: string }
export interface Session { id: string; title: string; createdAt: string; updatedAt: string; messages: Message[]; model?: string; thinkingLevel?: ThinkingLevel; compaction?: SessionCompaction; directories?: string[]; cwd?: string; addDirInitialized?: boolean; parentSessionId?: string; agentType?: string; agentDescription?: string; agentStatus?: "running" | "complete" | "error" | "stopped"; planningTasks?: PlanningTask[]; planningTaskArchiveHighWaterMark?: number; contextTokens?: number; planMode?: SessionPlanMode; skillRoots?: string[]; skillTouchedPaths?: string[]; invokedSkills?: InvokedSkill[] }
export interface AgentSessionSummary { id: string; description: string; status: NonNullable<Session["agentStatus"]> }
export interface Summary { id: string; title: string; updatedAt: string; messageCount: number; preview: string }
export interface AvailableModel { key: string; provider: string; api: "anthropic" | "openai"; model: string; displayName: string; thinkingLevel: ThinkingLevel; compactTokens?: number }
export interface Config { configured: boolean; authenticationRequired: boolean; configurationError?: string; provider: string; model: string; defaultModel: string; models: AvailableModel[]; mode: "live"; homeDirectory: string; workspaceRoot: string; authActionToken: string; theme: "dark" | "light" | "light+" | "hacker" }
export type AmberTheme = Config["theme"];
export interface EditableModelSettings { thinking_level?: ThinkingLevel; compact_tokens?: number; max_output_tokens?: number }
export interface EditableProviderSettings extends EditableModelSettings {
  api: "anthropic" | "openai";
  auth?: "openai-codex";
  auth_key?: string;
  auth_url?: string;
  default_model?: string;
  models: Record<string, EditableModelSettings>;
}
export interface EditableAgentSettings { type: string; whenToUse: string; systemPrompt: string; readOnly: boolean; compact?: boolean; model?: string; thinking_level?: ThinkingLevel }
export interface EditableSettings {
  theme: AmberTheme;
  default_provider?: string;
  default_agent_provider?: string;
  default_agent_model?: string;
  providers: Record<string, EditableProviderSettings>;
  agents: EditableAgentSettings[];
}
export interface SettingsDocument { settings: EditableSettings; path: string; error?: string }
export interface SavedSettings extends SettingsDocument { config: Config }
export interface AuthProviderStatus { id: "openai-codex"; name: string; authName: string; configured: boolean; providerConfigured: boolean }
export type AuthLoginStatus = { status: "pending" } | { status: "complete" } | { status: "failed"; error: string } | { status: "cancelled" };
export type AuthLoginStart =
  | { id: string; method: "browser"; authorizationUrl: string; redirectUri: string; callbackAvailable: boolean }
  | { id: string; method: "device_code"; userCode: string; verificationUri: string; expiresInSeconds: number };
export interface ActiveAuthLogin { start: AuthLoginStart; status: AuthLoginStatus }
export interface BackgroundTask { id: string; type: "local_bash"; command: string; description: string; workingDirectory: string; status: "running" | "completed" | "failed" | "timed_out" | "killed"; stdout: string; stderr: string; combinedOutput: string; exitCode: number | null; startedAt: string; completedAt?: string; durationMs?: number }
export interface AskUserQuestionOption { label: string; description: string; preview?: string }
export interface AskUserQuestion { question: string; header: string; options: AskUserQuestionOption[]; multiSelect: boolean }
export interface AskUserQuestionRequest { toolUseId: string; questions: AskUserQuestion[] }
export interface SessionPlanMode { active: boolean; planFilePath: string }
export type PlanModeRequest =
  | { toolUseId: string; kind: "enter" }
  | { toolUseId: string; kind: "exit"; plan: string; planFilePath: string };
export interface SessionSnapshot {
  session: Session;
  // Older messages exist before the returned window.
  hasMore: boolean;
  active: boolean;
  compaction?: { generatedCharacters: number };
  questionRequest?: AskUserQuestionRequest;
  planModeRequest?: PlanModeRequest;
}
export interface QuestionSelection { labels: Set<string>; other: string; otherSelected: boolean; focusIndex: number }
export interface DirectoryCompletion { value: string; absolutePath: string; kind?: "directory" | "file" }
export interface MarkdownRenderer { render(source: string): string }
