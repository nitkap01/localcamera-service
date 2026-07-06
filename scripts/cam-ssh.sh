#!/bin/sh
# SSH into the camera. This old dropbear needs legacy crypto; root has a blank password.
# Usage:
#   scripts/cam-ssh.sh 'command to run'     # run a command
#   scripts/cam-ssh.sh                      # interactive shell
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$ROOT/config.env" ] && . "$ROOT/config.env"
IP="${CAMERA_IP:-192.168.0.143}"

exec ssh \
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o KexAlgorithms=+diffie-hellman-group1-sha1,diffie-hellman-group14-sha1 \
  -o HostKeyAlgorithms=+ssh-rsa,ssh-dss -o PubkeyAcceptedAlgorithms=+ssh-rsa \
  -o Ciphers=+aes128-cbc,3des-cbc -o PreferredAuthentications=password \
  -o ConnectTimeout=10 "root@$IP" "$@"
