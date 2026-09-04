export type MessageRole = "user" | "assistant";
export type MessageStatus = "streaming" | "complete" | "error";
export type ProviderProtocol = "anthropic" | "openai";
export type ThinkingLevel = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/** Base64-encoded image bytes (no data: URL prefix). */
export interface MessageImage {
  mediaType: ImageMediaType;
  data: string;
}

export interface ImageSource {
  type: "base64";
  media_type: ImageMediaType;
  data: string;
}

export type ProviderImageBlock = { type: "image"; source: ImageSource; cache_control?: ProviderCacheControl };

export interface TokenUsage {
  input: number;
  output: number;
}

export type ToolStatus = "queued" | "running" | "complete" | "error" | "timed_out";

export interface ToolStatusDisplay {
  text: string;
  appendElapsed?: boolean;
}

export interface ToolReadRange {
  startLine: number;
  endLine: number;
  totalLines: number;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: ToolStatus;
  output: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  exitCode?: number | null;
  workingDirectory?: string;
  timeoutMs?: number;
  filePath?: string;
  readRange?: ToolReadRange;
  statusDisplay?: ToolStatusDisplay;
  agentSessionId?: string;
  agentType?: string;
  agentModel?: string;
  agentThinkingLevel?: ThinkingLevel;
  agentNotificationDeliveredAt?: string;
  skillModel?: string;
  skillEffort?: string;
}

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  thinking?: string;
  thinkingSignature?: string;
  thinkingProvider?: ProviderProtocol;
  createdAt: string;
  status: MessageStatus;
  kind?: "chat" | "command" | "fork-banner" | "agent-banner" | "plan-banner" | "compact-banner" | "tool-result" | "skill" | "agent-notification";
  sourceSessionId?: string;
  forkedSessionId?: string;
  usage?: TokenUsage;
  toolCalls?: ToolCall[];
  toolUseId?: string;
  toolError?: boolean;
  contentBlocks?: Array<{ type: "text"; text: string }>;
  /** User-attached images, and images returned by image Reads (tool-result messages). */
  images?: MessageImage[];
  /** Skill name for hidden `kind: "skill"` messages. */
  skillName?: string;
}

export interface SessionCompaction {
  summary: string;
  throughMessageId: string;
  createdAt: string;
  coveredMessageCount: number;
}

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
  model?: string;
  /** Per-session reasoning effort override; undefined uses the model default. */
  thinkingLevel?: ThinkingLevel;
  compaction?: SessionCompaction;
  directories?: string[];
  cwd?: string;
  addDirInitialized?: boolean;
  fileReadState?: Record<string, FileReadState>;
  parentSessionId?: string;
  agentType?: string;
  agentDescription?: string;
  agentStatus?: "running" | "complete" | "error" | "stopped";
  planningTasks?: import("./planning-task-tools.js").PlanningTask[];
  planningTaskHighWaterMark?: number;
  planningTaskArchiveHighWaterMark?: number;
  contextTokens?: number;
  planMode?: SessionPlanMode;
  /** Nested project directories with their own skills, discovered from touched files. */
  skillRoots?: string[];
  /** Project paths touched this session, activating `paths:`-gated skills. */
  skillTouchedPaths?: string[];
  /** Exact transformed content of each invoked skill, preserved across compaction. */
  invokedSkills?: SessionInvokedSkill[];
}

export interface SessionInvokedSkill {
  name: string;
  path: string;
  content: string;
  invokedAt: string;
}

export interface SessionPlanMode {
  active: boolean;
  planFilePath: string;
}

export interface FileReadState {
  mtimeMs: number;
  size: number;
  hash: string;
  full: boolean;
  totalLines?: number;
  ranges?: FileReadRange[];
  hasRead?: boolean;
}

export interface FileReadRange {
  startLine: number;
  endLine: number;
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  preview: string;
}

export interface AgentSessionSummary {
  id: string;
  description: string;
  status: NonNullable<Session["agentStatus"]>;
}

export interface ProviderCacheControl {
  type: "ephemeral";
  scope?: "global";
}

export type ProviderContentBlock =
  | { type: "thinking"; thinking: string; signature: string; provider?: ProviderProtocol }
  | { type: "text"; text: string; cache_control?: ProviderCacheControl }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | Array<{ type: "text"; text: string } | ProviderImageBlock>; is_error?: boolean; cache_control?: ProviderCacheControl }
  | ProviderImageBlock;

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export interface StreamOptions {
  tools?: ToolDefinition[];
  /** Null explicitly omits a system prompt; undefined uses the provider default. */
  system?: string | ProviderSystemBlock[] | null;
  temperature?: number;
  thinking?: boolean;
  /** Turn-level reasoning-effort override; falls back to the provider default. */
  thinkingLevel?: ThinkingLevel;
}

export interface ProviderSystemBlock {
  type: "text";
  text: string;
  cache_control?: ProviderCacheControl;
}

export interface ProviderMessage {
  role: MessageRole;
  content: string | ProviderContentBlock[];
}

export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "thinking_signature_delta"; signature: string }
  | { type: "tool_use_start"; index: number; id: string; name: string }
  | { type: "tool_input_delta"; index: number; partialJson: string }
  | { type: "usage"; usage: Partial<TokenUsage> }
  | { type: "done"; stopReason?: string };

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  readonly protocol: ProviderProtocol;
  readonly mode: "live";
  stream(messages: ProviderMessage[], signal: AbortSignal, options?: StreamOptions): AsyncGenerator<StreamEvent>;
}
