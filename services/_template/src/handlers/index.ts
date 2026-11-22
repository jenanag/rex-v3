import type { components } from "../../contract/types.js";
import type { Handlers } from "../app.js";
import { echo } from "../domain/echo.js";

export const handlers: Handlers = {
  echoText: async (request) => echo(request.body as components["schemas"]["EchoRequest"]),
};
