# Amber Agent - Claude code compatible web CLI
<img width="auto" height="633" alt="amber_gold" src="https://github.com/user-attachments/assets/657cf2c9-17a8-4e07-9fc1-2e77daf409f2" />
I built Amber because I wanted a coding agent that felt like a terminal, but with a browser UI to take advantage of linking. Also Claude Code has a serious amount of bloat that I wanted to cut out.

So I reverse-engineered Claude Code and rebuilt it from scratch as a minimal web CLI, with prompt-accurate reproduction of the workflow.

Amber takes advantage of the fact that it's in a web browser to do many things that CLIs cannot do easily, such as linking forked sessions together with hyperlinks, and linking agent sessions to the main session and vice versa.

What makes it different:
* Amber takes advantage of **hyperlinks everywhere**.
* **Supports OpenAI Codex plans** and pretty much any other provider with OpenAI API and Anthropic API support.
* Only 6 runtime npm dependencies — **diff**, **markdown-it**, **smol-toml**, **yaml**, **ignore**, and **shell-quote**. No framework, no database, no bloat.
* Easily configurable sub-agents. You can even **customize the model per each agent.**
* Claude Code, rebuilt. **Reverse-engineered from Claude Code's behavior**, reproducing the prompt flow accurately while stripping it down to a lightweight tool.

## Themes 
It supports 4 themes out of the box. `light+` follows the VS Code Light+ palette; the other alternate themes are shown below.
### Theme = hacker

<img width="auto" height="633" alt="amber_hacker" src="https://github.com/user-attachments/assets/802655e8-bdb4-4445-8a1b-f5b75f6d3489" />

### Theme = light
<img width="auto" height="633" alt="amber_light" src="https://github.com/user-attachments/assets/056ec095-a2a5-4e1e-81b6-36519d1c1ac6" />


## Install and run

### Prebuilt binary

Linux x86_64 and Apple Silicon macOS are supported.

```bash
curl -fsSL https://raw.githubusercontent.com/tpolasek/amber/main/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
amber
```

The first run creates **~/.amber/settings.toml**. Add your provider credentials, then run **amber** again.

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

AMBER reads **~/.amber/settings.toml**. Each provider is configured with **api = "anthropic"** (Anthropic Messages API) or **api = "openai"** (OpenAI Responses API); **api** defaults to **"anthropic"** when omitted. Either way, providers discover their available models from **/v1/models**. OpenAI-protocol providers prefer the Responses API and automatically fall back to **Chat Completions** when the server does not implement it (LM Studio, Ollama, vLLM, llama.cpp), so local servers work without extra configuration.

```toml
theme = "dark" # dark (current Amber), light (Solarized Light), light+ (VS Code Light+), or hacker (terminal green)
default_provider = "zai"
default_agent_provider = "openai"
default_agent_model = "gpt-5.4" # Optional; otherwise uses the agent provider's default model.

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

# Local servers speaking the OpenAI Chat Completions API (LM Studio, Ollama,
# vLLM, llama.cpp) use the same "openai" protocol: AMBER tries the Responses
# API first and falls back to Chat Completions when it is unavailable.
[providers.lm-studio]
api = "openai"
auth_key = "your-local-key"   # Any non-empty string when the server does not check keys.
auth_url = "http://127.0.0.1:1234/v1"
default_model = "qwen3-32b"
thinking_level = "high"       # Reasoning is controlled server-side; deltas display when streamed.

[[agents]]
type = "explore"
whenToUse = "Search and inspect a codebase."
systemPrompt = "Inspect the requested code and return concise findings."
readOnly = true
model = "zai/glm-5.3" # Optional; overrides the global agent defaults.
```

The theme is applied when Amber starts. Change **theme** and restart Amber to switch palettes.

Provider credentials belong under **[providers.\<name>]**, never under an agent. API-key provider configuration comes from **settings.toml**; no environment variables are used. **api** selects the provider's protocol: **"anthropic"** (the default) or **"openai"**. OpenAI-protocol providers accept slashed model ids such as **xiaomi/mimo-v2-pro**, so OpenRouter-style backends work. Models in `[[agents]]` are referenced as **provider/model**. Agent model precedence is the per-agent `model`, then `default_agent_model` within `default_agent_provider`, then that provider's default model; without agent defaults, agents inherit the session model. Select a session's model from the model name in the browser's top-right corner.

### ChatGPT Plus/Pro OAuth for OpenAI Codex

Amber can use a ChatGPT Plus/Pro subscription through OpenAI's Codex OAuth flow. Configure the provider without an API key:

```toml
default_provider = "openai-codex"

[providers.openai-codex]
api = "openai"
auth = "openai-codex"
# auth_url defaults to https://chatgpt.com/backend-api
default_model = "gpt-5.4" # Required (or list models) so the provider works before login; replaced by discovery after connecting.
thinking_level = "high"
```

Start Amber, open **AUTH → PROVIDERS** in the sidebar, and choose either:

- **Browser login** — Authorization Code + PKCE through `auth.openai.com`, with a state-validated callback on `localhost:1455`. Remote sessions can paste the final redirect URL or authorization code.
- **Device code** — displays a code for `https://auth.openai.com/codex/device` and waits for authorization.

Amber uses OpenAI Codex's public native-client ID and sends `originator=amber`. OAuth credentials are stored in **~/.amber/auth.json** with user-only permissions. Access tokens are refreshed automatically when fewer than five minutes remain; refreshes are serialized so concurrent requests cannot overwrite a rotated refresh token. The file contains plaintext access and refresh tokens, so protect access to your user account and home directory.

## Dependencies

AMBER intentionally has only six direct runtime npm dependencies:

- **diff** — unified diff generation
- **markdown-it** — safe Markdown rendering
- **smol-toml** — **settings.toml** parsing
- **yaml** — skill **SKILL.md** frontmatter parsing
- **ignore** — gitignore-style matching for `paths:`-gated skills
- **shell-quote** — skill `$ARGUMENTS` parsing

Build and development dependencies are also small:

- **typescript**
- **@types/node**
- **@types/shell-quote**
- **@yao-pkg/pkg** — standalone binary packaging

The packaged binary includes everything needed to run AMBER; Node.js and npm are not required on the destination machine.

### Optional: ripgrep

The Grep and Glob tools search with **ripgrep** when it is installed and fall back to the system **grep** otherwise, so it is not a hard requirement. Installing ripgrep and keeping its **rg** binary on PATH is recommended for the best search performance; multiline pattern matching requires it.

```bash
brew install ripgrep        # macOS
sudo apt install ripgrep    # Debian/Ubuntu
sudo dnf install ripgrep    # Fedora
sudo pacman -S ripgrep      # Arch Linux
cargo install ripgrep       # any platform with Rust
```

## Useful commands

```bash
npm test                 # Build and run all tests
npm run typecheck        # Type-check without emitting files
npm run package:macos    # Build the Apple Silicon binary
npm run package:linux    # Build the Linux x86_64 binary
```

AMBER binds to **127.0.0.1:3000** by default and is intended for local, single-user use.
