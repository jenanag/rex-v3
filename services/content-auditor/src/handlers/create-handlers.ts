import type { Handlers } from "../app.js";
import { auditPage } from "../domain/audit.js";
import type { AiCrawler, AuditRequest } from "../domain/types.js";
import { ToolProblem } from "../errors.js";

export function createHandlers(crawlers: readonly AiCrawler[]): Handlers {
  return {
    auditPage: async (request) => auditPage(request.body as AuditRequest, crawlers),
    checkCrawlerAccess: async () => {
      throw new ToolProblem(501, "not_implemented", "Operation is not implemented");
    },
  };
}
