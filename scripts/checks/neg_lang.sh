#!/bin/bash
# Negative tests: per-tool implementation language (ADR 0024).
HERE=$(cd "$(dirname "$0")" && pwd); SRC=${REX_SRC:-$(cd "$HERE/../.." && pwd)}; PY=${PYTHON:-python3}
. "$HERE/neglib.sh"; pass=0; fail=0
run() { name="$1"; expect="$2"; mut="$3"
  T=$(mktemp -d); copy_repo "$SRC" "$T"; (cd $T && eval "$mut")
  out=$(REX=$T REX_SKIP_PHASE0_SCRIPT=${SKIP:-1} $PY "$HERE/check.py" 2>&1)
  if echo "$BASE" | grep -qF -- "$expect"; then echo "BASELINE $name (message already reported on the unmutated repo)"; base=$((base+1))
  elif echo "$out" | grep -qF -- "$expect"; then echo "CAUGHT  $name"; pass=$((pass+1)); else echo "MISSED  $name"; echo "$out" | head -8; fail=$((fail+1)); fi
  rm -rf $T; }
V=packages/contracts/vendoring.yaml; A=docs/adr/0024-per-tool-language.md; C=docs/conventions.md
# vendoring.yaml language field
run "unknown language" "language 'rust' must be one of" "sed -i '/^  answer-analysis:/{n;s/language: ts/language: rust/}' $V"
run "tool without language" "language None must be one of" "sed -i '/^  engine-query:/{n;/language: ts/d}' $V"
run "platform service with language" "only tools have a language" "sed -i 's/^  gateway:\$/  gateway:\n    language: ts/' $V"
run "language key removed" "vendoring.yaml languages ['python', 'ts'] must be exactly" "sed -i '/^  go:\$/,/^    types:/d' $V"
run "extra language key" "must be exactly ['go', 'python', 'ts']" "sed -i 's/^languages:\$/languages:\n  rust: {name: Rust, template: services\/_template-rust, types: {how: oapi-codegen, target: contract\/x.rs}}/' $V"
run "template does not match language" "languages.python: template must be services/_template-python" "sed -i 's#template: services/_template-python#template: services/_template-py#' $V"
run "generator not declared" "types generator datamodel-code-generator is not in generators" "sed -i '/^  datamodel-code-generator:/d' $V"
run "types target outside contract" "languages.go: types target must be under contract/" "sed -i 's#target: contract/types.gen.go#target: internal/types.gen.go#' $V"
run "types entry with target" "needs exactly one types entry" "sed -i '0,/      - {how: types, from: .\/contract\/openapi.yaml, fromPhase: 1}/s##      - {target: contract/types.ts, how: types, from: ./contract/openapi.yaml, fromPhase: 1}#' $V"
run "old openapi-typescript entry" "unknown how openapi-typescript" "sed -i '0,/      - {how: types, from: .\/contract\/openapi.yaml, fromPhase: 1}/s##      - {target: contract/types.ts, from: ./contract/openapi.yaml, how: openapi-typescript, fromPhase: 1}#' $V"
run "version not bumped" "vendoring.yaml version must be 2" "sed -i 's/^version: 2/version: 1/' $V"
# ADR 0024 and the amended ADRs
run "ADR 0024 reverted to Proposed" "ADR 0024 must be Accepted (2026-11-22, accepted by Jay)" "sed -i 's/^- \*\*Status:\*\* Accepted (2026-11-22, accepted by Jay)/- **Status:** Proposed/' $A"
run "ADR 0024 hides Jay" "must mark what Jay decided" "sed -i 's/\*\*Decided by Jay:\*\*/**Decided:**/' $A"
run "ADR 0024 drops a neutral rule" "lacks the language-neutral rule \"RFC 9457\"" "sed -i 's/RFC 9457/the problem standard/g' $A"
run "ADR 0024 missing Go column" "equivalents table lacks a column for go" "sed -i 's/| Go (\`go\`) |\$/| Golang |/' $A"
run "language table misses a tool" "ADR 0024 language table ['report-renderer'] out of sync" "sed -i '/^| \`report-renderer\` |/d' $A"
run "language table unknown language" "proposes Rust, not a language" "sed -i 's/^| \`ai-traffic-analyzer\` | 7 | Go (Proposed)/| \`ai-traffic-analyzer\` | 7 | Rust (Proposed)/' $A"
run "language not marked Proposed" "every proposed language must be marked (Proposed)" "sed -i 's/^| \`answer-analysis\` | 2 | Python (Proposed)/| \`answer-analysis\` | 2 | Python/' $A"
run "ADR 0024 restates package table" "ADR 0024 restates the package table" "printf '\n| Package | Purpose | Tools |\n' >> $A"
run "ADR 0018 amended-by line missing" "ADR 0018 lacks its dated \"Amended by: [0024]\"" "sed -i '/^- \*\*Amended by:\*\* \[0024\]/d' docs/adr/0018-tool-portability.md"
run "ADR 0002 amended-by undated" "ADR 0002 lacks its dated" "sed -i 's/^- \*\*Amended by:\*\* \[0024\](0024-per-tool-language.md), 2026-11-22/- **Amended by:** [0024](0024-per-tool-language.md)/' docs/adr/0002-typescript-fastify.md"
run "amended ADR status changed" "ADR 0019: status changed" "sed -i 's/^- \*\*Status:\*\* Accepted.*/- **Status:** Proposed/' docs/adr/0019-internal-packages.md"
run "ADR 0024 not in index" "ADR index rows [24] out of sync" "sed -i '/^| \[0024\]/d' docs/adr/README.md"
run "ADR 0024 index says Proposed" "ADR index: 0024 status differs" "sed -i 's/^\(| \[0024\].*| \)Accepted |\$/\1Proposed |/' docs/adr/README.md"
run "status does not name ADR 0024" "AGENTS.md: the status must name ADR 0024" "sed -i 's/^to 0023 (0020 reserved; 0003, 0004, 0005 and 0008 superseded) are Accepted. ADR 0024\$/to 0023 (0020 reserved; 0003, 0004, 0005 and 0008 superseded) are Accepted. The ADR/' AGENTS.md"
run "README misses 0024 in decisions" "README Decisions list" "sed -i 's/ · 0024 per-tool language//' README.md"
run "new ADR 0025 unreferenced" "the status must name ADR 0025" "sed 's/^# 0024: .*/# 0025: Next/' $A > docs/adr/0025-next.md && sed -i 's/^\(| \[0024\].*\)\$/\1\n| [0025](0025-next.md) | Next | Proposed |/' docs/adr/README.md"
# conventions, template, architecture, roadmap, AGENTS
run "conventions loses Go table" "conventions §16 approved tables ['python', 'ts'] != languages" "sed -i 's/^#### Go (\`go\`)\$/#### Golang/' $C"
run "Python table not approved" "python table must say it is approved by Jay" "sed -i '0,/Approved by Jay with \[ADR 0024\]/s//Proposed with [ADR 0024]/' $C"
run "Python validator dropped" "python table lacks the spec validator openapi-core" "sed -i '/^| \`openapi-core\` |/d' $C"
run "Python scope unknown" "approved dependency structlog (python): unknown scope everything" "sed -i 's/^| \`structlog\` | JSON logs | all |/| \`structlog\` | JSON logs | everything |/' $C"
run "§16 rule loses go.sum" "conventions §16 rules lack \"go.sum\"" "sed -i 's/\`uv.lock\`, \`go.sum\`)/\`uv.lock\`)/' $C"
run "template loses a go block" "tool-AGENTS template language blocks uneven" "python3 -c \"import re;p='docs/agents/tool-AGENTS.md.tmpl';s=open(p).read();i=s.rindex('{{#lang go}}');j=s.index('{{/lang}}',i);open(p,'w').write(s[:i]+s[j+len('{{/lang}}')+1:])\""
run "tool AGENTS hand-edited language" "drifted from docs/agents/tool-AGENTS.md.tmpl" "sed -i 's/ADR 0024 proposes Python/ADR 0024 proposes Rust/' services/answer-analysis/AGENTS.md"
run "architecture loses Go layout" "architecture lacks the go tool layout" "sed -i 's/^Go (\`go\`; template/Golang (template/' docs/architecture.md"
run "architecture loses deferred template" "architecture repo layout lacks services/_template-go" "sed -i '/_template-go\/ /d; s/_template-go/_tmpl-go/g' docs/architecture.md"
run "roadmap Phase 1 loses --lang" "roadmap Phase 1 lacks \"--lang ts|python|go\"" "sed -i 's/\[--lang ts|python|go\]/[--language]/' docs/roadmap.md"
run "roadmap loses Go spike" "roadmap 1.3 lacks the time-boxed Go spike" "sed -i 's/\*\*Go (time-boxed/**Go spike (time-boxed/' docs/roadmap.md"
run "Go bring-up back in Phase 2" "roadmap Phase 2 schedules the Go bring-up" "sed -i 's/The Go bring-up waits for Phase 7./The Go bring-up starts when step 5 starts./' docs/roadmap.md"
run "roadmap does not link 0024" "roadmap does not link ADR 0024" "sed -i 's#(adr/0024-per-tool-language.md)#(adr/README.md)#g' docs/roadmap.md"
run "AGENTS new-tool without --lang" "scripts/new-tool must take --lang" "sed -i 's/ \[--lang ts|python|go\]//' AGENTS.md"
run "AGENTS --fetch returns" "still lists a --fetch switch" "sed -i 's/\[--llm\]   # Phase 1/[--llm] [--fetch]   # Phase 1/' AGENTS.md"
# tool folders
run "python manifest in a ts tool" "a python manifest, but vendoring.yaml says language ts" "printf '[project]\nname=\"x\"\n' > services/answer-analysis/pyproject.toml; touch services/answer-analysis/uv.lock"
run "python path source" "path, git or editable source" "sed -i '/^  answer-analysis:/{n;s/language: ts/language: python/}' $V; printf '[project]\ndependencies = [\n  \"fastapi==0.115.0\",\n]\n[tool.uv.sources]\nfoo = { path = \"../foo\" }\n' > services/answer-analysis/pyproject.toml; touch services/answer-analysis/uv.lock"
run "python range pin" "fastapi is not pinned with ==" "sed -i '/^  answer-analysis:/{n;s/language: ts/language: python/}' $V; printf '[project]\ndependencies = [\n  \"fastapi>=0.115\",\n]\n' > services/answer-analysis/pyproject.toml; touch services/answer-analysis/uv.lock"
run "python without uv.lock" "no uv.lock next to it" "sed -i '/^  answer-analysis:/{n;s/language: ts/language: python/}' $V; printf '[project]\nname=\"x\"\n' > services/answer-analysis/pyproject.toml"
run "go replace directive" "replace directive (public modules only)" "sed -i '/^  engine-query:/{n;s/language: ts/language: go/}' $V; printf 'module x\n\ngo 1.25\n\nreplace example.com/a => ../a\n' > services/engine-query/go.mod; touch services/engine-query/go.sum"
run "go without go.sum" "no go.sum next to it" "sed -i '/^  engine-query:/{n;s/language: ts/language: go/}' $V; printf 'module x\n\ngo 1.25\n' > services/engine-query/go.mod"
# Jay's decisions at acceptance (t38u)
run "engine-query back to Go" "engine-query in Go; Jay decided Go starts with ai-traffic-analyzer" "sed -i 's/^| \`engine-query\` | 2 | TypeScript (Decided by Jay)/| \`engine-query\` | 2 | Go (Proposed)/' $A"
run "engine-query decision unmarked" "engine-query must be TypeScript (Decided by Jay)" "sed -i 's/^| \`engine-query\` | 2 | TypeScript (Decided by Jay)/| \`engine-query\` | 2 | TypeScript (Proposed)/' $A"
run "Go before Phase 7" "query-discovery in Go" "sed -i 's/^\(| \`query-discovery\` | [0-9] | \)Python (Proposed)/\1Go (Proposed)/' $A"
run "0024 edit before acceptance not recorded" "must record the edit made before acceptance" "sed -i '/^- \*\*Edited before acceptance:\*\*/d' $A"
run "0024 loses Python budget" "lacks Jay's decision \"5 ms for Python\"" "sed -i 's/5 ms for Python/10 ms for Python/g' $A"
run "0024 Spike marker returns" "still has markers that only waited on Jay's choice" "printf '\n**Spike** pending\n' >> $A"
run "0024 design not marked accepted" "design section must be marked accepted by Jay" "sed -i 's/\*\*Design (accepted by Jay, 2026-11-22):\*\*/**Design:**/' $A"
run "Amended-by still Proposed" "ADR 0019 lacks its dated" "sed -i 's/^\(- \*\*Amended by:\*\* \[0024\](0024-per-tool-language.md), 2026-11-22\) (accepted by Jay):/\1 (Proposed, at Jay'\''s request):/' docs/adr/0019-internal-packages.md"
run "Go table still Proposed" "go table must say it is approved by Jay" "sed -i 's/Approved by Jay with \[ADR 0024\]\(.*Phase 7\)/Proposed with [ADR 0024]\1/' $C; python3 -c \"p='$C';s=open(p).read();i=s.index('#### Go');open(p,'w').write(s[:i]+s[i:].replace('Approved by Jay with [ADR 0024]','Proposed with [ADR 0024]',1))\""
run "Phase 2 step without language ADR" "step content-auditor must open with its language ADR" "sed -i 's/^3\. \`content-auditor\`: language ADR (TypeScript), then /3. \`content-auditor\`: /' docs/roadmap.md"
run "roadmap engine-query step in Go" "roadmap Phase 2: engine-query is TypeScript (Jay)" "sed -i \"s/language ADR (TypeScript, Jay's decision)/language ADR (Go)/\" docs/roadmap.md"
run "Phase 7 loses Go bring-up" "roadmap Phase 7 lacks the Go bring-up" "sed -i 's/^- \*\*Go bring-up\*\* before/- Go work before/' docs/roadmap.md"
run "roadmap budgets changed" "roadmap 1.3 must state Jay's validation budgets" "sed -i 's/(1 ms for TypeScript and Go, 5 ms for/(2 ms for TypeScript and Go, 5 ms for/' docs/roadmap.md"
run "spikes no longer gates" "roadmap 1.3 must keep the spikes as gates" "sed -i 's/Each spike is a gate/Each spike is advisory/' docs/roadmap.md"
run "roadmap status says 0024 Proposed" "status must say ADR 0024 was accepted by Jay on 2026-11-22" "sed -i 's/(per-tool implementation language, accepted by Jay on 2026-11-22)/(per-tool implementation language, Proposed)/' docs/roadmap.md AGENTS.md"
run "README status says 0024 Proposed" "README status must say ADR 0024 was accepted" "python3 -c \"p='README.md';s=open(p).read();open(p,'w').write(s.replace('ADR 0024 (accepted by Jay on\\n2026-11-22)','ADR 0024 (Proposed)'))\""
run "AGENTS loses per-tool language ADR rule" "AGENTS.md must require a language ADR per tool" "sed -i 's/gets a language ADR at the start of its step, accepted by Jay before/gets a language ADR before/' AGENTS.md"
echo "caught $pass / $((pass+fail))"
[ "$fail" -eq 0 ]
