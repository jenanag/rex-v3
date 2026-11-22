import type { components } from "../../contract/types.js";
import { blocks, parseHtml, readMarkupBlock } from "./html.js";
import { expandDocument, vocabularyIssues } from "./json-ld.js";
import { validationResult, type Issue } from "./schema.js";

export async function validateDocument(document: unknown, root: string, pageUrl?: string) {
  const expanded = await expandDocument(document, root, pageUrl);
  return "issue" in expanded ? [expanded.issue] : vocabularyIssues(document, expanded.graph, root);
}

export async function validateMarkup(
  request: components["schemas"]["SchemaMarkupValidateRequest"],
) {
  if ("jsonLd" in request)
    return validationResult(await validateDocument(request.jsonLd, "/jsonLd"));

  const markupBlocks = blocks(parseHtml(request.html));
  if (!markupBlocks.length)
    return validationResult([
      {
        severity: "error",
        code: "missing_jsonld",
        message: "The supplied HTML contains no JSON-LD blocks.",
        pointer: "line:1",
      },
    ]);

  const issues: Issue[] = [];
  for (const block of markupBlocks) {
    const document = readMarkupBlock(block.text);
    if (document) {
      issues.push(...(await validateDocument(document.value, block.pointer, request.pageUrl)));
    } else {
      issues.push({
        severity: "error",
        code: "malformed_jsonld",
        message: "The embedded JSON-LD block contains malformed JSON.",
        pointer: block.pointer,
      });
    }
  }
  return validationResult(issues);
}
