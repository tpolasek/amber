import type { ToolDefinition } from "./types.js";

export interface AgentInput {
  description: string;
  prompt: string;
  subagentType: string;
  model?: "sonnet" | "opus" | "haiku";
  runInBackground: boolean;
}

export interface AgentDefinition {
  type: string;
  whenToUse: string;
  systemPrompt: string;
  readOnly: boolean;
  model?: string;
}

export const AGENT_TOOL_NAME = "Agent";

export function createAgentTool(definitions: readonly AgentDefinition[]): ToolDefinition {
  const defaultAgentType = definitions[0]?.type;
  if (!defaultAgentType) throw new Error("At least one agent must be configured");
  return {
    name: AGENT_TOOL_NAME,
    description: [
      "Launch a new agent to handle complex, multi-step tasks autonomously.",
      "",
      `The Agent tool launches a specialized agent in a persisted Amber sub-session. Each invocation starts fresh and returns one final message. If subagent_type is omitted, ${defaultAgentType} is used.`,
      "",
      "Available agent types and the tools they have access to:",
      ...definitions.map((agent) => `- ${agent.type}: ${agent.whenToUse} (Tools: ${agent.readOnly ? "Bash, Glob, Grep, Read" : "All tools"})`),
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
        subagent_type: {
          type: "string",
          enum: definitions.map((agent) => agent.type),
          description: "The type of specialized agent to use for this task",
        },
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
}

export function parseAgentInput(input: Record<string, unknown>, definitions: readonly AgentDefinition[]): AgentInput {
  const description = typeof input.description === "string" ? input.description.trim() : "";
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  const subagentType = input.subagent_type === undefined ? definitions[0]?.type : input.subagent_type;
  if (!description) throw new Error("Agent description is required");
  if (!prompt) throw new Error("Agent prompt is required");
  if (description.length > 200) throw new Error("Agent description must be 200 characters or fewer");
  if (prompt.length > 32_000) throw new Error("Agent prompt must be 32,000 characters or fewer");
  if (typeof subagentType !== "string" || !definitions.some((agent) => agent.type === subagentType)) {
    throw new Error(`Agent type '${String(subagentType)}' not found. Available agents: ${definitions.map((agent) => agent.type).join(", ")}`);
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

export function getAgentDefinition(definitions: readonly AgentDefinition[], type: string): AgentDefinition {
  const definition = definitions.find((agent) => agent.type === type);
  if (!definition) throw new Error(`Agent type '${type}' is no longer configured`);
  return definition;
}

export function startAgentRuns<T extends { id: string }, TResult>(
  calls: readonly T[],
  run: (call: T) => Promise<TResult>,
): Map<string, Promise<TResult>> {
  return new Map(calls.map((call) => [call.id, run(call)]));
}
