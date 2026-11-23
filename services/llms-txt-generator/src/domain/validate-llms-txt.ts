import { fromMarkdown } from "mdast-util-from-markdown";
import type { components } from "../../contract/types.js";

type Issue = components["schemas"]["ValidationIssue"];
type Validation = components["schemas"]["LlmsTxtValidation"];
type ValidationRequest = components["schemas"]["LlmsTxtValidateRequest"];
type MarkdownNode = ReturnType<typeof fromMarkdown>["children"][number];
type Heading = Extract<MarkdownNode, { type: "heading" }>;
type List = Extract<MarkdownNode, { type: "list" }>;
type Inline = Heading["children"][number];

function hasLabel(nodes: readonly Inline[]): boolean {
  return nodes.some((node) => {
    if ("children" in node) return hasLabel(node.children);
    if (node.type === "text" || node.type === "inlineCode") return Boolean(node.value.trim());
    if (node.type === "image" || node.type === "imageReference") return Boolean(node.alt?.trim());
    return false;
  });
}

function linkDefinitions(blocks: readonly MarkdownNode[]) {
  const definitions = new Map<string, string>();
  const remaining = [...blocks].reverse();
  for (let node = remaining.pop(); node; node = remaining.pop()) {
    if (node.type === "definition" && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node.url);
    }
    if (node.type === "blockquote" || node.type === "list" || node.type === "listItem") {
      for (let index = node.children.length - 1; index >= 0; index--) {
        remaining.push(node.children[index]);
      }
    }
  }
  return definitions;
}

function validateMarkdown(content: string, fileUrl: string | null): Issue[] {
  const issues: Issue[] = [];
  const documentPointer = fileUrl === null ? "/content" : "/file/content";
  const report = (
    code: string,
    message: string,
    node?: MarkdownNode,
    severity: Issue["severity"] = "error",
  ) => {
    const line = node?.position?.start.line;
    issues.push({
      code,
      message,
      severity,
      pointer: line === undefined ? documentPointer : `line:${line}`,
    });
  };

  const markdown = content.replace(/^\uFEFF/, "");
  if (!markdown.trim()) {
    report("empty_file", "The llms.txt file is blank.");
    return issues;
  }

  const blocks = fromMarkdown(markdown).children;
  const title = blocks.find((node) => node.type === "heading" && node.depth === 1);
  if (!title) {
    report("missing_title", "A top-level H1 title is required.");
  } else if (blocks[0] !== title) {
    report("section_order", "The H1 title must come before the other blocks.", blocks[0]);
  }

  let definitions: Map<string, string> | undefined;
  function validateList(list: List) {
    for (const item of list.children) {
      const firstBlock = item.children.find((node) => node.type !== "definition");
      const firstInline = firstBlock?.type === "paragraph" ? firstBlock.children[0] : undefined;
      const lead =
        firstInline?.type === "link" || firstInline?.type === "linkReference"
          ? firstInline
          : undefined;
      let destination = lead?.type === "link" ? lead.url : undefined;
      if (lead?.type === "linkReference") {
        definitions ??= linkDefinitions(blocks);
        destination = definitions.get(lead.identifier);
      }

      if (!lead || !hasLabel(lead.children) || !destination?.trim()) {
        report(
          "invalid_file_list_entry",
          "A file-list item must start with a Markdown link with a label and destination.",
          item,
        );
      } else if (!URL.parse(destination, fileUrl ?? "https://example.invalid/")) {
        report("invalid_file_list_entry", "The file-list link destination is invalid.", lead);
      } else if (fileUrl === null && !URL.canParse(destination)) {
        report("relative_link", "A relative link needs the file URL as its base.", lead, "warning");
      }

      for (const block of item.children) {
        if (block.type === "list") validateList(block);
      }
    }
  }

  let section: Heading | undefined;
  let sectionHasContent = false;
  const checkSection = () => {
    if (section && !sectionHasContent) {
      report("missing_file_list", "An H2 section must contain a Markdown file list.", section);
    }
  };

  for (const block of blocks) {
    if (block.type === "definition") continue;
    if (block.type === "heading") {
      if (block.depth === 1) {
        if (block !== title) report("duplicate_title", "Only one top-level H1 is allowed.", block);
        else if (!hasLabel(block.children))
          report("missing_title", "The H1 title is empty.", block);
      } else if (block.depth === 2) {
        checkSection();
        section = block;
        sectionHasContent = false;
      } else {
        report("section_order", "Only H2 headings can start file-list sections.", block);
      }
    } else if (section) {
      sectionHasContent = true;
      if (block.type === "list") validateList(block);
      else
        report("section_order", "Place freeform details before the H2 file-list sections.", block);
    }
  }
  checkSection();

  return issues;
}

export function validateLlmsTxt(request: ValidationRequest): Validation {
  const file = "file" in request ? request.file : null;
  const url = file?.url ?? null;
  const httpStatus = file?.status ?? null;
  const content = "content" in request ? request.content : request.file.content;
  const failedFetch =
    file !== null && (httpStatus === null || httpStatus < 200 || httpStatus >= 300);
  if (failedFetch || content === null) {
    const issue: Issue = {
      severity: "error",
      code: "file_unavailable",
      message: failedFetch
        ? "The file fetch did not return a successful status."
        : "The fetch did not supply file content.",
      pointer: failedFetch ? "/file/status" : "/file/content",
    };
    return { found: false, valid: false, url, httpStatus, issues: [issue] };
  }

  const issues = validateMarkdown(content, url);
  return {
    found: true,
    valid: !issues.some(({ severity }) => severity === "error"),
    url,
    httpStatus,
    issues,
  };
}
