#!/bin/bash
# Negative tests for check 19 (agent onboarding). Each case: fresh copy, one violation, expect a matching error.
HERE=$(cd "$(dirname "$0")" && pwd); SRC=${REX_SRC:-$(cd "$HERE/../.." && pwd)}; PY=${PYTHON:-python3}
. "$HERE/neglib.sh"; pass=0; fail=0
run() { name="$1"; expect="$2"; mut="$3"
  T=$(mktemp -d); copy_repo "$SRC" "$T"; (cd $T && eval "$mut")
  out=$(REX=$T REX_SKIP_PHASE0_SCRIPT=${SKIP:-1} $PY "$HERE/check.py" 2>&1)
  if echo "$BASE" | grep -qF -- "$expect"; then echo "BASELINE $name (message already reported on the unmutated repo)"; base=$((base+1))
  elif echo "$out" | grep -qF -- "$expect"; then echo "CAUGHT  $name"; pass=$((pass+1)); else echo "MISSED  $name"; echo "$out" | head -8; fail=$((fail+1)); fi
  rm -rf $T; }
run "tool AGENTS.md missing" "services/schema-generator/AGENTS.md missing" "rm services/schema-generator/AGENTS.md"
run "tool AGENTS.md hand-edited" "services/engine-query/AGENTS.md: drifted" "echo extra >> services/engine-query/AGENTS.md"
run "tool AGENTS.md links out of folder" "escapes the service folder" "sed -i 's#^Operations:#See [doc](../../docs/services/content-auditor.md). Operations:#' services/content-auditor/AGENTS.md"
run "root link broken" "AGENTS.md: broken link docs/nope.md" "sed -i 's#\[glossary.md\](docs/glossary.md)#[glossary.md](docs/nope.md)#' AGENTS.md"
run "root anchor broken" "AGENTS.md: broken anchor" "sed -i 's#roadmap.md\#deferred-decisions#roadmap.md\#open-questions#' AGENTS.md"
run "copilot pointer link broken" ".github/copilot-instructions.md: broken link" "sed -i 's#(../AGENTS.md)#(AGENTS.md)#' .github/copilot-instructions.md"
run "planned script claimed working today" "command that does not exist: scripts/check-contracts" "sed -i 's#^npx -y @asyncapi/cli@6.3.1 validate#scripts/check-contracts\nnpx -y @asyncapi/cli@6.3.1 validate#' AGENTS.md"
run "planned script already exists" "exists now (move it to \"Works today\"): scripts/vendor-contracts" "mkdir -p scripts && touch scripts/vendor-contracts"
run "planned command not in roadmap" "planned command scripts/deploy-all is not a roadmap Phase 1" "sed -i 's#^scripts/check-contracts #scripts/deploy-all\nscripts/check-contracts #' AGENTS.md"
run "unknown npx tool today" "unknown npx package" "sed -i 's#^npx -y @redocly/cli@2.82.0 lint #npx -y turbo@2.0.0 lint #' AGENTS.md"
run "unbuilt script mentioned without phase" "does not exist yet and the line does not say which phase" "echo 'Run scripts/gen-docs after editing.' >> AGENTS.md"
run "hard rule removed" "hard rules lack \"cache first\"" "sed -i 's#\*\*Cache first, outside tools\*\*#**Caching**#' AGENTS.md"
run "superseded list wrong" "superseded ADR list" "sed -i 's#(0003, 0004, 0005, 0008)#(0003, 0004, 0005)#' AGENTS.md"
run "current phase wrong" "AGENTS.md current phase 1" "sed -i 's#Current phase: 0#Current phase: 1#' AGENTS.md"
run "section missing" "lacks section \"## When unsure\"" "sed -i 's/^## When unsure/## Misc/' AGENTS.md"
run "root over 200 lines" "lines (limit 200" "for i in \$(seq 60); do printf 'x\n\n' >> AGENTS.md; done"
run "root AGENTS.md deleted" "AGENTS.md missing at the repo root" "rm AGENTS.md"
run "CLAUDE.md copies a line" "CLAUDE.md: repeats AGENTS.md line" "grep -m1 'Tools are stateless and self-contained' AGENTS.md >> CLAUDE.md"
run "CLAUDE.md paraphrased copy" "CLAUDE.md: repeats AGENTS.md text" "echo 'Remember: page audit, tools install, build, test and run in Docker when copied anywhere on its own.' >> CLAUDE.md"
run "CLAUDE.md states rules" "CLAUDE.md: states rule content ('@rex/')" "echo 'Never add @rex/ deps.' >> CLAUDE.md"
run "CLAUDE.md too long" "CLAUDE.md: 13 lines" "for i in 1 2 3 4 5 6 7 8; do echo \"note \$i\" >> CLAUDE.md; done"
run "cursor rule not pointing" ".cursor/rules/rex.mdc: does not point to AGENTS.md" "sed -i 's/AGENTS.md/the docs/g' .cursor/rules/rex.mdc"
run "cursor rule not always applied" ".cursor/rules/rex.mdc: not alwaysApply" "sed -i 's/alwaysApply: true/alwaysApply: false/' .cursor/rules/rex.mdc"
run "CLAUDE.md missing" "CLAUDE.md missing" "rm CLAUDE.md"
run "tool template unbuilt script w/o phase" "does not exist yet and the line does not say which phase" "sed -i 's#or \`scripts/vendor-contracts\` (from Phase 1), and#or \`scripts/vendor-contracts\`, and#' docs/agents/tool-AGENTS.md.tmpl && $PY \"$HERE/gen_agents.py\" . >/dev/null"
run "scaffolded status not regenerated" "services/schema-generator/AGENTS.md: drifted" "echo '{}' > services/schema-generator/package.json && touch services/schema-generator/package-lock.json"
echo "caught $pass / $((pass+fail))"
[ "$fail" -eq 0 ]
