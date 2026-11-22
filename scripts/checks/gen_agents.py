# Independent cross-check of the per-tool AGENTS.md part of scripts/gen-docs.
# Usage: gen_agents.py <root> [--check]. Renders docs/agents/tool-AGENTS.md.tmpl for every
# tool (x-rex-service.kind == tool) into services/<tool>/AGENTS.md, or checks for drift.
import sys, os, re, glob
HERE=os.path.dirname(os.path.abspath(__file__))
try:
    import yaml
except ImportError:
    sys.exit('PyYAML is missing: python3 -m pip install --user pyyaml')
sys.path.insert(0,HERE); import rexlib
root=sys.argv[1]; check='--check' in sys.argv
tmpl=open(f'{root}/docs/agents/tool-AGENTS.md.tmpl').read()
man=yaml.safe_load(open(f'{root}/packages/contracts/vendoring.yaml'))
road=open(f'{root}/docs/roadmap.md').read()
p2=road.split('## Phase 2:')[1].split('\n## ')[0]
order=re.findall(r'^(\d+)\. `([a-z-]+)`: (.+?)(?=^\d+\. `|^\s*$)',p2,re.M|re.S)
steps=len(order)
def tools():
    for f in sorted(glob.glob(f'{root}/packages/contracts/openapi/services/*.yaml')):
        d=yaml.safe_load(open(f))
        if d.get('x-rex-service',{}).get('kind')=='tool': yield d['x-rex-service']['name'],f,d
def wrap(text,width=88):
    out=[];line=''
    for w in text.split():
        if line and len(line)+1+len(w)>width: out.append(line); line=w
        else: line=(line+' '+w) if line else w
    out.append(line); return '\n'.join(out)
def render(name,f,d):
    doc=open(f'{root}/docs/services/{name}.md').read()
    purpose=doc.split('## Purpose',1)[1].strip().split('\n\n')[0]
    purpose=re.sub(r'\[([^\]]+)\]\([^)]+\)',r'\1',' '.join(purpose.split()))
    purpose=wrap(' '.join(x for x in re.split(r'(?<=\.) ',purpose) if not x.startswith('Replaces the v1')))  # history stays in the service doc
    ops=[]
    for path,item in d['paths'].items():
        for m,op in item.items():
            if not isinstance(op,dict) or 'operationId' not in op: continue
            if path in ('/healthz','/readyz'): continue
            ops.append(wrap(f'- `{op["operationId"]}` (`{m.upper()} {path}`): {op["summary"].rstrip(".")}.').replace('\n','\n  '))
    files=man['services'][name]['files']
    src=[e for e in files if e.get('target')=='contract/openapi.yaml'][0]['from']
    extra=''.join(f'- Data: [{e["target"]}]({e["target"]}), a generated copy of\n  `packages/contracts/{e["from"]}`.\n'
                  for e in files if e['how']=='copy')
    st=[(n,s) for n,t,s in order if t==name]
    if not st: raise SystemExit(f'{name}: not in the roadmap Phase 2 order')
    step,scope=st[0]
    scaffolded=os.path.exists(f'{root}/services/{name}/package.json')
    sw=rexlib.switches(root,name)
    status=('Scaffolded: these commands work in this folder.' if scaffolded else
            wrap('Not scaffolded yet: today this folder holds only this file and `contract/`. '
            f'`scripts/new-tool` (built in Phase 1) scaffolds the rest at the start of this tool\'s Phase 2 step, with `--lang` as its language ADR decides'
            +(' and '+' and '.join(f'`{x}`' for x in sw) if sw else '')+'. Then these commands work (for the language above):'))
    shared='\n'.join(rexlib.shared_lines(root,name,d,wrap))
    lim='\n'.join(wrap(f'- `{o}`: {rexlib.fmt_limit(p,l)}.').replace('\n','\n  ') for o,p,l in rexlib.limits(d))
    pk='\n'.join(wrap(f'- `{p}`: {pur}' + ('' if sc=='all' else f' ({sc})')).replace('\n','\n  ') for p,pur,sc in rexlib.tool_packages(root,name))
    swt=', '.join(f'`{x}`' for x in sw) if sw else 'none'
    v={'name':name,'purpose':purpose,'from':src,'extra_files':extra,'operations':'\n'.join(ops),
       'step':step,'steps':str(steps),'scope':wrap(' '.join(scope.split()),88-0),'status':status,
       'shared':shared,'limits':lim,'packages':pk,'switches':swt}
    lang=rexlib.tool_language(root,name) or 'ts'
    langs=rexlib.languages(root)
    if lang not in langs: raise SystemExit(f'{name}: language {lang} is not in vendoring.yaml languages')
    v['language_name']=langs[lang].get('name',lang)
    v['language_line']=wrap(rexlib.language_line(root,name) or v['language_name'])
    out=re.sub(r'\{\{#lang (\w+)\}\}\n(.*?)\{\{/lang\}\}\n',lambda m: m.group(2) if m.group(1)==lang else '',tmpl,flags=re.S)
    for k,val in v.items(): out=out.replace('{{'+k+'}}',val)
    left=re.findall(r'\{\{\w+\}\}',out)
    if left: raise SystemExit(f'{name}: unrendered {left}')
    # rewrap the scope line so the paragraph stays under 88 columns
    lines=out.split('\n'); i=[j for j,l in enumerate(lines) if l.startswith('Phase 2, step')][0]
    para=[]; j=i
    while j<len(lines) and lines[j].strip(): para.append(lines[j]); j+=1
    lines[i:j]=wrap(' '.join(para)).split('\n')
    return '\n'.join(lines)
problems=[]; seen=[]
for name,f,d in tools():
    seen.append(name); tgt=f'{root}/services/{name}/AGENTS.md'; want=render(name,f,d)
    if check:
        if not os.path.exists(tgt): problems.append(f'services/{name}/AGENTS.md: missing (run scripts/gen-docs)')
        elif open(tgt).read()!=want: problems.append(f'services/{name}/AGENTS.md: drifted from docs/agents/tool-AGENTS.md.tmpl (run scripts/gen-docs)')
    else: open(tgt,'w').write(want)
for n,t,s in order:
    if t not in seen: problems.append(f'roadmap Phase 2 lists {t}, which has no tool spec')
print('\n'.join(problems) if problems else ('tool AGENTS.md in sync' if check else 'rendered '+', '.join(seen)))
sys.exit(1 if problems else 0)
