#!/usr/bin/env bash
# pm2 entry point on the VM. The env file lives OUTSIDE the app dir (deploys
# rsync with --delete) and holds the session secret.
set -euo pipefail
set -a
. /etc/swapup.env
set +a
cd "$(dirname "$0")/.."
exec node node_modules/next/dist/bin/next start -p "${PORT:-4500}"
