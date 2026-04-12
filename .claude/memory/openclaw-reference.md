# OpenClaw Reference — Railway Template Debugging

## Canonical Diagnostic Sequence

Run these in order when troubleshooting:

```bash
openclaw status                        # Overall install health
openclaw gateway status --deep         # Gateway process, port, token auth
# Check wrapper logs (see endpoints below or $STATE_DIR/server.log)
openclaw doctor --fix --non-interactive --yes   # Auto-repair config/state
openclaw channels status --probe       # Channel connectivity
openclaw health --verbose              # Comprehensive health report
```

## Key CLI Commands

| Command | Purpose |
|---------|---------|
| `openclaw --version` | Installed version |
| `openclaw status` | Local gateway reachability, auth age, activity |
| `openclaw status --deep` | Live health probes incl. per-channel checks |
| `openclaw gateway status --deep` | Gateway process + comprehensive checks |
| `openclaw gateway status --json` | Machine-readable gateway status |
| `openclaw health --verbose` | Force live probe with connection details |
| `openclaw health --json` | Machine-readable health snapshot |
| `openclaw doctor --fix` | Diagnose + auto-fix (~70% of gateway issues) |
| `openclaw doctor --deep` | Scan for extra gateway installations |
| `openclaw config get <key>` | Read config value |
| `openclaw config set <key> <value>` | Write config value |
| `openclaw config set --json <key> '<json>'` | Write JSON config value |
| `openclaw config schema` | Dump current config schema |
| `openclaw gateway run --bind loopback --port 18789 --auth token --token <T>` | How wrapper starts gateway |
| `openclaw gateway stop` | Stop running gateway |
| `openclaw channels status --probe` | Channel connectivity check |
| `openclaw plugins doctor` | Plugin health check |
| `openclaw update` | Auto-detect install type, download, doctor, restart |

## Wrapper Health Endpoints (src/server.js)

### No Auth Required

**`GET /healthz`** (line 1078)
```json
{ "ok": true, "gateway": "unconfigured|ready|starting", "gmailWatcher": "unconfigured|ready|starting" }
```

**`GET /setup/healthz`** (line 1095)
```json
{ "ok": true, "wrapper": true, "configured": bool, "gatewayRunning": bool, "gatewayStarting": bool, "gatewayReachable": bool }
```

### Basic Auth Required (`*:<SETUP_PASSWORD>`)

**`GET /setup/api/debug`** (line 2180)
```json
{
  "wrapper": { "node": "...", "port": 8080, "stateDir": "...", "workspaceDir": "...", "configPath": "...", "gatewayTokenFromEnv": bool, "gatewayTokenPersisted": bool },
  "openclaw": { "entry": "...", "node": "...", "version": "...", "channelsAddHelpIncludesTelegram": bool }
}
```

**`GET /setup/api/status`** (line 1125) — Full status: version, auth groups, ACP config, codex status

**`POST /setup/api/doctor`** (line 2286) — Runs `openclaw doctor --fix --non-interactive --yes`

**`GET /setup/api/logs?n=500`** (line 2465) — Last N log lines (max 5000)

**`GET /setup/api/logs/stream`** (line 2479) — Server-Sent Events real-time log stream

## Authentication Details

- **Setup wizard**: Basic auth — username is literal `*`, password is `SETUP_PASSWORD`
  - Header: `Authorization: Basic <base64("*:<password>")>`
- **Gateway**: Bearer token auto-injected by proxy into all proxied requests
  - Token persisted to `${STATE_DIR}/gateway.token` if not set via `OPENCLAW_GATEWAY_TOKEN` env
  - Injected via `http-proxy` event handlers (`proxyReq` + `proxyReqWs`), NOT direct header modification

## Common Errors & Fixes

| Error | Cause | Fix |
|-------|-------|-----|
| `token_missing` / `token_mismatch` | Gateway token not injected into proxied requests | Check proxy event handlers (server.js:667-679). Must use `proxyReq`/`proxyReqWs` events |
| `ECONNREFUSED` on port 18789 | Gateway process not started | Check `ensureGatewayRunning()`, verify `openclaw.json` exists |
| `disconnected (1008): pairing required` | `allowInsecureAuth` not set | Set `gateway.controlUi.allowInsecureAuth=true` during onboarding |
| Gateway exits immediately | Invalid `openclaw.json` or STATE_DIR permissions | Validate JSON, check dir is writable, run `doctor --fix` |
| WebSocket auth failures (intermittent) | Using `req.headers` instead of proxy events | Token must be set via `proxyReqWs` event handler, not direct header mod |
| `Error 1006` (abnormal closure) | Plugin loading crash | Disable non-core plugins, re-enable one by one |
| Channel messages not delivered | DM policy / group allowlist / missing API scopes | Check `openclaw channels status --probe`, verify permissions |
| Anthropic 429 rate limiting | Credentials don't support long-context | Disable `context1m`, configure fallback models |
| No replies to messages | Routing policy / pairing / mention requirements | Check logs for "pairing request" or "mention required" |

## Troubleshooting Flowchart

```
GET /healthz -> what is the "gateway" field?

"unconfigured"
  -> openclaw.json doesn't exist
  -> Go to /setup and complete the wizard
  -> Or check if STATE_DIR is correct

"starting"
  -> Gateway is being spawned or waiting for readiness
  -> Wait 60s, then GET /setup/healthz
  -> If gatewayReachable=false after 60s:
      -> Check logs: GET /setup/api/logs
      -> Look for spawn errors or immediate exits
      -> Run: POST /setup/api/doctor

"ready"
  -> Gateway is running. If requests still fail:
  -> Check /setup/healthz -> gatewayReachable should be true
  -> Check /setup/api/debug -> verify token is persisted
  -> If proxy errors: check token injection in server.js
  -> If channel errors: openclaw channels status --probe
```

## Breaking Changes Checklist (for upgrades)

Before upgrading OpenClaw version in Dockerfile line 15, check:

- [ ] Gateway CLI args still work? (`--bind`, `--port`, `--auth`, `--token`, `--allow-unconfigured`)
- [ ] `onboard --non-interactive` args still work? (check `openclaw onboard --help`)
- [ ] Config schema keys moved or renamed? (run `openclaw config schema` on new version)
- [ ] Health endpoint response format changed?
- [ ] `channels add` CLI interface changed? (check `/setup/api/debug` -> `channelsAddHelpIncludesTelegram`)
- [ ] Existing `openclaw.json` from prior version still parses?
- [ ] Any deprecated config keys removed? (check CHANGELOG between versions)
- [ ] Plugin SDK changes? (check if bundled plugins still load)

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `SETUP_PASSWORD` | (required) | Protects /setup wizard |
| `OPENCLAW_STATE_DIR` | `/data/.openclaw` | Config + credentials |
| `OPENCLAW_WORKSPACE_DIR` | `/data/workspace` | Agent workspace |
| `OPENCLAW_GATEWAY_TOKEN` | (auto-generated) | Auth token for gateway |
| `PORT` | `8080` | Wrapper HTTP port |
| `INTERNAL_GATEWAY_PORT` | `18789` | Gateway internal port |
| `OPENCLAW_ENTRY` | `/usr/local/lib/node_modules/openclaw/dist/entry.js` | Path to entry.js |
| `OPENCLAW_LOG_LEVEL` | `info` | Log level (silent/error/warn/info/debug/trace) |
| `ENABLE_WEB_TUI` | (unset) | Enable terminal at /tui |

## Key File Locations (in container)

- Config: `${OPENCLAW_STATE_DIR}/openclaw.json`
- Gateway token: `${OPENCLAW_STATE_DIR}/gateway.token`
- Wrapper logs: `${OPENCLAW_STATE_DIR}/server.log`
- Workspace: `${OPENCLAW_WORKSPACE_DIR}`
- OpenClaw entry: `${OPENCLAW_ENTRY}`

## Useful Documentation URLs

- Configuration: https://docs.openclaw.ai/gateway/configuration
- Health Monitoring: https://docs.openclaw.ai/gateway/health
- Troubleshooting: https://docs.openclaw.ai/gateway/troubleshooting
- Doctor Command: https://docs.openclaw.ai/cli/doctor
- Releases: https://github.com/openclaw/openclaw/releases
- CHANGELOG: https://github.com/openclaw/openclaw/blob/main/CHANGELOG.md
