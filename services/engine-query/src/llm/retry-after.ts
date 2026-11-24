const months = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
const weekdays = "Sunday Monday Tuesday Wednesday Thursday Friday Saturday".split(" ");
const httpDateFormats = [
  /^(?<weekday>[A-Z][a-z]{2}), (?<day>\d{2}) (?<month>[A-Z][a-z]{2}) (?<year>\d{4}) (?<clock>\d{2}:\d{2}:\d{2}) GMT$/,
  /^(?<weekday>[A-Z][a-z]+), (?<day>\d{2})-(?<month>[A-Z][a-z]{2})-(?<year>\d{2}) (?<clock>\d{2}:\d{2}:\d{2}) GMT$/,
  /^(?<weekday>[A-Z][a-z]{2}) (?<month>[A-Z][a-z]{2}) (?<day>\d{2}| \d) (?<clock>\d{2}:\d{2}:\d{2}) (?<year>\d{4})$/,
];

function dateDelay(value: string, now: number) {
  const parts = httpDateFormats.map((format) => format.exec(value)?.groups).find(Boolean);
  if (!parts) return undefined;

  const month = months.indexOf(parts.month);
  const day = Number(parts.day);
  const [hour, minute, second] = parts.clock.split(":").map(Number);
  const leapSecond = second === 60 && hour === 23 && minute === 59;
  if (month < 0 || hour > 23 || minute > 59 || (second > 59 && !leapSecond)) return undefined;

  const date = new Date(0);
  date.setUTCHours(hour, minute, Math.min(second, 59), 0);
  const shortYear = parts.year.length === 2;
  let year = Number(parts.year);
  if (shortYear) {
    const cutoff = new Date(now);
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() + 50);
    year += Math.floor(cutoff.getUTCFullYear() / 100) * 100;
    date.setUTCFullYear(year, month, day);
    if (date > cutoff) year -= 100;
  }
  date.setUTCFullYear(year, month, day);
  const weekday = weekdays[date.getUTCDay()];
  if (
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    parts.weekday !== (shortYear ? weekday : weekday.slice(0, 3))
  )
    return undefined;

  const timestamp = date.getTime() + (leapSecond ? 1_000 : 0);
  return String(Math.max(0, Math.ceil((timestamp - now) / 1_000)));
}

export function retryAfter(error: unknown, now = Date.now()) {
  if (!(error instanceof Error) || !("headers" in error) || !(error.headers instanceof Headers))
    return undefined;
  const value = error.headers.get("retry-after");
  if (!value) return undefined;
  return /^\d+$/.test(value) ? value : dateDelay(value, now);
}
