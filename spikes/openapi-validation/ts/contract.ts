import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import { parse } from "yaml";

type Schema = boolean | { [key: string]: unknown };
type Reference = { $ref: string };
export type Media = { schema: Schema };
export type Operation = {
  operationId: string;
  parameters?: unknown[];
  requestBody?: { required?: boolean; content: Record<string, Media> };
  responses: Record<string, { content?: Record<string, Media> } | Reference>;
};
export type PathItem = { parameters?: unknown[] } & Record<
  string,
  Operation | unknown[] | undefined
>;
export type Spec = {
  openapi: string;
  paths: Record<string, PathItem>;
  components: {
    schemas: Record<string, Schema>;
    responses: Record<string, { content?: Record<string, Media> }>;
  };
};

const addFormats = createRequire(import.meta.url)("ajv-formats") as FormatsPlugin;
const schemasId = "urn:rex:openapi-validation:schemas";
const source = new URL("../../../services/answer-analysis/contract/openapi.yaml", import.meta.url);
export const analysisPath = "/v1/answer-analyses";

export function loadSpec(supplement = false): Spec {
  const spec = parse(readFileSync(source, "utf8"));
  if (supplement) {
    // These keywords are absent from the answer-analysis request. Lift nullable
    // fields from its response and propertyNames/lookahead from common.yaml.
    const common = parse(
      readFileSync(
        new URL("../../../packages/contracts/openapi/common.yaml", import.meta.url),
        "utf8",
      ),
    );
    const { schemas } = spec.components;
    schemas.AnswerAnalysisRequest.properties = {
      spike: {
        type: "object",
        unevaluatedProperties: false,
        properties: {
          score: schemas.MentionDetail.properties.sentimentScore,
          sentiment: schemas.MentionDetail.properties.sentiment,
          names: {
            type: "object",
            propertyNames:
              common.components.schemas.CacheDirective.properties.overrides.propertyNames,
          },
          duration: common.components.schemas.IsoDuration,
        },
      },
    };
  }
  return spec;
}

function withRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withRefs);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (key === "$ref") {
        if (typeof child !== "string" || !child.startsWith("#/components/schemas/")) {
          throw new Error("Expected a bundled schema reference: " + child);
        }
        return [key, schemasId + child.replace("#/components/schemas/", "#/$defs/")];
      }
      return [key, withRefs(child)];
    }),
  );
}

export function validator(spec: Spec, useDefaults: boolean) {
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    removeAdditional: false,
    coerceTypes: false,
    useDefaults,
  });
  addFormats(ajv);
  for (const keyword of ["example", "x-rex-service", "x-rex-public", "x-rex-limits"]) {
    ajv.addKeyword(keyword);
  }
  ajv.addSchema({ $id: schemasId, $defs: withRefs(spec.components.schemas) });
  return (schema: Schema) => ajv.compile(withRefs(schema) as object);
}

export function responseMedia(spec: Spec, response: Operation["responses"][string]) {
  if ("$ref" in response) {
    const prefix = "#/components/responses/";
    if (!response.$ref.startsWith(prefix)) throw new Error("Unbundled response: " + response.$ref);
    return spec.components.responses[response.$ref.slice(prefix.length)].content;
  }
  return response.content;
}
