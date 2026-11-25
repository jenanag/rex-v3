import type { components } from "../../contract/types.js";
import { luna, type LunaVerdict } from "../llm/luna.js";
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
type DeterministicId = keyof typeof descriptions;
const languages = [...packs.keys()];

export function listAnalyzers(lunaEnabled = false): Schemas["Analyzer"][] {
  const catalog: Schemas["Analyzer"][] = Object.entries(descriptions).map(([id, description]) => ({
    id,
    selector: id,
    kind: "deterministic",
    languages,
    description,
  }));
  if (lunaEnabled) catalog.push(luna);
  return catalog;
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
  const successful = results.filter(({ status }) => status === "ok");
  const scores = successful.flatMap(({ score }) => (score === null ? [] : [score]));
  if (scores.length < 2) return null;
  const counts = new Map<NonNullable<AnalyzerSentiment["label"]>, number>();
  for (const { label } of successful)
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
  analyzers: Schemas["Analyzer"][];
  primary?: string;
  language?: string;
  onUnsupportedLanguage: "fallback" | "error";
};

type LunaOutcome = { verdicts?: ReadonlyMap<string, LunaVerdict>; usage?: Schemas["LlmUsage"] };

export function prepareAnalysis(
  { text, brands }: Pick<Schemas["AnswerAnalysisRequest"], "text" | "brands">,
  options: Options,
) {
  const found = findMentionOccurrences(text, brands);
  const occurrences = found
    .flatMap(({ mention, spans }) => spans.map((span) => ({ ...span, brandKey: mention.brandKey })))
    .sort((a, b) => a.start - b.start);
  const covered = coveredBy(occurrences);
  const language = resolveLanguage(text, options.language, covered);
  const subtag = language.language?.split("-")[0].toLowerCase();
  const pack = subtag ? packs.get(subtag) : undefined;
  const supported = options.analyzers.filter(
    ({ languages }) =>
      languages.includes("*") || (subtag !== undefined && languages.includes(subtag)),
  );
  const unsupportedIndex = options.analyzers.findIndex((analyzer) => !supported.includes(analyzer));
  if (unsupportedIndex !== -1 && options.onUnsupportedLanguage === "error")
    return { unsupported: { index: unsupportedIndex, language: language.language } } as const;

  const requested = options.primary;
  const preferred =
    requested === undefined
      ? supported.find(({ kind }) => kind === "deterministic")
      : supported.find(({ id }) => id === requested);
  const primary = preferred ?? supported[0];
  const deterministic = supported
    .filter(({ kind }) => kind === "deterministic")
    .map(({ id }) => id as DeterministicId);
  const needsLuna = found.length > 0 && supported.some(({ id }) => id === luna.id);

  const results = new Map<DeterministicId, Contributions>();
  for (const id of deterministic) results.set(id, new Map());
  if (pack && deterministic.length && occurrences.length) {
    const score = createScorers(text, pack);
    for (const clause of clauses(text, pack, occurrences, covered)) {
      for (const id of deterministic) score[id](clause, results.get(id)!);
    }
  }

  function finish(lunaOutcome: LunaOutcome = {}): Schemas["AnswerAnalysis"] {
    const analyzers: AnalyzerRun[] = options.analyzers.map((analyzer) => ({
      analyzer: analyzer.id,
      kind: analyzer.kind,
      status: !supported.includes(analyzer)
        ? "unsupported"
        : analyzer.id === luna.id && needsLuna && !lunaOutcome.verdicts
          ? "failed"
          : "ok",
      primary: analyzer === primary,
    }));
    const mentions = found.map(({ mention }) => {
      const sentimentByAnalyzer = analyzers.map(({ analyzer, kind, status }): AnalyzerSentiment => {
        if (status !== "ok") return { analyzer, status, score: null, label: null };
        if (kind === "llm")
          return { analyzer, status, ...lunaOutcome.verdicts!.get(mention.brandKey)! };
        return {
          analyzer,
          status,
          ...verdict(
            results.get(analyzer as DeterministicId)?.get(mention.brandKey),
            analyzer === "det:lexicon" ? "No lexicon cues" : "No rule cues",
          ),
        };
      });
      const selected = sentimentByAnalyzer.find((entry) => entry.analyzer === primary?.id);
      return {
        ...mention,
        sentiment: selected?.label ?? null,
        sentimentScore: selected?.score ?? null,
        sentimentByAnalyzer,
        agreement: agreement(sentimentByAnalyzer),
      };
    });
    return {
      ...language,
      primaryFallback: requested !== undefined && primary !== undefined && primary.id !== requested,
      analyzers,
      mentions,
      usage: lunaOutcome.usage ? [lunaOutcome.usage] : [],
    };
  }

  return {
    found,
    language: language.language,
    needsLuna,
    lunaIsPrimary: primary?.id === luna.id,
    finish,
  } as const;
}
