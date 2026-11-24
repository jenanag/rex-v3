import { readFileSync } from "node:fs";
import type { ToolSpec } from "../contract.js";
import { createHandlers } from "./create-handlers.js";

const spec = JSON.parse(
  readFileSync(new URL("../../contract.json", import.meta.url), "utf8"),
) as ToolSpec;

export const handlers = createHandlers(spec);
