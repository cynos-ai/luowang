#!/usr/bin/env bash
# Shared filesystem contract for zero-model preflight and isolated live acceptance.
# Caller supplies image/command/network/mounts. Never mount daily service data here.
set -euo pipefail
exec docker run --rm --init --read-only --user node \
  --cap-drop ALL --security-opt no-new-privileges --shm-size 256m \
  --tmpfs /tmp:rw,exec,size=512m,mode=1777 \
  --tmpfs /run/luowang-pi:rw,noexec,size=64m,mode=1777 \
  --tmpfs /home/node/.npm:rw,size=1024m,mode=1777 \
  --tmpfs /home/node/.config:rw,noexec,size=64m,mode=1777 \
  --tmpfs /home/node/.cache:rw,noexec,size=64m,mode=1777 \
  --tmpfs /home/node/.pki:rw,noexec,size=64m,mode=1777 \
  -e PI_CODING_AGENT_DIR=/run/luowang-pi/agent -e PI_OFFLINE=1 \
  "$@"
