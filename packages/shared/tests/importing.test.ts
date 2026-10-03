import { describe, expect, it } from 'vitest';
import { arShared, dedupeImportRows, normalizeImportRow, normalizeNationalId, parseAmount, summarizeImport, type ImportContext } from '../src/index.js';

const ctx: ImportContext = {
  colleges: [{ id: 'c1', name: 'كلية طب الاسنان' }],
  areas: [
    { id: 'a1', name: 'الرجاء' },
    { id: 'a2', name: 'جامع النصر' },
  ],
};

const base = {
  timestamp: '2025/09/01 10:00:00',
  full_name: 'محمد أحمد علي',
  university_student_no: '323047',
  national_id: '02010045678',
  phone: '0944123456',
  college: 'كلية طب الأسنان',
  area_primary: 'الرجاء',
  work_days: 'السبت, الأحد',
  shift_start: 'الساعة ٨ صباحا',
};

describe('import row normalization', () => {
  it('accepts a clean row and resolves references', () => {
    const r = normalizeImportRow(2, base, ctx);
    expect(r.status).toBe('created');
    expect(r.data).toMatchObject({ college_id: 'c1', area_primary_id: 'a1', work_days: [6, 7], shift_start: '08:00' });
  });
  it('handles "other" areas and merges free text', () => {
    const r = normalizeImportRow(2, { ...base, area_primary: 'أخرى', area_other: 'حي الفرقان' }, ctx);
    expect(r.data).toMatchObject({ area_primary_id: null, area_other_text: 'حي الفرقان' });
    const r2 = normalizeImportRow(2, { ...base, area_secondary: 'جامع النصر' }, ctx);
    expect(r2.data).toMatchObject({ area_primary_id: 'a1', area_secondary_id: 'a2', area_other_text: null });
  });
  it('rejects with Arabic reasons', () => {
    const r = normalizeImportRow(3, { ...base, university_student_no: 'دد', national_id: 'abc' }, ctx);
    expect(r.status).toBe('rejected');
    expect(r.reasons).toEqual([arShared.import.STUDENT_NO_INVALID, arShared.import.NATIONAL_ID_INVALID]);
  });
  it('needs only name, university number and national number; the rest is asked at first login', () => {
    const r = normalizeImportRow(4, { full_name: base.full_name, university_student_no: '1', national_id: '02010045678' }, ctx);
    expect(r.status).toBe('created');
    expect(r.data).toMatchObject({ phone_e164: null, college_id: null, college_name: null, work_days: [], shift_start: null });
    expect(r.warnings.some((w) => w.startsWith(arShared.import.MISSING_ANSWERS))).toBe(true);
    const bad = normalizeImportRow(5, { ...base, phone: '123009', shift_start: 'الساعة ٩' }, ctx);
    expect(bad.status).toBe('created');
    expect(bad.data).toMatchObject({ phone_e164: null, shift_start: null });
  });
  it('keeps the latest timestamp among duplicates', () => {
    const rows = [
      normalizeImportRow(2, { ...base, timestamp: '2025/09/03 10:00:00', full_name: 'الأحدث اسم ثلاثي' }, ctx),
      normalizeImportRow(3, { ...base, timestamp: '2025/09/01 10:00:00', full_name: 'الأقدم اسم ثلاثي' }, ctx),
    ];
    const out = dedupeImportRows(rows);
    expect(out.map((r) => r.status)).toEqual(['created', 'duplicate']);
    expect(summarizeImport(out)).toMatchObject({ total: 2, created: 1, duplicates: 1, rejected: 0 });
  });
});

describe('national number', () => {
  it('normalizes digits, Excel numbers and Arabic digits', () => {
    expect(normalizeNationalId('٠٢٠١٠٠٤٥٦٧٨')).toEqual({ ok: true, value: '02010045678' });
    expect(normalizeNationalId(2010045678)).toEqual({ ok: true, value: '2010045678' });
    expect(normalizeNationalId('020 1004 5678')).toEqual({ ok: true, value: '02010045678' });
    expect(normalizeNationalId('12345').ok).toBe(false);
    expect(normalizeNationalId('02A10045678').ok).toBe(false);
  });
  it('is read from the sheet; missing → imported with a warning (password = transport number), invalid → rejected', () => {
    expect(normalizeImportRow(2, base, ctx).data?.national_id).toBe('02010045678');
    const missing = normalizeImportRow(2, { ...base, national_id: '' }, ctx);
    expect(missing.status).toBe('created');
    expect(missing.data?.national_id).toBeNull();
    expect(missing.warnings).toContain(arShared.import.NATIONAL_ID_MISSING);
    const bad = normalizeImportRow(2, { ...base, national_id: 'abc' }, ctx);
    expect(bad.status).toBe('rejected');
    expect(bad.reasons).toContain(arShared.import.NATIONAL_ID_INVALID);
  });
});

describe('package from «مبلغ الشريحة»', () => {
  const withPackages: ImportContext = {
    ...ctx,
    packages: [
      { id: 'p2', name: 'باقة يومين', price: '125.00' },
      { id: 'p3', name: 'باقة 3 أيام', price: 175 },
      { id: 'p5', name: 'باقة 5 أيام', price: '205.00' },
    ],
  };
  it('parses amounts written in many ways', () => {
    expect(parseAmount(205)).toBe(205);
    expect(parseAmount('٢٠٥')).toBe(205);
    expect(parseAmount('205 $')).toBe(205);
    expect(parseAmount('')).toBeNull();
    expect(parseAmount(null)).toBeNull();
  });
  it('picks the package whose price equals the amount', () => {
    const r = normalizeImportRow(2, { ...base, package_price: 175 }, withPackages);
    expect(r.data?.package_id).toBe('p3');
    expect(r.package_name).toBe('باقة 3 أيام');
  });
  it('no amount or an unknown amount → imported without a package, with a warning', () => {
    const none = normalizeImportRow(2, base, withPackages);
    expect(none.status).toBe('created');
    expect(none.data?.package_id).toBeNull();
    expect(none.warnings).toContain(arShared.import.PACKAGE_NO_AMOUNT);
    const odd = normalizeImportRow(2, { ...base, package_price: 150 }, withPackages);
    expect(odd.data?.package_id).toBeNull();
    expect(odd.warnings).toContain(arShared.import.PACKAGE_UNKNOWN(150));
  });
});
