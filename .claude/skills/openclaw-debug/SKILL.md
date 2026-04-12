---
name: openclaw-debug
description: Diagnose and fix OpenClaw Railway deployment issues. Use when the gateway won't start, requests fail, or channels aren't working after an update.
allowed-tools: Bash Read Grep Glob WebFetch
---

# OpenClaw Debug Workflow

You are diagnosing issues with an OpenClaw Railway deployment. Follow this structured approach.

## Step 1: Load Knowledge Base

Read the reference file for CLI commands, error codes, health endpoints, and troubleshooting flowcharts:

```
Read .claude/memory/openclaw-reference.md
```

## Step 2: Get Deployment Info

Ask the user for:
- Their Railway deployment URL (e.g. `https://myapp.up.railway.app`)
- Their `SETUP_PASSWORD`

If the user has already provided these or they are available in environment, proceed.

## Step 3: Run Smoke Test

Run the automated smoke test to get a baseline health snapshot:

```bash
bash scripts/smoke-test.sh <RAILWAY_URL> <SETUP_PASSWORD>
```

Review the output. Pay attention to:
- Is `/healthz` reachable at all? If not, the container may not be running.
- What is the `gateway` field? ("unconfigured", "starting", or "ready")
- Is the gateway reachable? (`gatewayReachable` from `/setup/healthz`)
- Does Basic auth work? (if `/setup/api/debug` fails, password may be wrong)

## Step 4: Follow the Troubleshooting Flowchart

Based on the `gateway` field from `/healthz`:

**"unconfigured"** — `openclaw.json` doesn't exist:
- Direct user to complete setup at `/setup`
- Check if `OPENCLAW_STATE_DIR` is correctly set
- Verify the Railway volume is mounted at `/data`

**"starting"** — Gateway is being spawned:
- Wait 60 seconds and re-check `/setup/healthz`
- If `gatewayReachable` stays false, fetch logs:
  ```bash
  curl -s -H "Authorization: Basic $(echo -n '*:<PASSWORD>' | base64)" '<URL>/setup/api/logs?n=200'
  ```
- Look for spawn errors, immediate exits, or permission issues
- Try running doctor:
  ```bash
  curl -s -X POST -H "Authorization: Basic $(echo -n '*:<PASSWORD>' | base64)" '<URL>/setup/api/doctor'
  ```

**"ready"** — Gateway is running but something is wrong:
- Hit `/setup/api/debug` to check token status and version info
- If `gatewayReachable=false`: internal connectivity issue between wrapper and gateway
- If proxy errors with `token_missing`/`token_mismatch`: check `src/server.js` proxy event handlers
- If channel issues: check `/setup/api/status` for channel configuration

## Step 5: Check for Version-Specific Issues

1. Note the OpenClaw version from `/setup/api/debug` response
2. Check the current Dockerfile version pin: `grep 'openclaw@' Dockerfile`
3. If there was a recent upgrade, review the CHANGELOG for breaking changes between the old and new version
4. Use Context7 MCP (if available) to look up known issues for the installed version

## Step 6: Deeper Diagnostics

If the above steps haven't identified the issue, fetch detailed logs:

```bash
# Recent logs (last 500 lines)
curl -s -H "Authorization: Basic $(echo -n '*:<PASSWORD>' | base64)" '<URL>/setup/api/logs?n=500' | jq -r '.lines[]'
```

Look for:
- `[gateway] starting with command:` — confirms gateway spawn attempt
- `[gateway] ready at` — confirms gateway became healthy
- `[gateway] failed to become ready` — gateway startup timeout
- `[gateway] exited with code` — gateway crash
- `Error:` or `ECONNREFUSED` — specific failures

## Step 7: Report Findings

Summarize your findings in this format:

**Current State**: healthy / degraded / down
**OpenClaw Version**: x.x.x (from /setup/api/debug)
**Gateway Status**: unconfigured / starting / ready
**Issues Found**:
- (list each issue)

**Actions Taken**:
- (what you checked or ran)

**Recommendations**:
- (what the user should do next)

If running doctor resolved the issue, note that. If a version rollback is needed, suggest reverting the Dockerfile change and redeploying.
