import { describe, expect, test } from "vitest";
import { generateMarkup } from "../src/domain/generation.js";
import { schemaContext, type SchemaType } from "../src/domain/schema.js";
import { validateMarkup } from "../src/domain/validation.js";

describe("expanded vocabulary findings", () => {
  test("locates unknown types and aliased properties in the original request", async () => {
    const result = await validateMarkup({
      jsonLd: {
        "@context": [schemaContext, { "short~name": "schema:headlne" }],
        "@graph": [{ "@type": ["Article", "Artcle"], "short~name": "News" }],
      },
    });
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "warning",
          code: "unknown_schema_type",
          pointer: "/jsonLd/@graph/0/@type/1",
        }),
        expect.objectContaining({
          severity: "warning",
          code: "unknown_schema_property",
          pointer: "/jsonLd/@graph/0/short~0name",
        }),
      ]),
    );
    expect(result.issues).toHaveLength(2);
  });

  test("warns about a nonempty untyped graph but leaves an empty graph alone", async () => {
    const untyped = await validateMarkup({
      jsonLd: { "@context": schemaContext, headline: "News" },
    });
    expect(untyped).toEqual({
      valid: true,
      issues: [
        expect.objectContaining({ severity: "warning", code: "untyped_graph", pointer: "/jsonLd" }),
      ],
    });
    expect(await validateMarkup({ jsonLd: { "@context": schemaContext, "@graph": [] } })).toEqual({
      valid: true,
      issues: [],
    });
  });

  test("locates an unknown term introduced by a property-scoped context", async () => {
    const result = await validateMarkup({
      jsonLd: {
        "@context": [
          schemaContext,
          { author: { "@id": "schema:author", "@context": { localTitle: "schema:headlne" } } },
        ],
        "@type": "Article",
        author: [{ "@type": "Person", localTitle: "Scoped typo" }],
      },
    });
    expect(result).toEqual({
      valid: true,
      issues: [
        expect.objectContaining({
          code: "unknown_schema_property",
          pointer: "/jsonLd/author/0/localTitle",
        }),
      ],
    });
  });

  test("uses the document pointer when a type-scoped location is uncertain", async () => {
    const result = await validateMarkup({
      jsonLd: {
        "@context": [
          schemaContext,
          { Article: { "@id": "schema:Article", "@context": { headline: "schema:headlne" } } },
        ],
        "@type": "Article",
        headline: "Scoped typo",
      },
    });
    expect(result).toEqual({
      valid: true,
      issues: [expect.objectContaining({ code: "unknown_schema_property", pointer: "/jsonLd" })],
    });
  });
});

const schemaTypes: SchemaType[] = [
  "Organization",
  "LocalBusiness",
  "Product",
  "SoftwareApplication",
  "Article",
  "FAQPage",
  "HowTo",
  "BreadcrumbList",
  "Person",
  "WebSite",
];
test.each(schemaTypes)("generates %s from data and HTML", async (schemaType) => {
  const data = await generateMarkup({ schemaType, source: { data: { name: "Example" } } });
  const fromHtml = await generateMarkup({ schemaType, source: { html: "<title>Example</title>" } });
  expect(data?.jsonLd).toEqual({ "@context": schemaContext, "@type": schemaType, name: "Example" });
  expect(fromHtml?.jsonLd).toEqual({
    "@context": schemaContext,
    "@type": schemaType,
    [schemaType === "Article" ? "headline" : "name"]: "Example",
  });
});

test("omits only unusable URLs and preserves falsy source values", async () => {
  const result = await generateMarkup({
    schemaType: "Article",
    source: {
      data: {
        "@type": "Product",
        headline: "Example",
        position: 0,
        isAccessibleForFree: false,
        identifier: "SKU-001",
        image: ["/missing.png", "https://example.com/kept.png"],
      },
    },
  });
  expect(result?.jsonLd).toEqual({
    "@context": schemaContext,
    "@type": "Article",
    headline: "Example",
    position: 0,
    isAccessibleForFree: false,
    identifier: "SKU-001",
    image: ["https://example.com/kept.png"],
  });
  expect(result?.validation).toEqual({
    valid: true,
    issues: [
      expect.objectContaining({
        severity: "warning",
        code: "unresolved_url",
        pointer: "/source/data/image/0",
      }),
    ],
  });
});
