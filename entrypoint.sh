#!/bin/bash
set -e

OPENCLAW_EXTENSIONS_DIR="/usr/local/lib/node_modules/openclaw/dist/extensions"
if [ -d "$OPENCLAW_EXTENSIONS_DIR" ]; then
  find "$OPENCLAW_EXTENSIONS_DIR" \
    -type d \( -name ".openclaw-runtime-deps-copy-*" -o -name ".openclaw-install-stage" \) \
    -prune -exec rm -rf {} +
fi

chown -R openclaw:openclaw /data
chmod 700 /data

mkdir -p /data/.config
chown -R openclaw:openclaw /data/.config

if [ ! -d /data/.linuxbrew ]; then
  cp -a /home/linuxbrew/.linuxbrew /data/.linuxbrew
fi

rm -rf /home/linuxbrew/.linuxbrew
ln -sfn /data/.linuxbrew /home/linuxbrew/.linuxbrew

mkdir -p /home/openclaw
ln -sfn /data/.config /home/openclaw/.config

export HOME=/home/openclaw
export USER=openclaw
export LOGNAME=openclaw
export XDG_CONFIG_HOME=/data/.config
export CLOUDSDK_CONFIG=/data/.config/gcloud
export PATH="/data/google-cloud-sdk/bin:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}"

exec gosu openclaw node src/server.js
