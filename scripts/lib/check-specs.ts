import {
  commonFile,
  contractsDir,
  nodes,
  operations,
  policyFile,
  read,
  resolver,
  serviceDoc,
  type Document,
} from "./contracts.js";

export type Report = (rule: string, file: string, message: string) => void;
type Spec = { file: string; spec: Document; name: string; kind: string };
const health = new Set(["/healthz", "/readyz"]);
const commonRef = (category: string, name: string) =>
  "../common.yaml#/components/" + category + "/" + name;

export function duration(value: unknown): number {
  const parts =
    typeof value === "string" &&
    /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!parts || !parts.slice(1).some(Boolean)) return NaN;
  return parts
    .slice(1)
    .reduce((seconds, part, i) => seconds + Number(part ?? 0) * [86400, 3600, 60, 1][i], 0);
}

function refsFrom(value: Document) {
  return [...nodes(value)].flatMap(([node]) => (typeof node.$ref === "string" ? [node.$ref] : []));
}

function normalizeSchema(value: any): any {
  const annotations = new Set(["title", "description", "$comment", "example", "examples"]);
  if (Array.isArray(value)) return value.map(normalizeSchema);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => !annotations.has(key) && !key.startsWith("x-"))
        .map((key) => [
          key,
          key === "required" && Array.isArray(value[key])
            ? [...value[key]].sort()
            : normalizeSchema(value[key]),
        ]),
    );
  return value;
}

function schemaPointers(
  start: { file: string; value: Document } | undefined,
  path: string[],
  lookup: ReturnType<typeof resolver>,
  accepts = (_schema: Document) => true,
): boolean {
  if (!start?.value) return false;
  if (!path.length && accepts(start.value)) return true;
  const { file, value } = start;
  const [head, ...tail] = path;
  const child =
    head === undefined
      ? undefined
      : (value.properties?.[head] ?? (/^(?:\*|\d+)$/.test(head) ? value.items : undefined));
  return (
    (child && schemaPointers({ file, value: child }, tail, lookup, accepts)) ||
    (value.$ref && schemaPointers(lookup(file, value.$ref), path, lookup, accepts)) ||
    ["allOf", "oneOf", "anyOf"].some((key) =>
      value[key]?.some((option: Document) =>
        schemaPointers({ file, value: option }, path, lookup, accepts),
      ),
    )
  );
}

function requiredUrl(
  file: string,
  schema: Document | undefined,
  pointer: string,
  lookup: ReturnType<typeof resolver>,
): boolean {
  const path = pointer
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  function visit(
    current: { file: string; value: Document } | undefined,
    index: number,
    seen: ReadonlySet<string>,
  ): boolean {
    if (!current?.value) return false;
    const { file, value } = current;
    const ref = value.$ref;
    const referenced = ref ? lookup(file, ref) : undefined;
    if (index === path.length)
      return referenced?.file === commonFile && ref.endsWith("#/components/schemas/Url");

    const key = path[index];
    // A required branch in allOf constrains every instance. Optional branches
    // in anyOf or oneOf cannot promise that the field is always present.
    if (value.required?.includes(key) && Object.hasOwn(value.properties ?? {}, key))
      if (visit({ file, value: value.properties[key] }, index + 1, new Set())) return true;

    const identity = file + ":" + ref;
    return (
      (referenced !== undefined &&
        !seen.has(identity) &&
        visit(referenced, index, new Set([...seen, identity]))) ||
      (value.allOf?.some((option: Document) => visit({ file, value: option }, index, seen)) ??
        false)
    );
  }
  return schema !== undefined && visit({ file, value: schema }, 0, new Set());
}

function checkRawUrlKeyInputs(
  service: string,
  id: string,
  entry: Document,
  request: Document | undefined,
  file: string,
  lookup: ReturnType<typeof resolver>,
  report: Report,
) {
  const mapping = entry.rawUrlKeyInputs;
  const crawler = service === "content-auditor" && id === "checkCrawlerAccess";
  const pageEntry = service === "llms-txt-generator" && id === "describePage";
  const problem = (message: string) =>
    report("cache-policy", policyFile, service + "." + id + ": rawUrlKeyInputs " + message);
  if (!Object.hasOwn(entry, "rawUrlKeyInputs") && !crawler && !pageEntry) return;
  if (
    !mapping ||
    typeof mapping !== "object" ||
    Array.isArray(mapping) ||
    !Object.keys(mapping).length
  ) {
    problem("must be a nonempty mapping");
    return;
  }
  if (
    crawler &&
    (mapping.siteUrl !== "/siteUrl" ||
      mapping.robotsTxtUrl !== "/robotsTxt/url" ||
      Object.keys(mapping).length !== 2)
  )
    problem("must map siteUrl to /siteUrl and robotsTxtUrl to /robotsTxt/url");
  if (pageEntry && (mapping.url !== "/url" || Object.keys(mapping).length !== 1))
    problem("must map url to /url");
  const targets = new Set<string>();
  for (const [alias, pointer] of Object.entries(mapping)) {
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(alias) || entry.extraKeyInputs?.includes(alias))
      problem("has an invalid or conflicting alias " + alias);
    if (
      typeof pointer !== "string" ||
      !/^(?:\/(?:[^/~]|~[01])+)+$/.test(pointer) ||
      !requiredUrl(file, request, pointer, lookup)
    ) {
      problem("must target a required shared Url at " + String(pointer));
    } else if (targets.has(pointer)) {
      problem("repeats target " + pointer);
    } else targets.add(pointer);
  }
}

function checkPolicy(all: Spec[], common: Document, policy: Document, report: Report) {
  const file = policyFile;
  const lookup = resolver();
  const limits = policy.resolution?.limits;
  const scopes = Object.keys(policy.scopes ?? {}).sort();
  if (scopes.join() !== [...common.components.schemas.CacheScope.enum].sort().join()) {
    report("cache-policy", file, "scopes differ from CacheScope in " + commonFile);
  }
  if (
    !limits ||
    !policy.resolution?.order?.length ||
    !policy.resolution?.layers ||
    policy.resolution.order.some((layer: string) => !policy.resolution.layers[layer]) ||
    !(duration(limits.minTtl) > 0 && duration(limits.maxTtl) >= duration(limits.minTtl)) ||
    !limits.windows?.length ||
    limits.windows.some((window: string) => !(duration(window) > 0))
  ) {
    report("cache-policy", file, "invalid or missing resolution or limits");
  }
  const enablement = { tool: policy.tools, external: policy.external };
  for (const [kind, block] of Object.entries(enablement)) {
    for (const name of new Set([
      ...Object.keys(block ?? {}),
      ...all.filter((entry) => entry.kind === kind).map((entry) => entry.name),
    ])) {
      const owner = all.find((entry) => entry.name === name && entry.kind === kind);
      const config = block?.[name];
      if (!owner || !config || !Number.isInteger(config.keyVersion) || config.keyVersion < 1) {
        report(
          "cache-policy",
          file,
          name + ": missing contract or a cache entry with a positive keyVersion",
        );
        continue;
      }
      if (kind === "external" && JSON.stringify(config.callers) !== '["workers"]') {
        report("external-callers", file, name + ".callers must be [workers]");
      }
      const ops = new Map(
        operations(owner.spec)
          .filter(({ path }) => !health.has(path))
          .map(({ op }) => [op.operationId, op]),
      );
      for (const id of new Set([...ops.keys(), ...Object.keys(config.operations ?? {})])) {
        const op = ops.get(id);
        const entry = config.operations?.[id];
        const location = name + "." + id + ": ";
        if (!op || !entry) {
          report("cache-policy", file, location + "missing contract operation or policy entry");
          continue;
        }
        if (
          entry.cacheable !== false &&
          (!scopes.includes(entry.scope) || [entry.ttl, entry.window].filter(Boolean).length !== 1)
        ) {
          report(
            "cache-policy",
            file,
            location + "must set a valid scope and exactly one ttl or window",
          );
        }
        if (
          (entry.ttl &&
            !(
              duration(entry.ttl) >= duration(limits?.minTtl) &&
              duration(entry.ttl) <= duration(limits?.maxTtl)
            )) ||
          (entry.window && !limits?.windows?.includes(entry.window))
        ) {
          report("cache-policy", file, location + "freshness outside resolution.limits");
        }
        const request = op.requestBody?.content?.["application/json"]?.schema;
        const response = op.responses?.["200"]?.content?.["application/json"]?.schema;
        checkRawUrlKeyInputs(name, id, entry, request, owner.file, lookup, report);
        const preserve = entry.preserveArrayOrder;
        const analyzeAnswer = name === "answer-analysis" && id === "analyzeAnswer";
        if (analyzeAnswer || Object.hasOwn(entry, "preserveArrayOrder")) {
          if (
            !Array.isArray(preserve) ||
            !preserve.length ||
            new Set(preserve).size !== preserve.length ||
            (analyzeAnswer && !preserve.includes("/sentiment/analyzers"))
          ) {
            report(
              "cache-policy",
              file,
              location +
                "preserveArrayOrder must list distinct request pointers" +
                (analyzeAnswer ? " including /sentiment/analyzers" : ""),
            );
          }
          for (const pointer of Array.isArray(preserve) ? preserve : []) {
            if (
              typeof pointer !== "string" ||
              !/^(?:\/(?:[^/~]|~[01])+)+$/.test(pointer) ||
              !schemaPointers(
                { file: owner.file, value: request },
                pointer
                  .slice(1)
                  .split("/")
                  .map((key) => key.replaceAll("~1", "/").replaceAll("~0", "~")),
                lookup,
                (schema) => schema.type === "array" && schema.uniqueItems === true,
              )
            ) {
              report(
                "cache-policy",
                file,
                location +
                  "preserveArrayOrder must target a request array with uniqueItems: true at " +
                  pointer,
              );
            }
          }
        }
        const paths = Object.keys(entry.normalize ?? {}).map((key) =>
          key.startsWith("/") ? key : "/" + key,
        );
        const checks = paths.map((path) => ({ path, shape: request, part: "request" }));
        if (entry.skipWhen)
          checks.push({ path: entry.skipWhen.pointer, shape: response, part: "response" });
        for (const { path, shape, part } of checks) {
          if (
            typeof path !== "string" ||
            !path.startsWith("/") ||
            !schemaPointers(
              { file: owner.file, value: shape },
              path
                .slice(1)
                .split("/")
                .map((key) => key.replaceAll("~1", "/").replaceAll("~0", "~")),
              lookup,
            )
          ) {
            report("cache-policy", file, location + "unknown " + part + " pointer " + path);
          }
        }
      }
    }
  }
}

export function checkSpecs(
  all: Spec[],
  common: Document,
  policy: Document,
  events: Document,
  report: Report,
) {
  const ids = new Map();
  const toolPaths = new Map();
  const schemaOwners = new Map();
  const lookup = resolver();
  const tenantSchemas = /\/(?:Org|User|Project|Brand|Member|ApiKey|Tenant)Id$/i;
  const cacheParts = /(?:^|\/)(?:Cache\w*|ToolCallCache\w*|XRexCache\w*)$/i;
  const statelessParts = /\/(?:IdempotencyKey|Page|PageInfo|JobFields)$/;
  const authText =
    /\bAuthorization\b|\b(?:bearer|service|access|refresh|JWT|auth(?:entication)?) tokens?\b|\bapi[- ]keys?\b/i;

  for (const { name, kind, file, spec } of all) {
    if (file !== contractsDir + "/openapi/services/" + name + ".yaml") {
      report("ownership", file, "x-rex-service.name must match its filename");
    }
    const tool = kind === "tool";
    const refs = refsFrom(spec);
    for (const [section, value] of Object.entries<Document>(spec.components ?? {})) {
      for (const key of Object.keys(value)) {
        if (
          Object.hasOwn(common.components[section] ?? {}, key) &&
          !(section === "securitySchemes" && value[key].$ref === commonRef(section, key))
        ) {
          report("copied-components", file, section + "." + key + " must reference " + commonFile);
        }
        if (section === "securitySchemes" && !value[key].$ref)
          report("copied-components", file, "inline security scheme " + key);
      }
    }

    for (const [node, path] of nodes(spec)) {
      const problem = node["application/problem+json"];
      if (problem && problem.schema?.$ref !== commonRef("schemas", "Problem")) {
        report("copied-components", file, path.join("/") + ": problem+json must reference Problem");
      }
      if ((tool || kind === "orchestrator") && node.properties) {
        for (const [key, value] of Object.entries<Document>(node.properties)) {
          if (
            /^(?:language(?:Tag)?|[a-z]+LanguageTag)$/.test(key) &&
            !refsFrom(value).includes(commonRef("schemas", "LanguageTag"))
          ) {
            report(
              "language-tag",
              file,
              path.join("/") + "/" + key + ": use the common LanguageTag",
            );
          }
        }
      }
    }

    if (tool) {
      if (
        !Array.isArray(spec.security) ||
        spec.security.length ||
        spec.components?.securitySchemes ||
        authText.test(JSON.stringify(spec))
      ) {
        report("no-auth", file, "tool must declare security: [] and contain no auth");
      }
      const doc = read(serviceDoc(name));
      if (
        authText.test(doc) ||
        /\b(?:requires?|implements?|performs?) (?:its own )?(?:auth|authentication)\b/i.test(doc)
      ) {
        report("no-auth", serviceDoc(name), "tool auth is enforced outside the tool");
      }
      if (
        refs.some((ref) => cacheParts.test(ref)) ||
        /\bcache(?:s|d|able|ability|ing)?\b|\bcaching\b/i.test(JSON.stringify(spec))
      ) {
        report("no-cache", file, "tool specs must not reference caching");
      }
      if (refs.some((ref) => statelessParts.test(ref) || tenantSchemas.test(ref))) {
        report(
          "stateless",
          file,
          "tool references a tenant, pagination, job or idempotency component",
        );
      }
    }

    for (const { path, method, op, item } of operations(spec)) {
      if (health.has(path)) continue;
      const id = op.operationId;
      if (ids.has(id)) report("ownership", file, id + " duplicates " + ids.get(id));
      ids.set(id, file);
      if (tool && toolPaths.has(path) && toolPaths.get(path) !== file) {
        report("ownership", file, path + " duplicates " + toolPaths.get(path));
      }
      if (tool) toolPaths.set(path, file);
      if (kind === "orchestrator" && /^\/v1\/tools(?:\/|$)/.test(path))
        report("ownership", file, path + " belongs to the gateway");
      const parameters = [...(item.parameters ?? []), ...(op.parameters ?? [])].map(
        (parameter: Document) => (parameter.$ref ? lookup(file, parameter.$ref).value : parameter),
      );
      if (op.operationId?.startsWith("list") && kind === "orchestrator") {
        const response = op.responses?.["200"]?.content?.["application/json"]?.schema;
        if (!response || !refsFrom(response).includes(commonRef("schemas", "Page"))) {
          const resolved = response?.$ref ? lookup(file, response.$ref).value : {};
          if (!refsFrom(resolved ?? {}).includes(commonRef("schemas", "Page"))) {
            report("copied-components", file, id + " must use the shared Page");
          }
        }
      }
      if (tool) {
        if (
          /\{/.test(path) ||
          parameters.some((p: Document) => p?.in === "path" || p?.name === "Idempotency-Key") ||
          ["201", "202", "204"].some((status) => op.responses?.[status])
        ) {
          report(
            "stateless",
            file,
            id + " uses path parameters, idempotency or a stateful success status",
          );
        }
        if (
          Object.hasOwn(op, "security") ||
          ["401", "403"].some((status) => op.responses?.[status])
        ) {
          report("no-auth", file, id + " declares security or a 401/403 response");
        }
        const result = op.responses?.["200"]?.content?.["application/json"]?.schema;
        if (op["x-rex-public"] && schemaPointers({ file, value: result }, ["usage"], lookup)) {
          report("stateless", file, id + " exposes usage in a public response");
        }
      }
      if (tool || kind === "external") {
        const limit = op["x-rex-limits"];
        const durations = ["maxDuration", "p99", "llmCallTimeout", "fetchTimeout"];
        if (
          !limit ||
          !["none", "optional", "required"].includes(limit.llm) ||
          !(tool ? ["none"] : ["one", "several", "crawl"]).includes(limit.outboundFetch) ||
          durations.some((key) => key in limit && !(duration(limit[key]) > 0)) ||
          (kind === "external" &&
            (!(duration(limit.fetchTimeout) > 0) ||
              !(Number.isInteger(limit.fetchMaxBytes) && limit.fetchMaxBytes > 0)))
        ) {
          report("limits", file, id + " has invalid x-rex-limits");
        }
        if (
          op["x-rex-public"] &&
          (!(duration(limit?.p99) > 0 && duration(limit?.p99) <= 2) ||
            limit.llm !== "none" ||
            (limit.maxDuration && duration(limit.maxDuration) > 2))
        ) {
          report("limits", file, id + " exceeds public-operation budgets");
        }
        for (const [, label, claimed] of String(op.description ?? "").matchAll(
          /\b(max duration|p99|fetch timeout|LLM call timeout)\s*(?:[:=]|of)?\s*`?(P[T\d][\dA-Z.]+)/gi,
        )) {
          const keys: Record<string, string> = {
            "max duration": "maxDuration",
            p99: "p99",
            "fetch timeout": "fetchTimeout",
            "llm call timeout": "llmCallTimeout",
          };
          const key = keys[label.toLowerCase()];
          if (duration(claimed) !== duration(limit?.[key]))
            report("limits", file, id + " description differs from x-rex-limits." + key);
        }
        if (
          kind === "external" &&
          !["400", "503"].every((status) =>
            op.responses?.[status]?.$ref?.startsWith("../common.yaml#/components/responses/"),
          )
        ) {
          report(
            "external-callers",
            file,
            method + " " + path + " must use shared problem responses",
          );
        }
      }
    }
    if (kind === "external" && [...health].some((path) => !spec.paths?.[path]?.$ref)) {
      report("external-callers", file, "missing shared health probes");
    }
  }

  for (const { file, spec } of [
    ...all,
    { file: commonFile, spec: common },
    { file: "packages/contracts/asyncapi/events.yaml", spec: events },
  ]) {
    for (const [schema, path] of nodes(spec)) {
      if (Object.keys(schema.properties ?? {}).length < 3) continue;
      const normalized = JSON.stringify(normalizeSchema(schema));
      const from = schemaOwners.get(normalized);
      const location = file + "#/" + path.join("/");
      if (from) report("duplicate-schema", file, location + " duplicates " + from);
      else schemaOwners.set(normalized, location);
    }
  }

  const answer = all.find(({ name }) => name === "answer-analysis");
  if (
    answer &&
    (![...nodes(answer.spec)].some(([node]) => node.properties?.onUnsupportedLanguage) ||
      !operations(answer.spec).some(
        ({ op }) => op.responses?.["422"] && /\bunsupported_language\b/.test(op.description),
      ) ||
      !/lexicons\/<subtag>\//.test(read(serviceDoc(answer.name))))
  ) {
    report(
      "language-tag",
      answer.file,
      "answer-analysis needs onUnsupportedLanguage, its 422 code and the lexicon extension path",
    );
  }
  checkPolicy(all, common, policy, report);
}
