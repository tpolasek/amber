# Amber Agent - Claude code compatible web CLI
<img width="auto" height="633" alt="amber_gold" src="https://github.com/user-attachments/assets/657cf2c9-17a8-4e07-9fc1-2e77daf409f2" />
I built Amber because I wanted a coding agent that felt like a terminal, but with a browser UI to take advantage of linking. Also Claude Code has a serious amount of bloat that I wanted to cut out.

So I reverse-engineered Claude Code and rebuilt it from scratch as a minimal web CLI, with prompt-accurate reproduction of the workflow.

Amber takes advantage of the fact that it's in a web browser to do many things that CLIs cannot do easily, such as linking forked sessions together with hyperlinks, and linking agent sessions to the main session and vice versa.

What makes it different:
* Amber takes advantage of **hyperlinks everywhere**.
* **Supports OpenAI Codex plans** and pretty much any other provider with OpenAI API and Anthropic API support.
* Only 4 runtime npm dependencies — **diff**, **markdown-it**, **smol-toml**, and **yaml**. No framework, no database, no bloat.
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

The first run creates **~/.amber/settings.toml** and opens Amber's Settings modal. Add your provider credentials and save; Amber validates and loads them without a restart.

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

## Settings

Open Settings with the gear beside the selected model. The modal is the primary interface for **~/.amber/settings.toml** and exposes every supported setting:

- Theme and default provider/agent model selection
- Editable API provider and per-model override lists
- Editable agent definitions, prompts, permissions, model overrides, and compaction
- OpenAI Codex login and connection status

The UI regenerates the TOML file, so hand-written formatting and comments are not preserved. Every save is validated and written atomically before Amber reloads its theme, provider catalog, model defaults, and agents. If startup configuration is invalid, the modal remains open until a working configuration is saved (and a default Codex provider is connected).

API-key providers use either the **Anthropic Messages** or **OpenAI Responses** protocol and default to a 200,000-token compaction threshold. Both protocols discover available models from **/v1/models**. OpenAI-protocol providers prefer the Responses API and automatically fall back to **Chat Completions** for compatible local servers such as LM Studio, Ollama, vLLM, and llama.cpp. OpenAI provider/model ids may contain slashes, so OpenRouter-style backends work.

Agent model precedence is the per-agent model override, then the default agent model within the default agent provider, then that provider's default model. Without agent defaults, agents inherit the session model. Agent auto-compaction is opt-in.

### ChatGPT Plus/Pro OAuth for OpenAI Codex

Amber can use a ChatGPT Plus/Pro subscription through OpenAI's Codex OAuth flow. **Login with Codex** creates and immediately saves this preset, makes it the default provider, and starts browser authentication:

```toml
default_provider = "openai-codex"

[providers.openai-codex]
api = "openai"
auth = "openai-codex"
# auth_url defaults to https://chatgpt.com/backend-api
default_model = "gpt-5.6-sol"
thinking_level = "high"
compact_tokens = 250000
```

The Codex connection section also provides both authentication methods:

- **Browser login** — Authorization Code + PKCE through `auth.openai.com`, with a state-validated callback on `localhost:1455`. Remote sessions can paste the final redirect URL or authorization code.
- **Device code** — displays a code for `https://auth.openai.com/codex/device` and waits for authorization.

Amber uses OpenAI Codex's public native-client ID and sends `originator=amber`. OAuth credentials are stored in **~/.amber/auth.json** with user-only permissions. Access tokens are refreshed automatically when fewer than five minutes remain; refreshes are serialized so concurrent requests cannot overwrite a rotated refresh token. The file contains plaintext access and refresh tokens, so protect access to your user account and home directory.

## User instructions in **AGENTS.md**

Standing guidance for every session goes in **~/.amber/AGENTS.md**. Amber appends the file to the system prompt in a delimited **<user-instructions>** block, so the model can tell your rules apart from Amber's built-in prompt, and treats them as taking precedence wherever the two conflict. Use it for coding conventions, writing style, tools to avoid, and anything else you would otherwise repeat in every session.

```markdown
# House rules

- Never use the em dash. Use a plain dash instead.
- Run the full test suite before claiming work is done.
```

The file is optional and is re-read on every turn, so edits take effect without restarting Amber. An empty or unreadable **AGENTS.md** is reported on the console once and the session continues without it.

## Dependencies

AMBER intentionally has only four direct runtime npm dependencies:

- **diff** — unified diff generation
- **markdown-it** — safe Markdown rendering
- **smol-toml** — **settings.toml** parsing
- **yaml** — skill **SKILL.md** frontmatter parsing

Build and development dependencies are also small:

- **typescript**
- **@types/node**
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
