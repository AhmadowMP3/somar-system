import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { expandNumericString, foldArabic, normalizeDigits, normalizeText, stripFormatChars } from './text.js';

export type Result<T> = { ok: true; value: T } | { ok: false; reason: string };

/** University student number → digits only; repairs Excel float/scientific artifacts. */
export function normalizeStudentNo(raw: unknown): Result<string> {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0 || !Number.isInteger(raw)) return { ok: false, reason: 'invalid' };
    return { ok: true, value: BigInt(raw).toString() };
  }
  const cleaned = normalizeDigits(normalizeText(raw)).replace(/[\s,]/g, '');
  if (!cleaned) return { ok: false, reason: 'empty' };
  const expanded = expandNumericString(cleaned);
  if (expanded === null || !/^\d+$/.test(expanded)) return { ok: false, reason: 'invalid' };
  return { ok: true, value: expanded };
}

const SY_MOBILE_NATIONAL = /^9\d{8}$/;

/** Normalize any phone input to E.164; accepts valid international numbers. */
export function normalizePhone(raw: unknown): Result<string> {
  let s: string;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || !Number.isInteger(raw)) return { ok: false, reason: 'invalid' };
    s = BigInt(raw).toString();
  } else {
    s = normalizeDigits(stripFormatChars(String(raw ?? '')));
  }
  s = s.replace(/[\s   \-()]/g, '');
  if (!s) return { ok: false, reason: 'empty' };

  let plus = false;
  if (s.startsWith('+')) {
    plus = true;
    s = s.slice(1);
  }
  const expanded = expandNumericString(s);
  if (expanded === null) return { ok: false, reason: 'invalid' };
  s = expanded;
  if (!plus && s.startsWith('00')) {
    plus = true;
    s = s.slice(2);
  }

  if (!plus) {
    if (/^09\d{8}$/.test(s)) return { ok: true, value: `+963${s.slice(1)}` };
    if (SY_MOBILE_NATIONAL.test(s)) return { ok: true, value: `+963${s}` };
    if (/^9639\d{8}$/.test(s)) return { ok: true, value: `+${s}` };
    const sy = parsePhoneNumberFromString(s, 'SY');
    if (sy?.isValid()) return { ok: true, value: sy.number };
    const intl = parsePhoneNumberFromString(`+${s}`);
    if (intl?.isValid()) return { ok: true, value: intl.number };
    return { ok: false, reason: 'invalid' };
  }

  if (s.startsWith('963')) {
    let national = s.slice(3);
    if (national.startsWith('0')) national = national.slice(1);
    if (SY_MOBILE_NATIONAL.test(national)) return { ok: true, value: `+963${national}` };
  }
  const parsed = parsePhoneNumberFromString(`+${s}`);
  if (parsed?.isValid()) return { ok: true, value: parsed.number };
  return { ok: false, reason: 'invalid' };
}

/** Syrian numbers render as `09XX XXX XXX`; others as international format. */
export function formatPhoneDisplay(e164: string | null | undefined): string {
  if (!e164) return '';
  const m = /^\+963(9\d{2})(\d{3})(\d{3})$/.exec(e164);
  if (m) return `0${m[1]} ${m[2]} ${m[3]}`;
  const parsed = parsePhoneNumberFromString(e164);
  return parsed ? parsed.formatInternational() : e164;
}

const DAY_MAP: Record<string, number> = {
  [foldArabic('الاثنين')]: 1,
  [foldArabic('الإثنين')]: 1,
  [foldArabic('اثنين')]: 1,
  [foldArabic('الثلاثاء')]: 2,
  [foldArabic('ثلاثاء')]: 2,
  [foldArabic('الأربعاء')]: 3,
  [foldArabic('اربعاء')]: 3,
  [foldArabic('الخميس')]: 4,
  [foldArabic('خميس')]: 4,
  [foldArabic('الجمعة')]: 5,
  [foldArabic('جمعه')]: 5,
  [foldArabic('السبت')]: 6,
  [foldArabic('سبت')]: 6,
  [foldArabic('الأحد')]: 7,
  [foldArabic('احد')]: 7,
};

export type WorkDaysResult = { ok: true; value: number[] } | { ok: false; reason: 'empty' | 'unknown'; token?: string };

/** Parse the Google Forms multi-select of weekdays into sorted ISO weekdays (1=Mon..7=Sun). */
export function parseWorkDays(raw: unknown): WorkDaysResult {
  const text = normalizeText(raw);
  if (!text) return { ok: false, reason: 'empty' };
  const tokens = text
    .split(/[,،;؛]/)
    .map((t) => foldArabic(t))
    .filter(Boolean);
  if (!tokens.length) return { ok: false, reason: 'empty' };
  const set = new Set<number>();
  for (const token of tokens) {
    const day = DAY_MAP[token] ?? DAY_MAP[token.replace(/^يوم /, '')];
    if (!day) return { ok: false, reason: 'unknown', token: normalizeText(token) };
    set.add(day);
  }
  return { ok: true, value: [...set].sort((a, b) => a - b) };
}

export const SHIFT_STARTS = ['08:00', '10:00', '12:00', '14:00'] as const;
export type ShiftStart = (typeof SHIFT_STARTS)[number];

/** Map the known shift-start answers (with spelling variants) to HH:MM. */
export function parseShiftStart(raw: unknown): Result<ShiftStart> {
  const folded = foldArabic(raw);
  if (!folded) return { ok: false, reason: 'empty' };
  const direct = /^(\d{1,2}):00$/.exec(folded);
  if (direct) {
    const hh = direct[1]!.padStart(2, '0') + ':00';
    if ((SHIFT_STARTS as readonly string[]).includes(hh)) return { ok: true, value: hh as ShiftStart };
    return { ok: false, reason: 'unknown' };
  }
  const t = ` ${folded.replace(/(\d+)/g, ' $1 ').replace(/[^\p{L}\d]+/gu, ' ')} `;
  const has = (...words: string[]) => words.some((w) => t.includes(` ${w} `));
  if (has('12', 'الثانيه عشر', 'الثانيه عشره', 'اثنا عشر', 'اثني عشر')) return { ok: true, value: '12:00' };
  if (has('8', '08', 'الثامنه', 'ثمانيه', 'ثمانه')) return { ok: true, value: '08:00' };
  if (has('10', 'العاشره', 'عشره')) return { ok: true, value: '10:00' };
  if (has('2', '02', '14', 'الثانيه', 'اثنين', 'ثنتين')) return { ok: true, value: '14:00' };
  return { ok: false, reason: 'unknown' };
}

export type NameCheck = { ok: true; value: string; warnNotTriple: boolean } | { ok: false; reason: 'empty' | 'short' };

export function checkFullName(raw: unknown): NameCheck {
  const value = normalizeText(raw);
  if (!value) return { ok: false, reason: 'empty' };
  const words = value.split(' ').filter(Boolean);
  if (words.length < 2) return { ok: false, reason: 'short' };
  return { ok: true, value, warnNotTriple: words.length < 3 };
}
