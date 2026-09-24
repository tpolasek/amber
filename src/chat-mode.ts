import { BASH_TOOL } from "./bash-tool.js";
import type { ProviderSystemBlock, ToolDefinition } from "./types.js";

export const CHAT_MODE_TOOLS: ToolDefinition[] = [BASH_TOOL];

export const CHAT_MODE_SYSTEM_PROMPT =
  "You are a helpful assistant for general conversation. You have a single tool, Bash, for running shell commands when they are genuinely useful; otherwise answer directly.";

export function chatModeSystemBlocks(): ProviderSystemBlock[] {
  return [{ type: "text", text: CHAT_MODE_SYSTEM_PROMPT }];
}

export interface ChatModeToggleInput {
  active: boolean;
}

export function parseChatModeToggleInput(value: unknown): ChatModeToggleInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Chat mode selection must be an object");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "active")) {
    throw new Error("Chat mode selection contains an unknown field");
  }
  if (typeof input.active !== "boolean") throw new Error("active must be a boolean");
  return { active: input.active };
}
