#!/usr/bin/env bash
# Build and run the viewer ON the Docker host — no Docker Hub.
#   scripts/deploy.sh            # host from $DEPLOY_HOST (default: ssh alias "portainer")
# Copies viewer/ to ~/localcamera-viewer on the host, then `docker compose up -d --build` there.
# viewer/.env on the host (which volume holds the people-count history) is never overwritten or committed.
# Recordings need /mnt/camera-feed on the host (the NAS share, passed in by Proxmox).
set -euo pipefail
HOST="${DEPLOY_HOST:-portainer}"
DIR="${DEPLOY_DIR:-localcamera-viewer}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "→ copying viewer/ to $HOST:~/$DIR"
ssh "$HOST" "mkdir -p ~/$DIR"
tar -C "$ROOT/viewer" --exclude=node_modules --exclude=.env --exclude=data --exclude=recordings \
    --exclude='models/coco-ssd' --exclude='models/yolo' -czf - . | ssh "$HOST" "tar -C ~/$DIR -xzf -"

ssh "$HOST" "test -f ~/$DIR/.env" || {
  echo "✗ ~/$DIR/.env is missing on $HOST — copy .env.example to .env there, then re-run."
  exit 1
}

ssh "$HOST" "test -d /mnt/camera-feed && docker run --rm -v /mnt/camera-feed:/rec busybox sh -c 'touch /rec/.deploy-check && rm /rec/.deploy-check'" || {
  echo "✗ /mnt/camera-feed is missing or not writable on $HOST — the NAS mount from Proxmox isn't in place (see docs/RECORDING.md)."
  exit 1
}

echo "→ building and starting on $HOST"
ssh "$HOST" "cd ~/$DIR && docker compose up -d --build --remove-orphans && docker image prune -f >/dev/null"
ssh "$HOST" "docker ps --filter name=^camera\$ --format '{{.Names}}  {{.Image}}  {{.Status}}'"
echo "✓ deployed — http://192.168.0.246:8080"
