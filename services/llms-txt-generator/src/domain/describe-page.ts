import { fromMarkdown } from "mdast-util-from-markdown";
import type { components } from "../../contract/types.js";
import { ToolProblem } from "../errors.js";
import { codePoints } from "./unicode.js";

type Request = components["schemas"]["PageEntryRequest"];
type Result = components["schemas"]["PageEntryResult"];
type Block = ReturnType<typeof fromMarkdown>["children"][number];
type Inline = Extract<Block, { type: "paragraph" }>["children"][number];

const sentences = new Intl.Segmenter("en", { granularity: "sentence" });
const words = new Intl.Segmenter("en", { granularity: "word" });
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

const normalize = (value: string | null) => (value ?? "").replace(/\s+/gu, " ").trim();

function visibleText(nodes: readonly Inline[]): string {
  return nodes
    .map((node) => {
      if ("children" in node) return visibleText(node.children);
      if (node.type === "text" || node.type === "inlineCode") return node.value;
      if (node.type === "image" || node.type === "imageReference") return node.alt ?? "";
      return node.type === "break" ? " " : "";
    })
    .join("");
}

function clip(text: string, limit: number, preferWords = false): string {
  if (codePoints(text) <= limit) return text;

  const budget = limit - 1; // Reserve one code point for the ellipsis.
  let count = 0;
  let end = 0;
  for (const { segment, index } of graphemes.segment(text)) {
    count += codePoints(segment);
    if (count > budget) break;
    end = index + segment.length;
  }

  if (end === 0) {
    let remaining = budget;
    for (const character of text) {
      end += character.length;
      if (--remaining === 0) break;
    }
    return text.slice(0, end) + "…";
  }

  if (preferWords) {
    let wordEnd = 0;
    for (const { segment, index, isWordLike } of words.segment(text)) {
      const boundary = index + segment.length;
      if (boundary > end) break;
      if (isWordLike) wordEnd = boundary;
    }
    if (wordEnd > 0) end = wordEnd;
  }
  return text.slice(0, end).trimEnd() + "…";
}

function describe(source: string): string | null {
  if (!source) return null;

  const candidates = sentences.segment(source)[Symbol.iterator]();
  const first = candidates.next().value?.segment.trim() ?? source;
  if (codePoints(first) > 1_000) return clip(first, 1_000, true);

  const second = candidates.next().value?.segment.trim();
  if (second && codePoints(first) + 1 + codePoints(second) <= 1_000) {
    return first + " " + second;
  }
  return first;
}

export function describePageExtractively({ url, metadata, content }: Request): Result {
  const parsed = URL.parse(url);
  if (!parsed) {
    throw new ToolProblem(422, "invalid_page_url", "/url is not a valid WHATWG URL.");
  }

  let title = normalize(metadata.title);
  let description = normalize(metadata.description);
  if ((!title || !description) && content.markdown.trim()) {
    for (const block of fromMarkdown(content.markdown).children) {
      if (!title && block.type === "heading") title = normalize(visibleText(block.children));
      if (!description && block.type === "paragraph") {
        description = normalize(visibleText(block.children));
      }
      if (title && description) break;
    }
  } else if (!description) {
    description =
      content.text
        .replace(/\r\n?/g, "\n")
        .split(/\n[^\S\n]*\n/)
        .map(normalize)
        .find(Boolean) ?? "";
  }

  title ||= parsed.pathname === "/" ? parsed.host : parsed.pathname;
  return {
    entry: { url, title: clip(title, 300), description: describe(description) },
    usage: [],
  };
}
