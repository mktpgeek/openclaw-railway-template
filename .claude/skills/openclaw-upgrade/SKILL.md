---
name: openclaw-upgrade
description: Upgrade the OpenClaw version in the Railway template with pre-flight checks and post-deploy smoke tests.
allowed-tools: Bash Read Edit Grep Glob WebFetch
---

# OpenClaw Upgrade Workflow

You are upgrading the OpenClaw version pinned in the Dockerfile. Follow this structured approach.

## Step 1: Determine Versions

**Current version** — extract from Dockerfile:
```bash
grep 'openclaw@' Dockerfile
```

**Target version** — use the argument if provided (`$ARGUMENTS`), otherwise check npm for latest:
```bash
npm view openclaw version
```

If the user passed a specific version, use that. If they said "latest", look it up.

## Step 2: Load Knowledge Base

Read the breaking changes checklist and reference:
```
Read .claude/memory/openclaw-reference.md
```

Focus on the "Breaking Changes Checklist" section.

## Step 3: Pre-Flight — Check for Breaking Changes

Fetch the CHANGELOG or release notes between the current and target versions:

```bash
# Try fetching the GitHub releases page
```
Use WebFetch to retrieve: `https://github.com/openclaw/openclaw/releases`

Scan for breaking changes between the current and target versions. Look for:
- CLI flag changes (especially `gateway run`, `onboard`, `config set`)
- Config schema changes (renamed/removed keys)
- Plugin SDK changes
- Health endpoint format changes
- Any migration steps mentioned

Summarize findings to the user before proceeding. If there are significant breaking changes, warn the user and ask whether to continue.

## Step 4: Apply the Upgrade

Edit `Dockerfile` line 15 to update the version pin:

```
RUN npm install -g openclaw@<NEW_VERSION> clawhub@latest acpx@0.4.1 @openai/codex@0.118.0 @anthropic-ai/claude-code@2.1.92
```

Only change the `openclaw@X.X.X` part. Leave other packages unchanged unless the user specifically requests updating them too.

## Step 5: Commit and Push

```bash
git add Dockerfile
git commit -m "chore: upgrade openclaw to <NEW_VERSION>"
git push -u origin <current-branch>
```

Tell the user that Railway will auto-deploy from the push. They should wait for the deploy to complete before running smoke tests.

## Step 6: Post-Deploy Smoke Test

Once the user confirms the deploy is complete, prompt them to provide:
- Their Railway URL
- Their SETUP_PASSWORD

Then run:
```bash
bash scripts/smoke-test.sh <RAILWAY_URL> <SETUP_PASSWORD> <NEW_VERSION>
```

The version argument makes the smoke test verify that the deployed version matches what we just set.

## Step 7: Report Results

**Upgrade Summary**:
- Previous version: X.X.X
- New version: Y.Y.Y
- Breaking changes found: (list or "none")
- Smoke test result: PASSED / FAILED

**If smoke test passed**: Done! The upgrade is live.

**If smoke test failed**:
- Suggest running `/openclaw-debug` to diagnose
- If the issue is clearly a breaking change: suggest reverting the Dockerfile and redeploying
  ```bash
  git revert HEAD
  git push
  ```
- If the issue is a config migration: suggest hitting the doctor endpoint
  ```bash
  curl -s -X POST -H "Authorization: Basic $(echo -n '*:<PASSWORD>' | base64)" '<URL>/setup/api/doctor'
  ```
