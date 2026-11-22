#!/bin/bash
# Negative tests: ADR enumerations must match docs/adr.
HERE=$(cd "$(dirname "$0")" && pwd); SRC=${REX_SRC:-$(cd "$HERE/../.." && pwd)}; PY=${PYTHON:-python3}
. "$HERE/neglib.sh"; pass=0; fail=0
run() { name="$1"; expect="$2"; mut="$3"
  T=$(mktemp -d); copy_repo "$SRC" "$T"; (cd $T && eval "$mut")
  out=$(REX=$T REX_SKIP_PHASE0_SCRIPT=${SKIP:-1} $PY "$HERE/check.py" 2>&1)
  if echo "$BASE" | grep -qF -- "$expect"; then echo "BASELINE $name (message already reported on the unmutated repo)"; base=$((base+1))
  elif echo "$out" | grep -qF -- "$expect"; then echo "CAUGHT  $name"; pass=$((pass+1)); else echo "MISSED  $name"; echo "$out" | head -8; fail=$((fail+1)); fi
  rm -rf $T; }
R=docs/roadmap.md
run "old stale range" "roadmap Phase 0 must list" "sed -i 's/\[ADRs 0001 to 0023\](adr\/README.md)/[ADRs 0001 to 0019 and 0021](adr\/README.md)/' $R"
run "range one short" "roadmap ADR range 0001 to 0022 does not match the Phase 0 ADRs" "sed -i 's/\[ADRs 0001 to 0023\](adr\/README.md)/[ADRs 0001 to 0022](adr\/README.md)/' $R"
run "new ADR not referenced" "roadmap does not link ADR 0025" "cp docs/adr/0023-llms-txt-pipeline.md docs/adr/0025-next.md"
run "ADR file removed" "roadmap ADR range 0001 to 0023 does not match the Phase 0 ADRs" "rm docs/adr/0022-page-archive.md"
run "index row dropped" "ADR index rows [23] out of sync" "sed -i '/^| \[0023\](0023-/d' docs/adr/README.md"
run "README decisions miss 0022" "README Decisions list" "sed -i 's/ · 0022 page archive//' README.md"
run "AGENTS status stale" "AGENTS.md: the Phase 0 status must name ADRs 0001 to 0023" "sed -i 's/^to 0023 (0020 reserved;/to 0021 (0020 reserved;/' AGENTS.md"
run "README status stale" "README.md: the Phase 0 status must name ADRs 0001 to 0023" "sed -i 's/(ADRs 0001 to 0023, 0020/(ADRs 0001 to 0021, 0020/' README.md"
run "superseded list wrong" "the Phase 0 status must name the superseded ADRs (0003, 0004, 0005 and 0008)" "sed -i 's/0003, 0004, 0005 and 0008 superseded) are/0003 and 0004 superseded) are/' $R AGENTS.md"
run "Phase 0 drops seo-auditor doc" "roadmap Phase 0 deliverables must mention the seo-auditor doc" "sed -i 's/  \[seo-auditor\](services\/seo-auditor.md) (docs only/  the seo-auditor (docs only/' $R"
run "Phase 0 drops aggregator doc" "roadmap Phase 0 deliverables must mention the data-aggregator doc" "sed -i 's/  \[data-aggregator\](services\/data-aggregator.md) and/  the data-aggregator and/' $R"
run "0020 used" "ADR 0020 is reserved" "cp docs/adr/0023-llms-txt-pipeline.md docs/adr/0020-spike.md"
run "Phase 1 marked started" "Phase 1 is open but not started" "sed -i 's/Phase 1 is open but not started:/Phase 1 is under way:/' $R AGENTS.md"
run "AGENTS loses post-acceptance change rule" "new ADR that amends or supersedes it" "sed -i 's/write a new ADR that amends or supersedes it/edit it in place/; s/decision is a new ADR that amends or supersedes it/decision is edited in place/' AGENTS.md $R"
run "accepted ADR without date" "ADR 0010: status" "sed -i 's/^- \*\*Status:\*\* Accepted.*/- **Status:** Accepted (by an agent)/' docs/adr/0010-orchestrator.md"
echo "caught $pass / $((pass+fail))"
[ "$fail" -eq 0 ]
