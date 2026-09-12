# AGENTS.md

Amber is a minimal, Claude Code–compatible coding agent that runs as a web CLI: a Node.js TypeScript server plus a vanilla TypeScript browser client. Four runtime dependencies (`diff`, `markdown-it`, `smol-toml`, `yaml`), no framework, no database. The server you develop is often the server hosting your own session — see "Reloading" below.

## Commands

- `npm run build` — compile with `tsc` into `dist/` (tests run against `dist/`)
- `npm test` — builds, then runs `node --test dist/test/*.test.js`
- `npm run typecheck` — `tsc --noEmit`
- `npm run test:e2e` — interruption end-to-end test (spawns real servers)
- `npm start` / `./run.sh` — start the server on port 3000

Run the full test suite before finishing any change.

## Layout

- `src/server.ts` — HTTP server and the agent run loop (streaming, tool execution, queued input, compaction). Large; read targeted sections.
- `src/provider.ts`, `src/openai-provider.ts`, `src/openai-chat-provider.ts` — the three wire protocols (Anthropic-style, OpenAI Responses, Chat Completions). All consume the same `ProviderMessage[]` built by `src/history.ts`.
- `src/store.ts` — session persistence: append-only `<id>.log.jsonl` of message operations plus `<id>.meta.json`, with an in-memory cache and canonical-log rewrites.
- `src/session-queue.ts`, `src/session-aborts.ts`, `src/compaction.ts`, `src/session-pagination.ts` — run lifecycle pieces.
- `src/user-instructions.ts` — AGENTS.md loaders (global and project), snapshotted once per session into `session.instructions` and carried in the system prompt.
- `src/client*.ts` — the browser client (no framework, hand-rolled DOM).
- `test/*.test.ts` — `node:test` suites mirroring `src/` filenames.
- `.amber/skills/` — skills available when developing amber itself (`/reload`, `/commit`, `/tag`).

## Persistence and crash invariants

Sessions live in `~/.amber/data/sessions/`. The log is the source of truth for messages; metadata is committed after it. Crash repair is a theme of this codebase: torn log tails are rewritten on load (`store.ts`), and provider history synthesizes results for tool calls interrupted by a crash (`history.ts`). Any change to persistence must keep a mid-run kill recoverable.

## Code style

- TypeScript throughout, ESM imports with `.js` extensions. Follow the style of nearby code.
- **Comments: only when the code is not clear on its own, or to explain a bug fix. Be brief and to the point — never verbose.** Prefer deleting an unclear construct over commenting it.
- Tests use `node:test` + `node:assert/strict`, plain data-literal fixtures.
- Commit messages: one imperative line, e.g. "Repair torn log tails and commit the log before metadata".

## Commit style
- Be brief and to the point, not overly verbose. Bullet points are encouraged.

## Reloading during development

Code changes require a server restart to take effect. Use the `/reload` skill (or `./run.sh` detached): it rebuilds, SIGINTs the old server, and starts a new one. The session you are running in dies mid-flight — that is expected; the session persists on disk and resumes after the reload.
