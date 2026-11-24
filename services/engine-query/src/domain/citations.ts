import { fromMarkdown } from "mdast-util-from-markdown";
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

type TextRange = { start: number; end: number };
type FenceClosing = { at: number; lineEnding: string; prefix: string };
type CodeBlock = TextRange & { closing?: FenceClosing };

function markdownPositions(text: string) {
  // The parser strips an initial byte-order mark before assigning positions.
  const sourceOffset = text.startsWith("\uFEFF") ? 1 : 0;
  const delimiters = new Map<number, number>();
  const tree = fromMarkdown(text, {
    mdastExtensions: [
      {
        enter: {
          codeFencedFence({ start, end }) {
            delimiters.set(end.offset + sourceOffset, start.offset + sourceOffset);
          },
        },
      },
    ],
  });
  const spans: TextRange[] = [];
  const blocks: CodeBlock[] = [];
  const links: (TextRange & { url: string })[] = [];

  const nodes = [...tree.children];
  for (const node of nodes) {
    if ("children" in node) nodes.push(...node.children);
    const { start: point, end: limit } = node.position ?? {};
    if (point?.offset === undefined || limit?.offset === undefined) continue;
    const start = point.offset + sourceOffset;
    const end = limit.offset + sourceOffset;

    if (node.type === "inlineCode") spans.push({ start, end });
    if (node.type === "link") links.push({ start, end, url: node.url });
    if (node.type === "code") {
      const block: CodeBlock = { start, end };
      // The parser emits a delimiter token for each fence line. An unclosed
      // block can end at its opener, which does not provide an insertion point.
      const marker = delimiters.get(end);
      if (marker !== undefined && marker > start) {
        const lineStart =
          Math.max(text.lastIndexOf("\n", marker - 1), text.lastIndexOf("\r", marker - 1)) + 1;
        const lineEnding =
          /^(?:\r\n|[\r\n])/.exec(text.slice(end))?.[0] ??
          /\r\n|[\r\n]/.exec(text.slice(start, end))?.[0] ??
          "\n";
        block.closing = { at: end, lineEnding, prefix: text.slice(lineStart, marker) };
      }
      blocks.push(block);
    }
  }

  links.sort((left, right) => left.start - right.start);
  return { spans, blocks, links };
}

export function renderAnswer(parts: TextPart[], validUrl: (value: string) => boolean) {
  const sources = new Map<string, Source>();
  const paragraphs = parts.map(({ text, annotations }) => {
    const offsets = utf16Boundaries(text);
    const { spans, blocks, links } = markdownPositions(text);
    const insertions = new Map<number, string[]>();
    const fenceCitations = new Map<FenceClosing, string[]>();

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
      // The API reference describes the last cited character. In the recorded
      // Luna response, [508, 599) covers the full parenthesized citation and
      // code point 599 is the following newline. Use that exclusive boundary.
      const end = offsets[citation.end_index];
      if (start === undefined || end === undefined || start >= end) continue;
      const label = `[${source.position}](<${url.replaceAll("&", "&amp;")}>)`;
      const fence = blocks.find((range) => range.start < end && end <= range.end);
      if (fence) {
        // A code block without a closing fence keeps its source row.
        if (fence.closing) {
          const labels = fenceCitations.get(fence.closing) ?? [];
          labels.push(label);
          fenceCitations.set(fence.closing, labels);
        }
        continue;
      }
      const boundary = spans.find((span) => span.start < end && end < span.end)?.end ?? end;
      const existing = links.find(
        (link) =>
          (link.start < end && start < link.end) ||
          (link.start >= boundary && !text.slice(boundary, link.start).trim()),
      );
      if (existing && normalizedUrl(existing.url, validUrl) === url) continue;
      const at = existing && existing.start < end ? Math.max(boundary, existing.end) : boundary;
      const labels = insertions.get(at) ?? [];
      labels.push(" " + label);
      insertions.set(at, labels);
    }

    for (const [{ at, lineEnding, prefix }, labels] of fenceCitations) {
      // The closing line already has the continuation markers for its containers.
      const blankPrefix = prefix.trimEnd();
      const following = text.slice(at + lineEnding.length);
      const separator = /^[ \t>]*(?:[\r\n]|$)/.test(following) ? "" : lineEnding + blankPrefix;
      insertions.set(at, [
        lineEnding + blankPrefix + lineEnding + prefix + labels.join(" ") + separator,
      ]);
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
