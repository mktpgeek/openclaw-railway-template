#!/bin/bash

start_openclaw_tailscale() {
  local enabled="${OPENCLAW_TAILSCALE_ENABLED:-auto}"
  local state_dir="${OPENCLAW_TAILSCALE_STATE_DIR:-/data/.tailscale}"
  local state_file="${state_dir}/tailscaled.state"
  local socket_path="${OPENCLAW_TEMPLATE_TAILSCALE_SOCKET:-${state_dir}/tailscaled.sock}"
  local log_path="${OPENCLAW_TAILSCALE_LOG:-${state_dir}/tailscaled.log}"
  local bridge_path="${OPENCLAW_IMESSAGE_BRIDGE_PATH:-/data/.openclaw/scripts/imsg-ssh}"
  local required="${OPENCLAW_TAILSCALE_REQUIRED:-false}"
  local run_as_current="${OPENCLAW_TAILSCALE_RUN_AS_CURRENT_USER:-false}"
  local run_current=false
  local should_start=false

  case "$run_as_current" in
    true|TRUE|True|1|yes|YES|Yes) run_current=true ;;
  esac

  case "$enabled" in
    true|TRUE|True|1|yes|YES|Yes) should_start=true ;;
    false|FALSE|False|0|no|NO|No) return 0 ;;
    auto|AUTO|Auto)
      if [ -f "$state_file" ] || [ -x "$bridge_path" ]; then
        should_start=true
      fi
      ;;
    *)
      echo "[tailscale] invalid OPENCLAW_TAILSCALE_ENABLED=$enabled; using auto detection" >&2
      if [ -f "$state_file" ] || [ -x "$bridge_path" ]; then
        should_start=true
      fi
      ;;
  esac

  if [ "$should_start" != "true" ]; then
    return 0
  fi

  export OPENCLAW_TAILSCALE_SOCKET="$socket_path"

  local binary="${OPENCLAW_TAILSCALED_BIN:-}"
  if [ -z "$binary" ]; then
    local candidate
    for candidate in /data/.local/bin/tailscaled /usr/local/bin/tailscaled /usr/bin/tailscaled; do
      if [ -x "$candidate" ]; then
        binary="$candidate"
        break
      fi
    done
  fi
  if [ -z "$binary" ] && command -v tailscaled >/dev/null 2>&1; then
    binary="$(command -v tailscaled)"
  fi

  if [ -z "$binary" ] || [ ! -x "$binary" ]; then
    echo "[tailscale] bridge configured but no executable tailscaled binary was found" >&2
    case "$required" in
      true|TRUE|True|1|yes|YES|Yes) return 1 ;;
    esac
    return 0
  fi

  if [ "$(id -u)" = "0" ] && [ "$run_current" != "true" ] && id openclaw >/dev/null 2>&1; then
    install -d -o openclaw -g openclaw "$state_dir"
  else
    mkdir -p "$state_dir"
  fi

  if [ -f "$log_path" ] && [ "$(wc -c < "$log_path" | tr -d ' ')" -gt 5242880 ]; then
    mv -f "$log_path" "${log_path}.1"
  fi
  touch "$log_path"
  if [ "$(id -u)" = "0" ] && [ "$run_current" != "true" ] && id openclaw >/dev/null 2>&1; then
    chown -R openclaw:openclaw "$state_dir"
  fi

  rm -f "$socket_path"

  local runner=()
  if [ "$(id -u)" = "0" ] && [ "$run_current" != "true" ] && command -v gosu >/dev/null 2>&1 && id openclaw >/dev/null 2>&1; then
    runner=(gosu openclaw)
  fi

  "${runner[@]}" "$binary" \
    --tun=userspace-networking \
    --state="$state_file" \
    --socket="$socket_path" \
    >>"$log_path" 2>&1 &
  OPENCLAW_TAILSCALED_PID=$!
  export OPENCLAW_TAILSCALED_PID

  local wait_steps="${OPENCLAW_TAILSCALE_WAIT_STEPS:-100}"
  if ! [[ "$wait_steps" =~ ^[0-9]+$ ]] || [ "$wait_steps" -lt 1 ]; then
    wait_steps=100
  fi

  local attempt=0
  while [ "$attempt" -lt "$wait_steps" ]; do
    if [ -S "$socket_path" ]; then
      echo "[tailscale] userspace daemon ready at $socket_path" >&2
      return 0
    fi
    if ! kill -0 "$OPENCLAW_TAILSCALED_PID" 2>/dev/null; then
      break
    fi
    attempt=$((attempt + 1))
    sleep 0.1
  done

  if kill -0 "$OPENCLAW_TAILSCALED_PID" 2>/dev/null; then
    kill "$OPENCLAW_TAILSCALED_PID" 2>/dev/null || true
  fi
  wait "$OPENCLAW_TAILSCALED_PID" 2>/dev/null || true
  echo "[tailscale] daemon did not create $socket_path; see $log_path" >&2
  case "$required" in
    true|TRUE|True|1|yes|YES|Yes) return 1 ;;
  esac
  return 0
}

start_openclaw_tailscale
