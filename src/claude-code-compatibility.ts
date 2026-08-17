import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { platform, release, type } from "node:os";
import compatibility from "./claude-code-compatibility.json" with { type: "json" };
import toolCatalog from "./claude-code-tools.json" with { type: "json" };
import { ASK_USER_QUESTION_TOOL } from "./ask-user-question-tool.js";
import { createAgentTool, type AgentDefinition } from "./agent-tool.js";
import { ENTER_PLAN_MODE_TOOL, EXIT_PLAN_MODE_TOOL } from "./plan-mode.js";
import {
  TASK_CREATE_TOOL,
  TASK_GET_TOOL,
  TASK_LIST_TOOL,
  TASK_UPDATE_TOOL,
} from "./planning-task-tools.js";
import type { ProviderMessage, ProviderSystemBlock, ToolDefinition } from "./types.js";

const catalogTools = toolCatalog.tools as unknown as ToolDefinition[];
const taskOutputIndex = catalogTools.findIndex((tool) => tool.name === "TaskOutput");
const writeIndex = catalogTools.findIndex((tool) => tool.name === "Write");
export function createClaudeCodeTools(agentDefinitions: readonly AgentDefinition[]): ToolDefinition[] {
  return [
    ...(agentDefinitions.length ? [createAgentTool(agentDefinitions)] : []),
    ASK_USER_QUESTION_TOOL,
    ...catalogTools.slice(1, taskOutputIndex),
    TASK_CREATE_TOOL,
    TASK_GET_TOOL,
    TASK_LIST_TOOL,
    ...catalogTools.slice(taskOutputIndex, writeIndex),
    TASK_UPDATE_TOOL,
    ...catalogTools.slice(writeIndex),
  ];
}

export function toolsForPlanMode(
  tools: readonly ToolDefinition[],
  active: boolean,
  approvalCapable = true,
): ToolDefinition[] {
  if (!approvalCapable) return [...tools];
  return [...tools, active ? EXIT_PLAN_MODE_TOOL : ENTER_PLAN_MODE_TOOL];
}

export const CLAUDE_CODE_AGENT_TOOLS = catalogTools.filter((tool) =>
  tool.name === "Bash" || tool.name === "Edit" || tool.name === "Grep" || tool.name === "Read" || tool.name === "Write"
);

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

export function structureClaudeCodeUserMessages(messages: ProviderMessage[]): ProviderMessage[] {
  return messages.map((message) => message.role === "user" && typeof message.content === "string"
    ? { ...message, content: [{ type: "text", text: message.content }] }
    : message);
}

export function buildClaudeCodeAgentSystemPrompt(
  currentDirectory: string,
  model: string,
  agentPrompt: string,
): ProviderSystemBlock[] {
  const shell = basename(process.env.SHELL ?? "unknown");
  const prompt = [
    agentPrompt,
    "",
    "Notes:",
    "- Agent threads always have their cwd reset between bash calls, as a result please only use absolute file paths.",
    "- In your final response, share file paths (always absolute, never relative) that are relevant to the task. Include code snippets only when the exact text is load-bearing (e.g., a bug you found, a function signature the caller asked for) — do not recap code you merely read.",
    "- For clear communication with the user the assistant MUST avoid using emojis.",
    "- Do not use a colon before tool calls. Text like \"Let me read the file:\" followed by a read tool call should just be \"Let me read the file.\" with a period.",
    "",
    "Here is useful information about the environment you are running in:",
    "<env>",
    `Working directory: ${currentDirectory}`,
    `Is directory a git repo: ${isGitRepository(currentDirectory) ? "Yes" : "No"}`,
    `Platform: ${platform()}`,
    `Shell: ${shell}`,
    `OS Version: ${type()} ${release()}`,
    "</env>",
    `You are powered by the model ${model}[1m].`,
  ].join("\n");

  return [
    { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.88.516; cc_entrypoint=sdk-cli;" },
    structuredClone(compatibility.systemPrefix[1]) as ProviderSystemBlock,
    { type: "text", text: prompt },
  ];
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
