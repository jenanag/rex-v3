# Independent cross-check of scripts/vendor-contracts (bundle/copy entries only).
# Usage: vendor.py <root> [--check] [--phase N]. Writes (or checks) every vendoring.yaml entry
# with how in {bundle, copy} and fromPhase <= phase.
import sys, os, subprocess, tempfile, shutil
try:
    import yaml
except ImportError:
    sys.exit('PyYAML is missing: python3 -m pip install --user pyyaml')
root=sys.argv[1]; check='--check' in sys.argv
phase=int(sys.argv[sys.argv.index('--phase')+1]) if '--phase' in sys.argv else 0
HERE=os.path.dirname(os.path.abspath(__file__)); REPO=os.path.dirname(os.path.dirname(HERE))
# redocly from REX_REDOCLY, the target root, this checker's repo, or PATH (needs `npm ci`)
RED=next((p for p in (os.environ.get('REX_REDOCLY'),f'{root}/node_modules/.bin/redocly',f'{REPO}/node_modules/.bin/redocly',shutil.which('redocly')) if p and os.path.exists(p)),None)
if RED is None:
    print('SKIPPED: vendored-copy check needs redocly (run npm ci); scripts/vendor-contracts --check covers it'); sys.exit(0)
man=yaml.safe_load(open(f'{root}/packages/contracts/vendoring.yaml'))
def render(e):
    src=f'{root}/packages/contracts/{e["from"]}'
    hdr=''.join('# '+l+'\n' for l in man['header'].format(**{'from':e['from']}).rstrip('\n').split('\n'))
    if e['how']=='copy': return hdr+open(src).read()
    with tempfile.TemporaryDirectory() as d:
        out=f'{d}/b.yaml'
        r=subprocess.run([RED,'bundle',src,'-o',out],cwd=root,capture_output=True,text=True)
        if r.returncode: raise SystemExit(f'bundle failed {src}: {r.stderr[-400:]}')
        return hdr+open(out).read()
problems=[]
groups=[(f'services/{svc}/',cfg) for svc,cfg in man['services'].items()]+[('packages/contracts/',cfg) for cfg in (man.get('handoff') or {}).values()]
for base,cfg in groups:
    for e in cfg['files']:
        if e.get('fromPhase',0)>phase or e['how'] not in ('bundle','copy'): continue
        svc=None; tgt=f'{root}/{base}{e["target"]}'
        want=render(e)
        if check:
            if not os.path.exists(tgt): problems.append(f'{base}{e["target"]}: missing (run scripts/vendor-contracts)')
            elif open(tgt).read()!=want: problems.append(f'{base}{e["target"]}: drifted from packages/contracts/{e["from"]} (run scripts/vendor-contracts)')
        else:
            os.makedirs(os.path.dirname(tgt),exist_ok=True); open(tgt,'w').write(want)
print('\n'.join(problems) if problems else ('vendored copies in sync' if check else 'vendored'))
sys.exit(1 if problems else 0)
