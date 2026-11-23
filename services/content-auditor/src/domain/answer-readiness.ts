import { finding, type AuditRequest, type Finding } from "./types.js";

const words = new Intl.Segmenter("en", { granularity: "word" });

function columnAfter(whitespace: string, column = 0): number {
  for (const character of whitespace) column += character === "\t" ? 4 - (column % 4) : 1;
  return column;
}

function scanMarkdown(markdown: string) {
  const lines = markdown.split(/\r\n?|\n/);
  let headings = 0;
  let question = false;
  let sections = 0;
  let hasListOrTable = false;
  let firstProse = "";
  let headingOpen = false;
  let fence: string | undefined;
  let inOtherBlock = false;
  let listIndent: number | undefined;
  let lead: string[] = [];

  const closeBlock = () => {
    if (!firstProse && lead.length) firstProse = lead.join(" ");
    lead = [];
    inOtherBlock = false;
  };

  for (const [index, line] of lines.entries()) {
    const marker = /^ {0,3}(\x60{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker?.[1].startsWith(fence) && !marker[2].trim()) fence = undefined;
      continue;
    }
    if (!line.trim()) {
      closeBlock();
      continue;
    }
    const heading = /^ {0,3}#{1,6}(?:[ \t]+(.*)|$)/.exec(line);
    const listItem = /^( {0,3})([-+*]|\d{1,9}[.)])([ \t]+|$)/.exec(line);
    const quote = /^ {0,3}>/.test(line);
    if (listIndent !== undefined) {
      const indentation = columnAfter(/^[ \t]*/.exec(line)![0]);
      if (indentation >= listIndent) {
        inOtherBlock = true;
        continue;
      }
      if (inOtherBlock && !marker && !heading && !listItem && !quote) continue;
      listIndent = undefined;
    }
    if (marker) {
      closeBlock();
      fence = marker[1];
      continue;
    }
    if (heading) {
      closeBlock();
      headings++;
      headingOpen = true;
      question ||= (heading[1] ?? "")
        .replace(/[ \t]+#+[ \t]*$/, "")
        .trimEnd()
        .endsWith("?");
      continue;
    }
    const next = lines[index + 1]?.trim().replace(/^\||\|$/g, "");
    const cells = next?.split("|").map((cell) => cell.trim()) ?? [];
    const isTable =
      line.includes("|") && cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
    if (isTable || listItem) hasListOrTable = true;
    if (listItem) {
      // A blank separates paragraphs, but the item's content indent still applies.
      const markerEnd = listItem[1].length + listItem[2].length;
      const padding = columnAfter(listItem[3], markerEnd) - markerEnd;
      listIndent = markerEnd + (padding >= 1 && padding <= 4 ? padding : 1);
    }
    if (isTable || listItem || quote || /^(?: {4}|\t)/.test(line)) {
      closeBlock();
      inOtherBlock = true;
      continue;
    }
    if (inOtherBlock) continue;
    if (headingOpen) {
      sections++;
      headingOpen = false;
    }
    if (!firstProse) lead.push(line.trim());
  }
  closeBlock();
  return { headings, question, sections, hasListOrTable, firstProse };
}

export function answerChecks({ text, markdown }: AuditRequest["content"]): Finding[] {
  const source = markdown.trim();
  const scan = source ? scanMarkdown(markdown) : undefined;
  const heading = !scan
    ? finding("answer_question_headings", "not_applicable", "No extracted Markdown was supplied.")
    : scan.question
      ? finding(
          "answer_question_headings",
          "pass",
          "An extracted heading ends with a question mark.",
        )
      : scan.headings
        ? finding(
            "answer_question_headings",
            "warn",
            "Extracted headings contain no question heading.",
          )
        : finding(
            "answer_question_headings",
            "fail",
            "No supported headings were found in the extracted Markdown.",
          );

  const prose = scan ? scan.firstProse : text.trim().split(/\r?\n[ \t]*\r?\n/, 1)[0];
  let wordCount = 0;
  for (const segment of words.segment(prose)) {
    if (segment.isWordLike && ++wordCount > 80) break;
  }
  const lead =
    !scan && !prose
      ? finding("answer_direct_lead", "not_applicable", "No extracted content was supplied.")
      : !prose
        ? finding("answer_direct_lead", "fail", "The extracted content contains no prose lead.")
        : wordCount >= 15 && wordCount <= 80
          ? finding(
              "answer_direct_lead",
              "pass",
              "The first prose paragraph contains 15 to 80 words.",
            )
          : finding(
              "answer_direct_lead",
              "warn",
              "The first prose paragraph is outside the 15 to 80 word range.",
            );

  const chunkability = scan ? Number(scan.sections >= 2) + Number(scan.hasListOrTable) : 0;
  const chunks = !scan
    ? finding("answer_chunkable_sections", "not_applicable", "No extracted Markdown was supplied.")
    : chunkability === 2
      ? finding(
          "answer_chunkable_sections",
          "pass",
          "At least two headed sections contain prose, and a list or table is present.",
        )
      : chunkability === 1
        ? finding(
            "answer_chunkable_sections",
            "warn",
            "Only one of the section and list-or-table signals is present.",
          )
        : finding(
            "answer_chunkable_sections",
            "fail",
            "The extracted Markdown lacks both chunkability signals.",
          );
  return [heading, lead, chunks];
}
