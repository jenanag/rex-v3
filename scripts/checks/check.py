import os,sys
HERE=os.path.dirname(os.path.abspath(__file__)); REPO=os.path.dirname(os.path.dirname(HERE))
try:
    import yaml
except ImportError:
    sys.exit('PyYAML is missing: python3 -m pip install --user pyyaml (see scripts/checks/README.md)')
import re,glob,json,hashlib,subprocess
R=os.path.abspath(os.environ.get('REX',REPO)); os.chdir(R)
errs=[];warn=[]
SCAN_EXCLUDES = {'node_modules', '.git', '.venv', 'dist'}

def scan_walk(root, *, include_hidden=False):
    for directory, subdirs, files in os.walk(root):
        subdirs[:] = [
            name for name in subdirs
            if name not in SCAN_EXCLUDES and (include_hidden or not name.startswith('.'))
        ]
        yield directory, files

def scan_files(root):
    return [
        os.path.normpath(os.path.join(directory, name))
        for directory, files in scan_walk(root)
        for name in files
        if not name.startswith('.')
    ]

TOOLS=['engine-query','answer-analysis','citation-extractor','content-auditor','schema-generator','llms-txt-generator']
FUTURE_TOOLS=['notifier','report-renderer','query-discovery','content-rewriter','entity-optimizer','ai-traffic-analyzer']
KIND={'gateway':'gateway','orchestrator':'orchestrator','workers':'workers',**{t:'tool' for t in TOOLS+FUTURE_TOOLS},'content-extractor':'external','sitemap-extractor':'external','seo-auditor':'external','data-aggregator':'external'}
EXTERNAL=['content-extractor','sitemap-extractor']                     # external services with a REx-defined contract
EXTERNAL_PLANNED=['seo-auditor','data-aggregator'] # external services whose interface is not known yet
EXT_ALL=EXTERNAL+EXTERNAL_PLANNED
EXT_ENV={'content-extractor':'CONTENT_EXTRACTOR_URL','sitemap-extractor':'SITEMAP_EXTRACTOR_URL','seo-auditor':'SEO_AUDITOR_URL','data-aggregator':'DATA_AGGREGATOR_URL'}
SERVICES=list(KIND)
SPEC_SVCS=['gateway','orchestrator']+TOOLS+['content-extractor','sitemap-extractor']
BUS_PARTIES={'orchestrator','workers'}
common=yaml.safe_load(open('packages/contracts/openapi/common.yaml'))
cnames={(k,n) for k,v in common['components'].items() for n in v}
SRC=lambda s: f'packages/contracts/openapi/services/{s}.yaml'
specs={s:yaml.safe_load(open(SRC(s))) for s in SPEC_SVCS}
raw={s:open(SRC(s)).read() for s in SPEC_SVCS}
CURRENT_PHASE=0
METHODS=('get','post','put','patch','delete')
def ops(sp):
    for path,item in sp['paths'].items():
        for m in METHODS:
            if m in item: yield path,m,item[m]
def resolve(sp,ref):
    if not ref.startswith('#/'): return None
    o=sp
    for k in ref[2:].split('/'): o=o[k]
    return o
def collect_props(sp,sch,seen=None):
    seen=seen or set(); out=set()
    if not isinstance(sch,dict): return out
    if '$ref' in sch:
        r=sch['$ref']
        if r in seen: return out
        seen.add(r); t=resolve(sp,r)
        return collect_props(sp,t,seen) if t else out
    out|=set(sch.get('properties',{}))
    for k in ('allOf','oneOf','anyOf'):
        for x in sch.get(k,[]): out|=collect_props(sp,x,seen)
    return out
# 1 service dirs
spec_entries = sorted(
    entry.name for entry in os.scandir('packages/contracts/openapi/services')
    if not (entry.name in SCAN_EXCLUDES and entry.is_dir())
)
if spec_entries!=sorted(f'{x}.yaml' for x in SPEC_SVCS): errs.append(f'contract sources {spec_entries}')
service_dirs = [
    entry.name for entry in os.scandir('services')
    if entry.name not in SCAN_EXCLUDES and entry.is_dir()
] if os.path.isdir('services') else []
service_agents = sorted(
    f'services/{name}/AGENTS.md' for name in service_dirs
    if not name.startswith('.') and os.path.isfile(f'services/{name}/AGENTS.md')
)
for d in service_dirs:
    if d not in SERVICES and d!='_template': errs.append(f'services/{d}: unknown service folder')
for t in TOOLS:
    if not os.path.isdir(f'services/{t}'): errs.append(f'services/{t}: tool folder (vendored contract) missing')
opids={}; public_paths={}
for s,sp in specs.items():
    x=sp.get('x-rex-service',{})
    if x.get('name')!=s: errs.append(f'{s}: x-rex-service.name={x.get("name")}')
    if x.get('kind')!=KIND[s]: errs.append(f'{s}: kind {x.get("kind")} != {KIND[s]}')
    for path,m,op in ops(sp):
        o=op['operationId']
        if o in opids: errs.append(f'operationId {o} in {s} and {opids[o]}')
        opids[o]=s
        if (path.startswith('/internal') or path.startswith('/.well-known')) and not op.get('x-internal'):
            errs.append(f'{s}: {path} not x-internal')
        if op.get('x-rex-public') and KIND[s]!='tool': errs.append(f'{s}: x-rex-public on non-tool')
    for k,v in sp.get('components',{}).items():
        for n,val in v.items():
            if (k,n) in cnames and not (isinstance(val,dict) and list(val)==['$ref'] and val['$ref'].endswith(f'common.yaml#/components/{k}/{n}')):
                errs.append(f'{s}: redefines common {k}/{n}')
    if 'problem+json' in raw[s]: errs.append(f'{s}: defines problem+json inline')
    for n,v in sp.get('components',{}).get('securitySchemes',{}).items():
        if '$ref' not in v: errs.append(f'{s}: inline security scheme {n}')
    # refs only to own file, common.yaml, or tool specs (orchestrator only)
    for r in re.findall(r"\$ref: '?([^'#\s]+)#",raw[s]):
        if r.endswith('common.yaml'): continue
        m=re.match(r'\./([a-z-]+)\.yaml$',r)
        if not m: errs.append(f'{s}: odd $ref target {r}'); continue
        if KIND[s]!='orchestrator': errs.append(f'{s}: refs another service spec {r}')
        elif m.group(1) not in TOOLS: errs.append(f'{s}: refs non-tool spec {r}')
# 2 tool statelessness
TENANT_IDS=[n for n in common['components']['schemas'] if n.endswith('Id') and n not in ('EngineId','RequestId')]
FORBIDDEN_REFS=['IdempotencyKey','/Page','PageInfo','JobFields','JobStatus','Cursor','Limit','bearerToken','apiKey','/Created','/Accepted']+[f'schemas/{n}' for n in TENANT_IDS]
WORDS=re.compile(r'(?<![.\w])(database|migrations?|persist(ed|s)?|stored|queues?|outbox|inbox|rabbitmq|bus|events?|jobs?|tenant|org(Id)?|project(Id)?)\b',re.I)
DISCLAIMER=re.compile(r'No database,\s+no queues,\s+no bus,\s+no calls to other tools[.:]')
for t in TOOLS:
    sp=specs[t]; txt=raw[t]
    # no auth inside tools (ADR 0014, ADR 0018): enforced in front of them
    if sp.get('security')!=[]: errs.append(f'{t}: tool spec must declare security: [] (no auth inside tools)')
    if sp.get('components',{}).get('securitySchemes'): errs.append(f'{t}: tool spec defines securitySchemes')
    if re.search(r'serviceToken|bearerToken|apiKey\b|responses/Unauthorized|responses/Forbidden|\bAuthorization\b|\bJWKS\b|service token',txt,re.I): errs.append(f'{t}: tool spec references auth (tokens, 401/403, Authorization)')
    for f in FORBIDDEN_REFS:
        if re.search(r"\$ref: '?[^'\n]*"+re.escape(f)+r"'?\s*$",txt,re.M): errs.append(f'{t}: references {f}')
    for path,m,op in ops(sp):
        if not (path.startswith('/v1/')): errs.append(f'{t}: path {path} not under /v1')
        if '{' in path: errs.append(f'{t}: path parameter in {path}')
        if m not in ('get','post'): errs.append(f'{t}: method {m} {path}')
        if 'security' in op: errs.append(f'{t}: {op["operationId"]} declares security')
        if any(str(c) in ('401','403') for c in op['responses']): errs.append(f'{t}: {op["operationId"]} has a 401/403 response')
        for code in op['responses']:
            if str(code) in ('201','202','204'): errs.append(f'{t}: {op["operationId"]} returns {code}')
        if op.get('x-rex-public'):
            if m!='post' and m!='get': errs.append('public method')
            sch=op['responses']['200']['content']['application/json']['schema']
            if 'usage' in collect_props(sp,sch): errs.append(f'{t}: public op {op["operationId"]} returns usage (LLM)')
            pp='/v1/tools'+path[3:]
            if pp in public_paths: errs.append(f'public path {pp} dup')
            public_paths[pp]=t
    for p in sp['paths']:
        if p.startswith('/internal'): errs.append(f'{t}: internal path {p}')
    # persistence/job/tenant words in any description/summary
    def walkd(o,where):
        if isinstance(o,dict):
            for k,v in o.items():
                if k in ('description','summary','title') and isinstance(v,str):
                    for w in WORDS.finditer(DISCLAIMER.sub('',v)): errs.append(f'{t}: word "{w.group(0)}" in {where}/{k}: {v[:70]!r}')
                else: walkd(v,f'{where}/{k}')
        elif isinstance(o,list):
            for i,v in enumerate(o): walkd(v,f'{where}/{i}')
    walkd(sp,t)
    # property names
    for n,v in sp.get('components',{}).get('schemas',{}).items():
        for pn in collect_props(sp,{'$ref':f'#/components/schemas/{n}'}):
            if pn in ('orgId','projectId','createdAt','updatedAt','idempotencyKey'): errs.append(f'{t}: schema {n} has property {pn}')
# 2b tools never reference the cache
for t in TOOLS:
    for m in re.finditer(r'(?i)cach(e|ing|ed)|CacheMode|CacheDirective|ToolCallCache|RexCache',raw[t]):
        errs.append(f'{t}: tool spec references the cache ({m.group(0)!r})')
# deterministic-first default for sentiment
_ss=specs['answer-analysis']['components']['schemas']['SentimentOptions']['properties']['analyzers']['default']
if not _ss or not all(a.startswith('det:') for a in _ss): errs.append('answer-analysis: default analyzers must be deterministic')
# 3 orchestrator & gateway
for p in specs['orchestrator']['paths']:
    if p.startswith('/v1/tools'): errs.append(f'orchestrator path {p} under /v1/tools')
if set(specs['gateway']['paths'])!={'/healthz','/readyz'}: errs.append('gateway has business paths')
# 4 duplicate schemas
def norm(o):
    if isinstance(o,dict): return {k:norm(v) for k,v in sorted(o.items()) if k not in ('description','examples','summary','default','example')}
    if isinstance(o,list): return [norm(i) for i in o]
    return o
seen={}
def walk(o,where):
    if isinstance(o,dict):
        if o.get('type')=='object' and len(o.get('properties',{}))>=3:
            h=hashlib.sha1(json.dumps(norm(o),sort_keys=True).encode()).hexdigest()
            if h in seen: errs.append(f'duplicate schema {where} == {seen[h]}')
            else: seen[h]=where
        for k,v in o.items(): walk(v,where+'/'+str(k))
    elif isinstance(o,list):
        for i,v in enumerate(o): walk(v,where+f'/{i}')
walk(common,'common.yaml#')
for s,sp in specs.items(): walk(sp,f'{s}#')
ev=yaml.safe_load(open('packages/contracts/asyncapi/events.yaml'))
topo=yaml.safe_load(open('packages/contracts/bus/topology.yaml'))
walk(ev,'events.yaml#'); walk(topo,'topology.yaml#')
# 5 AsyncAPI
ENG=common['components']['schemas']['EngineId']['enum']
def expand(s): return [s.replace('{engine}',e) for e in ENG] if '{engine}' in s else [s]
jobs={}; addrs={}
for cid,ch in ev['channels'].items():
    mref=list(ch['messages'].values())[0]['$ref'].split('/')[-1]
    m=ev['components']['messages'][mref]; n=m['name']
    if not re.fullmatch(r'[a-z][a-z-]*\.(requested|completed|failed)',n): errs.append(f'bad message name {n}')
    if ch['address'] not in (n, n+'.{engine}'): errs.append(f'address {ch["address"]} vs {n}')
    job,kind=n.rsplit('.',1); jobs.setdefault(job,set()).add(kind)
    prods=ch.get('x-rex-producers',[])
    if 'x-rex-consumers' in ch: errs.append(f'{n}: consumers must come from topology')
    want=['orchestrator'] if kind=='requested' else ['workers']
    if prods!=want: errs.append(f'{n}: producers {prods} != {want}')
    if ch.get('bindings',{}).get('$ref')!='#/components/channelBindings/eventsExchange': errs.append(f'{n}: binding not eventsExchange')
    pl=m['payload']
    if kind=='failed':
        if pl.get('$ref')!='#/components/schemas/FailedPayload': errs.append(f'{n}: failed payload')
    else:
        props=pl['allOf'][1]['properties']
        if props['type'].get('const')!=n: errs.append(f'{n}: type const {props["type"].get("const")}')
        if 'version' not in props: errs.append(f'{n}: no version const')
    addrs[n]=ch['address']
for j,k in jobs.items():
    if k!={'requested','completed','failed'}: errs.append(f'job {j} incomplete {k}')
ex=ev['components']['channelBindings']['eventsExchange']['amqp']['exchange']
if ex.get('$ref')!='../bus/topology.yaml#/exchanges/events': errs.append('eventsExchange not ref to topology')
# 5b cache fields in messages
for cid,ch in ev['channels'].items():
    mref=list(ch['messages'].values())[0]['$ref'].split('/')[-1]
    m=ev['components']['messages'][mref]; n=m['name']
    if n.endswith('.failed'): continue
    d=m['payload']['allOf'][1]['properties']['data']
    c=d.get('properties',{}).get('cache',{}).get('$ref','')
    want='CacheDirective' if n.endswith('.requested') else 'ToolCallCacheList'
    if not c.endswith('/'+want): errs.append(f'{n}: data.cache must $ref {want}')
    if n.endswith('.completed') and 'cache' not in d.get('required',[]): errs.append(f'{n}: cache not required')
# 5c cache policy: complete, well-formed, single definition
pol=yaml.safe_load(open('packages/contracts/cache/policy.yaml'))
DUR=re.compile(r'^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?$')
for part in ['tool','operationId','specMajor','keyVersion','scope','window','variant','inputHash']:
    if '{'+part+'}' not in pol['key']['format']: errs.append(f'policy key format lacks {part}')
    if part not in pol['key']['parts']: errs.append(f'policy key parts lack {part}')
if set(pol['modes'])!={'use','refresh','bypass'} or set(pol['modes'])!=set(common['components']['schemas']['CacheMode']['enum']): errs.append('policy modes != CacheMode enum')
if set(pol['tools'])!=set(TOOLS): errs.append(f'policy tools {set(pol["tools"]) ^ set(TOOLS)}')
def req_props(sp,op):
    rb=op.get('requestBody')
    return collect_props(sp,rb['content']['application/json']['schema']) if rb else set()
EXTRA_OK={'engineModel'}
def secs(d):
    m=re.match(r'^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$',str(d))
    if not m: return -1
    D,H,M,S=[int(x or 0) for x in m.groups()]; return ((D*24+H)*60+M)*60+S
# 5c2 scopes, resolution and limits (defined once in policy.yaml)
CS=common['components']['schemas']
res=pol.get('resolution') or {}; LIM=res.get('limits') or {}
if res.get('order')!=['customer','environment','default']: errs.append('policy resolution.order must be [customer, environment, default]')
if set(res.get('layers') or {})!=set(res.get('order') or []): errs.append('policy resolution.layers must match order')
if not res.get('rules'): errs.append('policy resolution.rules missing')
for k in ('minTtl','maxTtl'):
    if not DUR.match(str(LIM.get(k,''))): errs.append(f'policy limits.{k} missing or bad')
if not LIM.get('windows') or any(not DUR.match(str(w)) for w in LIM.get('windows',[])): errs.append('policy limits.windows missing or bad')
if set(pol.get('scopes') or {})!={'shared','tenant'} or set(CS.get('CacheScope',{}).get('enum',[]))!=set(pol.get('scopes') or {}): errs.append('policy scopes != CacheScope enum {shared, tenant}')
if 'tenant' not in pol['key']['parts']['scope'] or 'shared' not in pol['key']['parts']['scope']: errs.append('policy key.parts.scope must define shared and tenant parts')
co=CS.get('CacheOverride',{}); cd=CS.get('CacheDirective',{}).get('properties',{})
if co.get('properties',{}).get('scope',{}).get('$ref')!='#/components/schemas/CacheScope': errs.append('CacheOverride.scope must $ref CacheScope')
for k in ('ttl','window'):
    if co.get('properties',{}).get(k,{}).get('$ref')!='#/components/schemas/IsoDuration': errs.append(f'CacheOverride.{k} must $ref IsoDuration')
if set(co.get('properties',{}))!={'scope','ttl','window'}: errs.append('CacheOverride may only override scope, ttl, window')
ov=cd.get('overrides',{})
if ov.get('additionalProperties',{}).get('$ref')!='#/components/schemas/CacheOverride': errs.append('CacheDirective.overrides must map to CacheOverride')
else:
    pn=re.compile(ov['propertyNames']['pattern'])
    for t,tp in pol['tools'].items():
        for oid in tp.get('operations',{}):
            if not pn.match(f'{t}.{oid}'): errs.append(f'CacheDirective.overrides key pattern rejects {t}.{oid}')
for t in TOOLS:
    sp=specs[t]; tp=pol['tools'].get(t,{})
    if not (isinstance(tp.get('keyVersion'),int) and tp['keyVersion']>=1): errs.append(f'policy {t}: keyVersion')
    pops=tp.get('operations',{}); sops={op['operationId']:op for _,_,op in ops(sp)}
    if set(pops)!=set(sops): errs.append(f'policy {t}: operations mismatch {set(pops) ^ set(sops)}')
    for oid,o in pops.items():
        if oid not in sops: continue
        if o.get('cacheable') is False: continue
        if ('ttl' in o)==('window' in o): errs.append(f'policy {t}.{oid}: exactly one of ttl/window')
        for k in ('ttl','window'):
            if k in o and not DUR.match(str(o[k])): errs.append(f'policy {t}.{oid}: bad {k} {o[k]}')
        if o.get('scope') not in ('shared','tenant'): errs.append(f'policy {t}.{oid}: scope must be shared|tenant')
        for k,v in [('ttl',o.get('ttl')),('ttlWhenPresent',(o.get('ttlWhenPresent') or {}).get('ttl'))]:
            if v and DUR.match(str(v)) and not (secs(LIM.get('minTtl','PT0S'))<=secs(v)<=secs(LIM.get('maxTtl','P9999D'))): errs.append(f'policy {t}.{oid}: {k} {v} outside limits')
        if 'window' in o and o['window'] not in LIM.get('windows',[]): errs.append(f'policy {t}.{oid}: window {o["window"]} not in limits.windows')
        props=req_props(sp,sops[oid])
        for k in ('ttlWhenPresent',):
            if k in o:
                if not DUR.match(str(o[k]['ttl'])): errs.append(f'policy {t}.{oid}: bad {k}.ttl')
                if o[k]['pointer'].split('/')[1] not in props: errs.append(f'policy {t}.{oid}: pointer {o[k]["pointer"]} not in request')
        if 'skipWhen' in o:
            rs=sops[oid]['responses']['200']['content']['application/json']['schema']
            if o['skipWhen']['pointer'].split('/')[1] not in collect_props(sp,rs): errs.append(f'policy {t}.{oid}: skipWhen pointer not in response')
        for f in o.get('normalize',{}):
            if f not in props: errs.append(f'policy {t}.{oid}: normalize field {f} not in request')
        for x in o.get('extraKeyInputs',[]):
            if x not in EXTRA_OK: errs.append(f'policy {t}.{oid}: unknown extraKeyInput {x}')
repo_files = scan_files('.')
md = [f for f in repo_files if f.endswith('.md')]
yaml_files = [f for f in repo_files if f.endswith('.yaml')]
contract_yaml = [f for f in yaml_files if f.startswith('packages/contracts/')]
SUPERSEDED=['docs/adr/0003-postgres-schema-per-service.md','docs/adr/0004-redis-bullmq-queues.md','docs/adr/0005-auth.md','docs/adr/0008-event-contracts.md']
KEYDERIV=re.compile(r'RFC 8785|SHA-256|\bJCS\b|sha256')
for f in md+yaml_files:
    if f=='packages/contracts/cache/policy.yaml': continue
    for mm in KEYDERIV.finditer(open(f).read()): errs.append(f'{f}: cache key derivation restated ({mm.group(0)}); link policy.yaml instead')
PRECEDENCE=re.compile(r'(customer|tenant|org)[^\n|]{0,60}>\s*(the\s+)?(environment|env)\b|(environment|env)\s*>\s*(policy|default)|t-\{orgId')
for f in md+glob.glob('packages/contracts/openapi/services/*.yaml')+['packages/contracts/openapi/common.yaml','packages/contracts/asyncapi/events.yaml']:
    if f=='packages/contracts/cache/policy.yaml': continue
    for mm in PRECEDENCE.finditer(open(f).read()): errs.append(f'{f}: cache override precedence or tenant key restated ({mm.group(0)}); link policy.yaml resolution')
# 5c3 languages designed in once
BCP=re.compile(r"\[a-z\]\{2,3\}\(-")
for f in glob.glob('packages/contracts/openapi/services/*.yaml')+['packages/contracts/asyncapi/events.yaml']:
    if BCP.search(open(f).read()): errs.append(f'{f}: BCP 47 pattern restated; $ref common.yaml LanguageTag')
def walk_lang(node,path,f):
    if isinstance(node,dict):
        pr=node.get('properties')
        if isinstance(pr,dict) and 'language' in pr:
            txt=yaml.safe_dump(pr['language'])
            if 'LanguageTag' not in txt: errs.append(f'{f}: {path}.language must $ref LanguageTag')
        for k,v in node.items(): walk_lang(v,f'{path}/{k}',f)
    elif isinstance(node,list):
        for i,v in enumerate(node): walk_lang(v,f'{path}/{i}',f)
for svc,sp in specs.items(): walk_lang(sp,'',svc)
aa=specs['answer-analysis']; aas=aa['components']['schemas']
ou=aas['SentimentOptions']['properties'].get('onUnsupportedLanguage',{})
if set(ou.get('enum',[]))!={'fallback','error'} or ou.get('default')!='fallback': errs.append('answer-analysis onUnsupportedLanguage must be enum [fallback, error], default fallback')
for k in ('languageSource','primaryFallback'):
    if k not in aas['AnswerAnalysis'].get('required',[]): errs.append(f'answer-analysis AnswerAnalysis must require {k}')
if 'unsupported_language' not in yaml.safe_dump(aa['paths']['/v1/answer-analyses']['post']): errs.append('answer-analysis must document 422 unsupported_language')
aad=open('docs/services/answer-analysis.md').read()
if '## Languages and the lexicon registry' not in aad or 'Adding a language' not in aad or 'keyVersion' not in aad: errs.append('answer-analysis doc lacks the lexicon registry extension path')
if 'lexicon registry' not in open('docs/adr/0017-deterministic-first-analysis.md').read(): errs.append('ADR 0017 lacks the lexicon registry')
# 5d retry policy configurable
rt=topo.get('retry',{})
DL=re.compile(r'^\d+(s|m|h)$')
pool=rt.get('delayPool',[])
if not pool or not all(DL.match(d) for d in pool): errs.append('retry.delayPool missing/bad')
if 'retryTiers' in topo: errs.append('topology still has hard-coded retryTiers')
for name,cfg in [('defaults',rt.get('defaults',{}))]+list((rt.get('perQueue') or {}).items()):
    for d in cfg.get('delays',[]):
        if d not in pool: errs.append(f'retry {name}: delay {d} not in delayPool')
qnames={x for q in topo['queues'] for x in expand(q['name'])}|{q['name'] for q in topo['queues']}
for qn in (rt.get('perQueue') or {}):
    if qn not in qnames: errs.append(f'retry.perQueue unknown queue {qn}')
if 'PLACEHOLDER' not in open('packages/contracts/bus/topology.yaml').read(): errs.append('retry values not marked as placeholders')
HARD=re.compile(r'10 ?s, 1 ?min|10s/1m|\(10 s|1 min, 5 min')
for f in md:
    if f in SUPERSEDED: continue
    for mm in HARD.finditer(open(f).read()): errs.append(f'{f}: hard-coded retry delays {mm.group(0)!r}')
# 6 topology vs asyncapi
def tm(pat,key):
    rx='^'+'\\.'.join({'*':'[^.]+','#':'.*'}.get(w,re.escape(w)) for w in pat.split('.'))+'$'
    return re.match(rx,key) is not None
EXN={v['name'] for v in topo['exchanges'].values()}
if topo['exchanges']['events']['name']!='rex.events' or topo['exchanges']['events']['type']!='topic': errs.append('events exchange')
matched={n:[] for n in addrs}
for q in topo['queues']:
    if q['consumer'] not in BUS_PARTIES: errs.append(f'queue {q["name"]} consumer {q["consumer"]}')
    if not re.fullmatch(r'rex\.'+re.escape(q['consumer'])+r'\.[a-z-]+(\.\{engine\})?',q['name']): errs.append(f'queue name {q["name"]}')
    if not isinstance(q.get('prefetch'),int) or q['prefetch']<1: errs.append(f'{q["name"]} prefetch')
    for b in q['bindings']:
        if b.get('exchange','events') not in topo['exchanges']: errs.append(f'{q["name"]} exchange {b.get("exchange")}')
        hit=False
        for qn,pat in zip(expand(q['name']),expand(b['routingKey'])):
            for n,a in addrs.items():
                for key in expand(a):
                    if tm(pat,key):
                        hit=True; matched[n].append((q['consumer'],qn))
        if not hit: errs.append(f'binding {b["routingKey"]} on {q["name"]} matches no message')
for n,cs in matched.items():
    if not cs: errs.append(f'{n} has no consumer queue')
    want='workers' if n.endswith('.requested') else 'orchestrator'
    if {c for c,_ in cs}!={want}: errs.append(f'{n} consumed by {set(c for c,_ in cs)}')
    nkeys=len(expand(addrs[n]))
    if len(cs)!=nkeys: errs.append(f'{n} matched {len(cs)} queue bindings for {nkeys} keys (expect exactly one each)')
# 7 message names in docs
PLANNED={'notification','report-render','query-discovery','content-rewrite','entity-audit','traffic-classification'}
MSG=re.compile(r'`([a-z][a-z-]*)\.(requested|completed|failed)(\.[a-z{}<>-]+)?`')
SUPERSEDED=['docs/adr/0003-postgres-schema-per-service.md','docs/adr/0004-redis-bullmq-queues.md','docs/adr/0005-auth.md','docs/adr/0008-event-contracts.md']
for f in md+glob.glob('packages/contracts/openapi/services/*.yaml'):
    if f in SUPERSEDED: continue
    for j,k,_ in MSG.findall(open(f).read()):
        if j not in jobs and j not in PLANNED and not (f=='docs/adr/0011-rabbitmq-bus.md' and j=='prompt-run'): errs.append(f'{f}: unknown message {j}.{k}')
# 8 stale v1 names outside history
STALE=re.compile(r'(?<![A-Z_])REDIS_URL` only in the gateway|Redis only at the edge|retryTiers|retry tiers?\b|the only Redis user|prompt-tracker|citation-tracker|ai-traffic-analytics|BullMQ|Redis Streams|services/accounts|accounts service|`scheduler`|packages/queue|packages/events|gatewayPrefixes|usage\.recorded|answer\.captured|prompt_run\.|events\.[a-z_.]+\.v1|tools/scripts|_tool-template|packages/(sdk|http|auth|config|observability|llm-clients|scraper|db-client|ui)\b|REX_JWT_PUBLIC_KEYS')
# history and rename notes may name v1 terms
ALLOW_STALE=SUPERSEDED+['docs/adr/0009-stateless-tool-services.md','docs/adr/0011-rabbitmq-bus.md','docs/adr/README.md','docs/services/engine-query.md','docs/services/citation-extractor.md']
for f in md+yaml_files:
    if f in ALLOW_STALE: continue
    for mm in STALE.finditer(open(f).read()): errs.append(f'{f}: stale v1 term {mm.group(0)!r}')
# 9 links + anchors
def slug(h):
    h=h.strip().lower().replace('`','')
    h=re.sub(r'[^\w\- ]','',h)
    return h.replace(' ','-')
anchors={os.path.normpath(f):{slug(m) for m in re.findall(r'^#+ (.*)$',re.sub(r'```.*?```','',open(f).read(),flags=re.S),re.M)} for f in md}
for f in md:
    t=re.sub(r'`[^`\n]*`','',re.sub(r'```.*?```','',open(f).read(),flags=re.S))
    for link in re.findall(r'\]\(([^)\s]+)\)',t):
        if link.startswith('http'): continue
        path,_,anc=link.partition('#')
        tgt=os.path.normpath(os.path.join(os.path.dirname(f),path)) if path else os.path.normpath(f)
        if not os.path.exists(tgt): errs.append(f'{f}: broken link {link}'); continue
        if anc and tgt.endswith('.md') and anc not in anchors.get(tgt,set()): errs.append(f'{f}: broken anchor {link}')
# 10 crawlers
import jsonschema
sch=common['components']['schemas']['AiCrawler']; ids=set()
for c in yaml.safe_load(open('packages/contracts/data/ai-crawlers.yaml'))['crawlers']:
    try: jsonschema.validate(c,sch)
    except Exception as e: errs.append(f'crawler {c}: {e.message}')
    if c['id'] in ids: errs.append('dup crawler '+c['id'])
    ids.add(c['id'])
# 11 service docs and architecture table agree
docs={os.path.basename(f)[:-3] for f in glob.glob('docs/services/*.md')}
if docs!=set(SERVICES): errs.append(f'service docs mismatch {docs ^ set(SERVICES)}')
arch=open('docs/architecture.md').read()
rows=re.findall(r'^\| ([a-z-]+) \| ([a-z]+) \| (\d) \| \[',arch,re.M)
if {r[0] for r in rows}!=set(SERVICES): errs.append(f'architecture services table mismatch {set(r[0] for r in rows) ^ set(SERVICES)}')
for name,kind,phase in rows:
    if KIND.get(name)!=kind: errs.append(f'architecture kind {name}')
    d=open(f'docs/services/{name}.md').read() if os.path.exists(f'docs/services/{name}.md') else ''
    if f'- **Phase:** {phase}' not in d: errs.append(f'phase mismatch {name} arch={phase}')
    if f'- **Kind:** {kind}' not in d: errs.append(f'kind mismatch doc {name}')
# 12 ID prefixes unique
pre={}
for n,v in common['components']['schemas'].items():
    if n.endswith('Id') and 'pattern' in v:
        p=v['pattern'][1:5]
        if p in pre: errs.append(f'dup id prefix {p}')
        pre[p]=n
# 13 operationIds named in docs exist
IGN={'byReference','readPageResult','robotsTxt','pagesMissing','entryKey','extractionKey','includeFull','baseURL','keyVersion','languageSource','onUnsupportedLanguage','primaryFallback','cacheMode','sentimentScore','engineModel','sameAs','unevaluatedProperties','projectId','orgId','createdAt','occurredAt','idempotencyKey','causationId','fullContent','llmsTxt','brandKey','scheduledFor','nextRunAt','traceparent','maxDuration','llmsTxtFile','maxUrls','traceId','maxPages','siteUrl','respectRobotsTxt','archiveTo'}
IGN|={o for e in (yaml.safe_load(open('packages/contracts/cache/policy.yaml')).get('external') or {}).values() for o in e.get('operations',{})}
for f in glob.glob('docs/services/*.md')+['docs/architecture.md','docs/events.md']:
    for o in re.findall(r'`([a-z]+[A-Z][A-Za-z]+)`',open(f).read()):
        if o not in opids and o not in IGN: warn.append(f'{f}: `{o}` not an operationId')
# 14 kind boundaries in text: Redis only gateway; DATABASE_URL only orchestrator
for f in ['docs/conventions.md']:
    t=open(f).read()
    if '`CACHE_REDIS_URL` only in workers and the gateway' not in t or '`EDGE_REDIS_URL` only in the gateway' not in t: errs.append('conventions Redis env rule missing')
# 16 portability (ADR 0018): vendoring manifest, vendored copies in sync, hermetic tool folders
import subprocess
man=yaml.safe_load(open('packages/contracts/vendoring.yaml'))
_vs=(set(SPEC_SVCS)-set(EXTERNAL))|{'workers'}
if set(man.get('services',{}))!=_vs: errs.append(f'vendoring.yaml services {set(man.get("services",{})) ^ _vs}')
# hand-off copies of externally built services (ADR 0021): one self-contained bundle each, and workers vendor the spec
_ho=man.get('handoff') or {}
if set(_ho)!=set(EXTERNAL): errs.append(f'vendoring.yaml handoff {set(_ho) ^ set(EXTERNAL)}')
for e_ in EXTERNAL:
    fs_=(_ho.get(e_) or {}).get('files') or []
    if [(x.get('target'),x.get('from'),x.get('how')) for x in fs_]!=[(f'handoff/{e_}.openapi.yaml',f'openapi/services/{e_}.yaml','bundle')]: errs.append(f'vendoring.yaml handoff.{e_} must be one bundle to handoff/{e_}.openapi.yaml')
    if any(x.get('fromPhase',0)>0 for x in fs_): errs.append(f'vendoring.yaml handoff.{e_}: must be generated from Phase 0')
    if not any(x.get('from')==f'openapi/services/{e_}.yaml' for x in man['services'].get('workers',{}).get('files',[])): errs.append(f'vendoring.yaml: workers do not vendor {e_}')
    for s_,c_ in man['services'].items():
        if s_!='workers' and any(x.get('from')==f'openapi/services/{e_}.yaml' for x in c_.get('files',[])): errs.append(f'vendoring.yaml: {s_} vendors {e_} (only workers call it)')
    if not os.path.exists(f'packages/contracts/handoff/{e_}.openapi.yaml'): errs.append(f'packages/contracts/handoff/{e_}.openapi.yaml missing')
# ADR 0024: tool languages. `languages` names template and type generator per language; tools carry `language`.
LANG_KEYS={'ts','python','go'}
_langs=man.get('languages') or {}
if set(_langs)!=LANG_KEYS: errs.append(f'vendoring.yaml languages {sorted(_langs)} must be exactly {sorted(LANG_KEYS)} (ADR 0024)')
_gens=set(man.get('generators') or {})
for l_,c_ in _langs.items():
    c_=c_ or {}
    want_t='services/_template' if l_=='ts' else f'services/_template-{l_}'
    if c_.get('template')!=want_t: errs.append(f'vendoring.yaml languages.{l_}: template must be {want_t}')
    ty_=c_.get('types') or {}
    if ty_.get('how') not in _gens: errs.append(f'vendoring.yaml languages.{l_}: types generator {ty_.get("how")} is not in generators')
    if not str(ty_.get('target','')).startswith('contract/'): errs.append(f'vendoring.yaml languages.{l_}: types target must be under contract/')
    if not c_.get('name'): errs.append(f'vendoring.yaml languages.{l_}: name missing')
if man.get('version')!=2: errs.append('vendoring.yaml version must be 2 (language field, ADR 0024)')
for svc,cfg in man.get('services',{}).items():
    lg_=cfg.get('language')
    if svc in TOOLS:
        if lg_ not in _langs: errs.append(f'vendoring {svc}: language {lg_!r} must be one of {sorted(_langs)} (ADR 0024)')
        ty_=[e for e in cfg.get('files',[]) if e.get('how')=='types']
        if len(ty_)!=1 or ty_[0].get('from')!='./contract/openapi.yaml' or 'target' in ty_[0] or ty_[0].get('fromPhase')!=1: errs.append(f'vendoring {svc}: needs exactly one types entry from ./contract/openapi.yaml, fromPhase 1, without a target (the language sets it)')
    elif lg_ is not None: errs.append(f'vendoring {svc}: only tools have a language (platform services are TypeScript, ADR 0002)')
    for e in cfg.get('files',[]):
        if e.get('how')=='types':
            if svc not in TOOLS: errs.append(f'vendoring {svc}: types entries are for tools only')
            continue
        if not e.get('target','').startswith('contract/'): errs.append(f'vendoring {svc}: target {e.get("target")} outside contract/')
        if e['how'] not in ('bundle','copy'): errs.append(f'vendoring {svc}: unknown how {e["how"]}')
        if not e['from'].startswith('./') and not os.path.exists('packages/contracts/'+e['from']): errs.append(f'vendoring {svc}: source {e["from"]} missing')
for t in TOOLS:
    fs=man['services'].get(t,{}).get('files',[])
    if not any(e.get('target')=='contract/openapi.yaml' and e['from']==f'openapi/services/{t}.yaml' and e['how']=='bundle' and e.get('fromPhase',0)==0 for e in fs): errs.append(f'vendoring {t}: own spec not bundled into contract/openapi.yaml')
if 'content-auditor' in man['services'] and not any(e['from']=='data/ai-crawlers.yaml' for e in man['services']['content-auditor']['files']): errs.append('vendoring content-auditor: ai-crawlers.yaml not vendored')
r=subprocess.run([sys.executable,os.path.join(HERE,'vendor.py'),R,'--check','--phase',str(CURRENT_PHASE)],capture_output=True,text=True)
if r.returncode: errs+= [l for l in r.stdout.strip().split('\n') if l]
REL=re.compile(r'(?<![\w.])((?:\.\./)+)[\w./-]*')
for t in service_dirs:
    base=os.path.realpath(f'services/{t}')
    for dp,fns in scan_walk(f'services/{t}', include_hidden=True):
        for fn in fns:
            f=os.path.join(dp,fn); txt=open(f,errors='ignore').read()
            for mm in REL.finditer(txt):
                tgt=os.path.realpath(os.path.join(dp,mm.group(0)))
                if not (tgt==base or tgt.startswith(base+os.sep)): errs.append(f'{f}: reference {mm.group(0)} escapes the service folder')
            if fn=='package.json' and KIND.get(t)=='tool' or (fn=='package.json' and t=='_template'):
                pj=json.loads(txt)
                for sec in ('dependencies','devDependencies','optionalDependencies','peerDependencies'):
                    for dep,ver in (pj.get(sec) or {}).items():
                        if re.match(r'(workspace|file|link|portal):',str(ver)): errs.append(f'{f}: {dep} uses a {ver.split(":")[0]}: specifier (tools install from public registries only)')
                        if dep.startswith('@rex/'): errs.append(f'{f}: tool depends on internal package {dep}')
                if not os.path.exists(os.path.join(dp,'package-lock.json')): errs.append(f'{f}: tool has no package-lock.json next to package.json')
# 17 internal packages: only the ones justified in ADR 0019
ALLOWED_PKGS={'contracts','cache','bus'}
arch=open('docs/architecture.md').read()
lay=arch.split('```')[1]
pk=set(re.findall(r'^│   ├── ([a-z-]+)/',lay.split('├── packages/')[1].split('├── infra/')[0],re.M)) if '├── packages/' in lay else set()
pk|=set(re.findall(r'^│   └── ([a-z-]+)/',lay.split('├── packages/')[1].split('├── infra/')[0],re.M)) if '├── packages/' in lay else set()
if pk!=ALLOWED_PKGS: errs.append(f'architecture packages/ {sorted(pk)} != ADR 0019 set {sorted(ALLOWED_PKGS)}')
a19=open('docs/adr/0019-internal-packages.md').read() if os.path.exists('docs/adr/0019-internal-packages.md') else ''
for p_ in ('@rex/cache','@rex/bus'):
    if p_ not in a19: errs.append(f'ADR 0019 does not justify {p_}')
dr=open('docs/dry-rule.md').read()
if 'Portability beats DRY across tool boundaries' not in dr: errs.append('dry-rule.md lacks "Portability beats DRY across tool boundaries"')
cv=open('docs/conventions.md').read()
if 'Tools have no auth' not in cv: errs.append('conventions lacks the no-auth-in-tools rule')
for t in TOOLS:
    d=open(f'docs/services/{t}.md').read()
    if re.search(r'service token|packages/auth|JWKS',d,re.I): errs.append(f'docs/services/{t}.md: tool doc mentions tool auth')
rm=open('docs/roadmap.md').read()
# 18 roadmap: Phase 1 items each have deliverables and done criteria; Phase 2 order
p1=rm.split('## Phase 1:')[1].split('## Phase 2:')[0] if '## Phase 1:' in rm else ''
items=re.split(r'^### ',p1,flags=re.M)[1:]
if len(items)<5: errs.append(f'roadmap Phase 1 has {len(items)} items, expected 5')
for it in items:
    if 'Deliverables' not in it or 'Done when' not in it: errs.append(f'roadmap Phase 1 item "{it.splitlines()[0]}" lacks deliverables or done criteria')
p2=rm.split('## Phase 2:')[1].split('## Phase 3:')[0] if '## Phase 2:' in rm else ''
order=[m for m in re.findall(r'^\d\. `([a-z-]+)`',p2,re.M)]
if order!=['schema-generator','llms-txt-generator','content-auditor','citation-extractor','answer-analysis','engine-query']: errs.append(f'roadmap Phase 2 order {order}')
# 15 deferred decisions listed
if '## Deferred decisions' not in rm: errs.append('roadmap lacks Deferred decisions')
for k in ['PROBLEM_BASE_URI','Retry policy','SSO','lexicons beyond English','per-customer cache overrides','tenant-scoped cache']:
    if k not in rm.split('## Deferred decisions')[-1]: errs.append(f'deferred decisions lack {k}')
# 19 coding-agent onboarding: AGENTS.md entry point, per-tool AGENTS.md, thin pointers
AG='AGENTS.md'
ag=open(AG).read() if os.path.exists(AG) else ''
if not ag: errs.append('AGENTS.md missing at the repo root')
if len(ag.splitlines())>200: errs.append(f'AGENTS.md has {len(ag.splitlines())} lines (limit 200: link, do not restate)')
for h in ['## What REx is','## Hard rules','## Where to look','## Commands','### Works today','### Arrives in Phase 1','## Definition of done','## What not to touch','## Recording a decision','## When unsure']:
    if not re.search('^'+re.escape(h),ag,re.M): errs.append(f'AGENTS.md lacks section "{h}"')
hr=' '.join(ag.split('## Hard rules')[-1].split('\n## ')[0].lower().split()) if '## Hard rules' in ag else ''
for k in ['stateless','no auth, cache, bus or database','no imports outside a tool','workspace:','@rex/*','edited only in `packages/contracts`','vendored','never hand-edit generated','superseded adrs are history only','portability beats dry across tool boundaries','deterministic first','cache first']:
    if k not in hr: errs.append(f'AGENTS.md hard rules lack "{k}"')
m_=re.search(r'superseded ADRs are history\s+only\*\* \(([\d, ]+)\)',ag,re.I)
sup={f'{x.strip()}' for x in m_.group(1).split(',')} if m_ else set()
if sup!={os.path.basename(f)[:4] for f in SUPERSEDED}: errs.append(f'AGENTS.md superseded ADR list {sorted(sup)} != {sorted(os.path.basename(f)[:4] for f in SUPERSEDED)}')
for f in glob.glob('docs/adr/0*.md'):
    st=re.search(r'\*\*Status:\*\* (.*)',open(f).read()); n=os.path.basename(f)[:4]
    if st and st.group(1).startswith('Superseded') and n not in sup: errs.append(f'AGENTS.md does not list superseded ADR {n}')
m_=re.search(r'Current phase:(?:\*\*)? (\d+)',ag)  # '**Current phase: N**' or '**Current phase:** N'
if not m_ or int(m_.group(1))!=CURRENT_PHASE: errs.append(f'AGENTS.md current phase {m_.group(1) if m_ else None} != {CURRENT_PHASE}')
def blocks(sec):
    part=ag.split(sec,1)[1].split('\n#',1)[0] if sec in ag else ''
    return [l.split('#')[0].strip() for b in re.findall(r'```bash\n(.*?)```',part,re.S) for l in b.splitlines() if l.strip()]
now=blocks('### Works today'); planned=blocks('### Arrives in Phase 1')
NPX_OK={'@redocly/cli','@asyncapi/cli'}
p1txt=rm.split('## Phase 1:')[1].split('## Phase 2:')[0] if '## Phase 1:' in rm else ''
for c in now:
    tok=c.split()
    if tok[0]=='npx':
        pkg=[t for t in tok[1:] if not t.startswith('-')][0]
        mm_=re.match(r'(@?[^@]+)@(\d+\.\d+\.\d+)$',pkg)
        if not mm_: errs.append(f'AGENTS.md "works today" npx package not pinned to an exact version: {pkg}')
        elif mm_.group(1) not in NPX_OK: errs.append(f'AGENTS.md "works today" uses unknown npx package: {c}')
        for a in tok[2:]:
            if re.match(r'(packages|docs|services)/',a) and not os.path.exists(a): errs.append(f'AGENTS.md "works today" names a missing path: {a}')
    elif tok[0]=='python3':  # python3 scripts/checks/<x>.py
        if len(tok)<2 or not os.path.exists(tok[1]): errs.append(f'AGENTS.md lists as working today a command that does not exist: {c}')
    elif tok[0]=='npm':  # npm ci / npm run <script>: valid when package.json declares it
        pj_=json.load(open('package.json')) if os.path.exists('package.json') else None
        if pj_ is None: errs.append(f'AGENTS.md lists an npm command but there is no package.json: {c}')
        elif tok[1:2]==['run'] and tok[2] not in pj_.get('scripts',{}): errs.append(f'AGENTS.md lists npm script {tok[2]} that package.json lacks')
        elif tok[1:2]==['ci'] and not os.path.exists('package-lock.json'): errs.append('AGENTS.md lists npm ci but there is no package-lock.json')
        elif tok[1] not in ('ci','run'): errs.append(f'AGENTS.md "works today" uses an unexpected npm command: {c}')
    elif not os.path.exists(tok[0]): errs.append(f'AGENTS.md lists as working today a command that does not exist: {c}')
for c in planned:
    tok=c.split()
    if os.path.exists(tok[0]): errs.append(f'AGENTS.md lists as planned a command that exists now (move it to "Works today"): {tok[0]}')
    if f'`{tok[0]}' not in p1txt and tok[0] not in p1txt: errs.append(f'AGENTS.md planned command {tok[0]} is not a roadmap Phase 1 deliverable')
agent_files=([AG] if ag else [])+service_agents
for f in agent_files:
    for i,l in enumerate(open(f).read().splitlines(),1):
        for sc in [x.rstrip('.') for x in re.findall(r'scripts/[a-z0-9.-]+',l)]:
            if os.path.exists(sc): continue
            if f==AG and l.split('#')[0].strip() in planned: continue
            if not re.search(r'Phase \d|planned',l): errs.append(f'{f}:{i}: {sc} does not exist yet and the line does not say which phase brings it')
for t in TOOLS:
    if not os.path.exists(f'services/{t}/AGENTS.md'): errs.append(f'services/{t}/AGENTS.md missing (every tool has one)')
r=subprocess.run([sys.executable,os.path.join(HERE,'gen_agents.py'),R,'--check'],capture_output=True,text=True)
if r.returncode: errs+= [l for l in r.stdout.strip().split('\n') if l]
# links in .github and .cursor (dot folders are not in the md glob above)
for f in ['.github/copilot-instructions.md','CLAUDE.md']:
    if not os.path.exists(f): continue
    for link in re.findall(r'\]\(([^)\s#]+)',open(f).read()):
        if not link.startswith('http') and not os.path.exists(os.path.normpath(os.path.join(os.path.dirname(f),link))): errs.append(f'{f}: broken link {link}')
POINTERS=['CLAUDE.md','.cursor/rules/rex.mdc','.github/copilot-instructions.md']
agl={' '.join(l.split()) for l in ag.splitlines() if len(l.strip())>=30}
agw=re.findall(r'\w+',ag.lower())
agsh={' '.join(agw[i:i+8]) for i in range(len(agw)-7)}
for f in POINTERS:
    if not os.path.exists(f):
        if f!='.github/copilot-instructions.md': errs.append(f'{f} missing')
        continue
    t=open(f).read(); body=t.split('---',2)[2] if f.endswith('.mdc') and t.startswith('---') else t
    if 'AGENTS.md' not in body: errs.append(f'{f}: does not point to AGENTS.md')
    if f.endswith('.mdc') and not re.search(r'^alwaysApply: true$',t,re.M): errs.append(f'{f}: not alwaysApply')
    ne=[l for l in body.splitlines() if l.strip()]
    if len(ne)>12: errs.append(f'{f}: {len(ne)} lines; a pointer stays under 12 (rules live in AGENTS.md)')
    for l in ne:
        if ' '.join(l.split()) in agl: errs.append(f'{f}: repeats AGENTS.md line "{l.strip()[:60]}"')
    w=re.findall(r'\w+',body.lower())
    for i in range(len(w)-7):
        if ' '.join(w[i:i+8]) in agsh: errs.append(f'{f}: repeats AGENTS.md text "{" ".join(w[i:i+8])}"'); break
    for k in ['workspace:','@rex/','security: []','packages/contracts','LLM_MODE','keyVersion','npx ']:
        if k in body: errs.append(f'{f}: states rule content ({k!r}); keep rules in AGENTS.md')
# 20 onboarding review: status, ADR authority, pins, vendoring today, scripts, limits, dependencies, retries
def para_after(text,marker):
    if marker not in text: return None
    return ' '.join(text.split(marker,1)[1].split('\n\n',1)[0].split())
p0=rm.split('## Phase 0:')[1].split('\n## ')[0] if '## Phase 0:' in rm else ''
st_rm=para_after(p0,'**Status:**'); st_ag=para_after(ag,'**Status:**')
if not st_rm: errs.append('roadmap Phase 0 has no **Status:** line')
elif st_ag!=st_rm: errs.append(f'AGENTS.md status differs from roadmap Phase 0 status: {st_ag!r} vs {st_rm!r}')
# Phase 0 accepted by Jay on 2026-11-22: every non-superseded ADR is Accepted, statuses agree everywhere
ACCEPT_DATE='2026-11-22'
_adrs_={os.path.basename(f)[:4]:open(f).read() for f in glob.glob('docs/adr/0*.md') if not f.endswith('0000-template.md')}
PHASE0_LAST=23   # the last ADR accepted with Phase 0; later ADRs start Proposed (agents never accept)
for n_,t_ in sorted(_adrs_.items()):
    st_=(re.search(r'^- \*\*Status:\*\* (.*)$',t_,re.M) or [None,''])[1]
    if st_.startswith('Superseded'): continue
    if int(n_)>PHASE0_LAST:
        if not re.match(r'(Proposed|Accepted \(\d{4}-\d{2}-\d{2}, accepted by Jay\))$',st_): errs.append(f'ADR {n_}: status "{st_}" must be Proposed (or Accepted with the date and "accepted by Jay")')
        m_=re.search(r'^\| \['+n_+r'\]\([^)]*\) \| [^|]+ \| ([^|]+) \|',open('docs/adr/README.md').read(),re.M)
        if not m_ or m_.group(1).strip().split(' ')[0]!=st_.split(' ')[0]: errs.append(f'ADR index: {n_} status differs from the ADR ({st_.split(" ")[0]})')
        continue
    if not re.match(r'Accepted \((decided by Jay|'+ACCEPT_DATE+r', accepted by Jay)\)$',st_): errs.append(f'ADR {n_}: status "{st_}" must be Accepted ({ACCEPT_DATE}, accepted by Jay): Phase 0 was accepted')
    m_=re.search(r'^\| \['+n_+r'\]\([^)]*\) \| [^|]+ \| ([^|]+) \|',open('docs/adr/README.md').read(),re.M)
    if not m_ or not m_.group(1).strip().startswith('Accepted'): errs.append(f'ADR index: {n_} must be listed as Accepted')
for n_ in ('0003','0004','0005','0008'):
    if not re.search(r'^- \*\*Status:\*\* Superseded by',_adrs_.get(n_,''),re.M): errs.append(f'ADR {n_} must stay Superseded')
_acc_txt=f'accepted by Jay on {ACCEPT_DATE}'
if st_rm and 'Phase 0 (docs and contracts) was '+_acc_txt not in ' '.join(st_rm.split()): errs.append(f'roadmap Phase 0 status must say "{_acc_txt}"')
if st_rm and 'Phase 1 is open but not started' not in st_rm: errs.append('roadmap Phase 0 status must say Phase 1 is open but not started')
if f'Phase 0 accepted by Jay on {ACCEPT_DATE}' not in open('README.md').read(): errs.append('README status must say Phase 0 accepted by Jay on '+ACCEPT_DATE)
if re.search(r'awaiting Jay.s acceptance|stays? Proposed until',' '.join((open('README.md').read()+ag+rm).split())): errs.append('README, AGENTS.md or roadmap still say Phase 0 awaits acceptance')
if not re.search(r'new ADR that amends or supersedes it',' '.join(ag.split())) or 'never rewritten' not in ag: errs.append('AGENTS.md must route changes to Accepted ADRs through a new ADR that amends or supersedes it')
adr_readme=open('docs/adr/README.md').read()
if 'An **Accepted** ADR is binding as the current design and is never' not in adr_readme or 'amends or supersedes it' not in adr_readme: errs.append('docs/adr/README.md lacks the ADR authority rule (Accepted ADRs are binding, changed only by a new ADR)')
if 'Accepted ADRs (and Proposed ones Jay asked for) are binding' not in ag: errs.append('AGENTS.md lacks "Accepted ADRs ... are binding"')
# pinned npx versions, consistent everywhere; no unpinned npx of these tools in docs
pins={}
for f in [AG,'scripts/vendor-contracts-phase0.sh']+md:
    if not os.path.exists(f): continue
    t=open(f).read()
    for pk_,v in re.findall(r'(@redocly/cli|@asyncapi/cli)@(\d+\.\d+\.\d+)',t): pins.setdefault(pk_,set()).add((v,f))
    for mm_ in re.finditer(r'npx (?:-y )?(@redocly/cli|@asyncapi/cli)(?!@)',t): errs.append(f'{f}: unpinned `npx {mm_.group(1)}` (pin the version used in AGENTS.md)')
for pk_,vs in pins.items():
    if len({v for v,_ in vs})>1: errs.append(f'{pk_} pinned to different versions: {sorted(vs)}')
loc=json.load(open(os.path.join(REPO,'package.json')))['devDependencies']['@redocly/cli']  # the repo's pin (node_modules may be absent)
if pins.get('@redocly/cli') and {v for v,_ in pins['@redocly/cli']}!={loc}: errs.append(f'@redocly/cli pin {pins["@redocly/cli"]} != validated version {loc}')
if not any(re.match(r'scripts/vendor-contracts(-phase0\.sh)? --check',c) for c in now): errs.append('AGENTS.md "works today" lacks a command that checks the vendored copies')
if os.path.exists('scripts/vendor-contracts-phase0.sh') and os.environ.get('REX_SKIP_PHASE0_SCRIPT')!='1':  # skipped only by negative tests that do not touch vendoring
    r=subprocess.run(['bash','scripts/vendor-contracts-phase0.sh','--check'],capture_output=True,text=True)
    if r.returncode: errs+= ['vendor-contracts-phase0.sh --check: '+l for l in r.stdout.strip().split('\n') if l]
# every scripts/<name> mentioned anywhere exists or is planned in the roadmap
for f in md+([AG] if ag else [])+contract_yaml:
    if f in SUPERSEDED or not os.path.exists(f): continue
    for sc in set(x.rstrip('.') for x in re.findall(r'scripts/[a-z0-9.-]+[a-z0-9]',open(f).read())):
        if not os.path.exists(sc) and sc not in rm: errs.append(f'{f}: {sc} neither exists nor is planned in the roadmap')
if 'aeo-platform' in arch: errs.append('architecture.md uses the undefined name aeo-platform')
if '~/projects/REx/v3' not in arch.split('```')[1]: errs.append('architecture.md layout does not name the repo root ~/projects/REx/v3')
# x-rex-limits on every tool operation
sys.path.insert(0,HERE); import rexlib
ISO=re.compile(r'^P(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$')
def secs_(d):
    m_=re.match(r'^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$',d); a=[int(x or 0) for x in m_.groups()]
    return a[0]*86400+a[1]*3600+a[2]*60+a[3]
rows_,sw_=rexlib.approved_deps(R)
for t in TOOLS+EXTERNAL:
    sp=yaml.safe_load(open(f'packages/contracts/openapi/services/{t}.yaml'))
    uses_llm=uses_fetch=False
    for path,item in sp['paths'].items():
        for m,op in item.items():
            if not isinstance(op,dict) or 'operationId' not in op or path in ('/healthz','/readyz'): continue
            oid=op['operationId']; l=op.get('x-rex-limits')
            if not isinstance(l,dict): errs.append(f'{t} {oid}: no x-rex-limits'); continue
            bad=set(l)-{'maxDuration','p99','llm','llmCallTimeout','outboundFetch','fetchTimeout','fetchMaxBytes','notes'}
            if bad: errs.append(f'{t} {oid}: unknown x-rex-limits fields {sorted(bad)}')
            if l.get('llm') not in ('none','optional','required'): errs.append(f'{t} {oid}: x-rex-limits.llm invalid')
            if l.get('outboundFetch') not in ('none','one','several','crawl'): errs.append(f'{t} {oid}: x-rex-limits.outboundFetch invalid')
            for k in ('maxDuration','p99','llmCallTimeout','fetchTimeout'):
                if k in l and not ISO.match(str(l[k])): errs.append(f'{t} {oid}: x-rex-limits.{k} not an ISO duration')
            if l.get('llm')=='none' and 'llmCallTimeout' in l: errs.append(f'{t} {oid}: llmCallTimeout without LLM')
            if l.get('outboundFetch')=='none' and ('fetchTimeout' in l or 'fetchMaxBytes' in l): errs.append(f'{t} {oid}: fetch limits without fetches')
            uses_llm|=l.get('llm')!='none'; uses_fetch|=l.get('outboundFetch')!='none'
            if op.get('x-rex-public'):
                if l.get('llm')!='none' or l.get('outboundFetch') not in ('none','one') or l.get('p99')!='PT2S' or (l.get('outboundFetch')=='one' and (l.get('fetchTimeout')!='PT5S' or l.get('fetchMaxBytes')!=2000000)):
                    errs.append(f'{t} {oid}: public operation limits break conventions §2 (no LLM, at most one fetch PT5S/2 MB, p99 PT2S)')
            for n,u in re.findall(r'up to (\d+) (s|seconds?|minutes?)\b',op.get('description','')):
                v=int(n)*(60 if u.startswith('min') else 1)
                if v not in [secs_(l[k]) for k in ('maxDuration','llmCallTimeout') if k in l]: errs.append(f'{t} {oid}: description says up to {n} {u} but x-rex-limits says otherwise')
    if t in EXTERNAL: continue
    if uses_llm!=(t in sw_.get('--llm',[])): errs.append(f'{t}: LLM use in x-rex-limits ({uses_llm}) disagrees with the --llm switch list in conventions §16')
    if uses_fetch: errs.append(f'{t}: a tool operation declares outbound fetches; tools never touch the network besides LLM APIs (ADR 0021)')
if '--fetch' in sw_: errs.append('conventions §16 lists a --fetch template switch; tools never fetch (ADR 0021)')
# approved dependency list: single source, valid scopes, tool docs and package.json stay inside it
if not rows_: errs.append('conventions §16 has no approved tool dependency table')
for l_ in ('ts','python','go'):
    for pk_,_,sc in rexlib.approved_deps(R,l_)[0]:
        for x_ in sc.split(','):
            if x_.strip() not in {'all','--llm'}|set(TOOLS): errs.append(f'approved dependency {pk_} ({l_}): unknown scope {x_.strip()}')
allpk={p_ for p_,_,_ in rows_}
for t in TOOLS:
    ok_={p_ for p_,_,_ in rexlib.tool_packages(R,t)}
    d=open(f'docs/services/{t}.md').read()
    for p_ in allpk-ok_:
        if f'`{p_}`' in d: errs.append(f'docs/services/{t}.md names `{p_}`, which the approved list does not allow for {t}')
    pj=f'services/{t}/package.json'
    if os.path.exists(pj):
        for dep in (json.load(open(pj)).get('dependencies') or {}):
            if dep not in ok_: errs.append(f'{pj}: runtime dependency {dep} is not approved for {t} (conventions §16)')
a18=open('docs/adr/0018-tool-portability.md').read()
if '| Need | Public package' in a18: errs.append('ADR 0018 restates the package table (single source: conventions §16)')
# retries
if 'Tools never retry' not in cv: errs.append('conventions lacks "Tools never retry"')
if 'never retry' not in hr: errs.append('AGENTS.md hard rules lack "never retry"')
tm_=open('docs/agents/tool-AGENTS.md.tmpl').read()
for k in ['Never retry','## Changes outside this folder','## Rules inside this folder','{{shared}}','{{limits}}','{{packages}}']:
    if k not in tm_: errs.append(f'tool AGENTS template lacks {k}')

# 21 content extraction (ADR 0021): only workers call the external content-extractor
EXT='content-extractor'; EXTN=r'(?:content[- ]extractor|sitemap[- ]extractor|seo[- ]auditor|data[- ]aggregator)'; EXT_RE=re.compile(EXTN+r'\b',re.I)
NEG=re.compile(r'\b(never|not|no|nor|without)\b|\bonly\b.{0,40}\bworkers?\b|\bworkers?\b.{0,40}\bonly\b|\b(a|the) workers?\b[^.;]{0,80}'+EXTN,re.I)
CALLVERB=re.compile(r'\b(call|calls|calling|called|invoke|invokes|request|requests|query|queries|reach|reaches|uses?|via|through|sends?|writes?|archives?)\b[^.\n]{0,40}(?P<n>'+EXTN+r')\b|(?P<m>'+EXTN+r')\b[^.\n]{0,20}\b(client|call)\b',re.I)
def sentences(t): return [x.strip() for x in re.split(r'(?<=[.;:!?])\s+|\n\s*[-|*]\s|\n\n',' '.join(t.split('\n')) if False else t) if x.strip()]
def flat(t): return re.sub(r'\s+',' ',t)
def rd(f): return open(f).read() if os.path.exists(f) else ''
adr21=glob.glob('docs/adr/0021-*.md')
if not adr21: errs.append('ADR 0021 (content extraction) missing')
else:
    a21=open(adr21[0]).read()
    if not re.search(r'\*\*Status:\*\* Accepted \(decided by Jay\)',a21): errs.append('ADR 0021 must be Accepted (decided by Jay)')
    if 'workers' not in a21.split('\n',1)[0].lower(): errs.append('ADR 0021 title must say workers call the extractor')
    for n_ in ('0009','0013','0015','0016'):
        fa_=glob.glob(f'docs/adr/{n_}-*.md')[0]
        if not re.search(r'\*\*Amended:\*\*[^\n]*0021-content-extraction',open(fa_).read()): errs.append(f'ADR {n_} lacks its Amended line for ADR 0021')
if glob.glob('docs/adr/0020-*.md'): errs.append('ADR 0020 is reserved for the route-loader spike')
# policy: external entry, workers only
ext=pol.get('external') or {}
if set(ext)!=set(EXTERNAL): errs.append(f'policy external {set(ext) ^ set(EXTERNAL)}')
for e_,ep in ext.items():
    if ep.get('callers')!=['workers']: errs.append(f'policy external.{e_}.callers must be [workers], got {ep.get("callers")}')
    if not isinstance(ep.get('keyVersion'),int): errs.append(f'policy external.{e_}: keyVersion')
    if 'specMajor' in ep: errs.append(f'policy external.{e_}: specMajor comes from the spec info.version, not policy.yaml')
    if e_ in specs and set(ep.get('operations') or {})!={op['operationId'] for _,_,op in ops(specs[e_])}: errs.append(f'policy external.{e_}: operations differ from its spec')
    if not ep.get('operations'): errs.append(f'policy external.{e_}: no operations')
    for oid,o in (ep.get('operations') or {}).items():
        if o.get('scope') not in ('shared','tenant'): errs.append(f'policy external.{e_}.{oid}: scope')
        if not DUR.match(str(o.get('ttl',''))) or not (secs(LIM.get('minTtl','PT0S'))<=secs(o.get('ttl','PT0S'))<=secs(LIM.get('maxTtl','P9999D'))): errs.append(f'policy external.{e_}.{oid}: ttl missing or outside limits')
        if ov.get('propertyNames') and not re.match(ov['propertyNames']['pattern'],f'{e_}.{oid}'): errs.append(f'CacheDirective.overrides key pattern rejects {e_}.{oid}')
ptxt=open('packages/contracts/cache/policy.yaml').read()
if not re.search(r'extractContent:\s*\n\s*ttl: \S+\s+# DEFAULT',ptxt): errs.append('policy external content-extractor extractContent ttl must be marked DEFAULT (configurable)')
# the extractor contract: REx defines it; it returns everything workers need
xs=specs.get('content-extractor') or {}
xr=raw.get('content-extractor','')
if xs.get('security')!=[]: errs.append('content-extractor: spec must declare security: [] (reachable only from workers)')
if not re.match(r'^\d+\.\d+\.\d+$',str(xs.get('info',{}).get('version',''))): errs.append('content-extractor: info.version must be semver')
if not re.search(r'implemented in Go outside this repo',flat(xs.get('info',{}).get('description',''))): errs.append('content-extractor: spec must say it is implemented in Go outside this repo')
if set(xs.get('paths',{}))!={'/healthz','/readyz','/v1/content-extractions'}: errs.append(f'content-extractor: paths {sorted(xs.get("paths",{}))}')
for _,_,op in ops(xs):
    l=op.get('x-rex-limits') or {}
    if l.get('llm')!='none' or l.get('outboundFetch') not in ('one','several') or not all(k in l for k in ('maxDuration','fetchTimeout','fetchMaxBytes')): errs.append(f'content-extractor {op["operationId"]}: x-rex-limits must state maxDuration, fetchTimeout, fetchMaxBytes, no LLM')
    if 'DEFAULT' not in str(l.get('notes','')): errs.append(f'content-extractor {op["operationId"]}: limits must be marked DEFAULT (tunable placeholders)')
    for c_ in ('400','422','503','default'):
        if c_ not in op['responses'] or 'common.yaml#/components/responses/' not in str(op['responses'][c_]): errs.append(f'content-extractor {op["operationId"]}: response {c_} must $ref a common problem response')
    for code_ in ('target_unreachable','target_blocked','unsupported_content_type','origin_required'):
        if f'`{code_}`' not in op.get('description',''): errs.append(f'content-extractor {op["operationId"]}: 422 code {code_} not documented')
xsc=xs.get('components',{}).get('schemas',{})
if set((xsc.get('ExtractionInclude') or {}).get('enum',[]))!={'robotsTxt','llmsTxt'}: errs.append('content-extractor: include must offer exactly robotsTxt, llmsTxt (URL discovery is the sitemap-extractor\'s, ADR 0023)')
_xp=xsc.get('Extraction',{}).get('properties',{})
for k_,ref_ in (('content','ExtractedContent'),('metadata','PageMetadata'),('robotsTxt','FetchedFile'),('llmsTxt','FetchedFile')):
    if ref_ not in str(_xp.get(k_)): errs.append(f'content-extractor: Extraction.{k_} must $ref common {ref_}')
if 'FetchedPage' not in str(_xp.get('page')): errs.append('content-extractor: Extraction.page must $ref common FetchedPage (raw HTML, final URL, status, headers)')
for k_ in ('links','sitemap'):
    if k_ in _xp: errs.append(f'content-extractor: Extraction.{k_} is back (URL discovery is the sitemap-extractor\'s, ADR 0023)')
if re.search(r'\b(maxUrls|PageLink|SitemapUrls)\b',raw['content-extractor']): errs.append('content-extractor: discovery fields (maxUrls, PageLink, SitemapUrls) are back (ADR 0023)')
_rq=flat(json.dumps(xsc.get('ExtractionRequest',{})))
if not ('"required": ["url"]' in _rq and '"required": ["html"]' in _rq): errs.append('content-extractor: ExtractionRequest must take url or html')
# bus messages reuse the extractor schemas (no copies)
_ev=open('packages/contracts/asyncapi/events.yaml').read()
if not re.search(r"content-extractor\.yaml#/components/schemas/ExtractionRequest(?:'|\s*$)",_ev,re.M): errs.append('events.yaml must $ref content-extractor ExtractionRequest')
if re.search(r"content-extractor\.yaml#/components/schemas/Extraction(?:'|\s*$)",_ev,re.M): errs.append('events.yaml carries the Extraction itself; page results travel by reference (ADR 0023)')
if re.search(r'^    ContentExtraction(Request)?:',_ev,re.M): errs.append('events.yaml copies the extraction schemas; $ref content-extractor.yaml instead')
# nobody but the extractor fetches: no fetch helper, no undici, workers fetch nothing
if 'undici' in {p_ for p_,_,_ in rows_} and any(sc.strip()=='--fetch' for _,_,sc in rows_): errs.append('approved list keeps fetch-only packages')
for p_,_,sc in rows_:
    if p_=='undici': errs.append('conventions §16 still approves undici; tools never fetch')
for f in md:
    if f.startswith('services/') and '/contract/' in f: continue
    t=open(f).read()
    if re.search(r'src/fetch/|`--fetch`|MockAgent',t) and f not in ('docs/adr/0021-content-extraction.md',): errs.append(f'{f}: mentions a tool fetch helper, the --fetch switch or MockAgent (ADR 0021)')
if re.search(r'target websites|workers? fetch(es)? (the )?(page|robots)',flat(open('docs/services/workers.md').read()),re.I): errs.append('workers doc says workers fetch websites; only the content-extractor does')
# architecture: kinds table, communication, mermaid edges
kinds=re.findall(r'^\| (gateway|orchestrator|workers|tool|external) \| ([^|]+) \|[^|]*\|[^|]*\|[^|]*\| ([^\n]*)\|$',arch,re.M)
kd={k:(sv,mc) for k,sv,mc in kinds}
if set(kd)!={'gateway','orchestrator','workers','tool','external'}: errs.append(f'architecture kinds table rows {sorted(kd)}')
for e_ in EXT_ALL:
    if 'workers' in kd and e_ not in kd['workers'][1]: errs.append(f'architecture: workers "May call" must include the {e_}')
if 'external' in kd and (any(e_ not in kd['external'][0] for e_ in EXT_ALL) or not re.search(r'only by workers',kd['external'][1])): errs.append('architecture: external kind row must list content-extractor, seo-auditor and data-aggregator, called only by workers')
for k_ in ('gateway','orchestrator','tool'):
    if k_ in kd:
        for sn in re.split(r'[;.]',kd[k_][1]):
            if EXT_RE.search(sn) and not NEG.search(sn): errs.append(f'architecture: {k_} "May call" includes the content-extractor')
comm=re.findall(r'^\| ([^|]+?) -> ([^|]+?) \|',arch,re.M)
ext_rows=[(a,b) for a,b in comm if EXT_RE.search(b) or EXT_RE.search(a)]
if not ext_rows: errs.append('architecture communication table lacks Worker -> content-extractor')
for a,b in ext_rows:
    if not (a.strip().lower().startswith('worker') and EXT_RE.search(b)): errs.append(f'architecture communication: {a} -> {b} (only workers call external services)')
for e_ in EXT_ALL:
    if not any(a.strip().lower().startswith('worker') and b.strip()==e_ for a,b in ext_rows): errs.append(f'architecture communication table lacks Worker -> {e_}')
mer=arch.split('## Service map',1)[1].split('```',2)[1] if '## Service map' in arch else ''
ext_nodes=set(re.findall(r'(\w+)\["(?:content-extractor|sitemap-extractor|seo-auditor|data-aggregator)',mer))|({'content_extractor'} if 'content_extractor' in mer else set())
for src,dst in re.findall(r'^\s*(\w+)\s*-[-.]*>?\|?[^\n]*?\|?\s*(\w+)(?:\[|\(|$)',mer,re.M):
    if dst in ext_nodes and src!='workers': errs.append(f'architecture service map: {src} -> {"content-extractor" if dst=="extractor" else dst} (only workers)')
if not ext_nodes: errs.append('architecture service map lacks the content-extractor node')
# external-service URLs only in workers
_cv12=flat(open('docs/conventions.md').read())
if not all(f'`{v_}`' in _cv12 for v_ in EXT_ENV.values()) or 'exist only in workers' not in _cv12: errs.append('conventions §12 must say CONTENT_EXTRACTOR_URL, DATA_AGGREGATOR_URL and SEO_AUDITOR_URL exist only in workers')
_envok=('docs/services/workers.md','docs/architecture.md','docs/roadmap.md','docs/conventions.md','docs/dry-rule.md')+tuple(f'docs/services/{e_}.md' for e_ in EXT_ALL)+tuple(glob.glob('docs/adr/002[123]-*.md'))
for f in md+contract_yaml+[f for f in repo_files if f.startswith('services/')]:
    if f.endswith(('.png','.jpg')) or f in _envok: continue
    with open(f, 'rb') as source:
        contents = source.read()
    for e_,v_ in EXT_ENV.items():
        if v_.encode('ascii') in contents: errs.append(f'{f}: {v_} outside workers')
_wk=open('docs/services/workers.md').read()
for e_,v_ in EXT_ENV.items():
    if v_ not in _wk: errs.append(f'workers doc lacks {v_}')
    if v_ not in rd(f'docs/services/{e_}.md'): errs.append(f'docs/services/{e_}.md lacks {v_}')
# bus: orchestrator publishes, workers consume and answer
evy=yaml.safe_load(open('packages/contracts/asyncapi/events.yaml'))
want_={'content-extraction.requested':['orchestrator'],'content-extraction.completed':['workers'],'content-extraction.failed':['workers']}
got_={c.get('address'):c.get('x-rex-producers') for c in evy['channels'].values()}
for a_,w_ in want_.items():
    if got_.get(a_)!=w_: errs.append(f'{a_}: producers {got_.get(a_)} != {w_}')
topo_=yaml.safe_load(open('packages/contracts/bus/topology.yaml'))
qs_=[q for q in (topo_.get('queues') or []) if any(b.get('routingKey','').startswith('content-extraction.') for b in (q.get('bindings') or []))]
if not qs_ or any(q.get('consumer')!='workers' or [b.get('routingKey') for b in q['bindings']]!=['content-extraction.requested'] for q in qs_): errs.append('content-extraction.requested must be consumed by workers only (topology)')
# text: no tool, gateway or orchestrator text claims to call the extractor
NOCALL=[SRC(t) for t in TOOLS]+[f'services/{t}/contract/openapi.yaml' for t in TOOLS]+[f'services/{t}/AGENTS.md' for t in TOOLS]+[f'docs/services/{t}.md' for t in TOOLS+FUTURE_TOOLS]+['docs/agents/tool-AGENTS.md.tmpl',SRC('gateway'),SRC('orchestrator'),'docs/services/gateway.md','docs/services/orchestrator.md']
for f in NOCALL:
    if not os.path.exists(f): continue
    t=flat(open(f).read())
    for sn in re.split(r'(?<=[.;!?])\s+|\s-\s|\|',t):
        m_=CALLVERB.search(re.sub(r'also used by [^.]*','',sn))   # generated shared-schema lists name services, not calls
        if m_ and not NEG.search(sn): errs.append(f'{f}: claims to call the {re.sub(r"[ ]","-",(m_.group("n") or m_.group("m")).lower())}: "{sn.strip()[:90]}"')
for t in TOOLS:
    for f in (SRC(t),f'services/{t}/contract/openapi.yaml'):
        tx=open(f).read()
        if re.search(r'extractContent|CONTENT_EXTRACTOR|content-extraction',tx): errs.append(f'{f}: references the extraction job or extractor interface')
for t in TOOLS:
    for _,_,op in ops(specs[t]):
        if (op.get('x-rex-limits') or {}).get('outboundFetch')!='none': errs.append(f'{t} {op["operationId"]}: must fetch nothing (ADR 0021)')
# tool requests carry content, never a URL to fetch: a request schema whose only content field is a URL is refused
for t,o_,f_ in (('schema-generator','SchemaMarkupRequest','FromUrl'),('schema-generator','SchemaMarkupValidateRequest','FromUrl'),('llms-txt-generator','LlmsTxtValidateRequest','url')):
    if f_ in json.dumps(specs[t]['components']['schemas'].get(o_,{})) or f_ in specs[t]['components']['schemas']: errs.append(f'{t} {o_}: URL mode is back ({f_}); tools take content (ADR 0021)')
_lq=[b_ for b_ in (specs['llms-txt-generator']['components']['schemas'].get('LlmsTxtRequest',{}).get('allOf') or []) if isinstance(b_,dict) and 'properties' in b_]
if not any('pages' in b_.get('required',[]) and 'LlmsTxtEntry' in json.dumps(b_['properties'].get('pages',{})) for b_ in _lq): errs.append('llms-txt-generator LlmsTxtRequest must take the page entries (ADR 0023)')
# conventions §2: tools never touch the network; URL flows go through the orchestrator
cv_=flat(open('docs/conventions.md').read())
if 'Tools never touch the network' not in cv_ or 'every tool operation declares `outboundFetch: none`' not in cv_: errs.append('conventions §2 must say tools never touch the network (outboundFetch: none)')
if 'URL-based public flow goes through the orchestrator' not in cv_: errs.append('conventions §2 must say URL-based public flows go through the orchestrator')
if re.search(r'URL mode|Until Jay decides on them',cv_): errs.append('conventions §2 still lists URL-mode exceptions')
wk_=open('docs/services/workers.md').read()
if not re.search(r'^\| `content-extraction` \|',wk_,re.M): errs.append('workers doc flows table lacks content-extraction')
_lg=re.search(r'^\| `llms-txt-generation` \|([^\n]*)',wk_,re.M)
_lg=flat(_lg.group(1)) if _lg else ''
# page results by reference (ADR 0023): one rule in architecture, both readers link to it
BYREF='[by reference](../architecture.md#page-results-by-reference)'
_pr=arch.split('### Page results by reference',1)[1].split('\n### ',1)[0] if '### Page results by reference' in arch else ''
_prf=flat(_pr)
_rd=_prf.split('| Flow |',1)[0].split('**Read.**',1)
_rd=_rd[1] if len(_rd)>1 else ''
if not (0<=_rd.find('cache first')<_rd.find('data-aggregator')): errs.append('architecture "Page results by reference": the Read step must say cache first, then the data-aggregator (decided by Jay, ADR 0023)')
for k_ in ('PageRef','byReference','bypass','page_result_missing','pagesMissing','content-audit','llms-txt-generation','never the result'):
    if k_ not in _prf: errs.append(f'architecture "Page results by reference" lacks {k_}')
_ad=_pr.split('```mermaid',1)[1].split('```',1)[0] if '```mermaid' in _pr else ''
if 'sequenceDiagram' not in _ad or ';' in _ad: errs.append('architecture "Page results by reference": needs the audit sequenceDiagram, no semicolons in labels')
elif not (0<=_ad.find('W->>C: GET extraction by key')<_ad.find('W->>A: read by key')<_ad.find('W->>T: POST auditPage')): errs.append('architecture audit diagram: read the extraction from the cache first, then the data-aggregator, before auditPage')
if 'content-extraction.completed (PageRef' not in _ad or 'content-audit.requested (PageRef' not in _ad: errs.append('architecture audit diagram: content-extraction.completed and content-audit.requested carry the PageRef')
for f_ in ('content-audit','llms-txt-generation'):
    m_=re.search(r'^\| `'+f_+r'` \|([^\n]*)',wk_,re.M)
    if not m_ or BYREF not in m_.group(1): errs.append(f'workers doc: {f_} must read page results by reference (link the one rule, ADR 0023)')
_ca=re.search(r'^\| `content-audit` \|([^\n]*)',wk_,re.M)
if _ca and not (0<=_ca.group(1).find('by reference')<_ca.group(1).find('`validateLlmsTxt`')<_ca.group(1).find('`auditPage`')): errs.append('workers doc: content-audit reads the extraction by reference before validateLlmsTxt and auditPage')
_ce=re.search(r'^\| `content-extraction` \|([^\n]*)',wk_,re.M)
if not _ce or not all(k_ in _ce.group(1) for k_ in ('cache first','archived','`{page, cache}`','the worker only calls it')): errs.append('workers doc: content-extraction row must call extractContent cache first, archive, and report {page, cache} (the service extracts)')
for f_,need_ in (('docs/services/orchestrator.md',('page-results-by-reference','PageRef')),('docs/conventions.md',('page-results-by-reference',)),('docs/dry-rule.md',('page-results-by-reference',)),('docs/services/data-aggregator.md',('page-results-by-reference',))):
    if any(n_ not in rd(f_) for n_ in need_): errs.append(f'{f_} must link the page-results-by-reference rule')
if 'extractContent' in _lg or 'describePage' not in _lg: errs.append('workers doc: llms-txt-generation must reuse describePage results and call no extractor')
for f_,need_ in (('sitemap-discovery',('`extractSitemapUrls`','cache first')),('page-audit',('`extractContent`','`describePage`','cache first','archived'))):
    m_=re.search(r'^\| `'+f_+r'` \|([^\n]*)',wk_,re.M)
    if not m_ or any(n_ not in m_.group(1) for n_ in need_): errs.append(f'workers doc flows table: {f_} row must name {", ".join(need_)}')
_od=flat(open('docs/services/orchestrator.md').read())
for k_ in ('llms:<llmsTxtId>:discover','llms:<llmsTxtId>:page:<n>','llms:<llmsTxtId>:generate','sitemap-discovery.requested','page-audit.requested','maxPages'):
    if k_ not in _od: errs.append(f'orchestrator doc: llms.txt crawl lacks {k_}')
_lr=open('docs/roadmap.md').read()
for k_ in ('content-extractor interface:','Who fetches a page','URL modes of schema-generator'):
    if k_ in _lr: errs.append(f'roadmap still lists the decided row "{k_}"')
if not re.search(r'### 2026-11-22: REx defines the extractor contract',open(adr21[0]).read() if adr21 else ''): errs.append('ADR 0021 lacks its dated amendment (extractor contract)')

# Jay's answers of 2026-11-22 (second round): network, robots.txt, page limits, archive, seo-auditor
_a21=open(adr21[0]).read() if adr21 else ''
if not re.search(r'### 2026-11-22: private network, robots\.txt, no page cap, page archive, seo-auditor',_a21): errs.append('ADR 0021 lacks its dated amendment (private network, robots.txt, page cap, archive, seo-auditor)')
_a22=glob.glob('docs/adr/0022-*.md')
if not _a22: errs.append('ADR 0022 (page archive) missing')
else:
    _t22=open(_a22[0]).read()
    if not re.search(r'capture time',_t22.split('\n',1)[0]+_t22) or not re.search(r'evict',_t22): errs.append('ADR 0022 must decide archiving at capture time and explain why not on eviction')
    if '[0022](0022-' not in open('docs/adr/README.md').read(): errs.append('ADR README does not list 0022')
    if not re.search(r'\*\*Amended:\*\*[^\n]*0022-page-archive',open(glob.glob('docs/adr/0016-*.md')[0]).read()): errs.append('ADR 0016 lacks its Amended line for ADR 0022')
# archive rule lives in policy.yaml
_ec=((pol.get('external') or {}).get('content-extractor') or {}).get('operations',{}).get('extractContent',{})
if _ec.get('archiveTo')!='data-aggregator': errs.append('policy external content-extractor extractContent must declare archiveTo: data-aggregator (ADR 0022)')
if not any('archiveTo' in str(r_) for r_ in pol.get('storeRules') or []): errs.append('policy storeRules must make archiveTo a store condition (ADR 0022)')
if not any('archiveTo' in str(r_) and 'come only from this file' in str(r_) for r_ in (pol.get('resolution') or {}).get('rules') or []): errs.append('policy resolution rules must keep archiveTo out of overrides')
for e_ in EXTERNAL_PLANNED:
    if e_ in (pol.get('external') or {}): errs.append(f'policy external.{e_}: no entry before its interface is known')
# planned externals: a doc that lists the unknowns, no invented contract
for e_ in EXTERNAL_PLANNED:
    if os.path.exists(SRC(e_)): errs.append(f'{SRC(e_)}: contract for {e_} invented before its interface is known')
    d_=rd(f'docs/services/{e_}.md')
    if '## Not known yet' not in d_ or 'deferred-decisions' not in d_: errs.append(f'docs/services/{e_}.md must list what is not known (deferred decisions)')
    if '- **Kind:** external' not in d_: errs.append(f'docs/services/{e_}.md: kind must be external')
if 'data-aggregator' not in rd('docs/services/data-aggregator.md') or 'ADR 0022' not in rd('docs/services/data-aggregator.md'): errs.append('data-aggregator doc must link ADR 0022')
if re.search(r'structured-data-check', open('packages/contracts/asyncapi/events.yaml').read()+open('packages/contracts/bus/topology.yaml').read()): errs.append('structured-data-check is planned only: no message or queue before the seo-auditor interface is known')
if not re.search(r'^\| `structured-data-check` \|',open('docs/events.md').read(),re.M): errs.append('events.md planned messages lack structured-data-check')
if not re.search(r'^\| `content-extraction` \|[^\n]*data-aggregator',_wk,re.M): errs.append('workers doc: content-extraction flow must archive to the data-aggregator before caching')
# robots.txt: extractor option, orchestrator setting with resolution, default true
_xr=(xsc.get('ExtractionRequest') or {}).get('properties',{}).get('respectRobotsTxt') or {}
if _xr.get('type')!='boolean' or _xr.get('default') is not False: errs.append('content-extractor: ExtractionRequest.respectRobotsTxt must be a boolean, default false (REx sets it for crawls)')
for _,_,op in ops(xs):
    if '`robots_disallowed`' not in op.get('description',''): errs.append(f'content-extractor {op["operationId"]}: 422 code robots_disallowed not documented')
_xv=tuple(int(x) for x in str(xs.get('info',{}).get('version','0.0.0')).split('.')[:3])
if _xv<(2,0,0): errs.append('content-extractor: info.version must be at least 2.0.0 (discovery removed, ADR 0023)')
_osc=specs['orchestrator']['components']['schemas']
_ls=[b_ for b_ in (_osc.get('LlmsTxtSettings',{}).get('allOf') or []) if isinstance(b_,dict) and 'properties' in b_]
_lp=_ls[0]['properties'] if _ls else {}
_rr=_lp.get('respectRobotsTxt') or {}
if _rr.get('type')!='boolean' or 'default' in _rr or 'Default: true' not in flat(_rr.get('description','')): errs.append('orchestrator LlmsTxtSettings.respectRobotsTxt: boolean with no schema default (resolved: request, org setting, true)')
_mp=_lp.get('maxPages') or {}
if 'default' in _mp or 'maximum' in _mp: errs.append('orchestrator LlmsTxtSettings.maxPages: no default and no maximum (no page limit until membership tiers)')
_gj=(evy.get('components',{}).get('schemas',{}).get('LlmsTxtGenerationJob') or {}).get('properties',{}).get('pages',{})
if 'maxItems' in _gj: errs.append('events.yaml LlmsTxtGenerationJob.pages must not cap pages')
if 'maxItems' in json.dumps(_lq): errs.append('llms-txt-generator LlmsTxtRequest.pages must not cap pages (flag a needed bound instead)')
for k_ in ('respectRobotsTxt','Job settings resolution'):
    if k_ not in _od: errs.append(f'orchestrator doc lacks {k_}')
if not re.search(r'llms\.txt generation [^,;]*per\s+page',flat(arch)) or not re.search(r'sitemap discovery \d+ min, page audit \d+ min',flat(arch)): errs.append('architecture reconciler: the llms.txt generation deadline must scale per page (no page cap)')
for k_ in ('Where the content-extractor runs','honor robots.txt','URL-based schema markup flow'):
    if k_ in _lr: errs.append(f'roadmap still lists the decided row "{k_}"')
for k_ in ('| Very large llms.txt crawls','| Markdown parser for citation-extractor'):
    if k_ in _lr: errs.append(f'roadmap still lists the closed row "{k_.strip("| ")}"')
if re.search(r'PT10M|single[- ]call|in one request within',_lr): errs.append('roadmap still carries the 10-minute single-call concern (ADR 0023)')
for k_ in ('| Membership tiers','| seo-auditor interface','| data-aggregator interface','| Size limits of the llms.txt pipeline messages'):
    if k_ not in _lr: errs.append(f'roadmap deferred decisions lack "{k_.strip("| ")}"')

# 23 llms.txt pipeline (ADR 0023): event-driven, services never touch the bus, generation is LLM-free
PIPE=('sitemap-discovery','page-audit','llms-txt-generation')
for j_ in PIPE:
    if jobs.get(j_)!={'requested','completed','failed'}: errs.append(f'events.yaml: pipeline job {j_} needs requested, completed and failed')
_tq={}
for q_ in (topo_.get('queues') or []):
    for b_ in (q_.get('bindings') or []): _tq.setdefault(b_.get('routingKey'),[]).append((q_.get('name'),q_.get('consumer')))
for j_ in PIPE:
    if _tq.get(f'{j_}.requested')!=[(f'rex.workers.{j_}','workers')]: errs.append(f'topology: {j_}.requested must have exactly one queue rex.workers.{j_} consumed by workers (one queue per job)')
# no service publishes: tool and external specs declare no bus and never mention publishing
for s_ in TOOLS+EXTERNAL:
    d_=flat(specs[s_]['info'].get('description',''))
    if 'no bus' not in d_: errs.append(f'{s_}: spec description must say "no bus" (services never touch the bus)')
    for m_ in re.finditer(r'[^.]*\b(publish(es|ed|ing)?|RabbitMQ|rex\.events|outbox)\b[^.]*',flat(raw[s_])):
        if 'published by `listAnalyzers`' not in m_.group(0): errs.append(f'{s_}: spec mentions the bus ("{m_.group(0).strip()[:80]}"); services never publish')
for c_ in evy['channels'].values():
    if set(c_.get('x-rex-producers') or [])-BUS_PARTIES: errs.append(f'{c_.get("address")}: producer outside orchestrator/workers (services never publish)')
# generateLlmsTxt makes no LLM call; describePage is the only LLM operation of llms-txt-generator
_lops={op['operationId']:op for _,_,op in ops(specs['llms-txt-generator'])}
if (_lops.get('generateLlmsTxt',{}).get('x-rex-limits') or {}).get('llm')!='none': errs.append('llms-txt-generator generateLlmsTxt must declare llm: none (ADR 0023)')
_llmops=sorted(k_ for k_,o_ in _lops.items() if (o_.get('x-rex-limits') or {}).get('llm')!='none')
if _llmops!=['describePage']: errs.append(f'llms-txt-generator: only describePage may call an LLM, got {_llmops}')
if re.search(r'summarizer|"model"|PageEntryOptions|LlmUsage|usage',json.dumps(specs['llms-txt-generator']['components']['schemas'].get('LlmsTxtRequest',{}))+json.dumps(specs['llms-txt-generator']['components']['schemas'].get('LlmsTxtGeneration',{}))): errs.append('llms-txt-generator generateLlmsTxt request/response must carry no LLM options or usage')
if 'llmCallTimeout' in json.dumps(_lops.get('generateLlmsTxt',{}).get('x-rex-limits') or {}): errs.append('generateLlmsTxt: llmCallTimeout without an LLM')
# pipeline messages carry ids, URLs and cache keys, never page bodies
_evc=evy['components']
def _refs(node,seen):
    out=[]
    if isinstance(node,dict):
        for k_,v_ in node.items():
            if k_=='$ref' and isinstance(v_,str):
                out.append(v_)
                if v_.startswith('#/components/') and v_ not in seen:
                    seen.add(v_); t_=_evc
                    for part_ in v_.split('/')[2:]: t_=(t_ or {}).get(part_)
                    out+=_refs(t_,seen)
            else: out+=_refs(v_,seen)
    elif isinstance(node,list):
        for v_ in node: out+=_refs(v_,seen)
    return out
BODY=re.compile(r'/(ExtractedContent|FetchedPage|Extraction|LlmsTxtEntry|LlmsTxtPage|PageEntryResult|LlmsTxtGeneration|AuditRequest)$')
PAGEFLOW=PIPE+('content-extraction',)
for mn_,m_ in _evc['messages'].items():
    n_=m_.get('name','')
    if (n_.split('.')[0] in PAGEFLOW and n_!='llms-txt-generation.completed') or n_=='content-audit.requested':
        bad_=sorted({r_ for r_ in _refs(m_,set()) if BODY.search(r_)})
        if bad_: errs.append(f'{n_}: page-flow message carries a page body ({", ".join(bad_)})')
        if re.search(r'FetchedFile', json.dumps(m_.get('payload'))): errs.append(f'{n_}: page-flow message carries a site file')
_ltc=[m_ for m_ in _evc['messages'].values() if m_.get('name')=='llms-txt-generation.completed']
if not _ltc or 'pagesMissing' not in json.dumps(_ltc[0]): errs.append('llms-txt-generation.completed must report pagesMissing')
if 'key' not in (common['components']['schemas'].get('ToolCallCache',{}).get('properties') or {}): errs.append('common ToolCallCache must carry the cache key (messages carry keys)')
_sc=_evc.get('schemas') or {}
_pg=_sc.get('PageRef') or {}
if set(_pg.get('required') or [])!={'url','extractionKey'} or not {'url','extractionKey','entryKey'}<=set((_pg.get('properties') or {})): errs.append('events.yaml PageRef must carry url and extractionKey (required) and entryKey')
_prr=json.dumps(_sc.get('PageResultRef',{}))
if '#/components/schemas/PageRef' not in _prr or 'entryKey' not in _prr or 'properties' in (_sc.get('PageResultRef') or {}): errs.append('events.yaml PageResultRef must be a PageRef that requires entryKey (one page reference, ADR 0023)')
_PR={'content-extraction.completed':'PageRef','page-audit.completed':'PageResultRef'}
for m_ in _evc['messages'].values():
    w_=_PR.get(m_.get('name'))
    if w_:
        d_=((m_.get('payload') or {}).get('allOf') or [{},{}])[1].get('properties',{}).get('data',{})
        if (d_.get('properties') or {}).get('page',{}).get('$ref')!=f'#/components/schemas/{w_}' or 'page' not in (d_.get('required') or []): errs.append(f'{m_.get("name")}: data.page must be a required {w_}')
_aj=json.dumps(_sc.get('AuditJob') or {})
if '#/components/schemas/PageRef' not in _aj or 'AuditOptions' not in _aj: errs.append('events.yaml AuditJob must carry page (PageRef) and the audit options')
for m_ in _evc['messages'].values():
    if m_.get('name')=='content-audit.requested' and 'AuditJob' not in json.dumps(m_): errs.append('content-audit.requested must carry an AuditJob (by reference)')
    if m_.get('name') in ('content-extraction.requested','page-audit.requested') and 'PageExtractionRequest' not in json.dumps(_refs(m_,set())): errs.append(f'{m_.get("name")}: the extraction request must be a PageExtractionRequest (by url)')
if 'url' not in json.dumps((_sc.get('PageExtractionRequest') or {}).get('allOf',[{},{}])[-1].get('required',[])): errs.append('events.yaml PageExtractionRequest must require url')
_br=(yaml.safe_load(ptxt) or {}).get('byReference') or []
if sorted(_br)!=['content-extractor.extractContent','llms-txt-generator.describePage']: errs.append(f'policy.yaml byReference must list content-extractor.extractContent and llms-txt-generator.describePage, got {_br}')
# cache policy: sitemap URL lists and page entries, shared, TTL DEFAULT (per customer), entries archived
_pol=yaml.safe_load(ptxt)
_dp=(((_pol.get('tools') or {}).get('llms-txt-generator') or {}).get('operations') or {}).get('describePage') or {}
if _dp.get('scope')!='shared' or _dp.get('archiveTo')!='data-aggregator' or not re.search(r'describePage:\s*\{[^}]*\}\s*# DEFAULT',ptxt): errs.append('policy: llms-txt-generator describePage must be shared, archiveTo data-aggregator, ttl DEFAULT')
_se=((_pol.get('external') or {}).get('sitemap-extractor') or {})
_sx=(_se.get('operations') or {}).get('extractSitemapUrls') or {}
if _se.get('callers')!=['workers'] or _sx.get('scope')!='shared' or not re.search(r'extractSitemapUrls:[^\n]*\n?[^\n]*ttl: \S+\s+# DEFAULT',ptxt): errs.append('policy: external sitemap-extractor extractSitemapUrls must be workers-only, shared, ttl DEFAULT')
# ADRs: 0023 Proposed with Jay's decisions marked; 0021 the only Accepted; 0020 reserved
a23=glob.glob('docs/adr/0023-*.md'); _a23=rd(a23[0]) if a23 else ''
if not re.search(r'\*\*Status:\*\* Accepted',_a23) or 'Decided by Jay' not in _a23: errs.append('ADR 0023 must exist, be Accepted and mark the decisions by Jay')
if _a23.count('**Design details (accepted by Jay, 2026-11-22):**')!=2 or 'Design details (Proposed)' in _a23: errs.append('ADR 0023: both design-details sections must be marked accepted by Jay (2026-11-22)')
if '0023' not in rd('docs/adr/README.md'): errs.append('ADR README lacks 0023')
if glob.glob('docs/adr/0020-*.md'): errs.append('ADR 0020 is reserved')
if not re.search(r'### 2026-11-22: llms\.txt pipeline and the sitemap-extractor \(decided by Jay\)',_a21): errs.append('ADR 0021 lacks the pipeline amendment')
if 'Read back (decided by Jay' not in rd((glob.glob('docs/adr/0022-*.md') or ['-'])[0]): errs.append('ADR 0022 lacks the read-back decision')
# architecture: pipeline section with a mermaid sequence diagram, no semicolons in labels
_ps=arch.split('### llms.txt pipeline',1)
_sd=_ps[1].split('```mermaid',1)[1].split('```',1)[0] if len(_ps)>1 and '```mermaid' in _ps[1] else ''
if 'sequenceDiagram' not in _sd: errs.append('architecture: "llms.txt pipeline" section needs a mermaid sequenceDiagram')
if ';' in _sd: errs.append('architecture pipeline diagram: no semicolons in labels')
for k_ in ('sitemap-discovery.requested','page-audit.requested','llms-txt-generation.requested','data-aggregator','page-entries'):
    if k_ not in _sd: errs.append(f'architecture pipeline diagram lacks {k_}')
_sdl=[l_ for l_ in _sd.split('\n') if 'W->>C: GET entry' in l_ or 'W->>A: read' in l_]
if len(_sdl)!=2 or _sd.find('W->>C: GET entry')>_sd.find('W->>A: read'): errs.append('architecture pipeline diagram: generation reads the cache first, then the data-aggregator')
# marked: approved for citation-extractor, deferred row closed
if not re.search(r'^\| `marked` \|[^\n]*\| citation-extractor \|',rd('docs/conventions.md'),re.M): errs.append('conventions §16 must list marked for citation-extractor')
# orchestrator resource reports the stage and page counts
_lt=specs['orchestrator']['components']['schemas'].get('LlmsTxt',{})
_ltj=json.dumps(_lt)
if not all(k_ in _ltj for k_ in ('"stage"','discovering','auditing','generating','"selected"','"audited"','"failed"')): errs.append('orchestrator LlmsTxt must report stage and pages {selected, audited, failed}')

# ADR 0023 amendment (2026-11-22): audits by reference; sitemap-extractor deployment is the implementer's choice
if not re.search(r'^- \*\*Amended:\*\* 2026-11-22, at Jay.s request: audits',_a23,re.M) or not re.search(r'### 2026-11-22: audits by reference, sitemap-extractor deployment \(decided by Jay\)',_a23): errs.append('ADR 0023 lacks the dated amendment (audits by reference, sitemap-extractor deployment; decided by Jay)')
_sxd=flat(specs['sitemap-extractor']['info'].get('description',''))+' '+flat(rd('docs/services/sitemap-extractor.md'))
if _sxd.count("implementer's choice")<2 or re.search(r'may ship as|possibly (as )?an? (second )?endpoint',_sxd+flat(rd('docs/glossary.md'))+flat(_lr)): errs.append("sitemap-extractor deployment must be the implementer's choice (spec and doc), not an open possibility")
if re.search(r'^\| sitemap-extractor deployment',_lr,re.M|re.I): errs.append('roadmap still lists the closed row "sitemap-extractor deployment"')
# wording: services fetch and extract; workers only call them
_WP=re.compile(r"\bworkers?'?s?\b[^.\n|;:]{0,20}?\b(extracts?|extracting|extracted|fetch|fetches|fetching|fetched|crawls?)\b",re.I)
_WN=re.compile(r"\b(never|not|no|nor|only call|only makes|without|instead)\b",re.I)
_wf=[f_ for f_ in md if f_.startswith('docs/') and (not f_.startswith('docs/adr/') or re.match(r'docs/adr/002[23]-',f_))]+['AGENTS.md','README.md']+contract_yaml+service_agents
for f_ in _wf:
    for sn in re.split(r'(?<=[.;!?])\s+|\s-\s|\|',flat(rd(f_))):
        if _WP.search(sn) and not _WN.search(sn): errs.append(f'{f_}: says a worker extracts or fetches ("{sn.strip()[:80]}"); the service does, the worker only calls it')

# ADR enumerations match docs/adr (roadmap range, status sentences, README, index)
_adrn=sorted({int(os.path.basename(f_)[:4]) for f_ in glob.glob('docs/adr/[0-9][0-9][0-9][0-9]-*.md')}-{0})
_sup=sorted(int(os.path.basename(f_)[:4]) for f_ in glob.glob('docs/adr/0*.md') if re.search(r'\*\*Status:\*\* Superseded',rd(f_)))
_rm=re.search(r'\[ADRs (\d{4}) to (\d{4})\]\(adr/README\.md\) \(0020 is reserved',flat(rd('docs/roadmap.md')))
_p0n=[n_ for n_ in _adrn if n_<=PHASE0_LAST]; _later=[n_ for n_ in _adrn if n_>PHASE0_LAST]
if not _rm: errs.append('roadmap Phase 0 must list "[ADRs NNNN to NNNN](adr/README.md) (0020 is reserved ..."')
else:
    _want=[n_ for n_ in range(int(_rm.group(1)),int(_rm.group(2))+1) if n_!=20]
    if _want!=_p0n: errs.append(f'roadmap ADR range {_rm.group(1)} to {_rm.group(2)} does not match the Phase 0 ADRs in docs/adr ({_p0n[0]:04d} to {_p0n[-1]:04d}, missing or extra: {sorted(set(_want)^set(_p0n))})')
if 20 in _adrn: errs.append('ADR 0020 is reserved')
_last=f'{PHASE0_LAST:04d}'
_rd_st=(re.search(r'\*\*Status: Phase 0.*?(?=\n\n)',rd('README.md'),re.S) or [''])[0]
_sts=(('docs/roadmap.md',st_rm or ''),('AGENTS.md',st_ag or ''),('README.md',_rd_st))
for f_,t_ in _sts:
    m_=re.search(r'ADRs? \(?(\d{4})\s+to\s+(\d{4})',flat(t_))
    if not m_ or m_.group(2)!=_last: errs.append(f'{f_}: the Phase 0 status must name ADRs 0001 to {_last}')
    for n_ in _later:
        if f'ADR {n_:04d}' not in flat(t_): errs.append(f'{f_}: the status must name ADR {n_:04d} (after Phase 0, with its status)')
for n_ in _later:
    if not re.search(rf'\(adr/{n_:04d}-',rd('docs/roadmap.md')): errs.append(f'roadmap does not link ADR {n_:04d}')
_supt=', '.join(f'{n_:04d}' for n_ in _sup[:-1])+f' and {_sup[-1]:04d}' if _sup else ''
for f_,t_ in _sts:
    if _supt and _supt not in flat(t_): errs.append(f'{f_}: the Phase 0 status must name the superseded ADRs ({_supt})')
_idx=rd('docs/adr/README.md')
_rows=sorted(int(x_) for x_ in re.findall(r'^\| \[(\d{4})\]\(\1-',_idx,re.M))
if _rows!=_adrn: errs.append(f'ADR index rows {sorted(set(_rows)^set(_adrn))} out of sync with docs/adr')
_dec=re.search(r'\*\*Decisions:\*\*([^\n]*)',rd('README.md'))
_decn=sorted(int(x_) for x_ in re.findall(r'(?:: |· )(\d{4}) ',_dec.group(1).split(' (0003',1)[0])) if _dec else []
if sorted(set(_adrn)-set(_sup))!=_decn: errs.append(f'README Decisions list {_decn} must name every current ADR {sorted(set(_adrn)-set(_sup))}')
_ph0=flat(rd('docs/roadmap.md')).split('## Phase 0',1)[-1].split('## Phase 1',1)[0]
for e_ in EXT_ALL:
    if f'services/{e_}.md' not in _ph0: errs.append(f'roadmap Phase 0 deliverables must mention the {e_} doc')

# ADR 0024: per-tool implementation language (Proposed, at Jay's request)
_a24p=glob.glob('docs/adr/0024-*.md'); _a24=rd(_a24p[0]) if _a24p else ''
if not _a24: errs.append('ADR 0024 (per-tool implementation language) missing')
else:
    if not re.search(r'^- \*\*Status:\*\* Accepted \(2026-11-22, accepted by Jay\)$',_a24,re.M): errs.append('ADR 0024 must be Accepted (2026-11-22, accepted by Jay)')
    if not re.search(r'^- \*\*Edited before acceptance:\*\* 2026-11-22',_a24,re.M): errs.append('ADR 0024 must record the edit made before acceptance (engine-query, approved choices)')
    for k_ in ('engine-query stays TypeScript','ai-traffic-analyzer in Phase 7','uv (`uv.lock`)','openapi-core with FastAPI','kin-openapi as the Go request validator','5 ms for Python','1 ms for TypeScript and Go','right before each tool\'s step','One language ADR per tool, TypeScript tools included'):
        if k_ not in flat(_a24.split('**Design (accepted by Jay')[0]): errs.append(f'ADR 0024 lacks Jay\'s decision "{k_}" (Decided by Jay)')
    if '**Design (accepted by Jay, 2026-11-22):**' not in _a24: errs.append('ADR 0024 design section must be marked accepted by Jay (2026-11-22)')
    if '**Spike**' in _a24 or 'Proposed with this ADR' in _a24: errs.append('ADR 0024 still has markers that only waited on Jay\'s choice')
    if '**Decided by Jay:**' not in _a24: errs.append('ADR 0024 must mark what Jay decided ("Decided by Jay")')
    for k_ in ('RFC 9457','/healthz','LLM_MODE','no auth','never retries','lockfile','Dockerfile','portability job','vendored'):
        if k_ not in flat(_a24): errs.append(f'ADR 0024 lacks the language-neutral rule "{k_}"')
    if '| Package | Purpose' in _a24: errs.append('ADR 0024 restates the package table (single source: conventions §16)')
    _hdr=(re.search(r'^\| Rule \|(.*)\|$',_a24,re.M) or [None,''])[1]
    for l_,c_ in _langs.items():
        if f'{(c_ or {}).get("name")} (`{l_}`)' not in _hdr: errs.append(f'ADR 0024 equivalents table lacks a column for {l_}')
    _rows24=re.findall(r'^\| [^|`]+ \|( [^|]+ \|){3}$',_a24.split('| Rule |',1)[-1].split('\n\n',1)[0],re.M)
    if len(_rows24)<12: errs.append(f'ADR 0024 equivalents table has {len(_rows24)} rules, expected at least 12')
    _prop=rexlib.proposed_languages(R)
    _tooldocs=sorted(os.path.basename(f_)[:-3] for f_ in glob.glob('docs/services/*.md') if re.search(r'^- \*\*Kind:\*\* tool ',rd(f_),re.M))
    if sorted(_prop)!=_tooldocs: errs.append(f'ADR 0024 language table {sorted(set(_prop)^set(_tooldocs))} out of sync with the tool docs')
    _names={(c_ or {}).get('name'):l_ for l_,c_ in _langs.items()}
    for t_,(ph_,ln_,why_,mk_) in _prop.items():
        if ln_ not in _names: errs.append(f'ADR 0024: {t_} proposes {ln_}, not a language in vendoring.yaml')
        if ln_=='Go' and t_!='ai-traffic-analyzer': errs.append(f'ADR 0024: {t_} in Go; Jay decided Go starts with ai-traffic-analyzer (Phase 7)')
    if _prop.get('engine-query',('','',None,''))[1::2]!=('TypeScript','Decided by Jay'): errs.append('ADR 0024: engine-query must be TypeScript (Decided by Jay)')
    if len(re.findall(r'^\| `[a-z-]+` \| \d \| \w+ \| ',_a24,re.M)): errs.append('ADR 0024: every proposed language must be marked (Proposed)')
    if "own tool ADR at the start of the tool's Phase 2 step" not in flat(_a24): errs.append('ADR 0024: each proposed language needs its own tool ADR at the start of its Phase 2 step')
    if 'ADR 0020' not in _a24 or 'A Python spike' not in flat(_a24) or 'a Go spike' not in flat(_a24): errs.append('ADR 0024 must keep the TypeScript spike as ADR 0020 and add the Python and Go spikes')
for n_,why_ in (('0001','npm'),('0002','TypeScript'),('0006','generated per language'),('0007','per language'),('0018','project in its language'),('0019','every language')):
    f_=glob.glob(f'docs/adr/{n_}-*.md'); t_=rd(f_[0]) if f_ else ''
    head_=t_.split('\n## ',1)[0]
    if not re.search(r'^- \*\*Amended by:\*\* \[0024\]\(0024-per-tool-language\.md\), 2026-11-22 \(accepted by Jay\): .*'+re.escape(why_),head_,re.M): errs.append(f'ADR {n_} lacks its dated "Amended by: [0024]" header line ({why_})')
    if re.search(r'^- \*\*Status:\*\* (?!Accepted)',head_,re.M): errs.append(f'ADR {n_}: status changed (agents never change statuses)')
# conventions §16: one approved table per language; Python and Go tables Proposed until their spikes are accepted
_secs,_=rexlib.approved_sections(R)
if set(_secs)!=set(_langs): errs.append(f'conventions §16 approved tables {sorted(_secs)} != languages {sorted(_langs)}')
for l_ in ('python','go'):
    if 'Approved by Jay with [ADR 0024]' not in _secs.get(l_,'') or 'spike is still a gate' not in flat(_secs.get(l_,'')): errs.append(f'conventions §16 {l_} table must say it is approved by Jay with ADR 0024 and gated by its spike')
    if 'Proposed' in _secs.get(l_,''): errs.append(f'conventions §16 {l_} table still marked Proposed')
for l_,pk_ in (('ts','ajv'),('python','openapi-core'),('go','github.com/getkin/kin-openapi')):
    if pk_ not in {p_ for p_,_,_ in rexlib.approved_deps(R,l_)[0]}: errs.append(f'conventions §16 {l_} table lacks the spec validator {pk_}')
_s16=rd('docs/conventions.md').split('## 16. Tool portability',1)[-1].split('### Approved',1)[0]
for k_ in ('package-lock.json','uv.lock','go.sum','replace','editable'):
    if k_ not in _s16: errs.append(f'conventions §16 rules lack "{k_}" (every tool language)')
# tool AGENTS template: one block per language for each language-specific part
_tm=rd('docs/agents/tool-AGENTS.md.tmpl')
_bl={l_:len(re.findall(r'\{\{#lang '+l_+r'\}\}',_tm)) for l_ in _langs}
if len(set(_bl.values()))!=1 or not min(_bl.values() or [0]): errs.append(f'tool-AGENTS template language blocks uneven or missing: {_bl}')
if re.findall(r'\{\{#lang (\w+)\}\}',_tm) and set(re.findall(r'\{\{#lang (\w+)\}\}',_tm))-set(_langs): errs.append('tool-AGENTS template has a block for an unknown language')
for t_ in TOOLS:
    if '## Language' not in rd(f'services/{t_}/AGENTS.md'): errs.append(f'services/{t_}/AGENTS.md lacks its Language section')
# architecture: a layout per language and the deferred templates in the repo layout
_ar=rd('docs/architecture.md')
for l_,c_ in _langs.items():
    if f'{(c_ or {}).get("name")} (`{l_}`' not in _ar: errs.append(f'architecture lacks the {l_} tool layout')
    if f'{(c_ or {}).get("template")}/' .replace('services/','') not in _ar: errs.append(f'architecture repo layout lacks {(c_ or {}).get("template")}')
# roadmap: Phase 1 covers the three languages; Phase 2 says when each bring-up runs
_p1=flat(rm.split('## Phase 1:')[1].split('## Phase 2:')[0]) if '## Phase 1:' in rm else ''
for k_ in ('adr/0024-per-tool-language.md','--lang ts|python|go','openapi-typescript','datamodel-code-generator','oapi-codegen','dependency-cruiser','import-linter','depguard','jscpd','_template-python','_template-go','ADR 0020','portability','dev-only'):
    if k_ not in _p1: errs.append(f'roadmap Phase 1 lacks "{k_}" (ADR 0024)')
if not re.search(r'### 1\.3 Spikes',rm): errs.append('roadmap 1.3 must hold the spikes for every language')
for l_ in ('Python','Go'):
    if f'**{l_} (time-boxed' not in rm: errs.append(f'roadmap 1.3 lacks the time-boxed {l_} spike')
_p2=flat(rm.split('## Phase 2:')[1].split('## Phase 3:')[0]) if '## Phase 2:' in rm else ''
for k_ in ('Python bring-up','language ADR','accepted by Jay','The Go bring-up waits for Phase 7','right before step 5'):
    if k_ not in _p2: errs.append(f'roadmap Phase 2 lacks "{k_}"')
if '_template-go' in _p2 or 'Go bring-up starts' in _p2: errs.append('roadmap Phase 2 schedules the Go bring-up; it moved to Phase 7 (Jay)')
_p2steps=re.findall(r'^\d\. `([a-z-]+)`: (.*)$',rm.split('## Phase 2:')[1].split('## Phase 3:')[0],re.M) if '## Phase 2:' in rm else []
for t_,tx_ in _p2steps:
    if not tx_.startswith('language ADR ('): errs.append(f'roadmap Phase 2 step {t_} must open with its language ADR')
    if t_=='engine-query' and not tx_.startswith('language ADR (TypeScript'): errs.append('roadmap Phase 2: engine-query is TypeScript (Jay)')
_p7=flat(rm.split('## Phase 7:')[1].split('\n## ')[0]) if '## Phase 7:' in rm else ''
if '**Go bring-up** before `ai-traffic-analyzer`' not in _p7: errs.append('roadmap Phase 7 lacks the Go bring-up before ai-traffic-analyzer')
if "within Jay's budgets on CI hardware (1 ms for TypeScript and Go, 5 ms for Python" not in flat(rm): errs.append('roadmap 1.3 must state Jay\'s validation budgets (1 ms TS/Go, 5 ms Python)')
if 'Each spike is a gate' not in flat(rm): errs.append('roadmap 1.3 must keep the spikes as gates')
if 'ADR 0024 (per-tool implementation language, accepted by Jay on 2026-11-22)' not in flat(st_rm or ''): errs.append('roadmap and AGENTS status must say ADR 0024 was accepted by Jay on 2026-11-22')
# AGENTS.md: new-tool takes --lang; no fetch switch
if '--lang ts|python|go' not in ag: errs.append('AGENTS.md: scripts/new-tool must take --lang ts|python|go')
if '--fetch' in ag: errs.append('AGENTS.md still lists a --fetch switch (tools never fetch)')
if 'adr/0024-per-tool-language.md' not in ag: errs.append('AGENTS.md task map must link ADR 0024')
if 'gets a language ADR at the start of its step, accepted by Jay' not in flat(ag): errs.append('AGENTS.md must require a language ADR per tool (TypeScript included), accepted by Jay')
_rdme=flat(rd('README.md'))
if 'ADR 0024 (accepted by Jay on 2026-11-22)' not in _rdme: errs.append('README status must say ADR 0024 was accepted by Jay on 2026-11-22')
# tool folders: manifest matches the tool's language, and language-specific hermetic rules
_mf={'ts':'package.json','python':'pyproject.toml','go':'go.mod'}
for t_ in TOOLS:
    lg_=(man['services'].get(t_) or {}).get('language')
    for l_,f_ in _mf.items():
        p_=f'services/{t_}/{f_}'
        if not os.path.exists(p_): continue
        if l_!=lg_: errs.append(f'{p_}: a {l_} manifest, but vendoring.yaml says language {lg_}')
        tx_=rd(p_)
        if l_=='python':
            if re.search(r'\b(path|git|editable)\s*=',tx_): errs.append(f'{p_}: path, git or editable source (public PyPI only)')
            for dep_ in re.findall(r'^\s*"([A-Za-z0-9_.\-\[\]]+)\s*([<>=!~]=?[^"]*)?"',tx_,re.M):
                if dep_[1] and not dep_[1].startswith('=='): errs.append(f'{p_}: {dep_[0]} is not pinned with ==')
            if not os.path.exists(f'services/{t_}/uv.lock'): errs.append(f'{p_}: no uv.lock next to it')
        if l_=='go':
            if re.search(r'^\s*replace\b',tx_,re.M): errs.append(f'{p_}: replace directive (public modules only)')
            if not os.path.exists(f'services/{t_}/go.sum'): errs.append(f'{p_}: no go.sum next to it')

print('ERRORS',len(errs)); [print(' -',e) for e in errs]
print('WARN',len(warn)); [print(' -',w) for w in sorted(set(warn))]
sys.exit(1 if errs else 0)
