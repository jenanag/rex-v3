const monthNames = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
const weekdayNames = "Sunday Monday Tuesday Wednesday Thursday Friday Saturday".split(" ");
const imf =
  /^(?<weekday>[A-Za-z]{3}), (?<day>\d{2}) (?<month>[A-Za-z]{3}) (?<year>\d{4}) (?<clock>\d{2}:\d{2}:\d{2}) GMT$/;
const obsolete =
  /^(?<weekday>[A-Za-z]+), (?<day>\d{2})-(?<month>[A-Za-z]{3})-(?<year>\d{2}) (?<clock>\d{2}:\d{2}:\d{2}) GMT$/;
const asctime =
  /^(?<weekday>[A-Za-z]{3}) (?<month>[A-Za-z]{3}) (?<day>\d{2}| \d) (?<clock>\d{2}:\d{2}:\d{2}) (?<year>\d{4})$/;

function httpDateDelay(value: string, now: number) {
  const date = (imf.exec(value) ?? obsolete.exec(value) ?? asctime.exec(value))?.groups;
  if (!date) return undefined;
  const month = monthNames.indexOf(date.month);
  const day = Number(date.day);
  const [hour, minute, second] = date.clock.split(":").map(Number);
  const leapSecond = second === 60 && hour === 23 && minute === 59;
  if (month === -1 || hour > 23 || minute > 59 || (second > 59 && !leapSecond)) return undefined;

  const clock = new Date(0);
  clock.setUTCHours(hour, minute, Math.min(second, 59), 0);
  const shortYear = date.year.length === 2;
  const year = Number(date.year);
  if (shortYear) {
    const cutoff = new Date(now);
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() + 50);
    const candidate = Math.floor(cutoff.getUTCFullYear() / 100) * 100 + year;
    clock.setUTCFullYear(candidate, month, day);
    if (clock > cutoff) clock.setUTCFullYear(candidate - 100, month, day);
  } else {
    clock.setUTCFullYear(year, month, day);
  }
  const weekday = weekdayNames[clock.getUTCDay()];
  if (
    clock.getUTCMonth() !== month ||
    clock.getUTCDate() !== day ||
    date.weekday !== (shortYear ? weekday : weekday.slice(0, 3))
  )
    return undefined;

  const timestamp = clock.getTime() + (leapSecond ? 1000 : 0);
  return String(Math.max(0, Math.ceil((timestamp - now) / 1000)));
}

export function retryAfter(error: unknown) {
  if (
    !error ||
    typeof error !== "object" ||
    !("headers" in error) ||
    !(error.headers instanceof Headers)
  )
    return undefined;
  const value = error.headers.get("retry-after");
  if (!value) return undefined;
  return /^\d+$/.test(value) ? value : httpDateDelay(value, Date.now());
}
