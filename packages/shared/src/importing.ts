import { arShared } from './i18n/ar.js';
import {
  checkFullName,
  normalizeNationalId,
  normalizePhone,
  normalizeStudentNo,
  parseShiftStart,
  parseWorkDays,
  type ShiftStart,
} from './normalize.js';
import { foldArabic, normalizeText, similarity } from './text.js';

/**
 * Only name, university number and national number are required (owner's request). Anything else the
 * sheet leaves out, the student answers in the first-login questionnaire.
 */
export const IMPORT_FIELDS = [
  { key: 'timestamp', header: 'Timestamp', required: false },
  { key: 'full_name', header: 'الاسم الثلاثي', required: true },
  { key: 'university_student_no', header: 'الرقم جامعي', required: true },
  { key: 'national_id', header: 'الرقم الوطني', required: true },
  { key: 'card_image', header: 'صورة عن البطاقة الجامعية', required: false },
  { key: 'phone', header: 'رقم الهاتف المستخدم في الوتس ضمن مجموعة', required: false },
  { key: 'college', header: 'الكلية التابع اليها', required: false },
  { key: 'residence', header: 'مكان السكن', required: false },
  { key: 'area_primary', header: 'المنطقة القريبة اليك', required: false },
  { key: 'area_secondary', header: 'المنطقة القريبة اليك 2', required: false },
  { key: 'area_other', header: 'في حال اختيار (أخرى) يرجى كتابة اسم المنقطة القريبة اليك', required: false },
  { key: 'work_days', header: 'اختر أيام دوامك بالاسبوع', required: false },
  { key: 'shift_start', header: 'متى يبدأ دوامك الاسبوعي', required: false },
] as const;

export type ImportFieldKey = (typeof IMPORT_FIELDS)[number]['key'];
export type HeaderMapping = Partial<Record<ImportFieldKey, string>>;

/** Comparison key for a header cell. */
export function headerKey(value: unknown): string {
  return foldArabic(value).replace(/[()]/g, '').replace(/\s+/g, ' ').trim();
}

function stripArticles(key: string): string {
  return key
    .split(' ')
    .map((w) => (w.length > 3 && w.startsWith('ال') ? w.slice(2) : w))
    .join(' ');
}

/**
 * Match the sheet headers to the known fields. Exact (normalized) match first, then a strict
 * similarity fallback that never assigns one header to two fields. Never matches by position.
 */
export function matchHeaders(headers: string[]): { mapping: HeaderMapping; missing: ImportFieldKey[] } {
  const mapping: HeaderMapping = {};
  const used = new Set<string>();
  const keyed = headers.map((h) => ({ raw: h, key: headerKey(h) }));
  for (const field of IMPORT_FIELDS) {
    const target = headerKey(field.header);
    const exact = keyed.find((h) => h.key === target && !used.has(h.raw));
    if (exact) {
      mapping[field.key] = exact.raw;
      used.add(exact.raw);
    }
  }
  for (const field of IMPORT_FIELDS) {
    if (mapping[field.key]) continue;
    const target = headerKey(field.header);
    let best: { raw: string; score: number } | null = null;
    for (const h of keyed) {
      if (used.has(h.raw) || !h.key) continue;
      const score = Math.max(similarity(h.key, target), similarity(stripArticles(h.key), stripArticles(target)));
      if (score >= 0.85 && (!best || score > best.score)) best = { raw: h.raw, score };
    }
    if (best) {
      mapping[field.key] = best.raw;
      used.add(best.raw);
    }
  }
  const missing = IMPORT_FIELDS.filter((f) => f.required && !mapping[f.key]).map((f) => f.key);
  return { mapping, missing };
}

export function fieldHeader(key: ImportFieldKey): string {
  return IMPORT_FIELDS.find((f) => f.key === key)?.header ?? key;
}

export const OTHER_AREA_LABEL = 'أخرى';

export type RefItem = { id: string; name: string };

export type NormalizedImportRow = {
  row_number: number;
  timestamp: number;
  full_name: string;
  university_student_no: string;
  /** Initial password of a new account. */
  national_id: string;
  /** Left empty in the sheet → asked at first login. */
  phone_e164: string | null;
  college_name: string | null;
  college_id: string | null;
  residence_text: string | null;
  area_primary_id: string | null;
  area_secondary_id: string | null;
  area_other_text: string | null;
  work_days: number[];
  shift_start: ShiftStart | null;
};

export type ImportRowStatus = 'created' | 'updated' | 'duplicate' | 'rejected';

export type ImportRowResult = {
  row_number: number;
  status: ImportRowStatus;
  student_name: string;
  university_student_no: string | null;
  reasons: string[];
  warnings: string[];
  data: NormalizedImportRow | null;
};

/** Parse a Google Forms timestamp cell into epoch ms (NaN when unknown). */
export function parseTimestampCell(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Math.round((value - 25569) * 86_400_000);
  const s = normalizeText(value);
  if (!s) return Number.NaN;
  const m = /^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|ص|م)?/i.exec(s);
  if (m) {
    const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
    let y: number, mo: number, d: number;
    if (String(m[1]).length === 4) [y, mo, d] = [a, b, c];
    else if (b > 12) [mo, d, y] = [a, b, c];
    else [d, mo, y] = [a, b, c];
    let h = Number(m[4]);
    const ampm = m[7]?.toUpperCase();
    if ((ampm === 'PM' || ampm === 'م') && h < 12) h += 12;
    if ((ampm === 'AM' || ampm === 'ص') && h === 12) h = 0;
    return Date.UTC(y, mo - 1, d, h, Number(m[5]), Number(m[6] ?? 0));
  }
  const parsed = Date.parse(s);
  return parsed;
}

function matchRef(items: RefItem[], value: string): RefItem | undefined {
  const key = foldArabic(value);
  return items.find((i) => foldArabic(i.name) === key);
}

export type ImportContext = {
  colleges: RefItem[];
  areas: RefItem[];
};

/** Validate and normalize one raw row (keyed by field). */
export function normalizeImportRow(
  rowNumber: number,
  raw: Partial<Record<ImportFieldKey, unknown>>,
  ctx: ImportContext,
): ImportRowResult {
  const t = arShared.import;
  const reasons: string[] = [];
  const warnings: string[] = [];

  const name = checkFullName(raw.full_name);
  if (!name.ok) reasons.push(name.reason === 'empty' ? t.NAME_REQUIRED : t.NAME_TOO_SHORT);
  else if (name.warnNotTriple) warnings.push(t.NAME_NOT_TRIPLE);

  const studentNo = normalizeStudentNo(raw.university_student_no);
  if (!studentNo.ok) reasons.push(t.STUDENT_NO_INVALID);

  const nid = normalizeNationalId(raw.national_id);
  if (!nid.ok) reasons.push(nid.reason === 'empty' ? t.NATIONAL_ID_REQUIRED : t.NATIONAL_ID_INVALID);
  else if (nid.value.length !== 11) warnings.push(t.NATIONAL_ID_LENGTH);

  // Optional answers: a bad or empty cell is left empty and asked at first login.
  let phone: string | null = null;
  if (normalizeText(raw.phone)) {
    const p = normalizePhone(raw.phone);
    if (p.ok) phone = p.value;
    else warnings.push(t.PHONE_INVALID + t.ASKED_AT_LOGIN);
  }

  const collegeName = normalizeText(raw.college) || null;
  let collegeId: string | null = null;
  if (collegeName) {
    const c = matchRef(ctx.colleges, collegeName);
    if (c) collegeId = c.id;
    else warnings.push(t.COLLEGE_NEW + collegeName);
  }

  let workDays: number[] = [];
  if (normalizeText(raw.work_days)) {
    const days = parseWorkDays(raw.work_days);
    if (days.ok) workDays = days.value;
    else warnings.push(t.WORK_DAYS_UNKNOWN + (days.token ?? '') + t.ASKED_AT_LOGIN);
  }

  let shiftStart: ShiftStart | null = null;
  if (normalizeText(raw.shift_start)) {
    const shift = parseShiftStart(raw.shift_start);
    if (shift.ok) shiftStart = shift.value;
    else warnings.push(t.SHIFT_UNKNOWN + normalizeText(raw.shift_start) + t.ASKED_AT_LOGIN);
  }

  const missing = [!phone && t.FIELD_PHONE, !collegeName && t.FIELD_COLLEGE, !workDays.length && t.FIELD_DAYS, !shiftStart && t.FIELD_SHIFT]
    .filter(Boolean)
    .join('، ');
  if (missing) warnings.push(t.MISSING_ANSWERS + missing);

  const otherKey = foldArabic(OTHER_AREA_LABEL);
  const otherText = normalizeText(raw.area_other) || null;
  const otherParts: string[] = [];
  let primaryId: string | null = null;
  let secondaryId: string | null = null;

  const resolveArea = (value: unknown, isPrimary: boolean): string | null => {
    const v = normalizeText(value);
    if (!v) return null;
    if (foldArabic(v) === otherKey) {
      if (otherText) {
        if (!otherParts.includes(otherText)) otherParts.push(otherText);
      } else if (isPrimary) warnings.push(t.AREA_OTHER_EMPTY);
      return null;
    }
    const a = matchRef(ctx.areas, v);
    if (a) return a.id;
    warnings.push(t.AREA_UNKNOWN + v);
    if (!otherParts.includes(v)) otherParts.push(v);
    return null;
  };
  primaryId = resolveArea(raw.area_primary, true);
  secondaryId = resolveArea(raw.area_secondary, false);

  const fullName = name.ok ? name.value : normalizeText(raw.full_name);
  const base = {
    row_number: rowNumber,
    student_name: fullName,
    university_student_no: studentNo.ok ? studentNo.value : null,
    warnings,
  };
  if (reasons.length || !name.ok || !studentNo.ok || !nid.ok) {
    return { ...base, status: 'rejected', reasons, data: null };
  }
  return {
    ...base,
    status: 'created',
    reasons: [],
    data: {
      row_number: rowNumber,
      timestamp: parseTimestampCell(raw.timestamp),
      full_name: name.value,
      university_student_no: studentNo.value,
      national_id: nid.value,
      phone_e164: phone,
      college_name: collegeName,
      college_id: collegeId,
      residence_text: normalizeText(raw.residence) || null,
      area_primary_id: primaryId,
      area_secondary_id: secondaryId,
      area_other_text: otherParts.length ? otherParts.join(' / ') : null,
      work_days: workDays,
      shift_start: shiftStart,
    },
  };
}

/**
 * Within-file dedupe by student number: the row with the latest timestamp wins (ties → later row);
 * earlier duplicates are marked `duplicate`. Also flags shared phone numbers as warnings.
 */
export function dedupeImportRows(rows: ImportRowResult[]): ImportRowResult[] {
  const winners = new Map<string, ImportRowResult>();
  const score = (r: ImportRowResult) => {
    const ts = r.data?.timestamp;
    return Number.isFinite(ts) ? (ts as number) : Number.NEGATIVE_INFINITY;
  };
  for (const r of rows) {
    if (r.status === 'rejected' || !r.university_student_no) continue;
    const cur = winners.get(r.university_student_no);
    if (!cur || score(r) > score(cur) || (score(r) === score(cur) && r.row_number > cur.row_number)) {
      winners.set(r.university_student_no, r);
    }
  }
  const phoneCounts = new Map<string, number>();
  for (const w of winners.values()) {
    const p = w.data?.phone_e164;
    if (p) phoneCounts.set(p, (phoneCounts.get(p) ?? 0) + 1);
  }
  return rows.map((r) => {
    if (r.status === 'rejected' || !r.university_student_no) return r;
    if (winners.get(r.university_student_no) !== r) {
      return { ...r, status: 'duplicate', reasons: [arShared.import.DUPLICATE_ROW], data: null };
    }
    const p = r.data?.phone_e164;
    if (p && (phoneCounts.get(p) ?? 0) > 1) return { ...r, warnings: [...r.warnings, arShared.import.PHONE_DUPLICATE] };
    return r;
  });
}

export type ImportSummary = {
  total: number;
  accepted: number;
  rejected: number;
  updated: number;
  created: number;
  duplicates: number;
};

export function summarizeImport(rows: ImportRowResult[]): ImportSummary {
  const count = (s: ImportRowStatus) => rows.filter((r) => r.status === s).length;
  const created = count('created');
  const updated = count('updated');
  return {
    total: rows.length,
    accepted: created + updated,
    rejected: count('rejected'),
    updated,
    created,
    duplicates: count('duplicate'),
  };
}
