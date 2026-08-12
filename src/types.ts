export type MessageRole = "user" | "assistant";
export type MessageStatus = "streaming" | "complete" | "error";

export interface TokenUsage {
  input: number;
  output: number;
}

export type ToolStatus = "queued" | "running" | "complete" | "error" | "timed_out";

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
}

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  thinking?: string;
  thinkingSignature?: string;
  createdAt: string;
  status: MessageStatus;
  kind?: "chat" | "command" | "fork-banner" | "compact-banner" | "tool-result";
  sourceSessionId?: string;
  forkedSessionId?: string;
  usage?: TokenUsage;
  toolCalls?: ToolCall[];
  toolUseId?: string;
  toolError?: boolean;
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
  compaction?: SessionCompaction;
  directories?: string[];
  fileReadState?: Record<string, FileReadState>;
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

export type ProviderContentBlock =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

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
  system?: string;
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
  readonly mode: "live";
  stream(messages: ProviderMessage[], signal: AbortSignal, options?: StreamOptions): AsyncGenerator<StreamEvent>;
}
