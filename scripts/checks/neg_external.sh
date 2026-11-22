#!/bin/bash
# Negative tests for Jay's 2026-11-22 answers: external services, robots.txt, page limits, archive (ADR 0022).
HERE=$(cd "$(dirname "$0")" && pwd); SRC=${REX_SRC:-$(cd "$HERE/../.." && pwd)}; PY=${PYTHON:-python3}
. "$HERE/neglib.sh"; pass=0; fail=0
run() { name="$1"; expect="$2"; mut="$3"
  T=$(mktemp -d); copy_repo "$SRC" "$T"; (cd $T && eval "$mut")
  out=$(REX=$T REX_SKIP_PHASE0_SCRIPT=${SKIP:-1} $PY "$HERE/check.py" 2>&1)
  if echo "$BASE" | grep -qF -- "$expect"; then echo "BASELINE $name (message already reported on the unmutated repo)"; base=$((base+1))
  elif echo "$out" | grep -qF -- "$expect"; then echo "CAUGHT  $name"; pass=$((pass+1)); else echo "MISSED  $name"; echo "$out" | head -8; fail=$((fail+1)); fi
  rm -rf $T; }
S=packages/contracts/openapi/services; A=docs/architecture.md; X=$S/content-extractor.yaml; P=packages/contracts/cache/policy.yaml; R=docs/roadmap.md; D=docs/services
run "orchestrator doc archives pages" "orchestrator.md: claims to call the data-aggregator" "echo '- The optimization module sends each page to the data-aggregator.' >> $D/orchestrator.md"
run "gateway doc calls seo-auditor" "gateway.md: claims to call the seo-auditor" "echo '- It calls the seo-auditor for structured data.' >> $D/gateway.md"
run "tool doc writes to aggregator" "content-auditor.md: claims to call the data-aggregator" "echo '- Writes each audit to the data-aggregator.' >> $D/content-auditor.md"
run "aggregator URL in gateway doc" "DATA_AGGREGATOR_URL outside workers" "echo '- \`DATA_AGGREGATOR_URL\`: archive.' >> $D/gateway.md"
run "seo URL in a tool spec" "SEO_AUDITOR_URL outside workers" "sed -i 's/LLM, no network\\./LLM, no network; SEO_AUDITOR_URL./' $S/citation-extractor.yaml"
run "workers doc loses seo URL" "workers doc lacks SEO_AUDITOR_URL" "sed -i 's/ at \`SEO_AUDITOR_URL\`//' $D/workers.md"
run "conventions env rule dropped" "conventions §12 must say CONTENT_EXTRACTOR_URL, DATA_AGGREGATOR_URL and SEO_AUDITOR_URL exist only in workers" "sed -i 's/exist only in workers/are set in workers/' docs/conventions.md"
run "external kinds row drops aggregator" "external kind row must list" "sed -i 's/^| external | content-extractor, sitemap-extractor, seo-auditor, data-aggregator |/| external | content-extractor, sitemap-extractor, seo-auditor |/' $A"
run "orchestrator -> aggregator row" "architecture communication: Orchestrator -> data-aggregator" "sed -i 's/^| Worker -> data-aggregator |/| Orchestrator -> data-aggregator |/' $A"
run "service map orchestrator -> aggregator" "architecture service map: orchestrator -> aggregator" "sed -i 's/^  workers -->|\"before each page is cached\"| aggregator/  orchestrator -->|\"archive\"| aggregator/' $A"
run "seo-auditor contract invented" "contract for seo-auditor invented" "cp $X $S/seo-auditor.yaml"
run "policy entry for aggregator" "policy external.data-aggregator: no entry" "$PY -c \"import yaml;p='$P';d=yaml.safe_load(open(p));d['external']['data-aggregator']={'callers':['workers'],'keyVersion':1,'operations':{'archive':{'ttl':'PT1H','scope':'shared'}}};open(p,'w').write(yaml.safe_dump(d,sort_keys=False))\""
run "aggregator doc hides unknowns" "data-aggregator.md must list what is not known" "sed -i 's/^## Not known yet/## Details/' $D/data-aggregator.md"
run "aggregator doc missing" "service docs mismatch" "rm $D/data-aggregator.md"
run "seo-auditor missing from service table" "architecture services table mismatch" "sed -i '/^| seo-auditor | external |/d' $A"
run "structured-data-check queue invented" "structured-data-check is planned only" "echo '# structured-data-check queue' >> packages/contracts/bus/topology.yaml"
run "planned row dropped" "planned messages lack structured-data-check" "sed -i '/^| \`structured-data-check\` |/d' docs/events.md"
run "workers flow skips archive" "content-extraction flow must archive" "sed -i 's/; a fresh result is archived to the data-aggregator before it is cached (\`archiveTo\`)//' $D/workers.md"
run "policy archiveTo removed" "must declare archiveTo: data-aggregator" "sed -i '/^        archiveTo: data-aggregator/d' $P"
run "policy store rule removed" "storeRules must make archiveTo a store condition" "sed -i '/^  - An operation with \`archiveTo\`/d' $P"
run "archiveTo overridable" "keep archiveTo out of overrides" "sed -i 's/cacheable and archiveTo come only/cacheable come only/' $P"
run "ADR 0022 reverted to Proposed" "ADR 0022: status \"Proposed\" must be Accepted (2026-11-22, accepted by Jay)" "sed -i 's/^- \*\*Status:\*\* Accepted.*/- **Status:** Proposed/' docs/adr/0022-page-archive.md"
run "ADR 0018 undated acceptance" "ADR 0018: status \"Accepted\" must be Accepted (2026-11-22, accepted by Jay)" "sed -i 's/^- \*\*Status:\*\* Accepted.*/- **Status:** Accepted/' docs/adr/0018-tool-portability.md"
run "ADR 0022 missing" "ADR 0022 (page archive) missing" "rm docs/adr/0022-page-archive.md"
run "ADR README lacks 0022" "ADR README does not list 0022" "sed -i '/^| \[0022\]/d' docs/adr/README.md"
run "ADR 0016 not amended" "ADR 0016 lacks its Amended line for ADR 0022" "sed -i '/0022-page-archive/d' docs/adr/0016-cache-first.md"
run "ADR 0021 amendment removed" "ADR 0021 lacks its dated amendment (private network" "sed -i 's/^### 2026-11-22: private network, robots.txt/### Later: network, robots.txt/' docs/adr/0021-content-extraction.md"
run "extractor robots default true" "respectRobotsTxt must be a boolean, default false" "sed -i 's/          default: false/          default: true/' $X"
run "robots_disallowed undocumented" "422 code robots_disallowed not documented" "sed -i 's/\`robots_disallowed\`/robots-disallowed/g' $X"
run "extractor version not bumped" "info.version must be at least 2.0.0" "sed -i 's/^  version: 2.0.0/  version: 1.1.0/' $X"
run "orchestrator robots schema default" "respectRobotsTxt: boolean with no schema default" "perl -0pi -e 's/(respectRobotsTxt:\n\s+type: boolean\n)/\$1              default: true\n/' $S/orchestrator.yaml"
run "maxPages cap returns" "maxPages: no default and no maximum" "perl -0pi -e 's/(maxPages:\n\s+type: integer\n\s+minimum: 1\n)/\$1              maximum: 500\n/' $S/orchestrator.yaml"
run "generation job cap returns" "LlmsTxtGenerationJob.pages must not cap pages" "$PY -c \"p='packages/contracts/asyncapi/events.yaml';s=open(p).read();i=s.index('LlmsTxtGenerationJob:');j=s.index('minItems: 1\n',i)+len('minItems: 1\n');open(p,'w').write(s[:j]+'          maxItems: 500\n'+s[j:])\""
run "tool page cap returns" "LlmsTxtRequest.pages must not cap pages" "$PY -c \"p='$S/llms-txt-generator.yaml';s=open(p).read();i=s.index('    LlmsTxtRequest:');j=s.index('minItems: 1\n',i)+len('minItems: 1\n');open(p,'w').write(s[:j]+'              maxItems: 500\n'+s[j:])\""
run "orchestrator doc loses robots flag" "orchestrator doc lacks respectRobotsTxt" "sed -i 's/respectRobotsTxt/robotsFlag/g' $D/orchestrator.md"
run "settings resolution removed" "orchestrator doc lacks Job settings resolution" "sed -i 's/Job settings resolution/Settings/' $D/orchestrator.md"
run "fixed generation deadline" "llms.txt generation deadline must scale per page" "perl -0pi -e 's/llms\.txt generation 15 min plus 1 s per\s+page/llms.txt generation 2 h/' $A"
run "closed robots row returns" "roadmap still lists the decided row \"honor robots.txt\"" "sed -i 's/^| Membership tiers/| Should the llms.txt crawl honor robots.txt \`Disallow\` | x | y |\n&/' $R"
run "closed location row returns" "roadmap still lists the decided row \"Where the content-extractor runs\"" "sed -i 's/^| Membership tiers/| Where the content-extractor runs; auth | x | y |\n&/' $R"
run "tiers row missing" "roadmap deferred decisions lack \"Membership tiers\"" "sed -i '/^| Membership tiers/d' $R"
run "seo interface row missing" "roadmap deferred decisions lack \"seo-auditor interface\"" "sed -i '/^| seo-auditor interface/d' $R"
run "aggregator interface row missing" "roadmap deferred decisions lack \"data-aggregator interface\"" "sed -i '/^| data-aggregator interface/d' $R"
echo "caught $pass / $((pass+fail))"
[ "$fail" -eq 0 ]
