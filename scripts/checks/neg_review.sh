#!/bin/bash
# Negative tests for check 20 (onboarding review fixes).
HERE=$(cd "$(dirname "$0")" && pwd); SRC=${REX_SRC:-$(cd "$HERE/../.." && pwd)}; PY=${PYTHON:-python3}
. "$HERE/neglib.sh"; pass=0; fail=0
run() { name="$1"; expect="$2"; mut="$3"
  T=$(mktemp -d); copy_repo "$SRC" "$T"; (cd $T && eval "$mut")
  out=$(REX=$T REX_SKIP_PHASE0_SCRIPT=${SKIP:-1} $PY "$HERE/check.py" 2>&1)
  if echo "$BASE" | grep -qF -- "$expect"; then echo "BASELINE $name (message already reported on the unmutated repo)"; base=$((base+1))
  elif echo "$out" | grep -qF -- "$expect"; then echo "CAUGHT  $name"; pass=$((pass+1)); else echo "MISSED  $name"; echo "$out" | head -8; fail=$((fail+1)); fi
  rm -rf $T; }
S=packages/contracts/openapi/services
run "AGENTS status differs from roadmap" "AGENTS.md status differs from roadmap" "sed -i 's/was accepted by Jay on/was approved by Jay on/' AGENTS.md"
run "status still awaiting" "roadmap Phase 0 status must say \"accepted by Jay on 2026-11-22\"" "sed -i 's/was accepted by Jay on 2026-11-22/is delivered and awaiting Jay/' docs/roadmap.md AGENTS.md"
run "README says awaiting" "still say Phase 0 awaits acceptance" "sed -i \"s/Phase 1 is open\$/Phase 1 is open (awaiting Jay's acceptance)/\" README.md"
run "ADR authority rule removed" "lacks the ADR authority rule" "sed -i 's/ADR is binding as the current design and is never/ADR is the current design and is never/' docs/adr/README.md"
run "unpinned npx today" "not pinned to an exact version: @redocly/cli" "sed -i 's#^npx -y @redocly/cli@2.82.0 lint#npx -y @redocly/cli lint#' AGENTS.md"
run "pin mismatch script vs AGENTS" "@redocly/cli pinned to different versions" "sed -i \"s#@redocly/cli@2.82.0'#@redocly/cli@2.81.0'#\" scripts/vendor-contracts-phase0.sh"
run "unpinned npx in docs" "README.md: unpinned" "echo 'Run npx @asyncapi/cli validate.' >> README.md"
run "no vendored-copy check today" "lacks a command that checks the vendored copies" "sed -i '/^scripts\/vendor-contracts-phase0.sh --check/d' AGENTS.md"
SKIP=0 run "hand-edited vendored copy" "services/engine-query/contract/openapi.yaml: drifted" "echo '# edit' >> services/engine-query/contract/openapi.yaml"
SKIP=0 run "source changed, not re-vendored" "services/citation-extractor/contract/openapi.yaml: drifted" "sed -i 's/Extract and classify the citations of one answer/Extract the citations of one answer/' $S/citation-extractor.yaml"
SKIP=0 run "copied data file edited" "services/content-auditor/contract/ai-crawlers.yaml: drifted" "echo '# x' >> services/content-auditor/contract/ai-crawlers.yaml"
run "unknown script named" "scripts/check-portability neither exists nor is planned" "echo 'See scripts/check-portability.' >> docs/architecture.md"
run "undefined repo name" "undefined name aeo-platform" "echo 'aeo-platform' >> docs/architecture.md"
run "x-rex-limits missing" "extractCitations: no x-rex-limits" "sed -i '/x-rex-limits/d' $S/citation-extractor.yaml"
run "public op uses LLM" "validateLlmsTxt: public operation limits break" "sed -i \"s/{p99: PT2S, llm: none, outboundFetch: none, notes: 'validates the file/{p99: PT2S, llm: optional, outboundFetch: none, notes: 'validates the file/\" $S/llms-txt-generator.yaml"
run "public op p99 too slow" "validateSchemaMarkup: public operation limits break" "sed -i \"s/{p99: PT2S, llm: none, outboundFetch: none, notes: 'parses the JSON-LD/{p99: PT9S, llm: none, outboundFetch: none, notes: 'parses the JSON-LD/\" $S/schema-generator.yaml"
run "description duration != limits" "queryEngine: description says up to 90 s" "sed -i 's/may take up to 120 s/may take up to 90 s/' $S/engine-query.yaml"
run "bad limits enum" "x-rex-limits.outboundFetch invalid" "sed -i 's/{llm: none, outboundFetch: none}/{llm: none, outboundFetch: lots}/' $S/citation-extractor.yaml"
run "tool declares a fetch" "citation-extractor: a tool operation declares outbound fetches" "sed -i 's/{llm: none, outboundFetch: none}/{llm: none, outboundFetch: one}/' $S/citation-extractor.yaml"
run "limits changed, tool AGENTS not regenerated" "services/engine-query/AGENTS.md: drifted" "sed -i 's/maxDuration: PT120S/maxDuration: PT90S/; s/may take up to 120 s/may take up to 90 s/' $S/engine-query.yaml"
run "shared schema use changed, AGENTS not regenerated" "services/citation-extractor/AGENTS.md: drifted" "sed -i \"s#\\$ref: '../common.yaml\#/components/schemas/Domain'#type: string#\" $S/citation-extractor.yaml && grep -q 'schemas/Domain' $S/citation-extractor.yaml && echo STILL"
run "tool doc names unapproved package" "citation-extractor.md names \`cheerio\`" "echo '- Uses \`cheerio\`.' >> docs/services/citation-extractor.md"
run "package.json with unapproved dep" "runtime dependency cheerio is not approved for citation-extractor" "echo '{\"dependencies\":{\"cheerio\":\"1.0.0\"}}' > services/citation-extractor/package.json && echo '{}' > services/citation-extractor/package-lock.json"
run "approved row with unknown scope" "unknown scope" "sed -i 's/| \`marked\` | Markdown lexer for inline links in answer text | citation-extractor |/| \`marked\` | Markdown lexer | some-tool |/' docs/conventions.md"
run "ADR 0018 restates the package table" "ADR 0018 restates the package table" "printf '\n  | Need | Public package (template default) |\n' >> docs/adr/0018-tool-portability.md"
run "retry rule removed from conventions" "conventions lacks \"Tools never retry\"" "sed -i 's/Tools never retry/Tools do not need retries/' docs/conventions.md"
run "retry rule removed from AGENTS" "hard rules lack \"never retry\"" "sed -i 's/and tools never retry/and tools are simple/' AGENTS.md"
run "template loses never-retry" "tool AGENTS template lacks Never retry" "sed -i 's/^- Never retry:/- Retry policy:/' docs/agents/tool-AGENTS.md.tmpl"
echo "caught $pass / $((pass+fail))"
[ "$fail" -eq 0 ]
