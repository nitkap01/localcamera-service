#!/usr/bin/env bash
# Build and run the viewer ON the Docker host — no Docker Hub.
#   scripts/deploy.sh            # host from $DEPLOY_HOST (default: ssh alias "portainer")
# Copies viewer/ to ~/localcamera-viewer on the host, then `docker compose up -d --build` there.
# viewer/.env on the host holds the NAS password and is never overwritten or committed.
set -euo pipefail
HOST="${DEPLOY_HOST:-portainer}"
DIR="${DEPLOY_DIR:-localcamera-viewer}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "→ copying viewer/ to $HOST:~/$DIR"
ssh "$HOST" "mkdir -p ~/$DIR"
tar -C "$ROOT/viewer" --exclude=node_modules --exclude=.env --exclude=data --exclude=recordings \
    --exclude='models/coco-ssd' --exclude='models/yolo' -czf - . | ssh "$HOST" "tar -C ~/$DIR -xzf -"

ssh "$HOST" "test -f ~/$DIR/.env" || {
  echo "✗ ~/$DIR/.env is missing on $HOST — copy .env.example to .env there and set NAS_PASSWORD, then re-run."
  exit 1
}

echo "→ building and starting on $HOST"
ssh "$HOST" "cd ~/$DIR && docker compose up -d --build --remove-orphans && docker image prune -f >/dev/null"
ssh "$HOST" "docker ps --filter name=localcamera-viewer --format '{{.Names}}  {{.Image}}  {{.Status}}'"
echo "✓ deployed — http://192.168.0.246:8080"
