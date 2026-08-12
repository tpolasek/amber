# AMBER Agent Terminal

An amber monochrome, terminal-inspired web client for persistent LLM conversations. It uses a vanilla TypeScript browser client and the Node standard library on the server; TypeScript and Node type definitions are the only dependencies.

## Run it

```bash
npm install
npm run build
npm start
```

Configure an Anthropic-compatible backend, then open `http://127.0.0.1:3000`:

```bash
export ANTHROPIC_AUTH_TOKEN="your-key"
export ANTHROPIC_BASE_URL="https://api.z.ai/api/anthropic"
export ANTHROPIC_MODEL="glm-4.7" # optional for Z.AI
# export ANTHROPIC_THINKING_BUDGET_TOKENS=32768 # Z.AI default; set 0 to disable
npm start
```

Environment variables are documented in `.env.example`. `.env` files are intentionally not loaded by the app to avoid another dependency; export variables in the shell or use your process manager.

## Architecture

- `src/client.ts` — responsive browser terminal, session navigation, SSE stream handling, and lightweight safe Markdown rendering.
- Agent responses are rendered inline with `markdown-it`, including tables, fenced code, lists, links, blockquotes, and other CommonMark formatting. Raw HTML is disabled.
- `src/server.ts` — static server and small JSON/SSE API built on `node:http`.
- `src/provider.ts` — provider boundary for Anthropic-compatible APIs. Future tool-use, MCP, approvals, and alternative providers can be added behind this interface.
- Anthropic-compatible text and thinking deltas stream live. Thinking and its opaque signature are stored separately, returned unchanged in subsequent model history, shown expanded while generating, and collapsed into a reopenable disclosure when the response completes.
- `src/shell-tool.ts` — the first agent tool: a blocking Shell runner with streamed output, a 120-second default timeout, a 10-minute maximum, and per-session serialization. Different sessions may execute concurrently.
- `src/file-tools.ts` — Claude Code-style `Read`, `Write`, and `Edit` tools for plain-text files. Images, PDFs, and notebooks are deliberately unsupported.
- `src/store.ts` — atomic JSON persistence under `data/sessions`; sessions use three-word IDs drawn from the bundled [Basic English 2000 word list](https://people.sc.fsu.edu/~jburkardt/datasets/words/basic_english_2000.txt) and durable `/s/:sessionId` URLs.

## Terminal commands

- `/add-dir <directory>` adds a canonical working directory to the active session. Relative paths resolve from the AMBER project and `~/` paths are supported. Added directories are inherited by forks and retained by `/clear`.
- `/context` reports the latest measured active context, input/output usage, session output total, and model-message count. Command output is persisted in the transcript but excluded from model context.
- `/clear` permanently erases the active session's transcript and model context while keeping its existing ID and URL. Use `/fork` first when the conversation should be preserved.
- `/compact` streams visible progress while replacing earlier model context with an LLM-generated continuation summary and retaining the complete transcript for browsing. Its persisted banner reports the estimated before/after context size and reduction; estimates use a provider-independent character heuristic. The summary and boundary are stored as session metadata, the banner is excluded from model context, and the summarization exchange is not added as chat messages.
- `/fork` creates a new session with a copy of the complete transcript and its active compacted context, if present. It appends reciprocal provenance banners linking the fork to its source and the source to its fork. Fork banners persist in chat history but are excluded from model context.
- `/name <session name>` changes the active session's title as shown in the session archive. Running `/name` without a title asks the configured LLM to generate one from the conversation; the naming prompt and response are not saved in chat history.

## API

- `POST /api/sessions` creates a session.
- `GET /api/sessions` lists recent sessions.
- `GET /api/sessions/:id` restores a transcript.
- `DELETE /api/sessions/:id` permanently deletes a session.
- `POST /api/sessions/:id/messages` appends a user message and streams agent events as server-sent events.
- `POST /api/sessions/:id/commands` runs a supported slash command. Bare `/name` and `/compact` invoke the configured model without recording those command exchanges as chat messages.

## Agent tools

- `Shell` runs `/bin/bash -lc <command>` in the project or an `/add-dir` working directory. The model may override the 120-second timeout with `timeout_ms` up to 600,000 ms. Calls within one session execute in order and block the agent loop until completion or timeout; separate sessions can run Shell concurrently. Command, working directory, timeout, duration, exit code, and final status are shown in the transcript; streamed output is collapsed by default and can be expanded on demand.
- `Read` reads an absolute plain-text path with numbered output. It accepts a 1-based `offset` and a `limit` of up to 2,000 lines.
- `Write` creates or completely replaces a plain-text file. Replacing an existing file requires a fresh full `Read` first.
- `Edit` performs an exact string replacement, requiring a unique match unless `replace_all` is set. Existing files require a fresh full `Read`; an empty `old_string` may create a missing file.
- File tools are restricted to the project and directories enabled with `/add-dir`. Calls execute serially within a session; separate sessions remain independent.
- Tool calls and results are persisted and sent back to the model. Tool-result protocol messages remain hidden from the visible transcript, while their status cards remain part of the assistant history.
- `/add-dir` controls the working directories advertised to the agent and accepted as `working_directory`; it is not an operating-system sandbox for arbitrary shell commands.

This first version is intended for local, single-user use and binds to `127.0.0.1` by default. Add authentication and a database-backed `SessionStore` before exposing it publicly.
