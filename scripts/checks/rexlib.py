# Shared helpers for the box-side reference generators and checks (gen_svcdocs, gen_agents, check).
import re, os, glob, yaml
COMMON_RE=re.compile(r"(?:\.\./)?common\.yaml#/components/(schemas|responses|parameters|headers)/([A-Za-z0-9]+)")

def approved_sections(root):
    """{lang: table text} for the per-language tables in conventions §16 (#### Name (`lang`))."""
    t=open(f'{root}/docs/conventions.md').read()
    sec=t.split('### Approved tool dependencies',1)[1].split('\n## ',1)[0]
    parts=re.split(r'^#### [^\n]*\(`([a-z]+)`\)\s*$',sec,flags=re.M)
    return {parts[i]:parts[i+1] for i in range(1,len(parts)-1,2)}, sec

def approved_deps(root,lang='ts'):
    """Rows of the approved tool dependency table of one language in conventions §16: [(pkg, purpose, scope)]."""
    secs,sec=approved_sections(root)
    rows=re.findall(r'^\| `([^`]+)` \| (.+?) \| ([^|]+?) \|$',secs.get(lang,''),re.M)
    flat=' '.join(sec.split())
    m=re.search(r'Template switches per tool: `--llm` for (.+?)\. ',flat)
    names=lambda x:[n for n in re.findall(r'[a-z][a-z-]+[a-z]',x) if n!='and']
    sw={'--llm':names(m.group(1)) if m else []}
    mf=re.search(r'`--fetch` for (.+?)\. ',flat)
    if mf: sw['--fetch']=names(mf.group(1))
    return rows, sw

def tool_packages(root,tool,lang=None):
    rows,sw=approved_deps(root,lang or tool_language(root,tool)); out=[]
    for pkg,purpose,scope in rows:
        scope=scope.strip(); parts=[x.strip() for x in scope.split(',')]
        if any(x=='all' or (x in sw and tool in sw[x]) or x==tool for x in parts): out.append((pkg,purpose,scope))
    return out

def switches(root,tool):
    _,sw=approved_deps(root); return [k for k,v in sw.items() if tool in v]

def _walk(o):
    if isinstance(o,dict):
        for k,v in o.items():
            if k=='$ref' and isinstance(v,str): yield v
            else: yield from _walk(v)
    elif isinstance(o,list):
        for v in o: yield from _walk(v)

def shared_components(spec):
    """{(kind,name): set('request'|'response')} for common.yaml components a spec's operations use, following local refs."""
    comps=spec.get('components',{})
    def reach(node,seen):
        for r in _walk(node):
            m=COMMON_RE.search(r)
            if m: yield (m.group(1),m.group(2)); continue
            if r.startswith('#/components/'):
                _,_,kind,name=r.split('/')[:4]
                if (kind,name) in seen: continue
                seen.add((kind,name)); yield from reach(comps.get(kind,{}).get(name,{}),seen)
    use={}
    for path,item in spec['paths'].items():
        if path in ('/healthz','/readyz'): continue
        for m,op in item.items():
            if not isinstance(op,dict) or 'operationId' not in op: continue
            parts={'request':[op.get('requestBody',{}),op.get('parameters',[]),item.get('parameters',[])],'response':[op.get('responses',{})]}
            for side,nodes in parts.items():
                for k in reach(nodes,set()): use.setdefault(k,set()).add(side)
    return use

_CONT={}
def _containers(root,kind,name):
    """Common components that contain kind/name, transitively (including itself)."""
    key=(root,kind,name)
    if key in _CONT: return _CONT[key]
    common=yaml.safe_load(open(f'{root}/packages/contracts/openapi/common.yaml'))['components']
    direct={}
    for k,group in common.items():
        if not isinstance(group,dict): continue
        for n,node in group.items():
            for r in _walk(node):
                if r.startswith('#/components/'):
                    _,_,k2,n2=r.split('/')[:4]; direct.setdefault((k2,n2),set()).add((k,n))
    out={(kind,name)}; todo=[(kind,name)]
    while todo:
        for c in direct.get(todo.pop(),()):
            if c not in out: out.add(c); todo.append(c)
    _CONT[key]=out; return out

def users_of(root,kind,name):
    us=[]; cont=_containers(root,kind,name)
    for f in sorted(glob.glob(f'{root}/packages/contracts/openapi/services/*.yaml'))+[f'{root}/packages/contracts/asyncapi/events.yaml']:
        t=open(f).read()
        if any(re.search(rf'common\.yaml#/components/{k}/{n}\b',t) for k,n in cont):
            us.append('bus messages' if f.endswith('events.yaml') else os.path.basename(f)[:-5])
    return us

KIND_LABEL={'schemas':'schema','responses':'response','parameters':'parameter','headers':'header'}
def shared_lines(root,tool,spec,width_wrap):
    lines=[]
    for (kind,name),sides in sorted(shared_components(spec).items(),key=lambda x:(x[0][0]!='schemas',x[0][1])):
        others=[u for u in users_of(root,kind,name) if u!=tool]
        side=' and '.join(s for s in ('request','response') if s in sides)
        what='error response' if kind=='responses' and side=='response' else f'{KIND_LABEL[kind]}, {side}'
        lines.append(width_wrap(f'- `{name}` ({what}); also used by {", ".join(others)}.' if others else f'- `{name}` ({what}); no other service uses it yet.').replace('\n','\n  '))
    return lines

def limits(spec):
    out=[]
    for path,item in spec['paths'].items():
        for m,op in item.items():
            if isinstance(op,dict) and 'x-rex-limits' in op: out.append((op['operationId'],bool(op.get('x-rex-public')),op['x-rex-limits']))
    return out

def fmt_limit(pub,l):
    bits=[]
    bits.append('public' if pub else 'internal (workers only)')
    bits.append(f'max duration {l["maxDuration"]}' if 'maxDuration' in l else 'no max duration stated yet')
    if 'p99' in l: bits.append(f'p99 under {l["p99"]}')
    bits.append({'none':'no LLM','optional':'LLM only when the request asks for it','required':'one LLM call'}[l['llm']])
    if 'llmCallTimeout' in l: bits.append(f'each LLM call up to {l["llmCallTimeout"]}')
    f={'none':'no outbound fetch','one':'at most one outbound fetch','several':'several outbound fetches','crawl':'a crawl'}[l['outboundFetch']]
    if 'fetchTimeout' in l:
        b=l['fetchMaxBytes']; size=f'{b//1000000} MB' if b%1000000==0 else f'{b} bytes'
        f+=f' ({l["fetchTimeout"]} timeout, {size} cap)'
    bits.append(f)
    s='; '.join(bits)
    if l.get('notes'): s+=f' ({l["notes"]})'
    return s

def wrap(text,width=88):
    out=[];line=''
    for w in text.split():
        if line and len(line)+1+len(w)>width: out.append(line); line=w
        else: line=(line+' '+w) if line else w
    out.append(line); return '\n'.join(out)

# ADR 0024: per-tool language
LANG_ADR='docs/adr/0024-per-tool-language.md'
def languages(root):
    """vendoring.yaml `languages` map."""
    return yaml.safe_load(open(f'{root}/packages/contracts/vendoring.yaml')).get('languages') or {}

def tool_language(root,tool):
    """Current language of a tool (vendoring.yaml `language`), or None when the tool has no vendoring entry yet."""
    svc=(yaml.safe_load(open(f'{root}/packages/contracts/vendoring.yaml')).get('services') or {}).get(tool) or {}
    return svc.get('language')

def proposed_languages(root):
    """{tool: (phase, language name, why, mark)} from the language table in ADR 0024 (mark: Proposed or Decided by Jay)."""
    p=f'{root}/{LANG_ADR}'
    if not os.path.exists(p): return {}
    return {m[0]:(m[1],m[2],m[4],m[3]) for m in re.findall(r'^\| `([a-z-]+)` \| (\d) \| (\w+) \((Proposed|Decided by Jay)\) \| (.+?) \|$',open(p).read(),re.M)}

def language_line(root,tool):
    """The generated Language line of a tool (service doc header and tool AGENTS.md)."""
    langs=languages(root); names={k:v.get('name',k) for k,v in langs.items()}
    cur=tool_language(root,tool); prop=proposed_languages(root).get(tool)
    adr='ADR 0024'
    if prop is None: return None
    ph,pl,why,mark=prop
    when='at the start of its Phase 2 step' if ph=='2' else f'at the start of its phase (Phase {ph})'
    src=f'as Jay decided in {adr}' if mark=='Decided by Jay' else f'as {adr} proposes'
    if cur is None:
        return f'not chosen yet. {adr} proposes {pl}: {why}. Its own language ADR, accepted by Jay, decides {when}.'
    if names.get(cur)==pl:
        return f'{names[cur]} (`language: {cur}` in vendoring.yaml), {src}: {why}. Its own language ADR, accepted by Jay, confirms it {when}.'
    for path in sorted(glob.glob(f'{root}/docs/adr/*-{tool}-language.md'), reverse=True):
        header=open(path).read().split('\n## ',1)[0]
        lines=header.splitlines()
        if (re.search(r'^- \*\*Status:\*\* Accepted\b',header,re.M)
                and f'- **Tool:** `{tool}`' in lines and f'- **Language:** `{cur}`' in lines):
            number=os.path.basename(path).split('-')[0]
            return f'{names[cur]} (`language: {cur}` in vendoring.yaml), accepted by Jay in ADR {number}.'
    return f'{names.get(cur,cur)} for now (`language: {cur}` in vendoring.yaml). {adr} proposes {pl}: {why}. Its own language ADR, accepted by Jay, decides {when}.'
