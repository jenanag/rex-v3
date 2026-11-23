import type { components } from "../../contract/types.js";
import { ToolProblem } from "../errors.js";
import { codePoints } from "./unicode.js";

type Request = components["schemas"]["LlmsTxtRequest"];
type Generation = components["schemas"]["LlmsTxtGeneration"];

const fullLimit = 2_000_000;
const separator = "\n\n---\n\n";
const notice = "\n\n> llms-full.txt truncated. See llms.txt for the complete page list.\n";

function literalText(value: string | null): string {
  return (value ?? "")
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .trim()
    .replace(/[\\`*_[\]{}<>#+!&~|]/g, "\\$&")
    .replace(/^(-|\d{1,9}[.)](?=\s|$))/, (marker) => marker.replace(/[-.)]$/, "\\$&"));
}

function assembleFull(preamble: string, lines: readonly string[], pages: Request["pages"]): string {
  const blocks: { text: string; length: number }[] = [];
  let length = codePoints(preamble) + 1; // Include the final newline.
  for (const [index, { markdown }] of pages.entries()) {
    const prefix = (index === 0 ? "\n\n" : separator) + lines[index];
    const body = markdown?.replace(/\r\n?/g, "\n").replace(/\n$/, "");
    // If the source alone cannot fit, skip allocating its quoted representation.
    if (body && codePoints(body) > fullLimit - length) break;

    const text = body ? prefix + "\n\n> " + body.replaceAll("\n", "\n> ") : prefix;
    const blockLength = codePoints(text);
    if (length + blockLength > fullLimit) break;

    blocks.push({ text, length: blockLength });
    length += blockLength;
  }

  let ending = "\n";
  if (blocks.length < pages.length) {
    ending = notice;
    const extra = notice.length - 1; // The notice includes the final newline.
    while (length + extra > fullLimit) {
      const last = blocks.pop();
      if (!last) break;
      length -= last.length;
    }
  }
  return preamble + blocks.map(({ text }) => text).join("") + ending;
}

export function generateLlmsTxt({ siteUrl, pages, includeFull }: Request): Generation {
  const site = URL.parse(siteUrl);
  if (!site) {
    throw new ToolProblem(422, "invalid_assembly_url", "/siteUrl is not a valid WHATWG URL.");
  }
  for (const [index, { entry }] of pages.entries()) {
    if (!URL.canParse(entry.url)) {
      throw new ToolProblem(
        422,
        "invalid_assembly_url",
        `/pages/${index}/entry/url is not a valid WHATWG URL.`,
      );
    }
  }

  const home = pages.find(({ entry }) => entry.url === siteUrl)?.entry;
  const { host, pathname } = site;
  const title =
    literalText(home?.title ?? null) || literalText(host + (pathname === "/" ? "" : pathname));
  const summary = literalText(home?.description ?? null);
  const preamble = "# " + title + (summary ? "\n\n> " + summary : "");

  const lines = pages.map(({ entry }) => {
    const label = literalText(entry.title) || literalText(entry.url);
    const destination = entry.url.replace(/[\\&<>]/g, "\\$&");
    const notes = literalText(entry.description);
    return `- [${label}](<${destination}>)${notes ? ": " + notes : ""}`;
  });

  return {
    result: {
      content: preamble + "\n\n## Pages\n\n" + lines.join("\n") + "\n",
      fullContent: includeFull ? assembleFull(preamble, lines, pages) : null,
      pageCount: pages.length,
    },
  };
}
