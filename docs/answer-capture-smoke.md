# Answer-capture smoke check

This check exercises the three HTTP calls in the [answer-capture worker flow](services/workers.md#flows).
It replays the checked-in Parks Canada ChatGPT recording through the standalone
engine-query mock adapter, then passes its Markdown to answer-analysis and its
Markdown and sources to citation-extractor. It exercises the tool calls directly,
without a worker, bus, or cache.

## Build the standalone tools

From the repository root, select the Node version in `.nvmrc` (`nvm use` if
using nvm). Install dependencies before isolating the network.

```sh
for tool in engine-query answer-analysis citation-extractor; do
  (cd "services/$tool" && npm ci && npm run build) || exit 1
done
```

## Run over loopback

Use a shell with loopback available and external networking blocked. On Linux
with unprivileged user namespaces available, enter a new network namespace and
enable its loopback interface:

```sh
unshare --user --map-root-user --net bash
ip link set lo up
```

From the repository root in that shell, start the tools on distinct ports and
wait for each health endpoint to report ready. Each process uses an empty
environment apart from the settings shown. Starting with Node directly skips
local `.env` files.

```sh
set -e
start_tool() (
  cd "services/$1"
  exec env -i PATH="$PATH" LLM_MODE=mock PORT="$2" node dist/src/server.js
)
start_tool engine-query 18081 & query_pid=$!
start_tool answer-analysis 18082 & analysis_pid=$!
start_tool citation-extractor 18083 & citation_pid=$!
trap 'kill "$query_pid" "$analysis_pid" "$citation_pid" 2>/dev/null || true' EXIT

for port in 18081 18082 18083; do
  curl --noproxy '*' --fail --silent --show-error --retry 10 --retry-connrefused \
    --max-time 1 --retry-max-time 15 "http://127.0.0.1:$port/readyz" >/dev/null
done
env -i PATH="$PATH" node scripts/smoke-answer-capture.mjs
```

The script prints the status and result of each successful stage. It exits
nonzero with the stage name if an HTTP call or assertion fails.
