import { createRequire } from "node:module";
import { load, type CheerioAPI } from "cheerio";
import { finding, httpUrl, type AiCrawler, type AuditRequest, type Finding } from "./types.js";

type Page = AuditRequest["page"];
const robotsParser = createRequire(import.meta.url)(
  "robots-parser",
) as typeof import("robots-parser").default;
type Directives = { deny: boolean; limit: boolean };
const newDirectives = (): Directives => ({ deny: false, limit: false });

function header(page: Page, name: string): string | undefined {
  const values = Object.entries(page.headers)
    .filter(([key]) => key.toLowerCase() === name)
    .map(([, value]) => value);
  return values.length > 0 ? values.join(", ") : undefined;
}

export function inspectPage(page: Page) {
  const media = header(page, "content-type")?.split(";", 1)[0].trim().toLowerCase();
  const eligibleHtml =
    page.status >= 200 &&
    page.status < 300 &&
    (media === undefined || media === "text/html" || media === "application/xhtml+xml");
  const dom =
    eligibleHtml && page.html.trim() ? load(page.html, { scriptingEnabled: false }) : undefined;
  return { eligibleHtml, dom, finalUrl: httpUrl(page.finalUrl) };
}

function restrict(target: Directives, clause: string) {
  for (const directive of clause.toLowerCase().split(/[\s,]+/)) {
    if (directive === "noindex" || directive === "none") target.deny = true;
    if (directive === "nofollow" || directive === "nosnippet") target.limit = true;
  }
}

export function readPageDirectives(
  page: Page,
  dom: CheerioAPI | undefined,
  crawlers: readonly AiCrawler[],
) {
  const generic = newDirectives();
  const named = newDirectives();
  const ambiguous = newDirectives();
  const tokens = new Set(crawlers.map(({ robotsToken }) => robotsToken.toLowerCase()));
  const value = header(page, "x-robots-tag");

  let scope: string | undefined;
  for (const clause of value?.split(",") ?? []) {
    const scoped = /^\s*([a-z][a-z\d_-]*)\s*:\s*(.*)$/i.exec(clause);
    if (
      scoped &&
      !/^(?:max-snippet|max-image-preview|max-video-preview|unavailable_after)$/i.test(scoped[1])
    ) {
      scope = scoped[1].toLowerCase();
      if (tokens.has(scope)) restrict(named, scoped[2]);
    } else if (!scoped) {
      restrict(scope === undefined ? generic : ambiguous, clause);
    }
  }

  dom?.("meta[name]").each((_index, element) => {
    const name = dom(element).attr("name")?.trim().toLowerCase();
    const content = dom(element).attr("content") ?? "";
    if (name === "robots") restrict(generic, content);
    else if (name && tokens.has(name)) restrict(named, content);
  });

  return {
    generic,
    named,
    ambiguous: ambiguous.deny || ambiguous.limit,
    available: !!dom || value !== undefined,
  };
}

export function crawlerChecks(
  file: AuditRequest["robotsTxt"],
  finalUrl: URL | undefined,
  crawlers: readonly AiCrawler[],
  directives: ReturnType<typeof readPageDirectives>,
): Finding[] {
  const fileUrl = file && httpUrl(file.url);
  const sameOrigin = !!fileUrl && !!finalUrl && fileUrl.origin === finalUrl.origin;
  const status = file?.status;
  const parser =
    sameOrigin && status != null && status >= 200 && status < 300 && file?.content != null
      ? robotsParser(fileUrl.href, file.content)
      : undefined;
  const checks = crawlers.map(({ id, robotsToken }) => {
    const checkId = "robots_allows_" + id;
    if (!file) return finding(checkId, "not_applicable", "No robots.txt result was supplied.");
    const allowed =
      sameOrigin && status != null && status >= 400 && status < 500
        ? true
        : parser?.isAllowed(finalUrl!.href, robotsToken);
    if (allowed === undefined)
      return finding(checkId, "warn", "robots.txt access could not be determined for this page.");
    return allowed
      ? finding(checkId, "pass", "robots.txt allows this crawler to access the page.")
      : finding(checkId, "fail", "robots.txt blocks this crawler from accessing the page.");
  });

  const id = "crawler_page_directives";
  if (directives.named.deny)
    checks.push(finding(id, "fail", "A named crawler directive blocks indexing."));
  else if (directives.ambiguous || directives.named.limit)
    checks.push(
      finding(
        id,
        "warn",
        directives.ambiguous
          ? "A restrictive X-Robots-Tag clause has ambiguous crawler scope."
          : "A named crawler directive limits link following or snippets.",
      ),
    );
  else if (directives.available)
    checks.push(finding(id, "pass", "No supported restrictive named crawler directive was found."));
  else checks.push(finding(id, "not_applicable", "No HTML or page directive header was supplied."));
  return checks;
}

function canonicalCheck(dom: CheerioAPI | undefined, finalUrl: URL | undefined): Finding {
  const id = "canonical_url";
  if (!dom) return finding(id, "not_applicable", "No eligible HTML was supplied.");
  const links = dom("link[rel]")
    .toArray()
    .filter((element) =>
      dom(element).attr("rel")!.toLowerCase().split(/\s+/).includes("canonical"),
    );
  if (!links.length) return finding(id, "warn", "No canonical link was declared.");

  const targets = new Set<string>();
  let unresolved = false;
  for (const element of links) {
    const href = dom(element).attr("href")?.trim();
    if (!href) return finding(id, "fail", "A canonical link has no usable target.");
    const target = httpUrl(href, finalUrl);
    if (!target) {
      if (finalUrl || /^[a-z][a-z\d+.-]*:/i.test(href))
        return finding(id, "fail", "A canonical link has no usable HTTP(S) target.");
      unresolved = true;
      continue;
    }
    target.hash = "";
    targets.add(target.href);
  }
  if (targets.size > 1) return finding(id, "fail", "Canonical links declare different targets.");
  if (!finalUrl || unresolved)
    return finding(id, "warn", "The final URL cannot be compared with the canonical target.");
  const full = new URL(finalUrl);
  full.hash = "";
  return targets.has(full.href)
    ? finding(id, "pass", "The canonical target matches the final URL.")
    : finding(id, "warn", "The canonical target differs from the final URL.");
}

export function technicalChecks(
  page: Page,
  evidence: ReturnType<typeof inspectPage>,
  directives: ReturnType<typeof readPageDirectives>,
): Finding[] {
  const { dom, eligibleHtml, finalUrl } = evidence;
  const status = page.status;
  const httpStatus = finding(
    "http_status",
    status >= 200 && status < 300 ? "pass" : status >= 300 && status < 400 ? "warn" : "fail",
    "The final response reported HTTP " + status + ".",
  );
  const body = dom?.("body:not([hidden])")
    .filter((_index, element) => dom(element).parents("[hidden]").length === 0)
    .clone();
  body?.find("script, style, template, [hidden]").remove();
  const noscript = body?.find("noscript").text().trim();
  body?.find("noscript").remove();
  const rendered = "server_rendered_copy";
  const copy = !eligibleHtml
    ? finding(rendered, "not_applicable", "The response was not eligible HTML.")
    : body?.text().trim()
      ? finding(rendered, "pass", "The HTML body contains rendered copy.")
      : noscript
        ? finding(rendered, "warn", "Copy appears only in noscript.")
        : finding(rendered, "fail", "The HTML body has no rendered copy.");
  const indexability = "page_indexability";
  const index = directives.generic.deny
    ? finding(indexability, "fail", "A generic page directive blocks indexing.")
    : directives.available
      ? finding(indexability, "pass", "No supported generic directive blocks indexing.")
      : finding(indexability, "not_applicable", "No HTML or page directive header was supplied.");
  return [httpStatus, copy, canonicalCheck(dom, finalUrl), index];
}
