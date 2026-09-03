#!/usr/bin/env bash
set -euo pipefail

app_dir="${JAPANESE_WORDS_APP_DIR:-/opt/japanese-words/app}"
node_bin="${JAPANESE_WORDS_NODE_BIN:-/opt/japanese-words/runtime/node-current/bin/node}"
lock_file="${JAPANESE_WORDS_WEEKLY_CHECK_LOCK:-/run/japanese-words-weekly-check/weekly-content-check.lock}"

if [[ ! -x "${node_bin}" ]]; then
  node_bin="/usr/bin/node"
fi

if [[ ! -x "${node_bin}" ]]; then
  echo "Node runtime is unavailable." >&2
  exit 1
fi

cd "${app_dir}"
exec /usr/bin/flock --nonblock --exclusive "${lock_file}" "${node_bin}" server/weekly-content-check.mjs
