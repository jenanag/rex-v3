#!/usr/bin/env bash
# Runs the Phase 0 consistency checker and, with --negative, its eight negative suites.
# Usage: scripts/checks/run-all.sh [--negative]. Needs python3 with PyYAML; the
# negative suites also need GNU sed. See scripts/checks/README.md.
set -u
HERE=$(cd "$(dirname "$0")" && pwd); PY=${PYTHON:-python3}; rc=0
echo "== check.py"; "$PY" "$HERE/check.py" || rc=1
echo "== per-tool AGENTS.md cross-check"; "$PY" "$HERE/gen_agents.py" "$(cd "$HERE/../.." && pwd)" --check || rc=1
if [ "${1:-}" = "--negative" ]; then
  for s in agents review extractor external pipeline byref adrs lang; do
    echo "== neg_$s"; out=$(bash "$HERE/neg_$s.sh") || rc=1
    printf '%s\n' "$out" | grep -v '^CAUGHT' || true
  done
fi
exit $rc
