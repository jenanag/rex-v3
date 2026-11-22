#!/bin/bash
# Negative tests for the llms.txt pipeline (ADR 0023): bus parties, LLM-free generation, read order, no bodies in messages.
HERE=$(cd "$(dirname "$0")" && pwd); SRC=${REX_SRC:-$(cd "$HERE/../.." && pwd)}; PY=${PYTHON:-python3}
. "$HERE/neglib.sh"; pass=0; fail=0
run() { name="$1"; expect="$2"; mut="$3"
  T=$(mktemp -d); copy_repo "$SRC" "$T"; (cd $T && eval "$mut")
  out=$(REX=$T REX_SKIP_PHASE0_SCRIPT=${SKIP:-1} $PY "$HERE/check.py" 2>&1)
  if echo "$BASE" | grep -qF -- "$expect"; then echo "BASELINE $name (message already reported on the unmutated repo)"; base=$((base+1))
  elif echo "$out" | grep -qF -- "$expect"; then echo "CAUGHT  $name"; pass=$((pass+1)); else echo "MISSED  $name"; echo "$out" | head -8; fail=$((fail+1)); fi
  rm -rf $T; }
S=packages/contracts/openapi/services; E=packages/contracts/asyncapi/events.yaml; T_=packages/contracts/bus/topology.yaml; P=packages/contracts/cache/policy.yaml; A=docs/architecture.md; D=docs/services; L=$S/llms-txt-generator.yaml; X=$S/content-extractor.yaml; SX=$S/sitemap-extractor.yaml
# services never publish
run "tool publishes" "citation-extractor: spec mentions the bus" "sed -i 's/No database, no queues, no bus, no calls to other tools\./No database, no queues, no bus, no calls to other tools. It publishes a result event./' $S/citation-extractor.yaml"
run "extractor uses RabbitMQ" "sitemap-extractor: spec mentions the bus" "sed -i 's/no database, no queues, no bus, no calls to REx services/no database, no queues, no bus, no calls to REx services; results go to RabbitMQ/' $SX"
run "extractor drops no-bus" "content-extractor: spec description must say \"no bus\"" "sed -i 's/no queues, no bus, no calls/no queues, no calls/' $X"
run "service as producer" "producer outside orchestrator/workers" "sed -i '0,/x-rex-producers: \[workers\]/s//x-rex-producers: [workers, sitemap-extractor]/' $E"
run "orchestrator publishes completed" "producers ['orchestrator'] != ['workers']" "perl -0pi -e 's/(page-audit\.completed\n(?:.*\n){0,6}?\s+x-rex-producers: )\[workers\]/\$1\[orchestrator\]/' $E"
# generateLlmsTxt makes no LLM call
run "generation calls an LLM" "generateLlmsTxt must declare llm: none" "sed -i \"s/{maxDuration: PT30S, llm: none, outboundFetch: none, notes: 'assembles/{maxDuration: PT30S, llm: optional, outboundFetch: none, notes: 'assembles/\" $L"
run "validate calls an LLM" "only describePage may call an LLM" "sed -i 's/{p99: PT2S, llm: none, outboundFetch: none, notes: .validates/{p99: PT2S, llm: required, outboundFetch: none, notes: \"validates/; s/fetches nothing.}/fetches nothing\"}/' $L"
run "generation takes summarizer" "must carry no LLM options or usage" "$PY -c \"import yaml;p='$L';d=yaml.safe_load(open(p));d['components']['schemas']['LlmsTxtRequest']['allOf'][0]={'\\\$ref':'#/components/schemas/PageEntryOptions'};open(p,'w').write(yaml.safe_dump(d,sort_keys=False))\""
run "generation returns usage" "must carry no LLM options or usage" "$PY -c \"import yaml;p='$L';d=yaml.safe_load(open(p));d['components']['schemas']['LlmsTxtGeneration']['properties']['usage']={'\\\$ref':'../common.yaml#/components/schemas/LlmUsageList'};open(p,'w').write(yaml.safe_dump(d,sort_keys=False))\""
run "generation llmCallTimeout" "generateLlmsTxt: llmCallTimeout without an LLM" "sed -i \"s/{maxDuration: PT30S, llm: none, outboundFetch: none, notes: 'assembles/{maxDuration: PT30S, llm: none, llmCallTimeout: PT60S, outboundFetch: none, notes: 'assembles/\" $L"
run "request takes extractions again" "LlmsTxtRequest must take the page entries" "$PY -c \"import yaml;p='$L';d=yaml.safe_load(open(p));d['components']['schemas']['LlmsTxtRequest']['allOf'][1]['properties']['pages']['items']={'\\\$ref':'#/components/schemas/LlmsTxtPage'};open(p,'w').write(yaml.safe_dump(d,sort_keys=False))\""
# cache-then-aggregator read order
run "aggregator before cache" "llms-txt-generation must read page results by reference" "sed -i 's/^| \`llms-txt-generation\` | for each page ref in the job, read \[by reference\](..\/architecture.md#page-results-by-reference)/| \`llms-txt-generation\` | for each page ref in the job, read from the data-aggregator, else the cache,/' $D/workers.md"
run "no aggregator fallback" "the Read step must say cache first, then the data-aggregator" "perl -0pi -e 's/\*\*cache first, then\n   the data-aggregator\*\*/**cache only**/' docs/architecture.md"
run "generation re-extracts" "must reuse describePage results and call no extractor" "sed -i 's/^| \`llms-txt-generation\` | for each page ref/| \`llms-txt-generation\` | content-extractor \`extractContent\` for each page ref/' $D/workers.md"
run "diagram aggregator first" "generation reads the cache first, then the data-aggregator" "perl -0pi -e 's/(  loop each page ref\n)    W->>C: GET entry \(and Markdown for llms-full.txt\)\n    alt miss\n      W->>A: read by cache key\n/\$1    W->>A: read by cache key\n    alt miss\n      W->>C: GET entry (and Markdown for llms-full.txt)\n/' $A"
run "page-audit row loses archive" "page-audit row must name" "sed -i 's/(the service extracts; a fresh result is archived to the data-aggregator before it is cached)/(cached)/; s/(archived the same way)//' $D/workers.md"
run "discovery row skips cache" "sitemap-discovery row must name" "sed -i 's/^| \`sitemap-discovery\` | sitemap-extractor \`extractSitemapUrls\` with the job.s request, cache first/| \`sitemap-discovery\` | sitemap-extractor \`extractSitemapUrls\` with the job request/' $D/workers.md"
# messages carry ids and keys, never bodies
run "page ref carries entry" "page-flow message carries a page body" "perl -0pi -e 's/(    PageResultRef:\n(?:.*\n)*?      properties:\n)/\$1        entry:\n          \\\$ref: \x27..\/openapi\/services\/llms-txt-generator.yaml#\/components\/schemas\/LlmsTxtEntry\x27\n/' $E"
run "page-audit.completed carries extraction" "page-flow message carries a page body" "$PY -c \"import yaml;p='$E';d=yaml.safe_load(open(p));d['components']['messages']['pageAuditCompleted']['payload']['allOf'][1]['properties']['data']['properties']['extraction']={'\\\$ref':'../openapi/services/content-extractor.yaml#/components/schemas/Extraction'};open(p,'w').write(yaml.safe_dump(d,sort_keys=False))\""
run "pagesMissing dropped" "must report pagesMissing" "$PY -c \"import yaml;p='$E';d=yaml.safe_load(open(p));x=d['components']['messages']['llmsTxtGenerationCompleted']['payload']['allOf'][1]['properties']['data'];x['properties'].pop('pagesMissing');x['required'].remove('pagesMissing');open(p,'w').write(yaml.safe_dump(d,sort_keys=False))\""
run "keys dropped from refs" "PageRef must carry url and extractionKey (required) and entryKey" "sed -i 's/required: \[url, entryKey, extractionKey\]/required: [url]/; s/^        entryKey:/        entryRef:/' $E"
run "cache key field removed" "ToolCallCache must carry the cache key" "$PY -c \"import yaml;p='packages/contracts/openapi/common.yaml';d=yaml.safe_load(open(p));d['components']['schemas']['ToolCallCache']['properties'].pop('key');open(p,'w').write(yaml.safe_dump(d,sort_keys=False))\""
# bus topology and jobs
run "page-audit queue removed" "page-audit.requested must have exactly one queue" "$PY -c \"import yaml;p='$T_';d=yaml.safe_load(open(p));d['queues']=[q for q in d['queues'] if q['name']!='rex.workers.page-audit'];open(p,'w').write(yaml.safe_dump(d,sort_keys=False))\""
run "discovery shares a queue" "sitemap-discovery.requested must have exactly one queue" "$PY -c \"import yaml;p='$T_';d=yaml.safe_load(open(p));q=[q for q in d['queues'] if q['name']=='rex.workers.sitemap-discovery'][0];q['name']='rex.workers.optimization';open(p,'w').write(yaml.safe_dump(d,sort_keys=False))\""
run "page-audit.failed removed" "pipeline job page-audit needs requested, completed and failed" "$PY -c \"import yaml;p='$E';d=yaml.safe_load(open(p));[d['channels'].pop(k) for k in [k for k,c in d['channels'].items() if c.get('address')=='page-audit.failed']];d['components']['messages'].pop('pageAuditFailed');open(p,'w').write(yaml.safe_dump(d,sort_keys=False))\""
# cache policy
run "describePage not archived" "describePage must be shared, archiveTo data-aggregator" "sed -i 's/describePage: {ttl: P30D, scope: shared, archiveTo: data-aggregator}/describePage: {ttl: P30D, scope: shared}/' $P"
run "describePage tenant scope" "describePage must be shared, archiveTo data-aggregator" "sed -i 's/describePage: {ttl: P30D, scope: shared,/describePage: {ttl: P30D, scope: tenant,/' $P"
run "sitemap ttl not DEFAULT" "extractSitemapUrls must be workers-only, shared, ttl DEFAULT" "sed -i 's/ttl: PT24H  *# DEFAULT/ttl: PT24H/' $P"
run "sitemap called by gateway" "extractSitemapUrls must be workers-only" "$PY -c \"import yaml;p='$P';t=open(p).read();i=t.index('  sitemap-extractor:');j=t.index('callers: [workers]',i);open(p,'w').write(t[:j]+'callers: [workers, gateway]'+t[j+18:])\""
# extractor 2.0.0 stays discovery-free
run "extractor links back" "include must offer exactly robotsTxt, llmsTxt" "sed -i 's/enum: \[robotsTxt, llmsTxt\]/enum: [robotsTxt, llmsTxt, links]/' $X"
run "extractor maxUrls back" "discovery fields (maxUrls, PageLink, SitemapUrls) are back" "echo '# maxUrls' >> $X"
# ADRs
run "ADR 0023 design details still Proposed" "both design-details sections must be marked accepted by Jay" "sed -i '0,/Design details (accepted by Jay, 2026-11-22)/s//Design details (Proposed)/' docs/adr/0023-llms-txt-pipeline.md"
run "ADR 0023 hides Jay" "ADR 0023 must exist, be Accepted and mark the decisions by Jay" "sed -i 's/Decided by Jay/Decided/g' docs/adr/0023-llms-txt-pipeline.md"
run "ADR 0023 unlisted" "ADR README lacks 0023" "sed -i 's/0023/00XX/g' docs/adr/README.md"
run "ADR 0020 used" "ADR 0020 is reserved" "cp docs/adr/0023-llms-txt-pipeline.md docs/adr/0020-x.md"
run "0021 pipeline amendment removed" "ADR 0021 lacks the pipeline amendment" "sed -i 's/^### 2026-11-22: llms.txt pipeline and the sitemap-extractor (decided by Jay)/### llms.txt/' docs/adr/0021-content-extraction.md"
run "0022 read-back removed" "ADR 0022 lacks the read-back decision" "sed -i 's/Read back (decided by Jay/Read back (Jay/' docs/adr/0022-page-archive.md"
# architecture diagram
run "diagram semicolon" "no semicolons in labels" "sed -i 's/W->>MQ: page-audit.completed (PageRef, usage) or .failed/W->>MQ: page-audit.completed; cache keys/' $A"
run "diagram not sequence" "needs a mermaid sequenceDiagram" "perl -0pi -e 's/(### llms.txt pipeline(?:.*\n)*?)sequenceDiagram/\$1flowchart LR/' $A"
run "diagram loses generation job" "pipeline diagram lacks llms-txt-generation.requested" "sed -i 's/O->>MQ: llms-txt-generation.requested (page refs)/O->>MQ: generation job (page refs)/' $A"
run "reconciler loses page audit" "llms.txt generation deadline must scale per page" "sed -i 's/sitemap discovery 30 min, page audit 30 min,/sitemap discovery 30 min,/' $A"
# roadmap, conventions, orchestrator
run "large-crawl row back" "roadmap still lists the closed row \"Very large llms.txt crawls\"" "sed -i 's/^| Membership tiers/| Very large llms.txt crawls: x | x | x |\n| Membership tiers/' docs/roadmap.md"
run "marked row back" "roadmap still lists the closed row \"Markdown parser for citation-extractor\"" "sed -i 's/^| Membership tiers/| Markdown parser for citation-extractor: x | x | x |\n| Membership tiers/' docs/roadmap.md"
run "10-minute concern back" "10-minute single-call concern" "sed -i 's/^| Membership tiers/| generateLlmsTxt in one request within PT10M | x | x |\n| Membership tiers/' docs/roadmap.md"
run "message-size row dropped" "Size limits of the llms.txt pipeline messages" "sed -i '/^| Size limits of the llms.txt pipeline messages/d' docs/roadmap.md"
run "marked removed from conventions" "conventions §16 must list marked for citation-extractor" "sed -i '/^| \`marked\` |/d' docs/conventions.md"
run "sitemap URL outside workers" "SITEMAP_EXTRACTOR_URL outside workers" "echo '- \`SITEMAP_EXTRACTOR_URL\`: discovery.' >> $D/orchestrator.md"
run "orchestrator calls sitemap-extractor" "orchestrator.md: claims to call the sitemap-extractor" "echo '- The optimization module calls the sitemap-extractor directly.' >> $D/orchestrator.md"
run "LlmsTxt loses stage" "orchestrator LlmsTxt must report stage" "sed -i 's/enum: \[discovering, auditing, generating, done\]/enum: [running, done]/' $S/orchestrator.yaml"
run "orchestrator doc loses page jobs" "orchestrator doc: llms.txt crawl lacks page-audit.requested" "sed -i 's/page-audit\.requested/page job/g' $D/orchestrator.md"
echo "pipeline negative tests: $pass caught, $fail missed"
[ "$fail" -eq 0 ]
