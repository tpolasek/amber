# AMBER

AMBER is a simple, local web interface for persistent AI coding sessions. It supports both Anthropic- and OpenAI-compatible providers. The server uses Node's standard library, the browser client is vanilla TypeScript, and there is no frontend framework or database.

## Install and run

### Prebuilt binary

Linux x86_64 and Apple Silicon macOS are supported.

```bash
curl -fsSL https://raw.githubusercontent.com/tpolasek/amber/main/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
amber
```

The first run creates **~/.amber/settings.toml**. Add your provider credentials, then run **amber** again. AMBER opens its local browser interface automatically.

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

## Configure **settings.toml**

AMBER reads **~/.amber/settings.toml**. Each provider is configured with **api = "anthropic"** (Anthropic Messages API) or **api = "openai"** (OpenAI Responses API); **api** defaults to **"anthropic"** when omitted. Either way, providers discover their available models from **/v1/models**.

```toml
default_provider = "zai"

[providers.zai]
api = "anthropic"        # "anthropic" (default) or "openai"
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

Provider credentials belong under **[providers.\<name>]**, never under an agent. All provider configuration comes from **settings.toml**; no environment variables are used. **api** selects the provider's protocol: **"anthropic"** (the default) or **"openai"**. OpenAI-protocol providers accept slashed model ids such as **xiaomi/mimo-v2-pro**, so OpenRouter-style backends work. Models are referenced as **provider/model**. Select a session's model from the model name in the browser's top-right corner.

## Dependencies

AMBER intentionally has only three direct runtime npm dependencies:

- **diff** — unified diff generation
- **markdown-it** — safe Markdown rendering
- **smol-toml** — **settings.toml** parsing

Build and development dependencies are also small:

- **typescript**
- **@types/node**
- **@yao-pkg/pkg** — standalone binary packaging

The packaged binary includes everything needed to run AMBER; Node.js and npm are not required on the destination machine.

## Useful commands

```bash
npm test                 # Build and run all tests
npm run typecheck        # Type-check without emitting files
npm run package:macos    # Build the Apple Silicon binary
npm run package:linux    # Build the Linux x86_64 binary
```

AMBER binds to **127.0.0.1:3000** by default and is intended for local, single-user use.
