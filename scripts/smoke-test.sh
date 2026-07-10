#!/usr/bin/env bash
#
# OpenClaw Railway Smoke Test
# Tests a live Railway deployment by hitting health and debug endpoints.
#
# Usage: bash scripts/smoke-test.sh <RAILWAY_URL> <SETUP_PASSWORD> [expected-openclaw-version] [expected-codex-version]
#
# Examples:
#   bash scripts/smoke-test.sh https://myapp.up.railway.app mysecret
#   bash scripts/smoke-test.sh https://myapp.up.railway.app mysecret 2026.6.11 0.144.1
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------
BASE_URL="${1:-}"
SETUP_PASSWORD="${2:-}"
EXPECTED_VERSION="${3:-}"
EXPECTED_CODEX_VERSION="${4:-}"

if [[ -z "$BASE_URL" || -z "$SETUP_PASSWORD" ]]; then
  echo "Usage: $0 <RAILWAY_URL> <SETUP_PASSWORD> [expected-openclaw-version] [expected-codex-version]"
  exit 1
fi

# Strip trailing slash
BASE_URL="${BASE_URL%/}"

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
if ! command -v curl &>/dev/null; then
  echo "FAIL: curl is required but not found"
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "FAIL: jq is required but not found (install with: brew install jq / apt install jq)"
  exit 1
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
PASS=0
FAIL=0
HTTP_BODY=""
HTTP_STATUS="000"

check() {
  local label="$1"
  local ok="$2"
  if [[ "$ok" == "true" ]]; then
    echo "  PASS  $label"
    ((PASS += 1))
  else
    echo "  FAIL  $label"
    ((FAIL += 1))
  fi
}

normalize_openclaw_version() {
  local raw="$1"
  if [[ "$raw" =~ ([0-9]{4}\.[0-9]+\.[0-9]+([-.][[:alnum:].-]+)?) ]]; then
    echo "${BASH_REMATCH[1]}"
  else
    echo "unknown"
  fi
}

fetch_json() {
  local response
  if response=$(curl -sS --max-time 10 -w $'\n%{http_code}' "$@" 2>/dev/null); then
    HTTP_STATUS="${response##*$'\n'}"
    HTTP_BODY="${response%$'\n'*}"
  else
    HTTP_STATUS="000"
    HTTP_BODY='{}'
  fi
}

# ---------------------------------------------------------------------------
# 1. Unauthenticated health endpoints
# ---------------------------------------------------------------------------
echo ""
echo "=== OpenClaw Railway Smoke Test ==="
echo "URL: $BASE_URL"
echo ""

echo "--- Health Endpoints (no auth) ---"

# /healthz
fetch_json "${BASE_URL}/healthz"
HEALTHZ="$HTTP_BODY"
HEALTHZ_STATUS="$HTTP_STATUS"
HEALTHZ_OK=$(echo "$HEALTHZ" | jq -r '.ok // false')
HEALTHZ_GW=$(echo "$HEALTHZ" | jq -r '.gateway // "unknown"')
check "/healthz returns HTTP 200" "$( [[ "$HEALTHZ_STATUS" == "200" ]] && echo true || echo false )"
check "/healthz returns ok:true" "$HEALTHZ_OK"
echo "       status=$HEALTHZ_STATUS gateway=$HEALTHZ_GW"

# /setup/healthz
fetch_json "${BASE_URL}/setup/healthz"
SETUP_HEALTHZ="$HTTP_BODY"
SETUP_HEALTHZ_STATUS="$HTTP_STATUS"
SETUP_OK=$(echo "$SETUP_HEALTHZ" | jq -r '.ok // false')
SETUP_CONFIGURED=$(echo "$SETUP_HEALTHZ" | jq -r '.configured // false')
SETUP_GW_RUNNING=$(echo "$SETUP_HEALTHZ" | jq -r '.gatewayRunning // false')
SETUP_GW_READY=$(echo "$SETUP_HEALTHZ" | jq -r '.gatewayReady // false')
SETUP_GW_REACHABLE=$(echo "$SETUP_HEALTHZ" | jq -r '.gatewayReachable // false')
check "/setup/healthz returns HTTP 200" "$( [[ "$SETUP_HEALTHZ_STATUS" == "200" ]] && echo true || echo false )"
check "/setup/healthz returns ok:true" "$SETUP_OK"
echo "       status=$SETUP_HEALTHZ_STATUS configured=$SETUP_CONFIGURED gatewayRunning=$SETUP_GW_RUNNING gatewayReady=$SETUP_GW_READY gatewayReachable=$SETUP_GW_REACHABLE"

if [[ "$SETUP_CONFIGURED" == "true" ]]; then
  check "/healthz reports gateway ready" "$( [[ "$HEALTHZ_GW" == "ready" ]] && echo true || echo false )"
  check "/setup/healthz reports gateway running" "$SETUP_GW_RUNNING"
  check "/setup/healthz reports gateway ready" "$SETUP_GW_READY"
  check "/setup/healthz reports gateway reachable" "$SETUP_GW_REACHABLE"
fi

# ---------------------------------------------------------------------------
# 2. Authenticated endpoints
# ---------------------------------------------------------------------------
echo ""
echo "--- Debug & Status Endpoints (Basic auth) ---"

# /setup/api/debug
fetch_json -u "*:${SETUP_PASSWORD}" "${BASE_URL}/setup/api/debug"
DEBUG_RESP="$HTTP_BODY"
DEBUG_NODE=$(echo "$DEBUG_RESP" | jq -r '.wrapper.node // "unknown"')
DEBUG_PORT=$(echo "$DEBUG_RESP" | jq -r '.wrapper.port // "unknown"')
DEBUG_OC_VERSION_RAW=$(echo "$DEBUG_RESP" | jq -r '.openclaw.version // "unknown"')
DEBUG_OC_VERSION=$(normalize_openclaw_version "$DEBUG_OC_VERSION_RAW")
DEBUG_TOKEN_PERSISTED=$(echo "$DEBUG_RESP" | jq -r '.wrapper.gatewayTokenPersisted // false')

if [[ "$DEBUG_OC_VERSION" != "unknown" ]]; then
  check "/setup/api/debug returns OpenClaw version" "true"
  echo "       openclaw=$DEBUG_OC_VERSION node=$DEBUG_NODE port=$DEBUG_PORT tokenPersisted=$DEBUG_TOKEN_PERSISTED"
else
  check "/setup/api/debug returns OpenClaw version" "false"
  echo "       (could not reach endpoint — check SETUP_PASSWORD)"
fi

# /setup/api/status
fetch_json -u "*:${SETUP_PASSWORD}" "${BASE_URL}/setup/api/status"
STATUS_RESP="$HTTP_BODY"
STATUS_CODE="$HTTP_STATUS"
STATUS_CODEX_VERSION=$(echo "$STATUS_RESP" | jq -r '.codexCliVersion // "unknown"')
check "/setup/api/status returns 200" "$( [[ "$STATUS_CODE" == "200" ]] && echo true || echo false )"

if [[ -n "$EXPECTED_CODEX_VERSION" ]]; then
  if [[ "$STATUS_CODEX_VERSION" =~ (^|[^0-9.])${EXPECTED_CODEX_VERSION//./\.}([^0-9.]|$) ]]; then
    check "Codex CLI version matches expected ($EXPECTED_CODEX_VERSION)" "true"
  else
    check "Codex CLI version matches expected ($EXPECTED_CODEX_VERSION), got: $STATUS_CODEX_VERSION" "false"
  fi
fi

# ---------------------------------------------------------------------------
# 3. Version check (optional)
# ---------------------------------------------------------------------------
if [[ -n "$EXPECTED_VERSION" ]]; then
  echo ""
  echo "--- Version Check ---"
  if [[ "$DEBUG_OC_VERSION" == "$EXPECTED_VERSION" ]]; then
    check "OpenClaw version matches expected ($EXPECTED_VERSION)" "true"
  else
    check "OpenClaw version matches expected ($EXPECTED_VERSION), got: $DEBUG_OC_VERSION" "false"
  fi
fi

# ---------------------------------------------------------------------------
# 4. Gateway proxy check (if configured)
# ---------------------------------------------------------------------------
if [[ "$SETUP_CONFIGURED" == "true" ]]; then
  echo ""
  echo "--- Gateway Proxy Check ---"
  PROXY_CODE=$(curl -so /dev/null -w "%{http_code}" --max-time 10 "${BASE_URL}/openclaw" 2>/dev/null || echo "000")
  # 200 or 302 are both acceptable (redirect to /openclaw/ is normal)
  if [[ "$PROXY_CODE" == "200" || "$PROXY_CODE" == "302" || "$PROXY_CODE" == "301" ]]; then
    check "Gateway proxy /openclaw reachable (HTTP $PROXY_CODE)" "true"
  else
    check "Gateway proxy /openclaw reachable (HTTP $PROXY_CODE)" "false"
  fi
fi

# ---------------------------------------------------------------------------
# 5. Unconfigured redirect check
# ---------------------------------------------------------------------------
if [[ "$SETUP_CONFIGURED" == "false" ]]; then
  echo ""
  echo "--- Unconfigured Redirect Check ---"
  REDIR_CODE=$(curl -so /dev/null -w "%{http_code}" --max-time 10 "${BASE_URL}/" 2>/dev/null || echo "000")
  check "/ redirects to /setup when unconfigured (HTTP $REDIR_CODE)" "$( [[ "$REDIR_CODE" == "302" ]] && echo true || echo false )"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== Summary ==="
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
echo ""

if [[ $FAIL -gt 0 ]]; then
  echo "SMOKE TEST FAILED — $FAIL check(s) did not pass"
  exit 1
else
  echo "SMOKE TEST PASSED — all $PASS checks OK"
  exit 0
fi
