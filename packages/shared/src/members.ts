import { z } from 'zod';
import { arShared } from './i18n/ar.js';
import { parseTimestampCell, type ImportRowStatus, type ImportSummary } from './importing.js';
import { checkFullName, parseWorkDays } from './normalize.js';
import { foldArabic, normalizeText, similarity } from './text.js';

/**
 * Doctors and university employees ride without a package (unlimited trips). They share the students
 * table (`kind`), so they get the same account, transport number, QR and card.
 */
export const MEMBER_KINDS = ['doctor', 'employee'] as const;
export type MemberKind = (typeof MEMBER_KINDS)[number];
export type RiderKind = 'student' | MemberKind;

export const memberInputSchema = z.object({
  university_id: z.string().uuid(),
  kind: z.enum(MEMBER_KINDS),
  full_name: z.string().trim().min(1).max(200),
  phone: z.string().trim().max(40).nullish(),
  job_title: z.string().trim().max(200).nullish(),
  residence_text: z.string().trim().max(300).nullish(),
  area_primary_id: z.string().uuid().nullish(),
  work_days: z.array(z.number().int().min(1).max(7)).default([]),
  work_hours_text: z.string().trim().max(200).nullish(),
  notes: z.string().trim().max(1000).nullish(),
});
export type MemberInput = z.infer<typeof memberInputSchema>;

/**
 * Known column titles per field (Google Forms exports); matched exactly first, then by similarity.
 * Owner's choice: only name, job and work days are imported; every other column (residence, hours,
 * notes…) is ignored. The nearest stop is chosen by the doctor at first login.
 */
export const MEMBER_IMPORT_FIELDS = [
  { key: 'timestamp', headers: ['Timestamp', 'الطابع الزمني'], required: false },
  {
    key: 'full_name',
    headers: ['اسم الدكتور الثلاثي', 'اسم الموظف الثلاثي', 'الاسم الثلاثي', 'الاسم الكامل', 'الاسم', 'اسم الدكتور', 'اسم الموظف'],
    required: true,
  },
  { key: 'job_title', headers: ['المهنة', 'الوظيفة', 'المسمى الوظيفي', 'القسم', 'الصفة'], required: false },
  { key: 'work_days', headers: ['ايام الدوام', 'أيام الدوام', 'اختر أيام دوامك بالاسبوع'], required: false },
] as const;

export type MemberFieldKey = (typeof MEMBER_IMPORT_FIELDS)[number]['key'];
export type MemberMapping = Partial<Record<MemberFieldKey, string>>;

const headerKey = (value: unknown) => foldArabic(value).replace(/[()]/g, '').replace(/\s+/g, ' ').trim();

export function matchMemberHeaders(headers: string[]): { mapping: MemberMapping; missing: MemberFieldKey[] } {
  const mapping: MemberMapping = {};
  const used = new Set<string>();
  const keyed = headers.map((raw) => ({ raw, key: headerKey(raw) })).filter((h) => h.key);
  for (const field of MEMBER_IMPORT_FIELDS) {
    const targets = field.headers.map(headerKey);
    const exact = keyed.find((h) => !used.has(h.raw) && targets.includes(h.key));
    if (exact) {
      mapping[field.key] = exact.raw;
      used.add(exact.raw);
    }
  }
  for (const field of MEMBER_IMPORT_FIELDS) {
    if (mapping[field.key]) continue;
    const targets = field.headers.map(headerKey);
    let best: { raw: string; score: number } | null = null;
    for (const h of keyed) {
      if (used.has(h.raw)) continue;
      const score = Math.max(...targets.map((t) => similarity(h.key, t)));
      if (score >= 0.85 && (!best || score > best.score)) best = { raw: h.raw, score };
    }
    if (best) {
      mapping[field.key] = best.raw;
      used.add(best.raw);
    }
  }
  const missing = MEMBER_IMPORT_FIELDS.filter((f) => f.required && !mapping[f.key]).map((f) => f.key);
  return { mapping, missing };
}

/** Duplicate key for a name: honorifics («د.», «الدكتور») and spaces ignored. */
export function memberNameKey(name: unknown): string {
  return foldArabic(name)
    .replace(/^(الدكتور|الدكتوره|دكتور|دكتوره|د\s*\.|د\s)\s*/u, '')
    .replace(/[\s.]/g, '');
}

export type NormalizedMemberRow = {
  timestamp: number;
  full_name: string;
  job_title: string | null;
  work_days: number[];
};

export type MemberRowResult = {
  row_number: number;
  status: ImportRowStatus;
  full_name: string;
  name_key: string;
  reasons: string[];
  warnings: string[];
  data: NormalizedMemberRow | null;
};

export function normalizeMemberRow(rowNumber: number, raw: Partial<Record<MemberFieldKey, unknown>>): MemberRowResult {
  const t = arShared.import;
  const reasons: string[] = [];
  const warnings: string[] = [];

  const name = checkFullName(raw.full_name);
  if (!name.ok) reasons.push(name.reason === 'empty' ? t.NAME_REQUIRED : t.NAME_TOO_SHORT);

  let days: number[] = [];
  if (normalizeText(raw.work_days)) {
    const d = parseWorkDays(raw.work_days);
    if (d.ok) days = d.value;
    else warnings.push(d.reason === 'empty' ? t.WORK_DAYS_EMPTY : t.WORK_DAYS_UNKNOWN + (d.token ?? ''));
  }

  const fullName = name.ok ? name.value : normalizeText(raw.full_name);
  const base = { row_number: rowNumber, full_name: fullName, name_key: memberNameKey(fullName), warnings };
  if (!name.ok) return { ...base, status: 'rejected', reasons, data: null };
  return {
    ...base,
    status: 'created',
    reasons: [],
    data: {
      timestamp: parseTimestampCell(raw.timestamp),
      full_name: name.value,
      job_title: normalizeText(raw.job_title) || null,
      work_days: days,
    },
  };
}

/** The same person submitted twice: the latest timestamp wins (ties → later row). */
export function dedupeMemberRows(rows: MemberRowResult[]): MemberRowResult[] {
  const winners = new Map<string, MemberRowResult>();
  const score = (r: MemberRowResult) => (Number.isFinite(r.data?.timestamp) ? (r.data?.timestamp as number) : Number.NEGATIVE_INFINITY);
  for (const r of rows) {
    if (r.status === 'rejected') continue;
    const cur = winners.get(r.name_key);
    if (!cur || score(r) > score(cur) || (score(r) === score(cur) && r.row_number > cur.row_number)) winners.set(r.name_key, r);
  }
  return rows.map((r) =>
    r.status === 'rejected' || winners.get(r.name_key) === r
      ? r
      : { ...r, status: 'duplicate', reasons: [arShared.import.DUPLICATE_ROW], data: null },
  );
}

export function summarizeMemberImport(rows: { status: ImportRowStatus }[]): ImportSummary {
  const count = (s: ImportRowStatus) => rows.filter((r) => r.status === s).length;
  const created = count('created');
  const updated = count('updated');
  return { total: rows.length, accepted: created + updated, rejected: count('rejected'), updated, created, duplicates: count('duplicate') };
}
