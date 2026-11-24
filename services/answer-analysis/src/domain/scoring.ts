import type { components } from "../../contract/types.js";
import type { Pack } from "../lexicons/index.js";
import { firstAt, type Clause, type Occurrence, type Word } from "./context.js";

type Verdict = Pick<components["schemas"]["AnalyzerSentiment"], "label" | "score" | "rationale">;
type Contribution = { start: number; end: number; phrase: string; weight: number };
export type Contributions = Map<string, Contribution[]>;

function record(contributions: Contributions, brandKey: string, contribution: Contribution) {
  const values = contributions.get(brandKey);
  if (values) values.push(contribution);
  else contributions.set(brandKey, [contribution]);
}

function preceding(words: Word[], index: number, occupied: boolean[]) {
  const start = Math.max(0, index - 3);
  return words.slice(start, index).filter((_, i) => !occupied[start + i]);
}

function occupiedWords({ words, occurrences }: Clause) {
  const occupied = words.map(() => false);
  // A sweep over sorted spans also handles overlapping mentions across brands.
  let next = 0;
  let end = 0;
  for (const [index, word] of words.entries()) {
    while (next < occurrences.length && occurrences[next].start < word.end) {
      end = Math.max(end, occurrences[next++].end);
    }
    occupied[index] = end > word.start;
  }
  return occupied;
}

function mentionEdges({ words, occurrences }: Clause) {
  // Only a nearest endpoint can win on each side of a cue. Keep a second
  // distinct owner at the same endpoint to detect ambiguity.
  const before = new Map<number, Set<string>>();
  const after = new Map<number, Set<string>>();
  function add(edges: Map<number, Set<string>>, index: number, brandKey: string) {
    const owners = edges.get(index) ?? new Set<string>();
    if (owners.size < 2) owners.add(brandKey);
    edges.set(index, owners);
  }
  for (const { start, end, brandKey } of occurrences) {
    add(before, firstAt(words, (word) => word.start >= end) - 1, brandKey);
    add(
      after,
      firstAt(words, (word) => word.end > start),
      brandKey,
    );
  }
  return { before, after };
}

function nearestBrand(edges: ReturnType<typeof mentionEdges>, first: number, last: number) {
  for (let distance = 1; distance <= 6; distance++) {
    const left = edges.before.get(first - distance);
    // A symbol-only mention immediately after the last word shares the token
    // index of the next word, or the end of the token list.
    const right = edges.after.get(last + distance);
    if (!left && !right) continue;
    const owners = new Set([...(left ?? []), ...(right ?? [])]);
    return owners.size === 1 ? owners.values().next().value : undefined;
  }
}

function lexicon(text: string, clause: Clause, pack: Pack, contributions: Contributions) {
  const { words } = clause;
  const occupied = occupiedWords(clause);
  const edges = mentionEdges(clause);
  const cues = [...pack.cues].sort((a, b) => b.words.length - a.words.length);

  for (let i = 0; i < words.length; i++) {
    const cue = cues.find(
      ({ words: parts }) =>
        parts.every((part, offset) => !occupied[i + offset] && words[i + offset]?.value === part) &&
        parts
          .slice(1)
          .every((_, offset) =>
            /^\s+$/u.test(text.slice(words[i + offset].end, words[i + offset + 1].start)),
          ),
    );
    if (!cue) continue;
    const last = i + cue.words.length - 1;
    const brand = nearestBrand(edges, i, last);
    if (brand !== undefined) {
      const prefix = preceding(words, i, occupied);
      const negators = prefix.filter(({ value }) => pack.negators.includes(value));
      const modifier = prefix.findLast(({ value }) => pack.modifiers.has(value));
      const weight =
        cue.weight *
        (negators.length % 2 ? -1 : 1) *
        (modifier ? pack.modifiers.get(modifier.value)! : 1);
      const start = words[i].start;
      const end = words[last].end;
      record(contributions, brand, {
        start,
        end,
        phrase: text.slice(
          Math.min(start, negators[0]?.start ?? start, modifier?.start ?? start),
          end,
        ),
        weight: Math.max(-1, Math.min(1, weight)),
      });
    }
    i = last;
  }
}

function unambiguousSlots(occurrences: Occurrence[]) {
  const slots = new Map<number, Occurrence>();
  for (let i = 0; i < occurrences.length;) {
    const first = occurrences[i++];
    let end = first.end;
    let ambiguous = false;
    while (i < occurrences.length && occurrences[i].start < end) {
      ambiguous = true;
      end = Math.max(end, occurrences[i++].end);
    }
    if (!ambiguous) slots.set(first.start, first);
  }
  return slots;
}

function rulePatterns(pack: Pack) {
  return pack.rules.map(({ parts, weights, firstRationalePart }) => ({
    weights,
    firstRationalePart,
    parts: parts.map((part) =>
      part.startsWith("$")
        ? part
        : new RegExp(part.split(" ").join("\\s+") + "(?![\\p{L}\\p{N}\\p{M}\\p{Pc}])", "iuy"),
    ),
  }));
}

function rules(
  text: string,
  clause: Clause,
  pack: Pack,
  patterns: ReturnType<typeof rulePatterns>,
  contributions: Contributions,
) {
  const { words, occurrences, end } = clause;
  const occupied = occupiedWords(clause);
  const slots = unambiguousSlots(occurrences);
  const whitespace = /\s+/uy;
  const candidates = new Set([
    ...words.filter((_, index) => !occupied[index]).map((word) => word.start),
    ...slots.keys(),
  ]);
  let next = 0;
  for (const start of [...candidates].sort((a, b) => a - b)) {
    if (start < next) continue;
    const firstWord = firstAt(words, (word) => word.end > start);
    if (preceding(words, firstWord, occupied).some(({ value }) => pack.negators.includes(value)))
      continue;
    let best:
      | { end: number; targets: Occurrence[]; weights: number[]; firstRationaleStart: number }
      | undefined;
    for (const pattern of patterns) {
      let cursor = start;
      let firstRationaleStart = start;
      const targets: Occurrence[] = [];
      for (const [index, part] of pattern.parts.entries()) {
        if (index) {
          whitespace.lastIndex = cursor;
          if (!whitespace.test(text)) {
            cursor = -1;
            break;
          }
          cursor = whitespace.lastIndex;
        }
        if (cursor >= end) {
          cursor = -1;
          break;
        }
        if (index === pattern.firstRationalePart) firstRationaleStart = cursor;
        if (typeof part === "string") {
          const slot = slots.get(cursor);
          if (!slot || targets.some(({ brandKey }) => brandKey === slot.brandKey)) {
            cursor = -1;
            break;
          }
          targets.push(slot);
          cursor = slot.end;
        } else {
          part.lastIndex = cursor;
          if (!part.test(text)) {
            cursor = -1;
            break;
          }
          let wordIndex = firstAt(words, (word) => word.end > cursor);
          while (
            wordIndex < words.length &&
            words[wordIndex].start < part.lastIndex &&
            !occupied[wordIndex]
          )
            wordIndex++;
          if (wordIndex < words.length && words[wordIndex].start < part.lastIndex) {
            cursor = -1;
            break;
          }
          cursor = part.lastIndex;
        }
      }
      if (cursor > start && cursor <= end && (!best || cursor > best.end))
        best = { end: cursor, targets, weights: pattern.weights, firstRationaleStart };
    }
    if (!best) continue;
    next = best.end;
    for (const [index, target] of best.targets.entries()) {
      record(contributions, target.brandKey, {
        start,
        end: best.end,
        phrase: text.slice(index === 0 ? best.firstRationaleStart : start, best.end),
        weight: best.weights[index],
      });
    }
  }
}

export function createScorers(pack: Pack) {
  const patterns = rulePatterns(pack);
  return {
    "det:lexicon": (text: string, clause: Clause, result: Contributions) =>
      lexicon(text, clause, pack, result),
    "det:rules": (text: string, clause: Clause, result: Contributions) =>
      rules(text, clause, pack, patterns, result),
  };
}

export function verdict(contributions: Contribution[] = [], noCues: string): Verdict {
  if (!contributions.length) return { label: "neutral", score: 0, rationale: noCues };
  let total = 0;
  const rationale: string[] = [];
  let count = 0;
  let last: Contribution | undefined;
  for (const contribution of contributions) {
    if (last?.start === contribution.start && last.end === contribution.end) continue;
    last = contribution;
    total += contribution.weight;
    count++;
    if (rationale.length < 3) {
      const phrase = contribution.phrase.replace(/\s+/gu, " ");
      const signed = (contribution.weight > 0 ? "+" : "") + contribution.weight;
      rationale.push(phrase + " (" + signed + ")");
    }
  }
  const score = Math.round((total * 1000) / count) / 1000 || 0;
  return {
    label: score > 0.25 ? "positive" : score < -0.25 ? "negative" : "neutral",
    score,
    rationale: Array.from(rationale.join("; ")).slice(0, 300).join(""),
  };
}
