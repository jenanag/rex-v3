export function isObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function own<T>(value: Record<string, T> | undefined, key: string): T | undefined {
  return value && Object.hasOwn(value, key) ? value[key] : undefined;
}

export function pointerValue(document: unknown, pointer: string): unknown {
  if (!pointer.startsWith("/")) throw new Error(`Invalid JSON Pointer: ${pointer}`);
  let value = document;
  for (const segment of pointer.slice(1).split("/")) {
    const name = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    value =
      (isObject(value) || Array.isArray(value)) && Object.hasOwn(value, name)
        ? Reflect.get(value, name)
        : undefined;
  }
  return value;
}

export function pointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function quote(value: string): string {
  if (!value.isWellFormed())
    throw new Error("JCS requires Unicode strings without lone surrogates");
  return JSON.stringify(value);
}

// RFC 8785 uses ECMAScript primitive serialization and UTF-16 property ordering.
export function canonicalJson(value: unknown): string {
  if (typeof value === "string") return quote(value);
  if (value === null || typeof value === "boolean" || Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + Array.from(value, canonicalJson).join(",") + "]";
  if (isObject(value))
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => quote(key) + ":" + canonicalJson(value[key]))
        .join(",") +
      "}"
    );
  throw new Error("JCS requires JSON values and finite numbers");
}
