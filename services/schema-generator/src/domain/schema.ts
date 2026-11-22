import type { components } from "../../contract/types.js";
import context from "../data/schemaorg-context.json" with { type: "json" };
import vocabulary from "../data/schemaorg-vocabulary.json" with { type: "json" };

export type JsonObject = Record<string, unknown>;
export type Issue = components["schemas"]["ValidationIssue"];
export type Validation = components["schemas"]["ValidationResult"];
export type SchemaType = components["schemas"]["SchemaType"];

export const schemaContext = "https://schema.org";
export const schemaRelease = vocabulary.release;
export const schemaVocab = context["@context"]["@vocab"];
export const types = new Set(vocabulary.types);
export const properties = new Set(vocabulary.properties);
export const urlProperties = new Set(vocabulary.urlProperties);

export const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const pointer = (base: string, key: string | number) =>
  base + "/" + String(key).replaceAll("~", "~0").replaceAll("/", "~1");

export const schemaTerm = (iri: string) => /^https?:\/\/schema\.org\/(.+)$/.exec(iri)?.[1];
export const schemaProperty = (key: string) =>
  schemaTerm(key) ?? (key.startsWith("schema:") ? key.slice(7) : key);

export const validationResult = (issues: Issue[]): Validation => ({
  valid: issues.every(({ severity }) => severity !== "error"),
  issues,
});
