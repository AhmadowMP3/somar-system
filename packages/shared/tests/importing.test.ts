import { describe, expect, it } from 'vitest';
import { dedupeImportRows, normalizeImportRow, summarizeImport, type ImportContext } from '../src/index.js';

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
    const r = normalizeImportRow(3, { ...base, university_student_no: 'دد', phone: '123009' }, ctx);
    expect(r.status).toBe('rejected');
    expect(r.reasons.length).toBe(2);
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
