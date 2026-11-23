import { answerChecks } from "./answer-readiness.js";
import {
  crawlerChecks,
  inspectPage,
  readPageDirectives,
  technicalChecks,
} from "./page-evidence.js";
import {
  entityChecks,
  freshnessCheck,
  readStructuredData,
  structuredChecks,
} from "./structured-evidence.js";
import {
  finding,
  type AiCrawler,
  type AuditCategory,
  type AuditRequest,
  type AuditResult,
  type Finding,
} from "./types.js";

const categoryOrder: readonly AuditCategory[] = [
  "crawler_access",
  "structured_data",
  "llms_txt",
  "answer_readiness",
  "entity_signals",
  "technical",
  "freshness",
];

function llmsTxtCheck(result: AuditRequest["llmsTxt"]): Finding {
  const id = "llms_txt_valid";
  if (!result) return finding(id, "not_applicable", "No llms.txt validation result was supplied.");
  const { url, httpStatus, found, valid, issues } = result;
  if (url !== null && (httpStatus === null || (httpStatus >= 500 && httpStatus < 600)))
    return finding(id, "warn", "The supplied llms.txt fetch did not establish file validity.");
  if (
    !found ||
    !valid ||
    issues.some(({ severity }) => severity === "error") ||
    (httpStatus !== null && (httpStatus < 200 || httpStatus >= 300))
  )
    return finding(id, "fail", "The supplied llms.txt result is missing or invalid.");
  return issues.some(({ severity }) => severity === "warning")
    ? finding(id, "warn", "The supplied llms.txt result is valid with warnings.")
    : finding(id, "pass", "The supplied llms.txt result is valid without warnings.");
}

function score(
  findings: ReadonlyMap<AuditCategory, Finding[]>,
): Pick<AuditResult, "score" | "checks" | "categoryScores"> {
  const checks: AuditResult["checks"] = [];
  const categoryScores: AuditResult["categoryScores"] = [];
  // Use integer fractions so half-up rounding does not depend on floating-point summation.
  let numerator = 0;
  let denominator = 1;
  for (const [category, items] of findings) {
    let applicable = 0;
    let points = 0;
    for (const item of items) {
      checks.push({ ...item, category });
      if (item.result === "not_applicable") continue;
      applicable++;
      if (item.result === "pass") points += 100;
      if (item.result === "warn") points += 50;
    }
    if (!applicable) continue;
    categoryScores.push({ category, score: Math.round(points / applicable) });
    numerator = numerator * applicable + points * denominator;
    denominator *= applicable;
  }
  const overall = categoryScores.length
    ? Math.round(numerator / (denominator * categoryScores.length))
    : 0;
  return { score: overall, checks, categoryScores };
}

export function auditPage(input: AuditRequest, crawlers: readonly AiCrawler[]): AuditResult {
  const categories = categoryOrder.filter(
    (category) => !input.categories || input.categories.includes(category),
  );
  const needsPage = categories.some(
    (category) => category !== "llms_txt" && category !== "answer_readiness",
  );
  const evidence = needsPage ? inspectPage(input.page) : undefined;
  const dom = evidence?.dom;
  const needsStructure = categories.some(
    (category) =>
      category === "structured_data" || category === "entity_signals" || category === "freshness",
  );
  const blocks = needsStructure ? readStructuredData(dom) : [];
  const nodes = blocks.flatMap((block) => block?.nodes ?? []);
  const directives =
    categories.includes("crawler_access") || categories.includes("technical")
      ? readPageDirectives(input.page, dom, crawlers)
      : undefined;

  const evaluate: Record<AuditCategory, () => Finding[]> = {
    crawler_access: () => crawlerChecks(input.robotsTxt, evidence?.finalUrl, crawlers, directives!),
    structured_data: () => structuredChecks(dom, blocks),
    llms_txt: () => [llmsTxtCheck(input.llmsTxt)],
    answer_readiness: () => answerChecks(input.content),
    entity_signals: () => entityChecks(dom, nodes),
    technical: () => technicalChecks(input.page, evidence!, directives!),
    freshness: () => [freshnessCheck(dom, nodes, input.content.text)],
  };
  const findings = new Map(categories.map((category) => [category, evaluate[category]()]));
  return { url: input.url, finalUrl: input.page.finalUrl, ...score(findings) };
}
