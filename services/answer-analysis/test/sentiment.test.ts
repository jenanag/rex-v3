import { expect, test } from "vitest";
import { analyze } from "../src/domain/analysis.js";

const acme = {
  kind: "primary" as const,
  key: "acme",
  name: "Acme",
  aliases: ["Café"],
  domains: [],
};
const beta = { ...acme, key: "beta", name: "Beta", aliases: [] };

function run(text: string, analyzers: ("det:lexicon" | "det:rules")[], brands = [acme, beta]) {
  const outcome = analyze(
    { text, brands },
    { analyzers, language: "en", onUnsupportedLanguage: "fallback" },
  );
  if (!("result" in outcome)) throw new Error("Expected successful English analysis");
  return outcome.result.mentions;
}

test("lexicon handles conflicting cues, original occurrence spans, and cue-free mentions", () => {
  const text = "Cafe\u0301 is good. ACME is bad. Beta is mentioned.";
  expect(run(text, ["det:lexicon"])).toMatchObject([
    {
      brandKey: "acme",
      position: 1,
      occurrences: 2,
      snippet: text,
      sentiment: "neutral",
      sentimentScore: 0,
      agreement: null,
      sentimentByAnalyzer: [{ status: "ok", rationale: "good (+0.5); bad (-0.5)" }],
    },
    {
      brandKey: "beta",
      position: 2,
      occurrences: 1,
      snippet: text,
      sentiment: "neutral",
      sentimentScore: 0,
      sentimentByAnalyzer: [{ rationale: "No lexicon cues" }],
    },
  ]);
});

test.each([
  ["Acme is not very good.", -0.75, "negative", "not very good (-0.75)"],
  ["Acme is never not good.", 0.5, "positive", "never not good (+0.5)"],
  ["Acme is very slightly good.", 0.25, "neutral", "slightly good (+0.25)"],
  ["Acme isn’t good.", -0.5, "negative", "isn’t good (-0.5)"],
  ["Acme is slightly bad.", -0.25, "neutral", "slightly bad (-0.25)"],
  ["Acme is very unusable.", -1, "negative", "very unusable (-1)"],
  [
    "Acme is good. Acme is great. Acme is bad. Acme is good.",
    0.313,
    "positive",
    "good (+0.5); great (+0.75); bad (-0.5)",
  ],
  ["Acme has a b c d good.", 0.5, "positive", "good (+0.5)"],
  ["Acme has a b c d e good.", 0, "neutral", "No lexicon cues"],
  ["Acme. Good.", 0, "neutral", "No lexicon cues"],
  ["Acme, good; great but bad.", 0, "neutral", "No lexicon cues"],
])("lexicon scores %s", (text, sentimentScore, sentiment, rationale) => {
  expect(run(text, ["det:lexicon"])[0]).toMatchObject({
    sentiment,
    sentimentScore,
    sentimentByAnalyzer: [{ rationale }],
  });
});

test("a cue belongs to the nearest brand, and cross-brand ties and brand-name cues are excluded", () => {
  const brands = [acme, beta, { ...beta, key: "great", name: "Great" }];
  expect(
    run(
      "Acme good Beta. Acme is good, but Beta is bad. Great was mentioned.",
      ["det:lexicon"],
      brands,
    ),
  ).toMatchObject([
    { brandKey: "acme", sentimentScore: 0.5, sentimentByAnalyzer: [{ rationale: "good (+0.5)" }] },
    { brandKey: "beta", sentimentScore: -0.5, sentimentByAnalyzer: [{ rationale: "bad (-0.5)" }] },
    { brandKey: "great", sentimentScore: 0 },
  ]);
  expect(run("Acme good Acme.", ["det:lexicon"])[0].sentimentByAnalyzer[0].rationale).toBe(
    "good (+0.5)",
  );
});

test.each([
  [
    "Acme is better than Beta.",
    0.75,
    -0.75,
    "better than Beta (+0.75)",
    "Acme is better than Beta (-0.75)",
  ],
  [
    "Acme is worse than Beta.",
    -0.75,
    0.75,
    "worse than Beta (-0.75)",
    "Acme is worse than Beta (+0.75)",
  ],
  ["I prefer Acme over Beta.", 0.75, -0.75, "over Beta (+0.75)", "prefer Acme over Beta (-0.75)"],
  ["I recommend Acme but avoid Beta.", 0.75, -0.75, "recommend Acme (+0.75)", "avoid Beta (-0.75)"],
  ["Acme is a top pick. Beta is mentioned.", 0.75, 0, "is a top pick (+0.75)", "No rule cues"],
  ["Acme is not better than Beta. I do not recommend Acme.", 0, 0, "No rule cues", "No rule cues"],
  ["I don’t recommend Acme. We shouldn't avoid Beta.", 0, 0, "No rule cues", "No rule cues"],
  ["Acme is better than Café. Beta is mentioned.", 0, 0, "No rule cues", "No rule cues"],
  [
    "Acme is better than Beta. Avoid Acme.",
    0,
    -0.75,
    "better than Beta (+0.75); Avoid Acme (-0.75)",
    "Acme is better than Beta (-0.75)",
  ],
])("rules score %s", (text, acmeScore, betaScore, acmeRationale, betaRationale) => {
  expect(run(text, ["det:rules"])).toMatchObject([
    {
      brandKey: "acme",
      sentimentScore: acmeScore,
      sentimentByAnalyzer: [{ rationale: acmeRationale }],
    },
    {
      brandKey: "beta",
      sentimentScore: betaScore,
      sentimentByAnalyzer: [{ rationale: betaRationale }],
    },
  ]);
});

test("rules skip ambiguous shared slots and consume a matching rule before considering overlapping rules", () => {
  const brands = [acme, { ...beta, aliases: ["Café"] }];
  expect(
    run("Recommend Cafe\u0301. Acme is better than Beta is a top pick.", ["det:rules"], brands),
  ).toMatchObject([
    {
      brandKey: "acme",
      occurrences: 2,
      sentimentScore: 0.75,
      sentimentByAnalyzer: [{ rationale: "better than Beta (+0.75)" }],
    },
    {
      brandKey: "beta",
      occurrences: 2,
      sentimentScore: -0.75,
      sentimentByAnalyzer: [{ rationale: "Acme is better than Beta (-0.75)" }],
    },
  ]);
});

test("rules recognize explicit punctuation-bearing mention spans", () => {
  const brands = [{ ...acme, name: "Acme, Inc.", aliases: [] }, beta];
  expect(run("Acme, Inc. is better than Beta.", ["det:rules"], brands)).toMatchObject([
    { brandKey: "acme", sentimentScore: 0.75 },
    { brandKey: "beta", sentimentScore: -0.75 },
  ]);
});
