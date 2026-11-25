#!/usr/bin/env bash
set -euo pipefail
umask 077

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
local_dir=$here/.local/gemini
if ! command -v node >/dev/null || ! node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 24 || (major === 24 && minor < 10)) process.exit(1);
'; then
  echo 'Gemini MCP requires Node.js 24.10 or later on PATH.' >&2
  exit 1
fi

cd -- "$here"
node "$here/export.mjs"
port=$(node --input-type=module -e '
  import { readFileSync } from "node:fs";
  import { GEMINI_MAC_ORIGIN, validateConfig } from "./http-app.mjs";
  const config = validateConfig(JSON.parse(readFileSync(".local/gemini/config.json", "utf8")));
  if (config.origin !== GEMINI_MAC_ORIGIN || config.remotePort !== 48734 || config.sshUser !== "bowerbird-mcp-mac" || config.port === 0) {
    throw new Error("Set up the dedicated Mac Gemini config first. See the MCP README.");
  }
  console.log(config.port);
')

lock=$local_dir/start.lock
if ! mkdir -- "$lock" 2>/dev/null; then
  echo 'Gemini startup is in progress. Retry shortly.' >&2
  exit 1
fi
trap 'rmdir -- "$lock"' EXIT

pid=$(cat "$local_dir/run.pid" 2>/dev/null || true)
if [[ $pid =~ ^[1-9][0-9]*$ ]] && [[ $(ps -p "$pid" -o command=) == *run-gemini.mjs ]]; then
  message='Gemini is already running. The updated snapshot will load on the next tool call.'
else
  nohup node "$here/run-gemini.mjs" </dev/null >"$local_dir/run.out.log" 2>"$local_dir/run.err.log" &
  pid=$!
  message='Gemini is ready on loopback. SSH connects in the background.'
fi

for ((attempt=0; attempt<60; attempt++)); do
  if ! kill -0 "$pid" 2>/dev/null; then
    echo 'Gemini exited during startup. Check .local/gemini/run.err.log.' >&2
    exit 1
  fi
  if ps -axo ppid=,command= | awk -v pid="$pid" -v script="$here/http-server.mjs" '
      $1 == pid && substr($0, length($0) - length(script) + 1) == script { found = 1 }
      END { exit !found }' &&
    [[ $(curl --noproxy '*' -s --max-time 1 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/healthz") == 204 ]]; then
    printf '%s\n' "$message"
    exit 0
  fi
  sleep 0.25
done
echo 'Gemini did not become ready. Check .local/gemini/run.err.log.' >&2
exit 1
