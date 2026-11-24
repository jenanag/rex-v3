import { expect, test } from "vitest";
import { detectMentions } from "../src/domain/mentions.js";

function brand(key: string, name: string, aliases: string[] = []) {
  return { key, name, aliases };
}

test("matches composed and decomposed accents and preserves the original text", () => {
  const text = "CAFE\u0301, Café, and cafe.";
  expect(detectMentions(text, [brand("cafe", "cafe\u0301")])).toEqual([
    { brandKey: "cafe", position: 1, occurrences: 3, snippet: text },
  ]);
});

test("uses Unicode simple case folding, including both lowercase sigmas", () => {
  expect(detectMentions("ς σ Σ. SS ß.", [brand("sigma", "σ"), brand("eszett", "ß")])).toEqual([
    { brandKey: "sigma", position: 1, occurrences: 3, snippet: "ς σ Σ. SS ß." },
    { brandKey: "eszett", position: 2, occurrences: 1, snippet: "ς σ Σ. SS ß." },
  ]);
});

test("matches internal punctuation and spacing literally at Unicode word boundaries", () => {
  const text = "C++ C++17 C++四 C++_ C++\u0301 Café _Café Caféine ⅧCafé Café９ AT&T AT T A  B A B";
  const brands = [
    brand("missing", "C++++"),
    brand("spaces", "  A  B  ", [" ", "\t"]),
    brand("cafe", "Café"),
    brand("cpp", " C++ "),
    brand("att", "AT&T"),
  ];
  expect(detectMentions(text, brands)).toEqual(
    ["cpp", "cafe", "att", "spaces"].map((brandKey, index) => ({
      brandKey,
      position: index + 1,
      occurrences: 1,
      snippet: text,
    })),
  );
  expect(detectMentions(text, [brand("blank", " ", ["\t"])])).toEqual([]);
});

test("counts the leftmost non-overlapping matches and picks the longest at a shared start", () => {
  const text = "A B C. Café Labs and Café.";
  expect(
    detectMentions(text, [
      brand("partial", "A B", ["B C"]),
      brand("same-start", "A", ["A B", "B"]),
      brand("duplicate", "Café Labs", ["Cafe", "CAFÉ", "Café Labs"]),
    ]),
  ).toEqual([
    { brandKey: "partial", position: 1, occurrences: 1, snippet: text },
    { brandKey: "same-start", position: 2, occurrences: 1, snippet: text },
    { brandKey: "duplicate", position: 3, occurrences: 2, snippet: text },
  ]);
});

test("counts a shared alias independently and ranks ties in input brand order", () => {
  const text = "«CAFE\u0301 Labs» and Café. Caféine. _Café.";
  expect(
    detectMentions(text, [
      brand("north", "North", ["Café Labs"]),
      brand("cafe", "Café", ["Cafe", "Café Labs"]),
      brand("unmentioned", "West"),
    ]),
  ).toEqual([
    { brandKey: "north", position: 1, occurrences: 1, snippet: text },
    { brandKey: "cafe", position: 2, occurrences: 2, snippet: text },
  ]);
});

test("uses source boundaries around decomposed symbols", () => {
  const text = "≠A A BC";
  expect(detectMentions(text, [brand("a", "A", ["A B"]), brand("overlay", "\u0338")])).toEqual([
    { brandKey: "a", position: 1, occurrences: 2, snippet: text },
  ]);
});

test("splits a 500-code-point snippet around the first mention and shifts space at either end", () => {
  const tracked = [brand("cafe", "Café")];
  const left = "x".repeat(300);
  const right = "😀".repeat(300);
  const [middle] = detectMentions(left + " Café " + right, tracked);
  expect(middle.snippet).toBe("x".repeat(247) + " Café " + "😀".repeat(247));
  expect([...middle.snippet]).toHaveLength(500);

  const [first] = detectMentions("Café " + "😀".repeat(600), tracked);
  expect(first.snippet).toBe("Café " + "😀".repeat(495));

  const [last] = detectMentions("😀".repeat(600) + " Café", tracked);
  expect(last.snippet).toBe("😀".repeat(495) + " Café");
});

test("clips combining marks and joined emoji at grapheme boundaries", () => {
  const original = "Cafe\u0301";
  const left = "x".repeat(100) + "e\u0301" + "x".repeat(245) + " ";
  const right = " " + "y".repeat(246) + "👩‍💻" + "z".repeat(100);
  const [match] = detectMentions(left + original + right, [brand("cafe", "CAFÉ")]);
  expect(match.snippet).toBe("x".repeat(245) + " " + original + " " + "y".repeat(246));
  expect([...match.snippet]).toHaveLength(498);
});

test("clips an oversized match at a complete grapheme when one fits", () => {
  const first = "A" + "\u0301".repeat(299);
  const second = "B" + "\u0301".repeat(299);
  const [match] = detectMentions(first + second + "!", [brand("ab", "ab")]);
  expect(match.snippet).toBe(first);
});

test("clips by code point when a single matched grapheme exceeds 500", () => {
  const text = "A" + "\u0301".repeat(600);
  const [match] = detectMentions(text, [brand("a", "a")]);
  expect(match.snippet).toBe("A" + "\u0301".repeat(499));
});
