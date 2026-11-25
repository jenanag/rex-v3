export type CacheScope = "shared" | "tenant";
export type CacheWindow = "PT1H" | "P1D" | "P7D";
export type Freshness = { ttlSeconds: number } | { window: CacheWindow };

export interface OperationPolicy {
  scope?: CacheScope;
  ttl?: string;
  window?: CacheWindow;
  cacheable?: boolean;
  rawUrlKeyInputs?: Record<string, string>;
  extraKeyInputs?: readonly string[];
  normalize?: Record<string, "collapse-whitespace">;
  preserveArrayOrder?: readonly string[];
}

interface ServicePolicy {
  keyVersion: number;
  operations: Record<string, OperationPolicy>;
}

export interface CachePolicy {
  key: { format: string };
  resolution: {
    limits: { minTtl: string; maxTtl: string; windows: readonly CacheWindow[] };
  };
  tools: Record<string, ServicePolicy>;
  external: Record<string, ServicePolicy>;
}

export interface CacheDiagnostic {
  code: "invalid_override" | "ttl_clamped";
  layer: "customer" | "environment";
  location: string;
  detail: string;
}

export type EnvironmentOverrides = Partial<
  Record<"tools" | "external", Record<string, { operations?: Record<string, unknown> }>>
>;

const fields = ["scope", "ttl", "window"] as const;
type Field = (typeof fields)[number];
const windows: readonly CacheWindow[] = ["PT1H", "P1D", "P7D"];

function seconds(value: unknown): number {
  const match =
    typeof value === "string" &&
    /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!match || !match.slice(1).some(Boolean) || match[0].endsWith("T")) return NaN;
  const [, days, hours, minutes, secs] = match.map(Number);
  return (days || 0) * 86400 + (hours || 0) * 3600 + (minutes || 0) * 60 + (secs || 0);
}

export function findPolicy(policy: CachePolicy, tool: string, operationId: string) {
  const group: "tools" | "external" = Object.hasOwn(policy.tools, tool) ? "tools" : "external";
  const service = Object.hasOwn(policy[group], tool) ? policy[group][tool] : undefined;
  if (!service || !Object.hasOwn(service.operations, operationId)) return undefined;
  return { group, operation: service.operations[operationId], keyVersion: service.keyVersion };
}

interface OverrideSource {
  layer: CacheDiagnostic["layer"];
  location: string;
  value: unknown;
}

export function resolveSettings(
  defaults: OperationPolicy,
  limits: CachePolicy["resolution"]["limits"],
  sources: OverrideSource[],
  diagnostics: CacheDiagnostic[],
): { scope: CacheScope } & Freshness {
  const min = seconds(limits.minTtl);
  const max = seconds(limits.maxTtl);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || min > max)
    throw new Error("Invalid policy TTL limits");
  const validWindow = (value: unknown): value is CacheWindow =>
    windows.some((window) => window === value && limits.windows.includes(window));
  const scope = defaults.scope;
  const ttl = seconds(defaults.ttl);
  const freshness = defaults.ttl === undefined ? "window" : "ttl";
  if (
    (scope !== "shared" && scope !== "tenant") ||
    (freshness === "ttl"
      ? defaults.window !== undefined || !(ttl >= min && ttl <= max)
      : !validWindow(defaults.window))
  ) {
    throw new Error("Invalid policy operation defaults");
  }

  const resolved: Partial<Record<Field, string | number>> = {};
  for (const { layer, location, value } of sources) {
    const report = (code: CacheDiagnostic["code"], field: string, detail: string) =>
      diagnostics.push({ code, layer, location: location + field, detail });
    if (value === undefined) continue;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      report("invalid_override", "", "Expected an object of operation overrides");
      continue;
    }
    for (const [field, supplied] of Object.entries(value)) {
      if (field !== "scope" && field !== "ttl" && field !== "window") {
        report("invalid_override", "." + field, "Field cannot be overridden");
        continue;
      }
      let effective: string | number;
      if (field === "scope") {
        if (supplied !== "tenant" && (supplied !== "shared" || layer === "customer")) {
          report("invalid_override", ".scope", "Scope is not permitted for this layer");
          continue;
        }
        effective = supplied;
      } else if (field !== freshness) {
        report("invalid_override", "." + field, "Override must retain the policy freshness kind");
        continue;
      } else if (field === "window") {
        if (!validWindow(supplied)) {
          report("invalid_override", ".window", "Window is not in the policy's allowed set");
          continue;
        }
        effective = supplied;
      } else {
        const requested = seconds(supplied);
        if (!Number.isFinite(requested)) {
          report("invalid_override", ".ttl", "Expected a fixed ISO 8601 duration");
          continue;
        }
        effective = Math.min(max, Math.max(min, requested));
        if (effective !== requested)
          report("ttl_clamped", ".ttl", `Clamped ${requested} to ${effective} seconds`);
      }
      resolved[field] ??= effective;
    }
  }

  const effectiveScope = (resolved.scope ?? scope) as CacheScope;
  return freshness === "ttl"
    ? { scope: effectiveScope, ttlSeconds: (resolved.ttl ?? ttl) as number }
    : { scope: effectiveScope, window: (resolved.window ?? defaults.window) as CacheWindow };
}

export function utcBucket(timestamp: number, window?: CacheWindow): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new RangeError("Invalid cache timestamp");
  if (!window) return "-";
  if (window === "PT1H") return date.toISOString().slice(0, 13).toLowerCase();
  if (window === "P7D") date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}
