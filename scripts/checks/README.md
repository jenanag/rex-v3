# scripts/checks: Phase 0 reference checker

The cross-file checker that validated Phase 0, kept as an additional check next to
`scripts/check-contracts` until that script covers every rule here. Nothing in it is
generated; it reads the repo and reports.

| File | What it does |
| --- | --- |
| `check.py` | Consistency rules across specs, bus, cache policy, vendoring, ADRs, roadmap, docs and AGENTS.md files; prints `ERRORS n` and exits 1 when n > 0 |
| `gen_agents.py` | Renders `docs/agents/tool-AGENTS.md.tmpl` per tool; `--check` reports drift (an independent cross-check of `scripts/gen-docs`) |
| `vendor.py` | Re-bundles `bundle`/`copy` entries of `vendoring.yaml`; `--check` reports drift (needs Redocly from `npm ci`, otherwise skipped) |
| `rexlib.py` | Shared readers (vendoring.yaml, approved packages, ADR 0024 language table) |
| `neg_*.sh`, `neglib.sh` | Negative suites: each case mutates a temp copy of the repo and expects `check.py` to report a given message |
| `run-all.sh` | Runs `check.py` and the AGENTS.md cross-check; `--negative` also runs the eight suites |

## Run

```bash
python3 -m pip install --user pyyaml       # once; the only Python dependency
scripts/checks/run-all.sh                  # check.py + per-tool AGENTS.md cross-check
scripts/checks/run-all.sh --negative       # plus agents, review, extractor, external,
                                           # pipeline, byref, adrs and lang suites
```

- Paths are repo-relative: `check.py` checks the repo it sits in, or `REX=<root>`.
- `PYTHON=<python>` picks another interpreter; `REX_REDOCLY=<path>` points `vendor.py`
  at a Redocly binary when `node_modules` is absent.
- The suites need GNU sed (`brew install gnu-sed` on macOS; `gsed` is used if present).
- A negative case whose expected message already appears on the unmutated repo is
  reported as `BASELINE`, not `CAUGHT`: it proves nothing until the baseline is clean.

## Known limits

Some rules still encode the Phase 0 state (current phase 0, ADR 0020 reserved, Phase 1
not started). They report on a Phase 1 tree until the rules are updated at Jay's request.
