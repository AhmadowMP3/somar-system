/** Unicode "format" (Cf) characters: RLM, LRM, ZWJ, PDF, BOM, etc. */
const CF_REGEX = /\p{Cf}/gu;
/** JS `\s` already covers NBSP (U+00A0), figure space (U+2007) and narrow NBSP (U+202F). */
const WS_REGEX = /\s+/g;
const TATWEEL = /ـ/g;
const HARAKAT = /[ً-ْٰ]/g;

export function stripFormatChars(value: string): string {
  return value.replace(CF_REGEX, '');
}

/** Trim, collapse whitespace, strip Cf characters. */
export function normalizeText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return stripFormatChars(String(value)).replace(WS_REGEX, ' ').trim();
}

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EASTERN_ARABIC = '۰۱۲۳۴۵۶۷۸۹';

/** Map Arabic-Indic and Eastern Arabic-Indic digits to ASCII. */
export function normalizeDigits(value: string): string {
  let out = '';
  for (const ch of value) {
    const a = ARABIC_INDIC.indexOf(ch);
    if (a >= 0) {
      out += String(a);
      continue;
    }
    const e = EASTERN_ARABIC.indexOf(ch);
    out += e >= 0 ? String(e) : ch;
  }
  return out;
}

/**
 * Comparison-only folding for Arabic: strips tatweel and diacritics, unifies
 * alef variants, alef maqsura and taa marbuta, lower-cases Latin, collapses spaces.
 */
export function foldArabic(value: unknown): string {
  return normalizeDigits(normalizeText(value))
    .replace(TATWEEL, '')
    .replace(HARAKAT, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .toLowerCase()
    .replace(WS_REGEX, ' ')
    .trim();
}

/**
 * Expand a decimal / scientific-notation numeric string into a plain integer digit string.
 * Returns null when the value is not an integer (e.g. "1.5") or not numeric.
 */
export function expandNumericString(value: string): string | null {
  const m = /^(\d+)(?:\.(\d*))?(?:[eE]\+?(\d+))?$/.exec(value);
  if (!m) return null;
  const intPart = m[1] ?? '';
  const frac = m[2] ?? '';
  const exp = m[3] ? Number(m[3]) : 0;
  const digits = intPart + frac;
  const point = intPart.length + exp;
  if (point >= digits.length) return digits + '0'.repeat(point - digits.length);
  const whole = digits.slice(0, point);
  const rest = digits.slice(point);
  if (!/^0*$/.test(rest)) return null;
  return whole;
}

/** Levenshtein-based similarity in [0, 1]. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j] ?? 0;
  }
  const dist = prev[b.length] ?? 0;
  return 1 - dist / Math.max(a.length, b.length);
}
