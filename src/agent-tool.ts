import type { ToolDefinition } from "./types.js";

export type AgentType = "general-purpose" | "code-review";

export interface AgentInput {
  description: string;
  prompt: string;
  subagentType: AgentType;
  model?: "sonnet" | "opus" | "haiku";
  runInBackground: boolean;
}

export interface AgentDefinition {
  type: AgentType;
  whenToUse: string;
  systemPrompt: string;
  readOnly: boolean;
}

const SHARED_PREFIX = "You are an agent for Claude Code, Anthropic's official CLI for Claude. Given the user's message, you should use the tools available to complete the task. Complete the task fully—don't gold-plate, but don't leave it half-done.";

const SHARED_GUIDELINES = `Your strengths:
- Searching for code, configurations, and patterns across large codebases
- Analyzing multiple files to understand system architecture
- Investigating complex questions that require exploring many files
- Performing multi-step research tasks

Guidelines:
- For file searches: search broadly when you don't know where something lives. Use Read when you know the specific file path.
- For analysis: Start broad and narrow down. Use multiple search strategies if the first doesn't yield results.
- Be thorough: Check multiple locations, consider different naming conventions, look for related files.
- NEVER create files unless they're absolutely necessary for achieving your goal. ALWAYS prefer editing an existing file to creating a new one.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested.`;

export const AGENT_DEFINITIONS: readonly AgentDefinition[] = [
  {
    type: "general-purpose",
    whenToUse: "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you.",
    systemPrompt: `${SHARED_PREFIX} When you complete the task, respond with a concise report covering what was done and any key findings — the caller will relay this to the user, so it only needs the essentials.

${SHARED_GUIDELINES}`,
    readOnly: false,
  },
  {
    type: "code-review",
    whenToUse: "Review the most recent working-tree change for concrete logic bugs and errors. Use after code changes when a focused correctness review is needed.",
    systemPrompt: `${SHARED_PREFIX}

You are a code-review agent. Your sole job is to review the repository's most recent change as shown by git diff and report concrete logic bugs or errors.

Rules:
- Start from git diff. Include staged changes if necessary to understand the complete current change.
- Inspect surrounding code only when needed to verify whether a changed line is actually wrong.
- Report only actionable correctness problems: logic bugs, runtime errors, broken edge cases, regressions, or security errors.
- Do not report style, naming, formatting, documentation, test-coverage, or subjective design feedback.
- Do not edit files or otherwise change the repository.
- For each finding, identify the file and line, explain the failure mode, and state when it occurs.
- If there are no logic bugs or errors, say exactly: No logic bugs or errors found.
- Return only the findings (or the no-findings sentence), with no praise, summary, or preamble.`,
    readOnly: true,
  },
] as const;

export const AGENT_TOOL: ToolDefinition = {
  name: "Agent",
  description: [
    "Launch a new agent to handle complex, multi-step tasks autonomously.",
    "",
    "The Agent tool launches a specialized agent in a persisted Amber sub-session. Each invocation starts fresh and returns one final message. If subagent_type is omitted, general-purpose is used.",
    "",
    "Available agent types and the tools they have access to:",
    ...AGENT_DEFINITIONS.map((agent) => `- ${agent.type}: ${agent.whenToUse} (Tools: ${agent.readOnly ? "Bash, Read" : "All tools"})`),
    "",
    "Always include a short description (3-5 words). Brief the agent like a smart colleague who has not seen this conversation, and clearly say whether it should write code or only research.",
    "Launch multiple agents concurrently whenever possible by returning multiple Agent tool uses in a single response. Amber starts all Agent calls from that response in parallel.",
    "Amber currently runs agents in the foreground on the configured model. The model and run_in_background fields are accepted for Claude Code wire compatibility; omit them unless needed by another compatible client.",
  ].join("\n"),
  input_schema: {
    type: "object",
    properties: {
      description: { type: "string", description: "A short (3-5 word) description of the task" },
      prompt: { type: "string", description: "The task for the agent to perform" },
      subagent_type: { type: "string", description: "The type of specialized agent to use for this task" },
      model: {
        type: "string",
        enum: ["sonnet", "opus", "haiku"],
        description: "Optional model override for this agent. Takes precedence over the agent definition's model frontmatter. If omitted, uses the agent definition's model, or inherits from the parent.",
      },
      run_in_background: {
        type: "boolean",
        description: "Set to true to run this agent in the background. You will be notified when it completes.",
      },
    },
    required: ["description", "prompt"],
    additionalProperties: false,
  },
};

export function parseAgentInput(input: Record<string, unknown>): AgentInput {
  const description = typeof input.description === "string" ? input.description.trim() : "";
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  const subagentType = input.subagent_type === undefined ? "general-purpose" : input.subagent_type;
  if (!description) throw new Error("Agent description is required");
  if (!prompt) throw new Error("Agent prompt is required");
  if (description.length > 200) throw new Error("Agent description must be 200 characters or fewer");
  if (prompt.length > 32_000) throw new Error("Agent prompt must be 32,000 characters or fewer");
  if (typeof subagentType !== "string" || !isAgentType(subagentType)) {
    throw new Error(`Agent type '${String(subagentType)}' not found. Available agents: ${AGENT_DEFINITIONS.map((agent) => agent.type).join(", ")}`);
  }
  const model = input.model;
  if (model !== undefined && model !== "sonnet" && model !== "opus" && model !== "haiku") {
    throw new Error("Agent model must be sonnet, opus, or haiku");
  }
  if (input.run_in_background !== undefined && typeof input.run_in_background !== "boolean") {
    throw new Error("Agent run_in_background must be a boolean");
  }
  return {
    description,
    prompt,
    subagentType,
    ...(model ? { model } : {}),
    runInBackground: input.run_in_background === true,
  };
}

export function getAgentDefinition(type: AgentType): AgentDefinition {
  return AGENT_DEFINITIONS.find((agent) => agent.type === type)!;
}

export function startAgentRuns<T extends { id: string }, TResult>(
  calls: readonly T[],
  run: (call: T) => Promise<TResult>,
): Map<string, Promise<TResult>> {
  return new Map(calls.map((call) => [call.id, run(call)]));
}

function isAgentType(value: string): value is AgentType {
  return AGENT_DEFINITIONS.some((agent) => agent.type === value);
}
