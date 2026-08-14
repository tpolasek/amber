import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { platform, release, type } from "node:os";
import compatibility from "./claude-code-compatibility.json" with { type: "json" };
import toolCatalog from "./claude-code-tools.json" with { type: "json" };
import type { ProviderMessage, ProviderSystemBlock, ToolDefinition } from "./types.js";

export const CLAUDE_CODE_TOOLS = toolCatalog.tools as unknown as ToolDefinition[];

export function buildClaudeCodeSystemPrompt(currentDirectory: string, model: string): ProviderSystemBlock[] {
  const shell = basename(process.env.SHELL ?? "unknown");
  const environment = [
    "# Session-specific guidance",
    " - If you do not understand why the user has denied a tool call, use the AskUserQuestion to ask them.",
    " - Use the Agent tool with specialized agents when the task at hand matches the agent's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but they should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing - if you delegate research to a subagent, do not also perform the same searches yourself.",
    " - /<skill-name> (e.g., /commit) is shorthand for users to invoke a user-invocable skill. When executed, the skill gets expanded to a full prompt. Use the Skill tool to execute them. IMPORTANT: Only use Skill for skills listed in its user-invocable skills section - do not guess or use built-in CLI commands.",
    "",
    "# Environment",
    "You have been invoked in the following environment: ",
    ` - Primary working directory: ${currentDirectory}`,
    `  - Is a git repository: ${isGitRepository(currentDirectory)}`,
    ` - Platform: ${platform()}`,
    ` - Shell: ${shell}`,
    ` - OS Version: ${type()} ${release()}`,
    ` - You are powered by the model ${model}[1m].`,
    "",
    "When working with tool results, write down any important information you might need later in your response, as the original tool result may be cleared later.",
  ].join("\n");

  return [
    ...(structuredClone(compatibility.systemPrefix) as ProviderSystemBlock[]),
    { type: "text", text: environment },
  ];
}

export function injectClaudeCodeUserContext(messages: ProviderMessage[]): ProviderMessage[] {
  let injected = false;
  return messages.map((message) => {
    if (injected || message.role !== "user" || typeof message.content !== "string") return message;
    injected = true;
    return {
      ...message,
      content: [
        ...(structuredClone(compatibility.userPrefix) as Array<{ type: "text"; text: string }>),
        { type: "text", text: message.content },
      ],
    };
  });
}

function isGitRepository(directory: string): boolean {
  let candidate = directory;
  for (;;) {
    if (existsSync(join(candidate, ".git"))) return true;
    const parent = dirname(candidate);
    if (parent === candidate) return false;
    candidate = parent;
  }
}
