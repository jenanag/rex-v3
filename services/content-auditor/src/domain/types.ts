import type { components } from "../../contract/types.js";

export type AuditRequest = components["schemas"]["AuditRequest"];
export type AuditResult = components["schemas"]["AuditResult"];
export type AuditCategory = components["schemas"]["AuditCategory"];
export type AuditCheck = components["schemas"]["AuditCheck"];
export type AiCrawler = components["schemas"]["AiCrawler"];
export type Finding = Omit<AuditCheck, "category">;

export function finding(id: string, result: Finding["result"], message: string): Finding {
  return { id, result, message };
}

export function httpUrl(value: string, base?: URL): URL | undefined {
  const url = URL.parse(value, base);
  return url?.protocol === "http:" || url?.protocol === "https:" ? url : undefined;
}
