#!/bin/bash
# Negative tests for page results by reference (ADR 0023 amendment): audits carry no bodies; read order; one shared pattern.
HERE=$(cd "$(dirname "$0")" && pwd); SRC=${REX_SRC:-$(cd "$HERE/../.." && pwd)}; PY=${PYTHON:-python3}
. "$HERE/neglib.sh"; pass=0; fail=0
run() { name="$1"; expect="$2"; mut="$3"
  T=$(mktemp -d); copy_repo "$SRC" "$T"; (cd $T && eval "$mut")
  out=$(REX=$T REX_SKIP_PHASE0_SCRIPT=${SKIP:-1} $PY "$HERE/check.py" 2>&1)
  if echo "$BASE" | grep -qF -- "$expect"; then echo "BASELINE $name (message already reported on the unmutated repo)"; base=$((base+1))
  elif echo "$out" | grep -qF -- "$expect"; then echo "CAUGHT  $name"; pass=$((pass+1)); else echo "MISSED  $name"; echo "$out" | head -8; fail=$((fail+1)); fi
  rm -rf $T; }
E=packages/contracts/asyncapi/events.yaml; P=packages/contracts/cache/policy.yaml; A=docs/architecture.md; D=docs/services
J="import yaml;p='$E';d=yaml.safe_load(open(p))"; W="open(p,'w').write(yaml.safe_dump(d,sort_keys=False))"
DATA="d['components']['messages']"
# audit messages carry no bodies
run "extraction result carries Extraction" "events.yaml carries the Extraction itself" "$PY -c \"$J;x=$DATA['contentExtractionCompleted']['payload']['allOf'][1]['properties']['data'];x['properties']['extraction']={'\\\$ref':'../openapi/services/content-extractor.yaml#/components/schemas/Extraction'};$W\""
run "extraction result body via content" "content-extraction.completed: page-flow message carries a page body" "$PY -c \"$J;x=$DATA['contentExtractionCompleted']['payload']['allOf'][1]['properties']['data'];x['properties']['content']={'\\\$ref':'../openapi/common.yaml#/components/schemas/ExtractedContent'};$W\""
run "extraction result drops page ref" "content-extraction.completed: data.page must be a required PageRef" "$PY -c \"$J;x=$DATA['contentExtractionCompleted']['payload']['allOf'][1]['properties']['data'];x['required']=['cache'];$W\""
run "audit job by value again" "content-audit.requested: page-flow message carries a page body" "$PY -c \"$J;x=$DATA['contentAuditRequested']['payload']['allOf'][1]['properties']['data'];x['properties']['request']={'\\\$ref':'../openapi/services/content-auditor.yaml#/components/schemas/AuditRequest'};$W\""
run "audit job loses AuditJob" "content-audit.requested must carry an AuditJob" "$PY -c \"$J;x=$DATA['contentAuditRequested']['payload']['allOf'][1]['properties']['data'];x['properties']['request']={'type':'object'};$W\""
run "audit job carries llms.txt file" "content-audit.requested: page-flow message carries a site file" "$PY -c \"$J;x=$DATA['contentAuditRequested']['payload']['allOf'][1]['properties']['data'];x['properties']['llmsTxtFile']={'\\\$ref':'../openapi/common.yaml#/components/schemas/FetchedFile'};$W\""
run "AuditJob page not a PageRef" "AuditJob must carry page (PageRef)" "$PY -c \"$J;d['components']['schemas']['AuditJob']['properties']['page']={'\\\$ref':'../openapi/common.yaml#/components/schemas/Url'};$W\""
run "AuditJob carries content" "content-audit.requested: page-flow message carries a page body" "$PY -c \"$J;d['components']['schemas']['AuditJob']['properties']['content']={'\\\$ref':'../openapi/common.yaml#/components/schemas/ExtractedContent'};$W\""
run "PageRef carries markdown" "page-flow message carries a page body" "$PY -c \"$J;d['components']['schemas']['PageRef']['properties']['page']={'\\\$ref':'../openapi/common.yaml#/components/schemas/FetchedPage'};$W\""
run "extraction request allows html" "PageExtractionRequest must require url" "$PY -c \"$J;d['components']['schemas']['PageExtractionRequest']['allOf'][1]['required']=[];$W\""
run "audit extraction bypasses shared request" "content-extraction.requested: the extraction request must be a PageExtractionRequest" "$PY -c \"$J;x=$DATA['contentExtractionRequested']['payload']['allOf'][1]['properties']['data'];x['properties']['request']={'\\\$ref':'../openapi/services/content-extractor.yaml#/components/schemas/ExtractionRequest'};$W\""
# one shared page reference
run "PageResultRef copies fields" "PageResultRef must be a PageRef that requires entryKey" "$PY -c \"$J;d['components']['schemas']['PageResultRef']={'type':'object','required':['url','entryKey','extractionKey'],'properties':{'url':{'type':'string'},'entryKey':{'type':'string'},'extractionKey':{'type':'string'}}};$W\""
run "PageRef drops extractionKey" "PageRef must carry url and extractionKey" "$PY -c \"$J;d['components']['schemas']['PageRef']['required']=['url'];$W\""
run "page-audit.completed bare url" "page-audit.completed: data.page must be a required PageResultRef" "$PY -c \"$J;x=$DATA['pageAuditCompleted']['payload']['allOf'][1]['properties']['data'];x['properties']['page']={'\\\$ref':'../openapi/common.yaml#/components/schemas/Url'};$W\""
# read order and the one rule
run "rule reads aggregator first" "the Read step must say cache first, then the data-aggregator" "sed -i 's/by key from the \*\*cache first, then\$/by key from the **data-aggregator first, then/; s/^   the data-aggregator\*\* (decided by Jay)/   the cache first** (decided by Jay)/' $A"
run "rule drops aggregator" "the Read step must say cache first, then the data-aggregator" "perl -0pi -e 's/\*\*cache first, then\n   the data-aggregator\*\*/**cache first**/' $A"
run "audit diagram reads aggregator first" "audit diagram: read the extraction from the cache first" "perl -0pi -e 's/  W->>C: GET extraction by key\n  alt miss\n    W->>A: read by key\n/  W->>A: read by key\n  alt miss\n    W->>C: GET extraction by key\n/' $A"
run "audit diagram carries the page" "content-extraction.completed and content-audit.requested carry the PageRef" "sed -i 's/W->>MQ: content-extraction.completed (PageRef, cache outcome) or .failed/W->>MQ: content-extraction.completed (extraction) or .failed/' $A"
run "audit diagram semicolon" "needs the audit sequenceDiagram, no semicolons" "sed -i 's/  O->>MQ: content-audit.requested (PageRef, options)/  O->>MQ: content-audit.requested (PageRef; options)/' $A"
run "rule section removed" "the Read step must say cache first" "sed -i 's/^### Page results by reference/### Page references/' $A"
run "rule loses bypass note" "lacks bypass" "sed -i 's/\`bypass\` mode (it acts as \`refresh\` there)/any mode/' $A"
run "audit row reads inline" "content-audit must read page results by reference" "sed -i 's/^| \`content-audit\` | read the extraction \[by reference\](..\/architecture.md#page-results-by-reference)/| \`content-audit\` | read the extraction from the cache/' $D/workers.md"
run "audit row reads after the audit" "content-audit reads the extraction by reference before validateLlmsTxt and auditPage" "sed -i 's/^| \`content-audit\` | read the extraction \(\[by reference\]([^)]*)\) (\`page.extractionKey\`); \(.*\) | \`{result, cache}\` |/| \`content-audit\` | \2; then read the extraction \1 | \`{result, cache}\` |/' $D/workers.md"
run "generation row reads inline" "llms-txt-generation must read page results by reference" "sed -i 's/^| \`llms-txt-generation\` | for each page ref in the job, read \[by reference\](..\/architecture.md#page-results-by-reference)/| \`llms-txt-generation\` | for each page ref in the job, read from the cache/' $D/workers.md"
run "extraction row: worker extracts" "content-extraction row must call extractContent cache first" "sed -i 's/ (the service fetches and extracts; the worker only calls it)//' $D/workers.md"
run "extraction row reports body" "content-extraction row must call extractContent cache first" "sed -i 's/| \`{page, cache}\` (a \`PageRef\`, never the extraction) |/| \`{extraction, cache}\` |/' $D/workers.md"
run "orchestrator doc unlinked" "orchestrator.md must link the page-results-by-reference rule" "sed -i 's/page-results-by-reference/x/g' $D/orchestrator.md"
run "dry-rule row dropped" "dry-rule.md must link the page-results-by-reference rule" "sed -i '/page-results-by-reference/d' docs/dry-rule.md"
run "byReference drops extractContent" "byReference must list content-extractor.extractContent" "sed -i '/^  - content-extractor.extractContent\$/d' $P"
# ADRs: Jay's decision recorded, Phase 0 accepted
run "0023 amendment line removed" "ADR 0023 lacks the dated amendment" "sed -i '/^- \*\*Amended:\*\* 2026-11-22, at Jay.s request: audits/d' docs/adr/0023-llms-txt-pipeline.md"
run "0023 amendment unmarked" "ADR 0023 lacks the dated amendment" "sed -i 's/### 2026-11-22: audits by reference, sitemap-extractor deployment (decided by Jay)/### Audits by reference/' docs/adr/0023-llms-txt-pipeline.md"
run "0023 reverted to Proposed" "ADR 0023 must exist, be Accepted" "sed -i 's/^- \*\*Status:\*\* Accepted.*/- **Status:** Proposed/' docs/adr/0023-llms-txt-pipeline.md"
# sitemap-extractor deployment: implementer's choice, closed
run "deployment question reopened" "sitemap-extractor deployment must be the implementer's choice" "sed -i 's/Deployment is the implementer.s choice: a/It may ship as a/' packages/contracts/openapi/services/sitemap-extractor.yaml"
run "deployment row in roadmap" "roadmap still lists the closed row \"sitemap-extractor deployment\"" "sed -i 's/^| Membership tiers/| sitemap-extractor deployment: separate service or endpoint | x | x |\n| Membership tiers/' docs/roadmap.md"
# wording: services extract, workers call
run "doc says a worker extracts" "says a worker extracts or fetches" "echo '- The worker extracts the page and caches it.' >> $D/workers.md"
run "glossary says workers fetch" "says a worker extracts or fetches" "echo '- **Extraction step**: workers fetch each page.' >> docs/glossary.md"
echo "by-reference negative tests: $pass caught, $fail missed"
[ "$fail" -eq 0 ]
