import type { Handlers } from "../app.js";
import { auditPage } from "../domain/audit.js";
import type { AiCrawler, AuditRequest } from "../domain/types.js";
import { checkCrawlerAccess, type CrawlerCheckRequest } from "../domain/crawler-access.js";

export function createHandlers(crawlers: readonly AiCrawler[]): Handlers {
  return {
    auditPage: async (request) => auditPage(request.body as AuditRequest, crawlers),
    checkCrawlerAccess: async (request) =>
      checkCrawlerAccess(request.body as CrawlerCheckRequest, crawlers),
  };
}
