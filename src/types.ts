export type MessageRole = "user" | "assistant";
export type MessageStatus = "streaming" | "complete" | "error";

export interface TokenUsage {
  input: number;
  output: number;
}

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  status: MessageStatus;
  kind?: "chat" | "command";
  usage?: TokenUsage;
}

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  preview: string;
}

export interface ProviderMessage {
  role: MessageRole;
  content: string;
}

export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "usage"; usage: Partial<TokenUsage> }
  | { type: "done"; stopReason?: string };

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  readonly mode: "live";
  stream(messages: ProviderMessage[], signal: AbortSignal): AsyncGenerator<StreamEvent>;
}
