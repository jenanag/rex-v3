# Shared by the neg_*.sh suites. Each case mutates a temporary copy of the repo and
# expects check.py to report a given message. Needs GNU sed (`gsed` on macOS: brew
# install gnu-sed) because the mutations use `sed -i` and `0,/re/` addresses.
copy_repo() {  # copy the repo without node_modules, .venv or .git
  (cd "$1" && tar --exclude=./node_modules --exclude='*/node_modules' --exclude=./.git --exclude='*/.venv' --exclude=./.venv -cf - .) | (cd "$2" && tar -xf -)
}
if ! sed --version >/dev/null 2>&1; then
  if command -v gsed >/dev/null 2>&1; then sed() { gsed "$@"; }; export -f sed 2>/dev/null
  else echo "neg suites need GNU sed (macOS: brew install gnu-sed)"; exit 2; fi
fi
# Baseline: check.py on the unmutated repo. A case whose expected message is already in
# the baseline proves nothing, so it is counted as BASELINE, not CAUGHT.
base=0
BASE=$(REX="$SRC" REX_SKIP_PHASE0_SCRIPT=1 ${PYTHON:-python3} "$HERE/check.py" 2>&1)
trap 'echo "baseline-only $base (fix the repo or the rule, then re-run)"' EXIT
