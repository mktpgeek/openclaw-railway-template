#!/bin/bash
set -e

OPENCLAW_EXTENSIONS_DIR="/usr/local/lib/node_modules/openclaw/dist/extensions"
if [ -d "$OPENCLAW_EXTENSIONS_DIR" ]; then
  find "$OPENCLAW_EXTENSIONS_DIR" \
    -type d -name ".openclaw-runtime-deps-copy-*" \
    -prune -exec rm -rf {} +
fi

chown -R openclaw:openclaw /data
chmod 700 /data

for trusted_plugin_dir in \
  /data/.openclaw/npm/node_modules/@openclaw/acpx \
  /data/.openclaw/npm/node_modules/@openclaw/codex
do
  if [ -d "$trusted_plugin_dir" ]; then
    chown -R root:root "$trusted_plugin_dir"
  fi
done

mkdir -p /data/.config
chown -R openclaw:openclaw /data/.config

mkdir -p /data/.codex
chown -R openclaw:openclaw /data/.codex
find /data/.codex -type d -exec chmod 700 {} +
find /data/.codex -type f -exec chmod 600 {} +

CODEX_LOG_DB_MAX_BYTES="${OPENCLAW_CODEX_LOG_DB_MAX_BYTES:-536870912}"
if [ -f /data/.codex/logs_2.sqlite ]; then
  CODEX_LOG_DB_BYTES="$(wc -c < /data/.codex/logs_2.sqlite | tr -d ' ')"
  if [ "${CODEX_LOG_DB_BYTES:-0}" -gt "$CODEX_LOG_DB_MAX_BYTES" ]; then
    rm -f /data/.codex/logs_2.sqlite \
      /data/.codex/logs_2.sqlite-shm \
      /data/.codex/logs_2.sqlite-wal
  fi
fi
rm -rf /data/.codex/.tmp/* /data/.codex/tmp/*

if [ -L /data/.linuxbrew ] && [ "$(readlink /data/.linuxbrew)" = "/data/.linuxbrew" ]; then
  rm -f /data/.linuxbrew
fi

if [ ! -d /data/.linuxbrew ]; then
  rm -rf /data/.linuxbrew
  cp -aT /home/linuxbrew/.linuxbrew /data/.linuxbrew
fi

rm -rf /home/linuxbrew/.linuxbrew
ln -sfn /data/.linuxbrew /home/linuxbrew/.linuxbrew

mkdir -p /home/openclaw
ln -sfn /data/.config /home/openclaw/.config
ln -sfn /data/.codex /home/openclaw/.codex

export HOME=/home/openclaw
export USER=openclaw
export LOGNAME=openclaw
export XDG_CONFIG_HOME=/data/.config
export CODEX_HOME=/data/.codex
export CLOUDSDK_CONFIG=/data/.config/gcloud
export PATH="/data/.local/bin:/data/google-cloud-sdk/bin:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}"

source /app/scripts/start-tailscale.sh

exec gosu openclaw node src/server.js
