import type { components } from "../../contract/types.js";

type Brand = Pick<components["schemas"]["TrackedBrand"], "key" | "name" | "aliases">;
type Mention = Pick<
  components["schemas"]["MentionDetail"],
  "position" | "occurrences" | "snippet"
> & { brandKey: Brand["key"] };

type Span = { start: number; end: number };

const wordAtEnd = /[\p{L}\p{N}\p{M}\p{Pc}]$/u;
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });
const snippetLimit = 500;

function* normalizedParts(value: string) {
  // Keep base characters with their marks so NFD can reorder the marks.
  for (const part of value.matchAll(/\P{M}\p{M}*|\p{M}+/gu)) {
    const original = part[0];
    const start = part.index;
    const end = start + original.length;
    const decomposed = original.normalize("NFD");
    const split = /^[^\p{L}\p{M}](?=\p{M})/u.exec(original)?.[0];
    if (split) {
      const base = split.normalize("NFD");
      const marks = original.slice(split.length).normalize("NFD");
      // Preserve the source boundary after punctuation when the pieces
      // stay in that order after decomposition.
      if (base + marks === decomposed) {
        const middle = start + split.length;
        yield { normalized: base, start, end: middle };
        yield { normalized: marks, start: middle, end };
        continue;
      }
    }
    const normalized = decomposed.replace(
      /(\p{L})(\p{M}+)/gu,
      (_, letter: string, marks: string) => letter + marks.replace(/[\p{M}&&\p{Diacritic}]/gv, ""),
    );
    yield { normalized, start, end };
  }
}

function searchText(text: string) {
  const wordAtOffset = /[\p{L}\p{N}\p{M}\p{Pc}]/uy;
  const parts: string[] = [];
  const starts: (number | undefined)[] = [];
  const ends: (number | undefined)[] = [];
  let wordBefore = false;
  for (const { normalized, start, end } of normalizedParts(text)) {
    parts.push(normalized);
    // Only whole source spans with valid original boundaries can match.
    // A symbol such as ≠ can introduce a combining mark during decomposition.
    wordAtOffset.lastIndex = end;
    const wordAfter = wordAtOffset.test(text);
    for (let i = 0; i < normalized.length; i++) {
      starts.push(i === 0 && !wordBefore ? start : undefined);
      ends.push(i === normalized.length - 1 && !wordAfter ? end : undefined);
    }
    wordBefore = wordAtEnd.test(text.slice(start, end));
  }
  return { value: parts.join(""), starts, ends };
}

function matcher(brand: Brand) {
  const alternatives: RegExp[] = [];
  const candidates = [brand.name, ...brand.aliases]
    .map((value) => Array.from(normalizedParts(value.trim()), (part) => part.normalized).join(""))
    .sort((a, b) => b.length - a.length);

  for (const candidate of candidates) {
    if (
      !candidate ||
      alternatives.some((literal) => {
        literal.lastIndex = 0;
        return literal.exec(candidate)?.[0].length === candidate.length;
      })
    )
      continue;
    const source = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    alternatives.push(new RegExp(source, "iyu"));
  }
  if (alternatives.length === 0) return undefined;

  // Unicode-aware ignoreCase uses Unicode simple case folding.
  const search = new RegExp(alternatives.map(({ source }) => source).join("|"), "giu");
  return { search, alternatives };
}

function* brandMatches(
  { search, alternatives }: NonNullable<ReturnType<typeof matcher>>,
  { value, starts, ends }: ReturnType<typeof searchText>,
): Generator<Span> {
  for (let match = search.exec(value); match; match = search.exec(value)) {
    const offset = match.index;
    const start = starts[offset];
    if (start !== undefined) {
      let end = ends[search.lastIndex - 1];
      if (end === undefined) {
        // A shorter alias can end at a valid boundary when the longest cannot.
        for (const literal of alternatives) {
          literal.lastIndex = offset;
          if (!literal.test(value)) continue;
          end = ends[literal.lastIndex - 1];
          if (end !== undefined) {
            search.lastIndex = literal.lastIndex;
            break;
          }
        }
      }
      if (end !== undefined) {
        yield { start, end };
        continue;
      }
    }
    const character = value.codePointAt(offset)!;
    search.lastIndex = offset + (character > 0xffff ? 2 : 1);
  }
}

function snippets(text: string) {
  const offsets = [0];
  for (const character of text) offsets.push(offsets[offsets.length - 1] + character.length);
  const length = offsets.length - 1;
  if (length <= snippetLimit) return () => text;

  const segments = graphemes.segment(text);
  const floor = (offset: number) => segments.containing(offset)?.index ?? offset;

  return (first: Span) => {
    const start = offsets.indexOf(first.start);
    const end = offsets.indexOf(first.end);
    const room = snippetLimit - (end - start);
    if (room < 0) {
      const cap = offsets[start + snippetLimit];
      const complete = floor(cap);
      return text.slice(first.start, complete > first.start ? complete : cap);
    }

    const left = Math.max(0, Math.min(start - Math.floor(room / 2), length - snippetLimit));
    const rawStart = offsets[left];
    const rawEnd = offsets[left + snippetLimit];
    const segment = segments.containing(rawStart);
    const completeStart =
      segment && segment.index < rawStart ? segment.index + segment.segment.length : rawStart;
    return text.slice(Math.min(completeStart, first.start), Math.max(floor(rawEnd), first.end));
  };
}

export function detectMentions(text: string, brands: readonly Brand[]): Mention[] {
  const indexedText = searchText(text);
  const found: { brandKey: string; occurrences: number; first: Span; index: number }[] = [];

  for (const [index, brand] of brands.entries()) {
    const pattern = matcher(brand);
    if (!pattern) continue;
    let first: Span | undefined;
    let occurrences = 0;
    for (const span of brandMatches(pattern, indexedText)) {
      first ??= span;
      occurrences++;
    }
    if (first) found.push({ brandKey: brand.key, occurrences, first, index });
  }

  if (found.length === 0) return [];
  const snippet = snippets(text);
  return found
    .sort((a, b) => a.first.start - b.first.start || a.index - b.index)
    .map(({ brandKey, occurrences, first }, index) => ({
      brandKey,
      position: index + 1,
      occurrences,
      snippet: snippet(first),
    }));
}
