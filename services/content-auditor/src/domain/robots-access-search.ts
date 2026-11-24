import { robotsParser, type Rule } from "./robots-rules.js";

type Access = "allowed" | "disallowed" | "partial" | "unknown";
type Spend = (units: number) => void;
const exhausted = Symbol("robots work limit");
const groupLimit = 50_000;
const requestLimit = 250_000;

export function createGroupEvaluator(origin: string) {
  let remaining = requestLimit;
  return (rules: readonly Rule[]): Access => {
    let groupRemaining = groupLimit;
    const spend: Spend = (units) => {
      if (units > groupRemaining || units > remaining) throw exhausted;
      groupRemaining -= units;
      remaining -= units;
    };
    try {
      return evaluate(origin, rules, spend);
    } catch (error) {
      if (error !== exhausted) throw error;
      return "unknown";
    }
  };
}

const uppercaseEscapes = (value: string) =>
  value.replace(/%[\da-f]{2}/giu, (escape) => escape.toUpperCase());

function normalize(pattern: string): string {
  // Mirrors the pinned parser, including its fallback on a lone surrogate.
  try {
    return uppercaseEscapes(encodeURI(pattern).replaceAll("%25", "%"));
  } catch {
    return pattern;
  }
}

function evaluate(origin: string, selected: readonly Rule[], spend: Spend): Access {
  const rules: Rule[] = [];
  const source = ["User-agent: *\n"];
  let matchWidth = 0;
  spend(1);
  for (const { pattern, allow } of selected) {
    // Reserve input and worst-case percent encoding before normalizing.
    spend(1 + 10 * pattern.length);
    const normalized = normalize(pattern);
    matchWidth += normalized.length + 1;
    rules.push({ pattern: normalized, allow });
    source.push((allow ? "Allow: " : "Disallow: ") + pattern + "\n");
  }
  // Only parse the selected group's projection. The parser's per-character
  // matcher can visit each candidate offset for every pattern character.
  spend(matchWidth + source.length);
  const parser = robotsParser(origin + "/robots.txt", source.join(""));
  const isAllowed = (path: string) => {
    spend(1 + 4 * (path.length + 1) * matchWidth);
    return parser.isAllowed(origin + path, "*");
  };
  const rootAllowed = isAllowed("/");
  if (rootAllowed === false) return "disallowed";
  if (rootAllowed === undefined) return "unknown";

  // An identical Allow wins all ties with a Disallow regardless of other rules.
  const equalAllows = new Set<string>();
  for (const { pattern, allow } of rules) {
    spend(1 + pattern.length);
    if (allow) equalAllows.add(pattern);
  }
  const effective = rules.filter(({ pattern, allow }) => {
    spend(1 + pattern.length);
    return allow || !equalAllows.has(pattern);
  });
  if (!effective.some(({ allow }) => !allow)) return "allowed";
  return findBlock(origin, effective, isAllowed, spend);
}

type Position = { rule: number; offset: number };
type State = {
  positions: Position[];
  parent?: State;
  character: string;
  length: number;
};

function findBlock(
  origin: string,
  rules: readonly Rule[],
  isAllowed: (path: string) => boolean | undefined,
  spend: Spend,
): Access {
  // States track the offsets still reachable in every glob. Prefix matches
  // persist across suffixes. A terminal $ matches only at end of input.
  const initial: Position[] = [];
  const ends = rules.map(({ pattern }) => pattern.length - Number(pattern.endsWith("$")));
  function advance(positions: Position[], character: string): Position[] {
    const next: Position[] = [];
    const seen = new Set<string>();
    for (const { rule, offset } of positions) {
      const { pattern } = rules[rule];
      spend(1);
      if (offset === ends[rule]) {
        if (offset === pattern.length) add(next, seen, rule, offset);
      } else if (pattern[offset] === "*") add(next, seen, rule, offset);
      else if (pattern[offset] === character) add(next, seen, rule, offset + 1);
    }
    return next;
  }
  function add(next: Position[], seen: Set<string>, rule: number, offset: number) {
    const pattern = rules[rule].pattern;
    for (let index = offset; ; index++) {
      spend(1);
      const key = rule + ":" + index;
      if (seen.has(key)) return;
      seen.add(key);
      next.push({ rule, offset: index });
      if (pattern[index] !== "*") return;
    }
  }

  const startSeen = new Set<string>();
  for (let rule = 0; rule < rules.length; rule++) add(initial, startSeen, rule, 0);
  const queue: State[] = [{ positions: advance(initial, "/"), character: "/", length: 1 }];
  const visited = new Set<string>();
  let invalidWitness = false;
  for (let index = 0; index < queue.length; index++) {
    const state = queue[index];
    spend(1 + state.positions.length);
    // advance emits each rule's positions in offset order.
    const key = state.positions.map(({ rule, offset }) => rule + ":" + offset).join(",");
    if (visited.has(key)) continue;
    visited.add(key);

    let deny = -1;
    let allow = -1;
    let canDeny = false;
    const literals = new Set<string>();
    for (const { rule, offset } of state.positions) {
      spend(1);
      const item = rules[rule];
      if (!item.allow) canDeny = true;
      if (offset === ends[rule]) {
        if (item.allow) allow = Math.max(allow, item.pattern.length);
        else deny = Math.max(deny, item.pattern.length);
      } else if (urlCharacter(item.pattern[offset]) && item.pattern[offset] !== "*") {
        literals.add(item.pattern[offset]);
      }
    }
    if (deny > allow) {
      spend(2 * state.length);
      const characters: string[] = [];
      for (let node: State | undefined = state; node; node = node.parent) {
        characters.push(node.character);
      }
      const path = characters.reverse().join("");
      const url = URL.parse(origin + path);
      if (
        url?.origin === origin &&
        uppercaseEscapes(url.pathname + url.search) === path &&
        isAllowed(path) === false
      )
        return "partial";
      invalidWitness = true;
    }
    if (!canDeny) continue;

    // A serialized HTTP(S) path and query are ASCII, without a literal fragment
    // marker. At each state all characters other than its literals behave alike.
    for (const character of otherCharacters) {
      spend(1);
      if (!literals.has(character)) {
        literals.add(character);
        break;
      }
    }
    for (const character of literals) {
      spend(1);
      queue.push({
        positions: advance(state.positions, character),
        parent: state,
        character,
        length: state.length + 1,
      });
    }
  }
  return invalidWitness ? "unknown" : "allowed";
}

function urlCharacter(character: string): boolean {
  return character >= " " && character <= "~" && character !== "#";
}

const otherCharacters = [
  "x",
  ...Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index)).filter(urlCharacter),
];
