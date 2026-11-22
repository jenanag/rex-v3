import { load, type CheerioAPI } from "cheerio";
import type { SchemaType } from "./schema.js";

type LocatedText = { value: string; pointer: string };
type Metadata = Record<string, LocatedText | undefined>;

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
  function firstMeta(attribute: "name" | "property", key: string) {
    for (const el of $("meta[" + attribute + "]").toArray()) {
      const tag = $(el);
      if (tag.attr(attribute)?.trim().toLowerCase() === key) {
        const value = tag.attr("content")?.trim();
        if (value) return { value, pointer: "line:" + (el.sourceCodeLocation?.startLine ?? 1) };
      }
    }
  }
  function firstLink(relation: string) {
    for (const el of $("link[rel][href]").toArray()) {
      const tag = $(el);
      if (tag.attr("rel")?.toLowerCase().split(/\s+/).includes(relation)) {
        const href = tag.attr("href")?.trim();
        if (href)
          return { value: href, pointer: "line:" + (el.sourceCodeLocation?.startLine ?? 1) };
      }
    }
  }
  const title = $("title").first();
  const titleText = title.text().trim();
  const documentTitle = titleText
    ? { value: titleText, pointer: "line:" + (title[0]?.sourceCodeLocation?.startLine ?? 1) }
    : undefined;
  return {
    og: {
      [titleField]: firstMeta("property", "og:title"),
      description: firstMeta("property", "og:description"),
      image: firstMeta("property", "og:image") ?? firstMeta("property", "og:image:url"),
      url: firstMeta("property", "og:url"),
    },
    html: {
      [titleField]: firstMeta("name", "title") ?? documentTitle,
      description: firstMeta("name", "description"),
      image: firstMeta("name", "image") ?? firstLink("image_src"),
      url: firstLink("canonical"),
    },
  };
}
