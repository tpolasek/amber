# General-Purpose Subagent — Technical Overview

Based on the source at `/Users/thomas/code/xude`, here is how the general-purpose agent's system prompt is composed, assembled at runtime, and the engineering trade-offs behind it.

## 1. Source of Truth

**File:** `src/tools/AgentTool/built-in/generalPurposeAgent.ts`

This file exports a single `BuiltInAgentDefinition` named `GENERAL_PURPOSE_AGENT`. Unlike user-defined agents (which live on disk as Markdown-with-frontmatter and are parsed by `loadAgentsDir.ts`), built-ins are plain TS objects registered in-process.

```ts
export const GENERAL_PURPOSE_AGENT: BuiltInAgentDefinition = {
  agentType: "general-purpose",
  whenToUse: "General-purpose agent for researching complex questions, …",
  tools: ["*"],                  // wildcard — full tool pool
  source: "built-in",
  baseDir: "built-in",
  // model intentionally omitted → falls back to getDefaultSubagentModel()
  getSystemPrompt: getGeneralPurposeSystemPrompt,
};
```

Notable fields:
- `tools: ["*"]` — gets every tool the parent pool has, after denylists/permissions are applied.
- No `model` — uses `getDefaultSubagentModel()`, so subagent model selection is centrally controlled and can be re-pointed (e.g., to a cheaper model) without touching the agent definition.
- `disallowedTools` is absent; the prompt-builder at `prompt.ts:15-37` handles allow/deny combinations and renders either `"All tools"`, `"All tools except …"`, or the filtered allowlist into the tool description shown to the parent.

## 2. Prompt Composition

`getGeneralPurposeSystemPrompt()` (line 19) concatenates three pieces:

```
SHARED_PREFIX + middle-section + SHARED_GUIDELINES
```

### SHARED_PREFIX (shared by every built-in agent)
> You are an agent for Claude Code, Anthropic's official CLI for Claude. Given the user's message, you should use the tools available to complete the task. Complete the task fully—don't gold-plate, but don't leave it half-done.

This is the **identity + completion-ethic** anchor. Phrased once, reused across all built-ins.

### Middle section (general-purpose-specific)
> When you complete the task, respond with a concise report covering what was done and any key findings — the caller will relay this to the user, so it only needs the essentials.

This is the **return-contract**: results are funneled back through the parent, so verbosity is wasted. Other built-ins (e.g., a hypothetical `explore`) would substitute a different middle section here.

### SHARED_GUIDELINES (shared)
Four "strengths" bullets plus five guidelines. Two of the guidelines are negative rules with `NEVER`:
- Don't create files unless necessary; prefer editing existing ones.
- Don't proactively create `*.md` / README docs.

The strengths list double-functions as a self-description the parent model reads via `formatAgentLine()` to decide *when* to spawn this agent.

## 3. Runtime Augmentation: `enhanceSystemPromptWithEnvDetails`

The comment on line 18 flags that the static prompt is **not the whole story**:

> Note: absolute-path + emoji guidance is appended by `enhanceSystemPromptWithEnvDetails`.

Defined at `src/constants/prompts.ts:585`, this function takes the static prompt array and appends three more blocks:

1. **`Notes:`** block — four hard rules:
   - Always use absolute paths (agent cwds reset between bash calls).
   - Final response must contain absolute paths; only include code snippets when load-bearing.
   - **No emojis** in user-facing output.
   - No colon before tool calls (style/parse correctness).

2. Discover-skills guidance (currently `null` — gated off in this build).

3. **`envInfo`** — produced by `computeEnvInfo(model, additionalWorkingDirectories)`. Contains platform, OS version, working directory, additional dirs, git state, date.

So the *effective* prompt a freshly-spawned general-purpose agent sees is:

```
[SHARED_PREFIX]
[middle: report contract]
[SHARED_GUIDELINES]
[Notes: absolute paths / no emojis / no colon before tools]
[Env info block]
```

## 4. Why It's Split This Way — Cache Hygiene

The split between static prompt and runtime-appended env info is deliberate. From `prompt.ts:48-63` and the `getSessionSpecificGuidanceSection` docstring (`prompts.ts:271-279`):

- Anything that varies per-session (working dir, enabled tools, subscription tier, fork-enabled flag) is kept **after** `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` or pushed into attachment messages.
- This is described explicitly as preventing "Blake2b prefix hash variants" from multiplying `2^N` — each conditional in the static prefix would bin the prompt-cache key into a separate bucket and tank cache hit rates fleet-wide.

The same reasoning drives `shouldInjectAgentListInMessages()` (`prompt.ts:59-63`): the agent roster used to be inlined into the Agent tool description, but MCP plugin loads, `/reload-plugins`, and permission-mode flips mutated it constantly — described as "~10.2% of fleet cache_creation tokens." The fix is to ship the roster as an `agent_listing_delta` attachment and keep the tool description static.

## 5. Coordinator vs. Non-Coordinator Parent Prompts

`getPrompt()` in `prompt.ts:65` builds the **parent's** view of the tool — what *I* see when I decide to spawn an agent. Two branches:

- **Coordinator mode** (`isCoordinator=true`): returns only the slim `shared` block. The coordinator system prompt already contains usage/examples/when-not-to-use guidance, so duplicating it here would bust cache.
- **Non-coordinator**: appends the "When NOT to use" section, "Usage notes," optional background-task guidance, fork guidance (if `isForkSubagentEnabled()`), "Writing the prompt," and examples.

The fork flag (`isForkSubagentEnabled()`) rewrites large chunks: it inserts a "When to fork" section, swaps examples for fork-aware ones, and changes the omission rule from "general-purpose is the default" to "omitting `subagent_type` forks yourself." This is a build-time / feature-flag decision, not a per-call one.

## 6. Concurrency Nudge

`prompt.ts:234-238` injects an extra bullet — *"Launch multiple agents concurrently whenever possible…"* — **only** when the subscription tier is not `pro` and the roster isn't being shipped via attachment. So the parent model's bias toward parallelism is a lever the product team can tune without rewriting the prompt.

## 7. Return Path

The general-purpose prompt's middle section tells the agent to "respond with a concise report." That report is the tool result the parent receives. `prompt.ts:246` then reminds the parent: *"The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result."* This is why the agent itself never addresses the user directly — it's a single hop back to the parent.

---

### TL;DR

The general-purpose agent's prompt is a **three-layer sandwich**: a shared identity prefix, a role-specific middle (here: a return-value contract), and shared strengths/guidelines. At spawn time, `enhanceSystemPromptWithEnvDetails` glues on an absolute-path/no-emoji `Notes` block and a computed environment block. The split exists to keep the static portion cache-stable, with session-variant bits isolated behind a dynamic boundary or shipped as attachments. The agent itself has `tools: ["*"]`, no fixed model, and returns a single summarized message that the parent relays to the user.
