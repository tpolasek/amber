# AMBER Agent Terminal

An amber monochrome, terminal-inspired web client for persistent LLM conversations. It uses a vanilla TypeScript browser client and the Node standard library on the server; TypeScript and Node type definitions are the only dependencies.

## Run it

```bash
npm install
npm run build
npm start
```

On its first start, Amber creates `~/.amber/settings.toml`:

```toml
auth_key = "<INSERT_AUTH_KEY_HERE>"
auth_url = "<INSERT_AUTH_URL_HERE>"
default_model = "<INSERT_DEFAULT_MODEL_HERE>"

[[agents]]
type = "general-purpose"
whenToUse = "General-purpose agent for researching complex questions..."
systemPrompt = "You are an agent for Claude Code..."
readOnly = false

[[agents]]
type = "code-review"
whenToUse = "Review the most recent working-tree change..."
systemPrompt = "You are a code-review agent..."
readOnly = true
```

The generated agent entries contain the complete built-in prompts; the shortened strings above are only illustrative. Replace the placeholders with the bearer auth key, Anthropic-compatible endpoint, and model, then open `http://127.0.0.1:3000`. The endpoint defaults to `https://api.anthropic.com` when `auth_url` is left as its placeholder.

Agent types, selection guidance, system prompts, and read-only permissions come from the `agents` array. The first entry is used when an Agent call omits `subagent_type`. Read-only agents receive only the `Bash` and `Read` tools; other agents receive all child-agent tools. An absent or empty `agents` array disables the Agent tool.

Environment variables override the corresponding file settings:

```bash
export ANTHROPIC_AUTH_TOKEN="your-key"
export ANTHROPIC_BASE_URL="https://api.z.ai/api/anthropic"
export ANTHROPIC_MODEL="your-model"
npm start
```

`ANTHROPIC_API_KEY` is also supported and uses the `x-api-key` header instead of bearer authentication. `.env` files are intentionally not loaded by the app, so export variables in the shell or use your process manager.

## Architecture

- `src/client.ts` — responsive browser terminal, session navigation, SSE stream handling, and lightweight safe Markdown rendering.
- Agent responses are rendered inline with `markdown-it`, including tables, fenced code, lists, links, blockquotes, and other CommonMark formatting. Raw HTML is disabled.
- `src/server.ts` — static server and small JSON/SSE API built on `node:http`.
- `src/provider.ts` — provider boundary for Anthropic-compatible APIs. Future tool-use, MCP, approvals, and alternative providers can be added behind this interface.
- Top-level agent requests reproduce the captured Claude Code 2.1.88 wire contract: beta endpoint and flags, client headers, adaptive thinking, 32,000 output tokens, structured system/reminder blocks, and matching definitions for Amber's tools.
- Anthropic-compatible text and thinking deltas stream live. Thinking and its opaque signature are stored separately, returned unchanged in subsequent model history, shown expanded while generating, and collapsed into a reopenable disclosure when the response completes.
- `src/bash-tool.ts` — the Bash runner supports streamed foreground execution and Claude Code-style background execution, with a 120-second default timeout and 10-minute maximum.
- `src/background-tasks.ts` and `src/task-tools.ts` — session-scoped background process tracking plus `TaskOutput` and `TaskStop`. Tasks survive the HTTP response and later conversation turns while the Amber server remains running.
- `src/planning-task-tools.ts` — persistent session task-list tracking with `TaskCreate`, `TaskGet`, `TaskList`, and `TaskUpdate`, including metadata and reciprocal dependencies.
- `src/plan-mode.ts` — Claude-compatible `EnterPlanMode`/`ExitPlanMode` definitions, strict input validation, durable plan-file handling, system instructions, and abort-aware browser approvals.
- `src/file-tools.ts` — Claude Code-style `Read`, `Write`, and `Edit` tools for plain-text files. Images, PDFs, and notebooks are deliberately unsupported.
- `src/store.ts` — atomic JSON persistence under `data/sessions`; sessions use three-word IDs drawn from the bundled [Basic English 2000 word list](https://people.sc.fsu.edu/~jburkardt/datasets/words/basic_english_2000.txt) and durable `/s/:sessionId` URLs.

## Terminal commands

- `/add-dir <directory>` authorizes a canonical working-directory root for the active session. Its first successful use also changes the session CWD to that directory; later uses only add roots. Relative paths resolve from the AMBER project and `~/` paths are supported. Added directories and CWD are inherited by forks and retained by `/clear`.
- `/cwd` reports the current working directory. `/cwd <directory>` switches to the project or a path beneath an authorized `/add-dir` root; relative paths resolve from the current CWD.
- `/context` reports the latest measured active context, input/output usage, session output total, and model-message count. Command output is persisted in the transcript but excluded from model context.
- `/clear` permanently erases the active session's transcript, model context, plan-mode state, and plan file while keeping its existing ID and URL. Use `/fork` first when the conversation should be preserved.
- `/compact` streams visible progress while replacing earlier model context with an LLM-generated continuation summary and retaining the complete transcript for browsing. Its persisted banner reports the estimated before/after context size and reduction; estimates use a provider-independent character heuristic. The summary and boundary are stored as session metadata, the banner is excluded from model context, and the summarization exchange is not added as chat messages.
- `/fork` creates a new session with a copy of the complete transcript, its active compacted context, and an independent copy of its plan file and active/inactive plan-mode state. It appends reciprocal provenance banners linking the fork to its source and the source to its fork. Fork banners persist in chat history but are excluded from model context.
- `/name <session name>` changes the active session's title as shown in the session archive. Running `/name` without a title asks the configured LLM to generate one from the conversation; the naming prompt and response are not saved in chat history.
- Sessions whose title is still their generated session ID are named automatically in the background from their first user message. Explicitly named sessions are never auto-renamed.
- `/tasks` opens a Claude Code-style background-task manager. It lists the current session's running tasks newest first, opens the sole task directly, shows live command/output/runtime details, and supports stopping the selected task. `/bashes` is accepted as a compatibility alias.

## API

- `POST /api/run` accepts `{ "prompt": string, "cwd": string }`, creates a persistent session, and blocks until the browser-equivalent agent turn finishes. `cwd` must be an absolute existing directory and is authorized as if `/add-dir` and `/cwd` were run first. Because this blocking endpoint has no browser approval channel, it does not advertise `EnterPlanMode` or `ExitPlanMode`. A successful response is `{ "sessionId": "..." }`; execution errors retain the session and include its ID in the error response.
- `POST /api/sessions` creates a session.
- `GET /api/sessions` lists recent sessions.
- `GET /api/sessions/:id` restores a transcript.
- `DELETE /api/sessions/:id` permanently deletes a session.
- `POST /api/sessions/:id/messages` appends a user message and streams agent events as server-sent events.
- `POST /api/sessions/:id/plan-mode` directly selects the session mode with `{ "active": boolean }`. It is rejected while a response is active or for agent sub-sessions.
- `POST /api/sessions/:id/plan-mode/:toolUseId/decision` resolves the matching pending entry or exit review with `{ "approved": boolean, "feedback"?: string }`. Interactive message streams emit `plan_mode_request` events while awaiting this decision.
- `POST /api/sessions/:id/commands` runs a supported slash command. Bare `/name` and `/compact` invoke the configured model without recording those command exchanges as chat messages.
- `GET /api/sessions/:id/tasks` returns the current session's running background tasks for the live `/tasks` dialog.
- `POST /api/sessions/:id/tasks/:taskId/stop` terminates a running background task selected in that dialog.

For example, this blocks until the complete turn and all foreground tool calls finish:

```bash
curl --fail-with-body http://127.0.0.1:3000/api/run \
  --header 'content-type: application/json' \
  --data '{"prompt":"Inspect this directory and summarize it.","cwd":"/tmp"}'
```

The successful response is `{"sessionId":"..."}`. Invalid input returns `400` without creating a session. If execution fails after creation, the non-2xx JSON response includes both `error` and `sessionId`, and the failed transcript remains available for inspection.

## Agent tools

- The PLAN/NORMAL selector in the sidebar lets the user choose a session mode directly whenever the composer is ready for a new prompt. It is disabled throughout model responses and other composer-busy operations. Selecting PLAN prepares the durable plan path; selecting NORMAL exits plan mode without starting a model turn.
- `EnterPlanMode` accepts only `{}` and is advertised to interactive top-level sessions outside plan mode. It must be the sole tool call in its model response. Amber holds the SSE turn while the browser asks the user to approve or decline entry; a decline ends that model turn.
- While plan mode is active, Amber injects the absolute plan path and read-only planning workflow on every model continuation, including after restart or compaction. Plans live at `~/.amber/plans/<session-id>.md`. The browser banner shows this path, and only `ExitPlanMode` is advertised as the plan control.
- `ExitPlanMode` accepts an optional `allowedPrompts` array of `{ "tool": "Bash", "prompt": string }` entries and must also be the sole tool call. Amber validates that the saved plan is present, nonblank, and no more than 100,000 characters before showing a sanitized Markdown snapshot. Approval exits plan mode and returns that reviewed snapshot to the model for immediate implementation; rejection keeps plan mode active and returns optional feedback for revision. Requested Bash categories are retained and displayed informationally only.
- Plan-mode enforcement is intentionally hybrid rather than a general permission framework. Amber hard-blocks its dedicated `Write` and `Edit` tools for every path except the active session’s plan file. `Read` remains available, and planning subagents receive only `Read` and `Bash`. Bash is technically capable of mutation and follows the injected read-only instruction; `allowedPrompts` does not create command rules or alter Bash behavior.
- `Bash` runs `/bin/bash -lc <command>` in the session CWD by default, or in an explicitly selected `working_directory` beneath the project or an `/add-dir` root. Its Claude Code-style arguments include `timeout` (milliseconds), `description`, and `run_in_background`. Foreground calls within one session execute in order; background calls immediately return a `b`-prefixed task ID and continue independently. The parser still accepts the former `timeout_ms` spelling for saved-history compatibility.
- `TaskOutput` accepts `task_id`, `block` (default `true`), and `timeout` (default 30 seconds, maximum 10 minutes). It returns the task status and currently captured stdout/stderr, waiting for completion when requested.
- `TaskStop` accepts `task_id` and terminates a running background process group. The deprecated Claude Code `shell_id` spelling is accepted for transcript compatibility. Background tasks are isolated to their originating Amber session and are stopped when that session is deleted.
- `TaskCreate` adds a pending planning task with an auto-incremented string ID. `TaskGet` returns its full details, while `TaskList` returns ID-sorted summaries and omits dependencies that have already completed.
- `TaskUpdate` changes only supplied fields, merges metadata (with `null` deleting a key), adds reciprocal dependencies, and permanently removes tasks set to `deleted` without reusing their IDs.
- `Read` reads a plain-text path with numbered output. Relative paths resolve from the session CWD; absolute and `~/` paths are also accepted. It accepts a 1-based `offset` and a `limit` of up to 2,000 lines. Session-level range coverage prevents repeated and fully overlapping reads from duplicating file content in the model context; Write/Edit invalidate the affected file's coverage.
- `Write` creates or completely replaces a plain-text file. Replacing an existing file requires one full `Read` first; successful changes show an expanded unified diff with red removals and green additions.
- `Edit` performs an exact string replacement, requiring a unique match unless `replace_all` is set. Existing files require one full `Read`; an empty `old_string` may create a missing file. Successful changes use the same unified diff display.
- Read/Write/Edit resolve relative paths from the session CWD and remain restricted to the project and directories enabled with `/add-dir`. Calls execute serially within a session; separate sessions remain independent.
- Tool calls and results are persisted and sent back to the model. Tool-result protocol messages remain hidden from the visible transcript, while their status cards remain part of the assistant history. Short tool subjects render compactly on the header line (for example, `Edit: /tmp/example.ts`); long or multiline subjects retain a dedicated row. Bash shows `RUNNING <elapsed>` updated once per second, then replaces that status with its green final duration; timeout status includes the threshold that was hit (for example, `TIMED OUT 120s`). Timeout and exit metadata are shown only for non-zero exits, and commands with no output omit the output disclosure entirely; timing is omitted for Read/Write/Edit. Diffs are expanded by default; regular tool output remains collapsed until opened.
- Agent turns have no fixed tool-round limit. Amber stops only rapid no-progress loops: an identical tool batch or a cycle of up to four batches must repeat three times with unchanged status/output inside 30 seconds. Productive calls and long blocking waits can continue indefinitely.
- `/add-dir` controls the working directories advertised to the agent and accepted as `working_directory`; it is not an operating-system sandbox for arbitrary shell commands.

This first version is intended for local, single-user use and binds to `127.0.0.1` by default. Add authentication and a database-backed `SessionStore` before exposing it publicly.
