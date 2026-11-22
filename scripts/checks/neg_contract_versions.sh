#!/usr/bin/env bash
# Exercise the current contract checker against a temporary origin/main baseline.
set -euo pipefail
cd "$(dirname "$0")/../.."
exec ./node_modules/.bin/tsx --test --test-name-pattern='breaking request changes require an info.version major bump' scripts/test/contracts.test.ts
