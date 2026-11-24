import { isIP } from "node:net";
import type { components } from "../../contract/types.js";
import { markdownLinks } from "./markdown-links.js";

export type ExtractionRequest = components["schemas"]["CitationExtractionRequest"];
type Citation = components["schemas"]["CitationExtraction"]["citations"][number];
type Brand = ExtractionRequest["brands"][number];
type AddressChecks = { url(value: string): boolean; domain(value: string): boolean };

const normalizeHost = (value: string) => value.toLowerCase().replace(/\.$/u, "");

function citationAddress(value: string, check: AddressChecks) {
  const authority = /^https?:\/\/([^/?#]+)/iu.exec(value)?.[1];
  if (!authority || authority.startsWith(":") || authority.includes("@")) return undefined;
  // Prevent URL.parse from repairing a malformed absolute destination.
  if (/[\u0000-\u0020\u007f\\<>"`{}|^]|%(?![0-9a-f]{2})/iu.test(value)) return undefined;
  const parsed = URL.parse(value);
  if (!parsed) return undefined;
  const host = normalizeHost(parsed.hostname);
  if (!host) return undefined;
  parsed.hostname = host;
  parsed.hash = "";
  const url = parsed.href;
  const domain = host.replace(/^www\./u, "");
  if (!check.url(url) || !check.domain(domain)) return undefined;
  return { url, domain, host };
}

function brandDomains(brands: readonly Brand[]) {
  const domains = new Map<string, Brand>();
  for (const brand of brands) {
    for (const value of brand.domains) {
      const domain = normalizeHost(value);
      const existing = domains.get(domain);
      if (!existing || (brand.kind === "primary" && existing.kind !== "primary"))
        domains.set(domain, brand);
    }
  }
  return domains;
}

function findBrand(host: string, domains: ReadonlyMap<string, Brand>): Brand | undefined {
  const exact = domains.get(host);
  if (exact || isIP(host)) return exact;
  for (let dot = host.indexOf("."); dot !== -1; dot = host.indexOf(".", dot + 1)) {
    const suffix = host.slice(dot + 1);
    const brand = domains.get(suffix);
    if (brand && !isIP(suffix)) return brand;
  }
}

export function extractCitations(input: ExtractionRequest, check: AddressChecks) {
  const citations: Citation[] = [];
  const seen = new Set<string>();
  const domains = brandDomains(input.brands);
  function add(rawUrl: string, title: string | null, sourceType: Citation["sourceType"]) {
    const address = citationAddress(rawUrl, check);
    if (!address || seen.has(address.url)) return;
    seen.add(address.url);
    const brand = findBrand(address.host, domains);
    citations.push({
      url: address.url,
      domain: address.domain,
      title,
      position: citations.length + 1,
      sourceType,
      ownership: brand ? (brand.kind === "primary" ? "own" : "competitor") : "third_party",
      brandKey: brand?.key ?? null,
    });
  }

  // Node's stable sort retains the original order for equal engine positions.
  for (const source of input.sources.toSorted((left, right) => left.position - right.position))
    add(source.url, source.title ?? null, "engine_source");
  for (const { href, title } of markdownLinks(input.markdown)) add(href, title, "inline_link");
  return { citations };
}
