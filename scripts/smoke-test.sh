#!/usr/bin/env bash
#
# OpenClaw Railway Smoke Test
# Tests a live Railway deployment by hitting health and debug endpoints.
#
# Usage: bash scripts/smoke-test.sh <RAILWAY_URL> <SETUP_PASSWORD> [expected-version]
#
# Examples:
#   bash scripts/smoke-test.sh https://myapp.up.railway.app mysecret
#   bash scripts/smoke-test.sh https://myapp.up.railway.app mysecret 2026.4.11
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------
BASE_URL="${1:-}"
SETUP_PASSWORD="${2:-}"
EXPECTED_VERSION="${3:-}"

if [[ -z "$BASE_URL" || -z "$SETUP_PASSWORD" ]]; then
  echo "Usage: $0 <RAILWAY_URL> <SETUP_PASSWORD> [expected-version]"
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
AUTH_HEADER="Authorization: Basic $(echo -n "*:${SETUP_PASSWORD}" | base64)"

check() {
  local label="$1"
  local ok="$2"
  if [[ "$ok" == "true" ]]; then
    echo "  PASS  $label"
    ((PASS++))
  else
    echo "  FAIL  $label"
    ((FAIL++))
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
HEALTHZ=$(curl -sf --max-time 10 "${BASE_URL}/healthz" 2>/dev/null || echo '{}')
HEALTHZ_OK=$(echo "$HEALTHZ" | jq -r '.ok // false')
HEALTHZ_GW=$(echo "$HEALTHZ" | jq -r '.gateway // "unknown"')
check "/healthz returns ok:true" "$HEALTHZ_OK"
echo "       gateway=$HEALTHZ_GW"

# /setup/healthz
SETUP_HEALTHZ=$(curl -sf --max-time 10 "${BASE_URL}/setup/healthz" 2>/dev/null || echo '{}')
SETUP_OK=$(echo "$SETUP_HEALTHZ" | jq -r '.ok // false')
SETUP_CONFIGURED=$(echo "$SETUP_HEALTHZ" | jq -r '.configured // false')
SETUP_GW_RUNNING=$(echo "$SETUP_HEALTHZ" | jq -r '.gatewayRunning // false')
SETUP_GW_REACHABLE=$(echo "$SETUP_HEALTHZ" | jq -r '.gatewayReachable // false')
check "/setup/healthz returns ok:true" "$SETUP_OK"
echo "       configured=$SETUP_CONFIGURED gatewayRunning=$SETUP_GW_RUNNING gatewayReachable=$SETUP_GW_REACHABLE"

# ---------------------------------------------------------------------------
# 2. Authenticated endpoints
# ---------------------------------------------------------------------------
echo ""
echo "--- Debug & Status Endpoints (Basic auth) ---"

# /setup/api/debug
DEBUG_RESP=$(curl -sf --max-time 10 -H "$AUTH_HEADER" "${BASE_URL}/setup/api/debug" 2>/dev/null || echo '{}')
DEBUG_NODE=$(echo "$DEBUG_RESP" | jq -r '.wrapper.node // "unknown"')
DEBUG_PORT=$(echo "$DEBUG_RESP" | jq -r '.wrapper.port // "unknown"')
DEBUG_OC_VERSION=$(echo "$DEBUG_RESP" | jq -r '.openclaw.version // "unknown"')
DEBUG_TOKEN_PERSISTED=$(echo "$DEBUG_RESP" | jq -r '.wrapper.gatewayTokenPersisted // false')

if [[ "$DEBUG_OC_VERSION" != "unknown" ]]; then
  check "/setup/api/debug returns OpenClaw version" "true"
  echo "       openclaw=$DEBUG_OC_VERSION node=$DEBUG_NODE port=$DEBUG_PORT tokenPersisted=$DEBUG_TOKEN_PERSISTED"
else
  check "/setup/api/debug returns OpenClaw version" "false"
  echo "       (could not reach endpoint — check SETUP_PASSWORD)"
fi

# /setup/api/status
STATUS_CODE=$(curl -so /dev/null -w "%{http_code}" --max-time 10 -H "$AUTH_HEADER" "${BASE_URL}/setup/api/status" 2>/dev/null || echo "000")
check "/setup/api/status returns 200" "$( [[ "$STATUS_CODE" == "200" ]] && echo true || echo false )"

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
# 4. Gateway proxy check (if configured and running)
# ---------------------------------------------------------------------------
if [[ "$HEALTHZ_GW" == "ready" ]]; then
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
