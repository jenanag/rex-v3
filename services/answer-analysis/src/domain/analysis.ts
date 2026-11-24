import type { components } from "../../contract/types.js";
import { packs } from "../lexicons/index.js";
import { clauses, coveredBy, words } from "./context.js";
import { findMentionOccurrences } from "./mentions.js";
import { createScorers, verdict, type Contributions } from "./scoring.js";

type Schemas = components["schemas"];
type AnalyzerSentiment = Schemas["AnalyzerSentiment"];
type AnalyzerRun = Schemas["AnalyzerRun"];

const descriptions = {
  "det:lexicon": "Scores English words and phrases around tracked brand mentions.",
  "det:rules":
    "Scores English comparison and recommendation patterns with explicit brand mentions.",
};
type AnalyzerId = keyof typeof descriptions;
const languages = [...packs.keys()];

export function listAnalyzers(): Schemas["Analyzer"][] {
  return Object.entries(descriptions).map(([id, description]) => ({
    id,
    kind: "deterministic",
    languages,
    description,
  }));
}

export function isAdvertised(id: string): id is AnalyzerId {
  return Object.hasOwn(descriptions, id);
}

function resolveLanguage(
  text: string,
  given: string | undefined,
  covered: ReturnType<typeof coveredBy>,
): Pick<Schemas["AnswerAnalysis"], "language" | "languageSource"> {
  if (given !== undefined) return { language: given, languageSource: "given" };

  const english = packs.get("en")!;
  const markers = new Set<string>();
  let eligible = 0;
  let hits = 0;
  for (const word of words(text)) {
    const letters = word.value.match(/\p{L}/gu);
    if (!letters || covered.intersects(word)) continue;
    if (letters.some((letter) => !/\p{Script=Latin}/u.test(letter)))
      return { language: null, languageSource: "undetermined" };
    eligible++;
    if (english.markers.has(word.value)) {
      hits++;
      markers.add(word.value);
    }
  }
  return markers.size >= 2 && hits * 2 >= eligible
    ? { language: "en", languageSource: "detected" }
    : { language: null, languageSource: "undetermined" };
}

function agreement(results: AnalyzerSentiment[]): Schemas["SentimentAgreement"] | null {
  const scores = results.flatMap(({ score }) => (score === null ? [] : [score]));
  if (scores.length < 2) return null;
  const counts = new Map<NonNullable<AnalyzerSentiment["label"]>, number>();
  for (const { label } of results)
    if (label !== null) counts.set(label, (counts.get(label) ?? 0) + 1);
  const agreeingCount = Math.max(...counts.values());
  const leaders = [...counts].filter(([, count]) => count === agreeingCount);
  return {
    analyzerCount: scores.length,
    majorityLabel: leaders.length === 1 ? leaders[0][0] : null,
    agreeingCount,
    unanimous: agreeingCount === scores.length,
    scoreSpread: Math.round((Math.max(...scores) - Math.min(...scores)) * 1000) / 1000,
  };
}

type Options = {
  analyzers: AnalyzerId[];
  primary?: string;
  language?: string;
  onUnsupportedLanguage: "fallback" | "error";
};

export function analyze(
  { text, brands }: Pick<Schemas["AnswerAnalysisRequest"], "text" | "brands">,
  options: Options,
):
  | { result: Schemas["AnswerAnalysis"] }
  | { unsupported: { index: number; language: string | null } } {
  const found = findMentionOccurrences(text, brands);
  const occurrences = found
    .flatMap(({ mention, spans }) => spans.map((span) => ({ ...span, brandKey: mention.brandKey })))
    .sort((a, b) => a.start - b.start);
  const covered = coveredBy(occurrences);
  const language = resolveLanguage(text, options.language, covered);
  const pack = language.language
    ? packs.get(language.language.split("-")[0].toLowerCase())
    : undefined;
  const supported = new Set(options.analyzers.filter(() => pack !== undefined));
  const unsupportedIndex = options.analyzers.findIndex((id) => !supported.has(id));
  if (unsupportedIndex !== -1 && options.onUnsupportedLanguage === "error")
    return { unsupported: { index: unsupportedIndex, language: language.language } };

  // All advertised analyzers are deterministic and share the pack registry.
  const firstSupported = options.analyzers.find((id) => supported.has(id));
  const requested = options.primary;
  const primary =
    requested && isAdvertised(requested) && supported.has(requested) ? requested : firstSupported;
  const analyzers: AnalyzerRun[] = options.analyzers.map((analyzer) => ({
    analyzer,
    kind: "deterministic",
    status: supported.has(analyzer) ? "ok" : "unsupported",
    primary: analyzer === primary,
  }));
  const results = new Map(options.analyzers.map((id) => [id, new Map() as Contributions] as const));
  if (pack && options.analyzers.length && occurrences.length) {
    const score = createScorers(text, pack);
    for (const clause of clauses(text, pack, occurrences, covered)) {
      for (const id of options.analyzers) score[id](clause, results.get(id)!);
    }
  }
  const mentions = found.map(({ mention }) => {
    const sentimentByAnalyzer = options.analyzers.map((analyzer): AnalyzerSentiment =>
      supported.has(analyzer)
        ? {
            analyzer,
            status: "ok",
            ...verdict(
              results.get(analyzer)?.get(mention.brandKey),
              analyzer === "det:lexicon" ? "No lexicon cues" : "No rule cues",
            ),
          }
        : { analyzer, status: "unsupported", score: null, label: null },
    );
    const selected = sentimentByAnalyzer.find((entry) => entry.analyzer === primary);
    return {
      ...mention,
      sentiment: selected?.label ?? null,
      sentimentScore: selected?.score ?? null,
      sentimentByAnalyzer,
      agreement: agreement(sentimentByAnalyzer),
    };
  });
  return {
    result: {
      ...language,
      primaryFallback: requested !== undefined && primary !== undefined && primary !== requested,
      analyzers,
      mentions,
      usage: [],
    },
  };
}
