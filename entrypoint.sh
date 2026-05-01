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

mkdir -p /data/.config
chown -R openclaw:openclaw /data/.config

mkdir -p /data/.codex
chown -R openclaw:openclaw /data/.codex
find /data/.codex -type d -exec chmod 700 {} +
find /data/.codex -type f -exec chmod 600 {} +

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
export PATH="/data/google-cloud-sdk/bin:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}"

exec gosu openclaw node src/server.js
