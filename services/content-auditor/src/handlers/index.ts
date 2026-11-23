import { readFileSync } from "node:fs";
import type { AiCrawler } from "../domain/types.js";
import { createHandlers } from "./create-handlers.js";

const crawlers = JSON.parse(
  readFileSync(new URL("../../ai-crawlers.json", import.meta.url), "utf8"),
) as AiCrawler[];

export const handlers = createHandlers(crawlers);
