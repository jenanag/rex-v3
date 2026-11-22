import type { components } from "../../contract/types.js";

export function echo(
  input: components["schemas"]["EchoRequest"],
): components["schemas"]["EchoResponse"] {
  return { text: input.uppercase ? input.text.toUpperCase() : input.text, usage: [] };
}
