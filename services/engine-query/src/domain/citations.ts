import type { components } from "../../contract/types.js";

type Source = components["schemas"]["AnswerSource"];
export type TextPart = {
  text: string;
  annotations: { url: string; title: string; start_index: number; end_index: number }[];
};

function normalizedUrl(raw: unknown, validUrl: (value: string) => boolean) {
  // Keep the original path, query and fragment octets (WHATWG resolves dot segments).
  if (typeof raw !== "string") return;
  const match = /^https?:\/\/([^/?#]+)(.*)$/i.exec(raw);
  if (!match || match[1].includes("@") || /[\\\s\u0000-\u001f\u007f]/u.test(raw)) return;
  const parsed = URL.parse(raw);
  if (!parsed?.hostname) return;
  const url = parsed.origin + (match[2].startsWith("/") ? match[2] : "/" + match[2]);
  if (validUrl(url)) return url;
}

function utf16Boundaries(text: string) {
  const offsets = [0];
  let offset = 0;
  for (const character of text) {
    offset += character.length;
    offsets.push(offset);
  }
  return offsets;
}

function codeSpans(text: string) {
  const runs = [...text.matchAll(/`+/g)];
  const nextByWidth = new Map<number, number>();
  const pairs = new Map<number, { start: number; closing: number }>();
  for (let index = runs.length - 1; index >= 0; index--) {
    const run = runs[index];
    let before = run.index;
    while (text[before - 1] === "\\") before--;
    // An escape outside code consumes only the first backtick. Inside code,
    // the full run can close the span regardless of preceding backslashes.
    const escaped = (run.index - before) % 2;
    const width = run[0].length;
    const closing = nextByWidth.get(width - escaped);
    if (closing !== undefined) pairs.set(index, { start: run.index + escaped, closing });
    nextByWidth.set(width, index);
  }

  const spans: { start: number; end: number }[] = [];
  for (let index = 0; index < runs.length; index++) {
    const pair = pairs.get(index);
    if (!pair) continue;
    const delimiter = runs[pair.closing];
    spans.push({ start: pair.start, end: delimiter.index + delimiter[0].length });
    index = pair.closing;
  }
  return spans;
}

function markdownLinks(text: string) {
  // Recognize the inline link and autolink forms used in provider Markdown.
  // A balanced parenthesis pair inside a destination is part of the URL.
  const links =
    /(?<![\\!])\[(?:\\.|[^\]\\\n])*\]\(\s*(?:<([^<>\n]*)>|((?:[^()\s]|\([^()\n]*\))+))(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)|<(https?:\/\/[^<>\s]+)>/gi;
  return [...text.matchAll(links)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    url: (match[1] ?? match[2] ?? match[3]).replaceAll("&amp;", "&"),
  }));
}

export function renderAnswer(parts: TextPart[], validUrl: (value: string) => boolean) {
  const sources = new Map<string, Source>();
  const paragraphs = parts.map(({ text, annotations }) => {
    const offsets = utf16Boundaries(text);
    const code = codeSpans(text);
    const links = markdownLinks(text).filter(
      (link) => !code.some((span) => span.start <= link.start && link.start < span.end),
    );
    const insertions = new Map<number, string[]>();

    // Stable sort preserves provider order for equal starts within this text part.
    const citations = annotations.toSorted((left, right) => left.start_index - right.start_index);
    for (const citation of citations) {
      const url = normalizedUrl(citation.url, validUrl);
      if (!url) continue;

      let source = sources.get(url);
      if (!source) {
        const title = typeof citation.title === "string" ? citation.title.trim() || null : null;
        source = { url, title, position: sources.size + 1 };
        sources.set(url, source);
      }

      const start = offsets[citation.start_index];
      // Responses annotations describe the index of the last cited code point.
      const end = offsets[citation.end_index + 1];
      if (start === undefined || end === undefined || start >= end) continue;
      const boundary = code.find((span) => span.start < end && end < span.end)?.end ?? end;
      const existing = links.find(
        (link) =>
          (link.start < end && start < link.end) ||
          (link.start >= boundary && !text.slice(boundary, link.start).trim()),
      );
      if (existing && normalizedUrl(existing.url, validUrl) === url) continue;
      const at = existing && existing.start < end ? Math.max(boundary, existing.end) : boundary;
      const label = ` [${source.position}](<${url.replaceAll("&", "&amp;")}>)`;
      const labels = insertions.get(at) ?? [];
      labels.push(label);
      insertions.set(at, labels);
    }

    let rendered = "";
    let previous = 0;
    for (const at of [...insertions.keys()].sort((left, right) => left - right)) {
      rendered += text.slice(previous, at) + insertions.get(at)!.join("");
      previous = at;
    }
    return rendered + text.slice(previous);
  });

  return { text: paragraphs.join("\n\n"), sources: [...sources.values()] };
}
