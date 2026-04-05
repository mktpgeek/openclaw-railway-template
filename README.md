# OpenClaw Railway Template

## Security Notice

> **This template exposes your OpenClaw gateway to the public internet.** **Please read the [OpenClaw security documentation](https://docs.openclaw.ai/gateway/security) before deploying** to understand the risks and recommended configuration. If you only use chat channels (Telegram, Discord, Slack) and don't need the gateway dashboard, you can remove the public endpoint from Railway after setup.

<img width="1860" height="2624" alt="CleanShot 2026-02-23 at 21 59 06@2x" src="https://github.com/user-attachments/assets/2605d44c-4319-4e92-838c-3caa726b9595" />

## What you get

- **OpenClaw Gateway + Control UI** (served at `/` and `/openclaw`)
- A friendly **Setup Wizard** at `/setup` (protected by a password)
- Optional **Web Terminal** at `/tui` for browser-based TUI access
- **ACP agents** preconfigured for external harnesses like Codex and Claude via `acpx`
- Persistent state via **Railway Volume** (so config/credentials/memory survive redeploys)

## How it works (high level)

- The container runs a wrapper web server.
- The wrapper protects `/setup` with `SETUP_PASSWORD`.
- During setup, the wrapper runs `openclaw onboard --non-interactive ...` inside the container, writes state to the volume, and then starts the gateway.
- After setup, **`/` is OpenClaw**. The wrapper reverse-proxies all traffic (including WebSockets) to the local gateway process.
- During setup, the wrapper also enables the bundled `acpx` backend, turns on ACP dispatch, configures Railway-safe non-interactive permissions, and enables Discord/Telegram ACP thread spawning when those channels are configured.

## ACP Agents

This template now configures OpenClaw ACP support as part of the normal setup flow.

- Backend: `acpx`
- Default agent: `codex` unless overridden with `OPENCLAW_ACP_DEFAULT_AGENT`
- Allowed agents: `claude`, `codex`, `copilot`, `cursor`, `droid`, `gemini`, `iflow`, `kilocode`, `kimi`, `kiro`, `openclaw`, `opencode`, `pi`, `qwen`
- Default permission profile: `approve-all`
- Default non-interactive behavior: `deny`
- Runtime command: `/usr/local/bin/acpx` baked into the image
- Codex CLI: `/usr/local/bin/codex` baked into the image
- Codex home: persisted at `/data/.codex` by default on Railway
- Codex workspace trust: `/data/workspace` is auto-added to `/data/.codex/config.toml`
- If you choose `OpenAI Codex (ChatGPT OAuth)` during setup, leave the secret field empty. The wrapper will onboard without a provider secret, then default the model to `openai-codex/gpt-5.4` unless you provide another `openai-codex/...` model.

After setup, validate ACP from chat with:

```text
/acp doctor
```

Then try:

```text
/acp spawn codex --bind here
/acp spawn claude --mode persistent --thread auto
```

If you want ACP sessions to see installed OpenClaw plugin tools, set `OPENCLAW_ACP_PLUGIN_TOOLS_MCP_BRIDGE=true` before setup or redeploy and rerun setup.

For `codex` on Railway, you still need a real `OPENAI_API_KEY` or `CODEX_API_KEY`. A placeholder like `not-needed` will let ACP boot but Codex harness sessions will fail when they try to authenticate.

## Getting chat tokens (so you don't have to scramble)

### Telegram bot token

1. Open Telegram and message **@BotFather**
2. Run `/newbot` and follow the prompts
3. BotFather will give you a token that looks like: `123456789:AA...`
4. Paste that token into `/setup`

### Discord bot token

1. Go to the Discord Developer Portal: https://discord.com/developers/applications
2. **New Application** → pick a name
3. Open the **Bot** tab → **Add Bot**
4. Copy the **Bot Token** and paste it into `/setup`
5. Invite the bot to your server (OAuth2 URL Generator → scopes: `bot`, `applications.commands`; then choose permissions)

## Web Terminal (TUI)

The template includes an optional web-based terminal that runs `openclaw tui` in your browser.

### Enabling

Set `ENABLE_WEB_TUI=true` in your Railway Variables. The terminal is **disabled by default**.

Once enabled, access it at `/tui` or via the "Open Terminal" button on the setup page.

### Security

The web TUI implements multiple security layers:

| Control | Description |
|---------|-------------|
| **Opt-in only** | Disabled by default, requires explicit `ENABLE_WEB_TUI=true` |
| **Password protected** | Uses the same `SETUP_PASSWORD` as the setup wizard |
| **Single session** | Only 1 concurrent TUI session allowed at a time |
| **Idle timeout** | Auto-closes after 5 minutes of inactivity (configurable via `TUI_IDLE_TIMEOUT_MS`) |
| **Max duration** | Hard limit of 30 minutes per session (configurable via `TUI_MAX_SESSION_MS`) |

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_WEB_TUI` | `false` | Set to `true` to enable |
| `TUI_IDLE_TIMEOUT_MS` | `300000` (5 min) | Closes session after inactivity |
| `TUI_MAX_SESSION_MS` | `1800000` (30 min) | Maximum session duration |
| `OPENCLAW_ACP_DEFAULT_AGENT` | `codex` | Default ACP harness when one is not specified |
| `OPENCLAW_ACP_PERMISSION_MODE` | `approve-all` | ACPX permission profile for non-interactive ACP sessions |
| `OPENCLAW_ACP_NON_INTERACTIVE_PERMISSIONS` | `deny` | Behavior when a harness would otherwise prompt |
| `OPENCLAW_ACP_PLUGIN_TOOLS_MCP_BRIDGE` | `false` | Expose installed OpenClaw plugin tools to ACP sessions |
| `OPENCLAW_ACP_MAX_CONCURRENT_SESSIONS` | `8` | ACP session concurrency cap |
| `OPENCLAW_ACP_RUNTIME_TTL_MINUTES` | `120` | ACP session TTL |
| `OPENCLAW_ACP_COMMAND` | `/usr/local/bin/acpx` | ACPX runtime command OpenClaw should launch |
| `OPENCLAW_ACP_EXPECTED_VERSION` | `0.4.1` | Expected ACPX version |
| `OPENCLAW_CODEX_CLI_VERSION` | `0.118.0` | Codex CLI version baked into the image / installed during ACP bootstrap |
| `OPENCLAW_MANAGE_GMAIL_WATCHER` | `false` | Set to `true` only for older OpenClaw builds that do not manage the Gmail hook listener themselves |

## Local testing

```bash
docker build -t openclaw-railway-template .

docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e SETUP_PASSWORD=test \
  -e ENABLE_WEB_TUI=true \
  -e OPENCLAW_STATE_DIR=/data/.openclaw \
  -e OPENCLAW_WORKSPACE_DIR=/data/workspace \
  -v $(pwd)/.tmpdata:/data \
  openclaw-railway-template

# Setup wizard: http://localhost:8080/setup (password: test)
# Web terminal: http://localhost:8080/tui (after setup)
```

## FAQ

**Q: How do I access the setup page?**

A: Go to `/setup` on your deployed instance. When prompted for credentials, use the generated `SETUP_PASSWORD` from your Railway Variables as the password. The username field is ignored—you can leave it empty or enter anything.

**Q: I see "gateway disconnected" or authentication errors in the Control UI. What should I do?**

A: Go back to `/setup` and click the "Open OpenClaw UI" button from there. The setup page passes the required auth token to the UI. Accessing the UI directly without the token will cause connection errors.

**Q: I don't see the TUI option on the setup page.**

A: Make sure `ENABLE_WEB_TUI=true` is set in your Railway Variables and redeploy. The web terminal is disabled by default.

**Q: How do I approve pairing for Telegram or Discord?**

A: Go to `/setup` and use the "Approve Pairing" dialog to approve pending pairing requests from your chat channels.

**Q: I see "pairing required" when opening the Control UI. How do I fix it?**

A: New browsers/devices need a one-time approval from the gateway. Go to `/setup`, click "Manage Devices" in the Devices section, and click "Approve Latest Request". Refresh the Control UI and it should connect. Local connections (127.0.0.1) are auto-approved; remote connections (LAN, public URL) require explicit approval.

**Q: How do I change the AI model after setup?**

A: Use the OpenClaw CLI to switch models. Access the web terminal at `/tui` (if enabled) or SSH into your container and run:

```bash
openclaw models set provider/model-id
```

For example: `openclaw models set anthropic/claude-sonnet-4-20250514` or `openclaw models set openai/gpt-4-turbo`. Use `openclaw models list --all` to see available models.

**Q: Why does `/acp doctor` pass but `/acp spawn codex` or `/acp spawn claude` still fail?**

A: ACP still needs harness-side auth on the host. The OpenClaw gateway model you selected during setup is separate from Codex/Claude/Gemini CLI auth. For Codex on Railway, you need a real `OPENAI_API_KEY` or `CODEX_API_KEY`, plus the Codex CLI installed and the workspace trusted. This template now bootstraps the CLI, stores Codex auth under `/data/.codex`, and keeps trust config on the Railway volume, so the remaining blocker is usually credentials. If a harness reports an auth error on first use, add the required vendor credentials to the Railway environment or log in through the web terminal and rerun `/acp doctor`.

**Q: I see `401 Incorrect API key provided: not-needed`. How do I fix it?**

A: Redeploy the latest template and let it boot once. On startup, the wrapper now removes placeholder auth profiles like `not-needed` and, when Codex OAuth is available, migrates `openai/...` defaults onto the matching `openai-codex/...` model so the gateway stops trying to use a fake OpenAI API key. If you really want the `openai/...` provider instead, rerun setup with a real OpenAI API key.

**Q: How do I access configuration after the initial setup?**

A: Visit `/setup` on your deployed instance at any time — it works both before and after setup. Once configured, the setup page shows your current status along with management tools: device approval, health checks (Run Doctor), data export, and a reset option. You'll need your `SETUP_PASSWORD` to access it.

**Q: My config seems broken or I'm getting strange errors. How do I fix it?**

A: Go to `/setup` and click the "Run Doctor" button. This runs `openclaw doctor --fix --non-interactive --yes`, which performs health checks on your gateway and channels, creates a backup of your config, and repairs recognized migrations or corrupted configuration keys. The wrapper also runs this repair pass automatically on boot for already-configured deployments so updates can normalize older state before the gateway starts.

## Screenshots

## Setup

<img width="2110" height="2032" alt="CleanShot 2026-02-23 at 21 57 59@2x" src="https://github.com/user-attachments/assets/28640eec-fa35-42f2-ba56-cb1fbb9525de" />

## TUI

<img width="2510" height="608" alt="CleanShot 2026-02-23 at 22 08 20@2x" src="https://github.com/user-attachments/assets/61147ec2-ddd5-4b5b-b9ac-0dd81a1ae4c7" />

## Device approval

<img width="1712" height="1376" alt="CleanShot 2026-02-23 at 21 59 21@2x" src="https://github.com/user-attachments/assets/f30ab683-dbc2-4980-ace7-152265e00c79" />

## Support

Need help? [Request support on Railway Station](https://station.railway.com/all-templates/d0880c01-2cc5-462c-8b76-d84c1a203348)
