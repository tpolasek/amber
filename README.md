# AMBER

AMBER is a simple, local web interface for persistent AI coding sessions. The server uses Node's standard library, the browser client is vanilla TypeScript, and there is no frontend framework or database.

## Install and run

### Prebuilt binary

Linux x86_64 and Apple Silicon macOS are supported.

```bash
curl -fsSL https://raw.githubusercontent.com/tpolasek/amber/main/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
amber
```

The first run creates `~/.amber/settings.toml`. Add your provider credentials, then run `amber` again. AMBER opens its local browser interface automatically.

### Run from source

Requires Node.js 18.17 or newer.

```bash
git clone https://github.com/tpolasek/amber.git
cd amber
npm install
npm run build
npm start
```

For development with automatic rebuilds:

```bash
npm run dev
```

## Configure `settings.toml`

AMBER reads `~/.amber/settings.toml`. Providers use either the Anthropic Messages API or OpenAI Responses API and discover their available models from `/v1/models`.

```toml
default_provider = "zai"

[providers.zai]
api = "anthropic"
auth_key = "your-key"
auth_url = "https://api.z.ai/api/anthropic"
default_model = "glm-5.3" # Optional; otherwise uses the first discovered model.
thinking_level = "max"    # none, low, medium, high, xhigh, or max; levels beyond an API's ceiling are clamped.
compact_tokens = 200000   # Automatically compact context at this size.

# Override a discovered model or add a custom model.
[providers.zai.models.glm-4.7]
thinking_level = "low"
compact_tokens = 100000

# Add OpenAI alongside Anthropic-compatible providers.
[providers.openai]
api = "openai"
auth_key = "your-openai-key"
auth_url = "https://api.openai.com"
default_model = "gpt-5.4"
thinking_level = "high"

[[agents]]
type = "explore"
whenToUse = "Search and inspect a codebase."
systemPrompt = "Inspect the requested code and return concise findings."
readOnly = true
model = "zai/glm-5.3" # Optional; otherwise inherits the session model.
```

Provider credentials belong under `[providers.<name>]`, never under an agent. Models are referenced as `provider/model`. Select a session's model from the model name in the browser's top-right corner.

Environment variables can override the default provider:

```bash
export ANTHROPIC_AUTH_TOKEN="your-key"
export ANTHROPIC_BASE_URL="https://api.z.ai/api/anthropic"
export ANTHROPIC_MODEL="glm-5.3"
amber
```

For an OpenAI default provider, use `OPENAI_API_KEY`, `OPENAI_BASE_URL`, and `OPENAI_MODEL` instead.

## Dependencies

AMBER intentionally has only three direct runtime npm dependencies:

- `diff` — unified diff generation
- `markdown-it` — safe Markdown rendering
- `smol-toml` — `settings.toml` parsing

Build and development dependencies are also small:

- `typescript`
- `@types/node`
- `@yao-pkg/pkg` — standalone binary packaging

The packaged binary includes everything needed to run AMBER; Node.js and npm are not required on the destination machine.

## Useful commands

```bash
npm test                 # Build and run all tests
npm run typecheck        # Type-check without emitting files
npm run package:macos    # Build the Apple Silicon binary
npm run package:linux    # Build the Linux x86_64 binary
```

AMBER binds to `127.0.0.1:3000` by default and is intended for local, single-user use.
