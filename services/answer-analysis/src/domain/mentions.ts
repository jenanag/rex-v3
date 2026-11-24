import type { components } from "../../contract/types.js";

type Brand = Pick<components["schemas"]["TrackedBrand"], "key" | "name" | "aliases">;
type Mention = Pick<
  components["schemas"]["MentionDetail"],
  "position" | "occurrences" | "snippet"
> & { brandKey: Brand["key"] };

export type Span = { start: number; end: number };

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
    let reorderedMarks: { start: number; value: string } | undefined;
    if (split) {
      const base = split.normalize("NFD");
      const marks = original.slice(split.length).normalize("NFD");
      const middle = start + split.length;
      // Preserve the source boundary after punctuation when the pieces
      // stay in that order after decomposition.
      if (base + marks === decomposed) {
        yield { normalized: base, start, end: middle };
        yield { normalized: marks, start: middle, end };
        continue;
      }
      if (!wordAtEnd.test(split)) reorderedMarks = { start: middle, value: marks };
    }
    const normalized = decomposed.replace(
      /(\p{L})(\p{M}+)/gu,
      (_, letter: string, marks: string) => letter + marks.replace(/[\p{M}&&\p{Diacritic}]/gv, ""),
    );
    yield { normalized, start, end, reorderedMarks };
  }
}

function searchText(text: string) {
  const wordAtOffset = /[\p{L}\p{N}\p{M}\p{Pc}]/uy;
  const parts: string[] = [];
  const starts: (number | undefined)[] = [];
  const ends: (number | undefined)[] = [];
  const reordered: { start: number; marks: string; next: number; end?: number }[] = [];
  let wordBefore = false;
  for (const { normalized, start, end, reorderedMarks } of normalizedParts(text)) {
    parts.push(normalized);
    // Only whole source spans with valid original boundaries can match.
    // A symbol such as ≠ can introduce a combining mark during decomposition.
    wordAtOffset.lastIndex = end;
    const wordAfter = wordAtOffset.test(text);
    for (let i = 0; i < normalized.length; i++) {
      starts.push(i === 0 && !wordBefore ? start : undefined);
      ends.push(i === normalized.length - 1 && !wordAfter ? end : undefined);
    }
    if (reorderedMarks) {
      reordered.push({
        start: reorderedMarks.start,
        marks: reorderedMarks.value,
        next: ends.length,
        end: wordAfter ? undefined : end,
      });
    }
    wordBefore = wordAtEnd.test(text.slice(start, end));
  }
  return { value: parts.join(""), starts, ends, reordered };
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
  return { search, alternatives, maxLength: candidates[0].length };
}

type Matcher = NonNullable<ReturnType<typeof matcher>>;
type SearchText = ReturnType<typeof searchText>;

function* canonicalMatches(
  { search, alternatives }: Matcher,
  { value, starts, ends, reordered }: SearchText,
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
        // An earlier match from a reordered boundary may overlap this one.
        if (reordered.length === 0) continue;
      }
    }
    const character = value.codePointAt(offset)!;
    search.lastIndex = offset + (character > 0xffff ? 2 : 1);
  }
}

function* reorderedMatches(
  { alternatives, maxLength }: Matcher,
  { value, ends, reordered }: SearchText,
): Generator<Span> {
  for (const { start, marks, next, end: marksEnd } of reordered) {
    const room = maxLength - marks.length;
    if (room < 0) continue;
    // Normalize the original suffix independently at this boundary. The
    // canonical view still preserves the whole symbol sequence for other matches.
    const suffix = marks + value.slice(next, next + room + 1);
    for (const literal of alternatives) {
      literal.lastIndex = 0;
      if (!literal.test(suffix)) continue;
      const consumedAfterMarks = literal.lastIndex - marks.length;
      if (consumedAfterMarks < 0) continue;
      const end = consumedAfterMarks === 0 ? marksEnd : ends[next + consumedAfterMarks - 1];
      if (end !== undefined) {
        yield { start, end };
        break;
      }
    }
  }
}

function* brandMatches(pattern: Matcher, indexedText: SearchText): Generator<Span> {
  const suffixes = reorderedMatches(pattern, indexedText);
  let suffix = suffixes.next();
  for (const span of canonicalMatches(pattern, indexedText)) {
    while (!suffix.done && suffix.value.start < span.start) {
      yield suffix.value;
      suffix = suffixes.next();
    }
    yield span;
  }
  while (!suffix.done) {
    yield suffix.value;
    suffix = suffixes.next();
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

export function findMentionOccurrences(text: string, brands: readonly Brand[]) {
  const indexedText = searchText(text);
  const found: { brandKey: string; spans: Span[]; index: number }[] = [];

  for (const [index, brand] of brands.entries()) {
    const pattern = matcher(brand);
    if (!pattern) continue;
    let lastEnd = 0;
    const spans: Span[] = [];
    for (const span of brandMatches(pattern, indexedText)) {
      if (span.start < lastEnd) continue;
      lastEnd = span.end;
      spans.push(span);
    }
    if (spans.length) found.push({ brandKey: brand.key, spans, index });
  }

  if (found.length === 0) return [];
  const snippet = snippets(text);
  return found
    .sort((a, b) => a.spans[0].start - b.spans[0].start || a.index - b.index)
    .map(({ brandKey, spans }, index) => ({
      spans,
      mention: {
        brandKey,
        position: index + 1,
        occurrences: spans.length,
        snippet: snippet(spans[0]),
      } satisfies Mention,
    }));
}

export function detectMentions(text: string, brands: readonly Brand[]): Mention[] {
  return findMentionOccurrences(text, brands).map(({ mention }) => mention);

}
