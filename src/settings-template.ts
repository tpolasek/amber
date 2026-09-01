import { stringify } from "smol-toml";

const SHARED_AGENT_PREFIX = "You are an agent for Claude Code, Anthropic's official CLI for Claude. Given the user's message, you should use the tools available to complete the task. Complete the task fully—don't gold-plate, but don't leave it half-done.";

const SHARED_AGENT_GUIDELINES = `Your strengths:
- Searching for code, configurations, and patterns across large codebases
- Analyzing multiple files to understand system architecture
- Investigating complex questions that require exploring many files
- Performing multi-step research tasks

Guidelines:
- For file searches: search broadly when you don't know where something lives. Use Read when you know the exact file path.
- For analysis: Start broad and narrow down. Use multiple search strategies if the first doesn't yield results.
- Be thorough: Check multiple locations, consider multiple naming conventions, look for related files.
- NEVER create files unless they're absolutely necessary for achieving your goal. ALWAYS prefer editing an existing file to creating a new one.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested.`;

export const SETTINGS_TEMPLATE = {
  theme: "dark",
  default_provider: "default",
  providers: {
    default: {
      api: "anthropic",
      auth_key: "<INSERT_AUTH_KEY_HERE>",
      auth_url: "<INSERT_AUTH_URL_HERE>",
      default_model: "<INSERT_DEFAULT_MODEL_HERE>",
      thinking_level: "max",
      compact_tokens: 100_000,
      models: {},
    },
  },
  agents: [
    {
      type: "general-purpose",
      whenToUse: "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few times use this agent to perform the search.",
      systemPrompt: `${SHARED_AGENT_PREFIX} When you complete the task, respond with a concise report covering what was done and any key findings — the caller will relay this to the user, so it only needs the essentials.

${SHARED_AGENT_GUIDELINES}`,
      readOnly: false,
      compact: false,
    },
    {
      type: "code-review",
      whenToUse: "Review the most recent working-tree change for concrete logic bugs and errors. Use after code changes when a focused correctness review is needed.",
      systemPrompt: `${SHARED_AGENT_PREFIX}

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
      compact: false,
    },
  ],
} as const;

export const SETTINGS_TEMPLATE_SOURCE = `${stringify(SETTINGS_TEMPLATE).trimEnd()
  .replace('theme = "dark"', 'theme = "dark" # dark (current Amber), light (Solarized Light), light+ (VS Code Light+), or hacker (terminal green)')
  .replace('default_provider = "default"', `default_provider = "default"
# default_agent_provider = ""
# default_agent_model = ""`)
  .replace('compact = false', `compact = false # Set to true to enable auto-compaction of the agent's context.`)}
# model = "<INSERT_AGENT_PROVIDER_SLASH_MODEL_HERE>"

# The provider above uses the Anthropic Messages API (api = "anthropic", the default).
# To add an OpenAI Responses API provider, uncomment and fill in:
# [providers.openai]
# api = "openai"
# auth_key = "<INSERT_OPENAI_KEY_HERE>"
# auth_url = "https://api.openai.com"
# default_model = "gpt-5.4"
# thinking_level = "high"

# To use a ChatGPT Plus/Pro subscription instead of an API key:
# [providers.openai-codex]
# api = "openai"
# auth = "openai-codex"
# default_model = "gpt-5.4"
# thinking_level = "high"
# Then start Amber and connect ChatGPT from the Auth settings dialog.
`;

export const COMMIT_SKILL_TEMPLATE_SOURCE = `---
name: commit
description: Commit the current changes in this git repository with a generated commit message; pass "push" to also push to the remote.
argument-hint: [push]
allowed-tools: Bash, Read, Glob, Grep
---

Commit the current changes in this git repository.

1. Review the working tree (\`git status\`, \`git diff\`, \`git diff --cached\`) and the recent commit style (\`git log\`), then stage and commit the changes.
2. Create a concise, to-the-point commit title, favor bullet points in the body section, and make sure the body covers the high-level details of the change.
3. If the ARGUMENTS include \`push\`, push the commit to the remote after creating it. Otherwise, do not push the commit.
`;
