import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { platform, release, type } from "node:os";
import { ASK_USER_QUESTION_TOOL } from "./ask-user-question-tool.js";
import { createAgentTool, type AgentDefinition } from "./agent-tool.js";
import { BASH_TOOL } from "./bash-tool.js";
import { EDIT_TOOL, READ_TOOL, WRITE_TOOL } from "./file-tools.js";
import { GLOB_TOOL } from "./glob-tool.js";
import { GREP_TOOL } from "./grep-tool.js";
import { ENTER_PLAN_MODE_TOOL, EXIT_PLAN_MODE_TOOL } from "./plan-mode.js";
import {
  TASK_CREATE_TOOL,
  TASK_GET_TOOL,
  TASK_LIST_TOOL,
  TASK_UPDATE_TOOL,
} from "./planning-task-tools.js";
import { SKILL_TOOL } from "./skill-tool.js";
import { TASK_OUTPUT_TOOL, TASK_STOP_TOOL } from "./task-tools.js";
import type { ProviderContentBlock, ProviderMessage, ProviderSystemBlock, ToolDefinition } from "./types.js";

const require = createRequire(import.meta.url);
const compatibility = require("./claude-code-compatibility.json") as {
  systemPrefix: ProviderSystemBlock[];
  userPrefix: Array<{ type: "text"; text: string }>;
};

export function createClaudeCodeTools(agentDefinitions: readonly AgentDefinition[]): ToolDefinition[] {
  return [
    ...(agentDefinitions.length ? [createAgentTool(agentDefinitions)] : []),
    ASK_USER_QUESTION_TOOL,
    BASH_TOOL,
    EDIT_TOOL,
    GLOB_TOOL,
    GREP_TOOL,
    READ_TOOL,
    SKILL_TOOL,
    TASK_CREATE_TOOL,
    TASK_GET_TOOL,
    TASK_LIST_TOOL,
    TASK_OUTPUT_TOOL,
    TASK_STOP_TOOL,
    TASK_UPDATE_TOOL,
    WRITE_TOOL,
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

export const CLAUDE_CODE_AGENT_TOOLS: ToolDefinition[] = [
  BASH_TOOL,
  EDIT_TOOL,
  GLOB_TOOL,
  GREP_TOOL,
  READ_TOOL,
  SKILL_TOOL,
  TASK_CREATE_TOOL,
  TASK_GET_TOOL,
  TASK_LIST_TOOL,
  TASK_UPDATE_TOOL,
  WRITE_TOOL,
];

/** Keeps skills available even when an agent is restricted to read-only tools. */
export function toolsForAgentMode(restricted: boolean): ToolDefinition[] {
  if (!restricted) return [...CLAUDE_CODE_AGENT_TOOLS];
  return CLAUDE_CODE_AGENT_TOOLS.filter((tool) =>
    tool.name === "Bash"
      || tool.name === "Glob"
      || tool.name === "Grep"
      || tool.name === "Read"
      || tool.name === SKILL_TOOL.name
  );
}

export function buildClaudeCodeSystemPrompt(
  currentDirectory: string,
  model: string,
  userInstructions?: string,
): ProviderSystemBlock[] {
  const shell = basename(process.env.SHELL ?? "unknown");
  const environment = [
    "# Session-specific guidance",
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
    ` - You are powered by the model ${model}.`,
    "",
    "When working with tool results, write down any important information you might need later in your response, as the original tool result may be cleared later.",
  ].join("\n");

  return [
    ...(structuredClone(compatibility.systemPrefix) as ProviderSystemBlock[]),
    { type: "text", text: environment },
    ...(userInstructions?.trim()
      ? [{
          type: "text" as const,
          text: userInstructionsBlock(userInstructions.trim()),
          cache_control: { type: "ephemeral" as const },
        }]
      : []),
  ];
}

/** Wraps the user's own standing guidance so the model can tell it from the built-in prompt. */
function userInstructionsBlock(instructions: string): string {
  return [
    "# User instructions",
    "",
    "The user wrote the instructions below in ~/.amber/AGENTS.md. They apply to every session in addition to the guidance above, and they take precedence over it wherever the two conflict. They do not override safety rules or the need to confirm risky actions.",
    "",
    "<user-instructions>",
    instructions,
    "</user-instructions>",
  ].join("\n");
}

export function injectClaudeCodeUserContext(messages: ProviderMessage[], skillReminder?: string): ProviderMessage[] {
  let injected = false;
  const prefix: Array<{ type: "text"; text: string }> = skillReminder !== undefined
    ? [{ type: "text", text: skillReminder }]
    : structuredClone(compatibility.userPrefix) as Array<{ type: "text"; text: string }>;
  return messages.map((message, index) => {
    if (injected || message.role !== "user") return message;
    const isLast = index === messages.length - 1;
    injected = true;
    if (Array.isArray(message.content)) {
      return {
        ...message,
        content: [
          ...prefix,
          currentDateReminder(),
          ...markTrailingBlock(message.content, isLast),
        ],
      };
    }
    const promptBlock: ProviderContentBlock = { type: "text", text: message.content };
    if (isLast) promptBlock.cache_control = { type: "ephemeral" };
    return {
      ...message,
      content: [
        ...prefix,
        currentDateReminder(),
        promptBlock,
      ],
    };
  });
}

function markTrailingBlock(blocks: ProviderContentBlock[], isLast: boolean): ProviderContentBlock[] {
  const trailing = blocks.at(-1);
  if (!isLast || !trailing || !(trailing.type === "text" || trailing.type === "tool_result" || trailing.type === "image")) {
    return blocks;
  }
  return [...blocks.slice(0, -1), { ...trailing, cache_control: { type: "ephemeral" } }];
}

function currentDateReminder(): ProviderContentBlock {
  const today = new Date().toISOString().slice(0, 10);
  return {
    type: "text",
    text: `<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# currentDate\nToday's date is ${today}.\n\n      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</system-reminder>\n\n`,
  };
}

export function structureClaudeCodeUserMessages(messages: ProviderMessage[], skillReminder?: string): ProviderMessage[] {
  let injected = false;
  return messages.map((message, index) => {
    if (message.role !== "user") return message;
    const isLast = index === messages.length - 1;
    const reminder: ProviderContentBlock[] = injected ? [] : [
      ...(skillReminder !== undefined ? [{ type: "text", text: skillReminder } as const] : []),
      currentDateReminder(),
    ];
    injected = true;
    if (Array.isArray(message.content)) {
      return { ...message, content: [...reminder, ...markTrailingBlock(message.content, isLast)] };
    }
    const promptBlock: ProviderContentBlock = { type: "text", text: message.content };
    if (isLast) promptBlock.cache_control = { type: "ephemeral" };
    return { ...message, content: [...reminder, promptBlock] };
  });
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
    `You are powered by the model ${model}.`,
  ].join("\n");

  return [
    { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.88.516; cc_entrypoint=cli;" },
    { ...(structuredClone(compatibility.systemPrefix[1]) as ProviderSystemBlock), cache_control: { type: "ephemeral" } },
    { type: "text", text: prompt, cache_control: { type: "ephemeral" } },
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
