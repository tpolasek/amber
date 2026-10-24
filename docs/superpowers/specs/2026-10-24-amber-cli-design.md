# Amber CLI Design

Date: 2026-10-24
Status: Approved (sections 1–3), pending implementation plan

## Problem

Amber's only client is the browser UI, which is unusable over a heavily
bandwidth-limited terminal link (~6 kbps). We need a terminal client whose
output is small enough to use comfortably over SSH at that rate, while still
rendering assistant markdown (including tables) with terminal formatting.

**Where the bottleneck sits:** the user SSHes into a host where both the CLI
and the amber server run. Only the bytes between the CLI and the user's
terminal cross the slow link; CLI↔server HTTP is fast and local. The server
therefore needs **no changes** — this is a pure client addition.

## Constraints

- No full-screen redraws, no alternate screen, no cursor addressing.
- Bash output, file-write contents, read/grep results, and thinking text are
  never printed; tools surface as single summary lines.
- Every rendered byte is printed exactly once (no re-render of already-shown
  content).
- No new runtime dependencies (`markdown-it` already exists in the repo).
- Follow repo conventions: TypeScript ESM with `.js` import extensions,
  `node:test` with plain data fixtures.

## Non-goals (v1)

- Model / thinking-level switching, planning-task list rendering, streaming
  thinking display (thinking only feeds the status line).
- Image attachment input; images in history render as `[img: alt]`.
- Raw-mode TUI, mouse support, scrollback management (the terminal owns it).

## Architecture

New `src/cli/` modules; dispatch as a subcommand of the existing single
binary (`bin` stays `dist/src/server.js`):

| File | Purpose |
|---|---|
| `src/cli/main.ts` | Entry (`runCli(argv)`): arg parsing, session resolution, REPL loop |
| `src/cli/api.ts` | HTTP client: messages, commands, abort, answers, plan decisions, list/create; base URL from `--server` or `AMBER_SERVER`, default `http://127.0.0.1:3000` |
| `src/cli/stream.ts` | SSE subscription via `fetch` reusing `src/sse.ts`; reconnect with 1s→10s capped backoff |
| `src/cli/blocks.ts` | Incremental markdown block splitter (pure) |
| `src/cli/render.ts` | markdown-it token stream → ANSI renderer, width wrapping, wcwidth (pure) |
| `src/cli/tools.ts` | One-line `ToolCall` summaries (pure) |
| `src/cli/term.ts` | Batched append-only writer, single status line, SGR constants, `NO_COLOR`/non-TTY fallback |

`src/cli.ts` (server arg parser) gains a `cli` subcommand; `src/server.ts`
dispatches to `runCli` before starting the server. Server startup path is
untouched.

### Command surface

- `amber cli` — resume the most recently updated session (prints one line
  identifying it, no prompt).
- `amber cli --new [name]` — create a session rooted at the current directory.
- `amber cli --list` — print `id  title  updated` lines, exit.
- `amber cli <id-prefix>` — resume the session whose id matches the prefix.
- `--server URL`, `--history N` (turns printed on attach, default 2).

## Bandwidth mechanics

At 6 kbps, SSH per-packet overhead dominates; the payload is secondary.
Three rules follow:

1. **Append-only output.** Bytes flow one direction, once. The single
   exception is a one-line status line rewritten with `\r\x1b[K` (~1 Hz while
   a run is active, only on change or ticker tick), cleared when idle.
   Example: `streaming 1.4k · Bash npm test 3s`.
2. **Batched flushes.** All writes buffer in `term.ts`; flush at ≥250 ms
   intervals, when >4 KB accumulates, or explicitly (gates, errors, `done`).
   Writes are line-atomic so a flush never tears a line.
3. **One line per tool call.** Printed at completion:
   `✓ Bash npm test · 0 · 2.1s`, `✓ Edit src/cli/main.ts`,
   `✗ Grep TODO · error`. Arguments are summarized (command or path, first
   ~60 chars; line ranges for reads; match counts where derivable). Tool
   output is retrievable on demand via local `/output` (see below).

### Streaming at block granularity

Assistant `delta` text accumulates in `blocks.ts`. Each time a markdown block
*closes* — blank line outside a fenced code block, closing fence line, or end
of a table — that block is rendered and appended once. The pending partial
block flushes on `done`. Result: formatted output, one copy of every byte,
no re-rendering. Loose lists spanning blank lines render as separate
paragraph-style blocks — accepted visual simplification.

### Rendering (markdown-it tokens → ANSI)

- Headings: bold. Emphasis: italic. Strong: bold.
- Inline code: cyan (36/39). Fenced code: dim (2/22), two-space indent, no
  boxes, no language tag.
- Lists: hanging indent; wrapped continuation lines align under content;
  nesting indents two spaces per level.
- Blockquotes: dim `> ` bar.
- Links: `text` when the URL equals the text, else `text (url)`.
  Images: `[img: alt]` — never fetched.
- Horizontal rule: short dim dash line.
- Tables: real measured column widths (wcwidth-aware), padding and alignment
  per `:` markers, bold header row, `---` separator, over-wide columns wrap
  proportionally so the table fits `process.stdout.columns` (default 80).
- CJK / wide characters measured by a small wcwidth range table; combining
  marks count zero.
- `NO_COLOR` set or stdout not a TTY ⇒ all SGR codes stripped; wrapping still
  applies.

## Behavior

### Live event flow

On connect the SSE stream yields a `snapshot`; the CLI prints the last
`--history` turns formatted, then tracks new events:

- `delta` → block stream (above). `thinking_delta` → status line only.
- `tool_update` → status line while running; one summary line on completion.
- `user_message` (queued, goal reminder, continuation) → one dim line.
- `assistant_complete` / `done` → flush pending block; one dim usage line
  (`· 3.1k→0.8k tok`).
- `error` → flush, print error line.
- `session_named` → one dim line.
- `compaction_*` → status line while running; one line on completion.

### Interactive gates

- `ask_user_question`: flush, print each question header and numbered options
  (noting multi-select where applicable), read answers inline (`1,3` or free
  text), POST `{ answers: Record<questionText, string> }` to
  `/questions/:toolUseId/answers` — selected option labels joined with `", "`,
  free text passed through verbatim (mirrors the browser client). Empty input
  declines via `{ cancelled: true }`.
- `plan_mode_request`: flush, print the plan as formatted markdown, prompt
  `approve / decline / new session`, POST the decision to
  `/plan-mode/:toolUseId/decision`.

### Control flow

- While a run is active: one Ctrl-C POSTs `/abort`; a second Ctrl-C exits.
  Submitted text during a run POSTs to `queued-message` and prints `· queued`.
- While idle: Ctrl-C or `/quit` exits.
- Slash input starting with `/` POSTs to the server's `/commands` endpoint —
  `/compact`, `/clear`, `/name`, `/add-dir`, `/goal`, `/cwd`, `/git`,
  `/fork`, skills, plugins all work server-side; a 400 prints the error line.
- Local-only commands (never sent): `/output [chars=2000]` (tail of the most
  recent tool call's output, from the cached last `tool_update` — no index in
  v1), `/history [n]` (fetch and print n more turns), `/list`, `/new`,
  `/quit`.

### Reconnect and crash behavior

SSE drop → retry at 1s, 2s, 5s, then 10s (capped). The reconnect `snapshot`
diffs against per-message printed-block counts, so only unseen messages and
unprinted trailing blocks render. The session log is server-side, so a dead
CLI loses nothing but its own scrollback.

## Testing

- Unit tests, repo style (`node:test` + `assert/strict`, data-literal
  fixtures): `render` (golden outputs including table wrapping, CJK widths,
  NO_COLOR stripping), `blocks` (fence/blank-line/table splits, partial-tail
  holds), `tools` (summary lines per tool name/status), arg parsing.
- One e2e in the mold of `test/interrupt.e2e.mjs`: spawn a server on a spare
  port, drive the CLI with scripted stdin, assert transcript bytes (including
  that tool output is absent). Skipped if faking a provider in that harness
  proves disproportionate.
