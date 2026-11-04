/**
 * Loose dates as people type them (`@fri`, `tomorrow`, `+3d`, `nov 12`).
 * Mirrors `crates/core/src/dates.rs`; keep the two in step.
 */

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

const named = (word: string, name: string) => word.length >= 3 && name.startsWith(word);

export function isoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function addDays(d: Date, n: number) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** Adds months, clamping to the month's last day (Jan 31 + 1m = Feb 28). */
function addMonths(d: Date, n: number) {
  const first = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return new Date(first.getFullYear(), first.getMonth(), Math.min(d.getDate(), last));
}

function validDate(y: number, m: number, d: number): Date | null {
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d
    ? date
    : null;
}

/** `YYYY-MM-DD` for what was typed, or `null`. `today` defaults to now. */
export function parseNatural(input: string, today = new Date()): string | null {
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const text = input.trim().toLowerCase();
  if (text === "today" || text === "tod") return isoDate(base);
  if (["tomorrow", "tom", "tmr"].includes(text)) return isoDate(addDays(base, 1));
  if (text === "yesterday") return isoDate(addDays(base, -1));

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const d = validDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    return d && isoDate(d);
  }
  const weekday = WEEKDAYS.findIndex((w) => named(text, w));
  if (weekday >= 0) {
    const current = (base.getDay() + 6) % 7;
    const ahead = (weekday - current + 7) % 7 || 7;
    return isoDate(addDays(base, ahead));
  }
  const offset = text.match(/^\+(\d+)([dwmy])$/);
  if (offset) {
    const n = Number(offset[1]);
    const unit = offset[2];
    if (unit === "d") return isoDate(addDays(base, n));
    if (unit === "w") return isoDate(addDays(base, n * 7));
    return isoDate(addMonths(base, unit === "m" ? n : n * 12));
  }
  const words = text.split(/\s+/);
  if (words.length !== 2) return null;
  const monthOf = (w: string) => MONTHS.findIndex((m) => named(w, m)) + 1;
  const [first, second] = words as [string, string];
  const [month, day] =
    monthOf(first) && /^\d+$/.test(second)
      ? [monthOf(first), Number(second)]
      : /^\d+$/.test(first) && monthOf(second)
        ? [monthOf(second), Number(first)]
        : [0, 0];
  if (!month) return null;
  const thisYear = validDate(base.getFullYear(), month, day);
  if (!thisYear) return null;
  if (thisYear >= base) return isoDate(thisYear);
  const next = validDate(base.getFullYear() + 1, month, day);
  return next && isoDate(next);
}
