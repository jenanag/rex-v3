import type { Pack } from "../lexicons/index.js";
import type { Span } from "./mentions.js";

export type Occurrence = Span & { brandKey: string };
export type Word = Span & { value: string };

const sentences = new Intl.Segmenter("en", { granularity: "sentence" });
const wordSource = `[\\p{L}\\p{N}\\p{M}\\p{Pc}]+(?:['’][\\p{L}\\p{M}]+)*`;
const wordPattern = new RegExp(wordSource, "gu");
const delimiters = new RegExp("[,;]|" + wordSource, "gu");

export function words(text: string, offset = 0): Word[] {
  return Array.from(text.matchAll(wordPattern), (match) => ({
    start: offset + match.index,
    end: offset + match.index + match[0].length,
    value: match[0].toLowerCase().replaceAll("’", "'"),
  }));
}

export function firstAt<T>(items: readonly T[], predicate: (item: T) => boolean) {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (predicate(items[middle])) high = middle;
    else low = middle + 1;
  }
  return low;
}

export function coveredBy(occurrences: readonly Occurrence[]) {
  const merged: Span[] = [];
  for (const { start, end } of occurrences) {
    const last = merged.at(-1);
    if (last && last.end > start) last.end = Math.max(last.end, end);
    else merged.push({ start, end });
  }
  return {
    intersects(span: Span) {
      const index = firstAt(merged, (part) => part.end > span.start);
      return index < merged.length && merged[index].start < span.end;
    },
    containsBoundary(offset: number) {
      const index = firstAt(merged, (part) => part.end > offset);
      return index < merged.length && merged[index].start < offset;
    },
  };
}

export type Clause = {
  end: number;
  words: Word[];
  occurrences: Occurrence[];
};

export function* clauses(
  text: string,
  pack: Pack,
  occurrences: Occurrence[],
  covered: ReturnType<typeof coveredBy>,
): Generator<Clause> {
  let start = 0;
  let nextOccurrence = 0;
  function take(end: number, next: number): Clause | undefined {
    // A delimiter inside an accepted name or alias must not split that occurrence.
    if (next > end ? covered.intersects({ start: end, end: next }) : covered.containsBoundary(end))
      return;
    const selected: Occurrence[] = [];
    while (nextOccurrence < occurrences.length && occurrences[nextOccurrence].start < end) {
      selected.push(occurrences[nextOccurrence++]);
    }
    const result = selected.length
      ? { end, words: words(text.slice(start, end), start), occurrences: selected }
      : undefined;
    start = next;
    return result;
  }

  for (const sentence of sentences.segment(text)) {
    for (const match of sentence.segment.matchAll(delimiters)) {
      if (match[0] !== "," && match[0] !== ";" && !pack.contrasts.includes(match[0].toLowerCase()))
        continue;
      const end = sentence.index + match.index;
      const result = take(end, end + match[0].length);
      if (result) yield result;
    }
    const end = sentence.index + sentence.segment.length;
    const result = take(end, end);
    if (result) yield result;
  }
}
