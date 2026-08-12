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
npm start
```

Environment variables are documented in `.env.example`. `.env` files are intentionally not loaded by the app to avoid another dependency; export variables in the shell or use your process manager.

## Architecture

- `src/client.ts` — responsive browser terminal, session navigation, SSE stream handling, and lightweight safe Markdown rendering.
- `src/server.ts` — static server and small JSON/SSE API built on `node:http`.
- `src/provider.ts` — provider boundary for Anthropic-compatible APIs. Future tool-use, MCP, approvals, and alternative providers can be added behind this interface.
- `src/store.ts` — atomic JSON persistence under `data/sessions`; each session has a durable `/s/:sessionId` URL.

## API

- `POST /api/sessions` creates a session.
- `GET /api/sessions` lists recent sessions.
- `GET /api/sessions/:id` restores a transcript.
- `POST /api/sessions/:id/messages` appends a user message and streams agent events as server-sent events.

This first version is intended for local, single-user use and binds to `127.0.0.1` by default. Add authentication and a database-backed `SessionStore` before exposing it publicly.
