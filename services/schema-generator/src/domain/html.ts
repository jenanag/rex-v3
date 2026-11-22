import { load, type CheerioAPI } from "cheerio";
import type { SchemaType } from "./schema.js";

type LocatedText = { value: string; pointer: string };
type Metadata = Record<string, Iterable<LocatedText>>;

export const parseHtml = (html: string) => load(html, { sourceCodeLocationInfo: true });

export function blocks($: CheerioAPI) {
  return $("script[type]")
    .toArray()
    .filter(
      (element) =>
        $(element).attr("type")?.split(";")[0].trim().toLowerCase() === "application/ld+json",
    )
    .sort(
      (a, b) => (a.sourceCodeLocation?.startOffset ?? 0) - (b.sourceCodeLocation?.startOffset ?? 0),
    )
    .map((element) => ({
      text: $(element).text(),
      pointer: "line:" + (element.sourceCodeLocation?.startLine ?? 1),
    }));
}

export function readMarkupBlock(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}

export function metadata($: CheerioAPI, type: SchemaType): { og: Metadata; html: Metadata } {
  const titleField = type === "Article" ? "headline" : "name";
  function* meta(attribute: "name" | "property", key: string) {
    for (const el of $("meta[" + attribute + "]").toArray()) {
      const tag = $(el);
      if (tag.attr(attribute)?.trim().toLowerCase() === key) {
        const value = tag.attr("content")?.trim();
        if (value) yield { value, pointer: "line:" + (el.sourceCodeLocation?.startLine ?? 1) };
      }
    }
  }
  function* link(relation: string) {
    for (const el of $("link[rel][href]").toArray()) {
      const tag = $(el);
      if (tag.attr("rel")?.toLowerCase().split(/\s+/).includes(relation)) {
        const href = tag.attr("href")?.trim();
        if (href) yield { value: href, pointer: "line:" + (el.sourceCodeLocation?.startLine ?? 1) };
      }
    }
  }
  function* title() {
    yield* meta("name", "title");
    for (const el of $("title").toArray()) {
      const value = $(el).text().trim();
      if (value) yield { value, pointer: "line:" + (el.sourceCodeLocation?.startLine ?? 1) };
    }
  }
  return {
    og: {
      [titleField]: meta("property", "og:title"),
      description: meta("property", "og:description"),
      image: [...meta("property", "og:image"), ...meta("property", "og:image:url")],
      url: meta("property", "og:url"),
    },
    html: {
      [titleField]: title(),
      description: meta("name", "description"),
      image: [...meta("name", "image"), ...link("image_src")],
      url: link("canonical"),
    },
  };
}
