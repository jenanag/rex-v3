import { Lexer, Tokenizer, type Links, type Token, type Tokens } from "marked";
import entityData from "./html-entities.json" with { type: "json" };

const entities: Readonly<Record<string, string>> = entityData;
const reference = /&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]*);/giu;

function decodeReference(raw: string, name: string): string {
  if (name[0] !== "#") return Object.hasOwn(entities, name) ? entities[name] : raw;
  const hex = name[1]?.toLowerCase() === "x";
  const value = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
  if (value === 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return "\ufffd";
  return String.fromCodePoint(value);
}

function decodeDestination(source: string): string {
  const value = source.startsWith("<") ? source.slice(1, -1) : source;
  // Consume Markdown escapes and references in one pass so an escaped ampersand
  // or an ampersand produced by a reference is never decoded again.
  return value.replace(
    /\\([\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e])|&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]*);/giu,
    (raw: string, escaped: string | undefined, name: string) =>
      escaped ?? decodeReference(raw, name),
  );
}

class CitationTokenizer extends Tokenizer {
  override link(source: string) {
    if (this.lexer.state.inRawBlock) return;
    const token = super.link(source);
    // Use Marked's own grammar on the consumed token to recover the destination
    // before Marked removes punctuation escapes. Leave link recognition to Marked.
    const href = token && this.rules.inline.link.exec(token.raw)?.[2];
    if (token && href !== undefined) token.href = decodeDestination(href.trim());
    return token;
  }

  override reflink(source: string, links: Links) {
    if (!this.lexer.state.inRawBlock) return super.reflink(source, links);
  }

  override autolink(source: string) {
    if (!this.lexer.state.inRawBlock) return super.autolink(source);
  }

  override def(source: string) {
    const token = super.def(source);
    const href = token && this.rules.block.def.exec(token.raw)?.[2];
    if (token && href !== undefined) token.href = decodeDestination(href);
    return token;
  }
}

function children(token: Token): Token[] {
  if (token.type === "list") return (token as Tokens.List).items;
  return "tokens" in token && Array.isArray(token.tokens) ? token.tokens : [];
}

function labelText(tokens: readonly Token[]): string {
  return tokens
    .map((token) => {
      switch (token.type) {
        case "br":
          return " ";
        case "text": {
          const text = token as Tokens.Text;
          return text.tokens
            ? labelText(text.tokens)
            : text.text.replace(reference, decodeReference);
        }
        case "codespan":
        case "escape":
          return (token as Tokens.Codespan | Tokens.Escape).text;
        default:
          return labelText(children(token));
      }
    })
    .join("");
}

export function* markdownLinks(markdown: string) {
  const pending: Token[] = Lexer.lex(markdown, {
    gfm: false,
    tokenizer: new CitationTokenizer(),
  }).reverse();
  while (pending.length) {
    const token = pending.pop()!;
    if (token.type === "link") {
      const link = token as Tokens.Link;
      const title = link.raw.startsWith("<") ? link.text : labelText(link.tokens);
      yield { href: link.href, title: title.trim() || null };
    } else if (token.type !== "image") {
      const nested = children(token);
      for (let index = nested.length - 1; index >= 0; index--) pending.push(nested[index]);
    }
  }
}
