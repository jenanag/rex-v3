import { createHash } from "node:crypto";
import { canonicalJson, isObject, own, pointerValue } from "./json.js";
import { findPolicy, resolveSettings, utcBucket } from "./policy.js";
import type {
  CacheDiagnostic,
  CachePolicy,
  CacheScope,
  EnvironmentOverrides,
  Freshness,
} from "./policy.js";
import { findOperationSchema, normalizeRequest } from "./schema.js";
import type { OperationContract } from "./schema.js";

export type {
  CacheDiagnostic,
  CachePolicy,
  CacheScope,
  CacheWindow,
  EnvironmentOverrides,
} from "./policy.js";
export type { OperationContract } from "./schema.js";

export interface CacheKeyOptions {
  policy: CachePolicy;
  contract: OperationContract;
  tool: string;
  operationId: string;
  /** The schema-validated request body, with current deployment eligibility already checked. */
  request?: unknown;
  /** Epoch milliseconds. */
  timestamp: number;
  orgId?: string;
  variant?: number;
  customerOverrides?: Record<string, unknown>;
  environmentOverrides?: EnvironmentOverrides;
  extraKeyInputs?: Record<string, unknown>;
}

export type CacheKeyResult =
  | ({
      status: "cacheable";
      key: string;
      canonicalBytes: Buffer;
      scope: CacheScope;
      diagnostics: CacheDiagnostic[];
    } & Freshness)
  | {
      status: "uncacheable";
      reason: "operation_not_cacheable" | "missing_org_id" | "unsafe_input";
      diagnostics: CacheDiagnostic[];
    };

/** Derive a cache key without modifying inputs, consulting a clock, or accessing a store. */
export function deriveCacheKey(options: CacheKeyOptions): CacheKeyResult {
  const { policy, contract, tool, operationId, orgId, timestamp } = options;
  const diagnostics: CacheDiagnostic[] = [];
  const selected = findPolicy(policy, tool, operationId);
  if (!selected || selected.operation.cacheable === false)
    return { status: "uncacheable", reason: "operation_not_cacheable", diagnostics };
  const { group, operation, keyVersion } = selected;
  const serviceOverrides = own(options.environmentOverrides?.[group], tool);
  for (const [location, overrides, allowed] of [
    ["", options.environmentOverrides, ["tools", "external"]],
    [group + "." + tool + ".", serviceOverrides, ["operations"]],
  ] as const) {
    for (const name of Object.keys(overrides ?? {})) {
      if (!(allowed as readonly string[]).includes(name))
        diagnostics.push({
          code: "invalid_override",
          layer: "environment",
          location: location + name,
          detail: "Field cannot be overridden",
        });
    }
  }
  const environment = own(serviceOverrides?.operations, operationId);
  const customerKey = tool + "." + operationId;
  const settings = resolveSettings(
    operation,
    policy.resolution.limits,
    [
      {
        layer: "customer",
        location: customerKey,
        value: own(options.customerOverrides, customerKey),
      },
      { layer: "customer", location: "*", value: own(options.customerOverrides, "*") },
      {
        layer: "environment",
        location: `${group}.${tool}.operations.${operationId}`,
        value: environment,
      },
    ],
    diagnostics,
  );
  if (settings.scope === "tenant" && !orgId)
    return { status: "uncacheable", reason: "missing_org_id", diagnostics };
  if (contract["x-rex-service"]?.name && contract["x-rex-service"].name !== tool)
    throw new Error("Cache policy service does not match the OpenAPI bundle");
  const schema = findOperationSchema(contract, operationId);
  const specMajor = /^(0|[1-9]\d*)\.\d+\.\d+(?:[-+].+)?$/.exec(contract.info.version)?.[1];
  const variant = options.variant ?? 0;
  if (!specMajor || !Number.isSafeInteger(keyVersion) || keyVersion < 1)
    throw new Error("Invalid cache key version inputs");
  if (!Number.isInteger(variant) || variant < 0 || variant > 99)
    throw new RangeError("Cache variant must be an integer from 0 to 99");
  if (settings.scope === "tenant" && orgId && !/^[a-z0-9_-]+$/i.test(orgId))
    throw new Error("Invalid organization ID in cache key");
  const window = utcBucket(timestamp, "window" in settings ? settings.window : undefined);
  try {
    const request = schema === undefined && options.request === undefined ? {} : options.request;
    if (schema === undefined && isObject(request) && Object.keys(request).length > 0)
      throw new Error("Unexpected request body");
    if (!isObject(request)) throw new Error("Expected a JSON request object");
    const extra: [string, unknown][] = [];
    for (const [alias, pointer] of Object.entries(operation.rawUrlKeyInputs ?? {})) {
      const original = pointerValue(request, pointer);
      if (typeof original !== "string") throw new Error("Missing original URL");
      extra.push(["$" + alias, original]);
    }
    for (const name of operation.extraKeyInputs ?? []) {
      const value = own(options.extraKeyInputs, name);
      if (value === undefined) throw new Error("Missing extra cache key input");
      extra.push(["$" + name, value]);
    }
    const additions = Object.fromEntries(extra);
    const normalized = normalizeRequest(contract, schema, operation, request);
    if (
      !isObject(normalized) ||
      Object.keys(additions).length !== extra.length ||
      Object.keys(additions).some((name) => Object.hasOwn(normalized, name))
    )
      throw new Error("Conflicting cache key inputs");
    const canonicalBytes = Buffer.from(canonicalJson({ ...normalized, ...additions }), "utf8");
    const parts: Record<string, string> = {
      tool,
      operationId: operationId.toLowerCase(),
      specMajor,
      keyVersion: String(keyVersion),
      scope: settings.scope === "tenant" ? "t-" + orgId?.toLowerCase() : "shared",
      window,
      variant: String(variant),
      inputHash: createHash("sha256").update(canonicalBytes).digest("hex"),
    };
    const key = policy.key.format.replace(/\{(\w+)\}/g, (_, name: string) => {
      const part = own(parts, name);
      if (part === undefined) throw new Error("Unknown cache key part");
      return part;
    });
    return { status: "cacheable", key, canonicalBytes, ...settings, diagnostics };
  } catch {
    // A schema or value that cannot be canonicalized safely must never authorize a hit.
    return { status: "uncacheable", reason: "unsafe_input", diagnostics };
  }
}
