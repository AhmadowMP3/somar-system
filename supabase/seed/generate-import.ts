/**
 * Generates supabase/seed/demo-import.xlsx — 60 Google-Forms-style rows reproducing every dirty-data
 * case of the real file. Deterministic. Usage: npm run seed:import-file
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';
import { IMPORT_FIELDS } from '@somar/shared';
import { AREAS, COLLEGES, DAY_LABELS, FAMILY_NAMES, FATHER_NAMES, FIRST_NAMES_F, FIRST_NAMES_M, rng, SHIFT_LABELS } from './data.js';

export const IMPORT_FILE = resolve(dirname(fileURLToPath(import.meta.url)), 'demo-import.xlsx');

/** Expected results when importing into a university that has none of these students yet. */
export const IMPORT_EXPECTED = {
  total: 60,
  created: 55,
  updated: 0,
  rejected: 2,
  duplicates: 3,
  needsAreaMapping: 4,
  /** Rows (sheet row numbers) that must be rejected: bad university number, invalid national number. */
  rejectedRows: [6, 42],
  /** Row without a national number: imported, its first password is the transport number. */
  noNationalIdStudentNo: '330040',
  /** Row whose optional answers are all empty: imported, the student completes them at first login. */
  incompleteStudentNo: '330042',
  /** Student number whose later-in-file row is OLDER; the earlier (newer) row must win. */
  duplicateNewerFirst: { studentNo: '331102', winningName: 'رهف عادل الأحدث' },
  foreignPhones: ['+966565324644', '+971501234567', '+905321234567', '+96566012345', '+97336001234', '+4915112345678'],
};

type Row = Record<string, unknown>;

function header(key: string): string {
  return IMPORT_FIELDS.find((f) => f.key === key)?.header ?? key;
}

export function buildRows(): Row[] {
  const r = rng(20260925);
  const base = new Date(Date.UTC(2025, 7, 20, 7, 0, 0));
  let minute = 0;
  const ts = () => new Date(base.getTime() + (minute += 37) * 60_000);
  const name = (words = 3) => {
    const female = r.chance(0.5);
    const first = r.pick(female ? FIRST_NAMES_F : FIRST_NAMES_M);
    return words === 2 ? `${first} ${r.pick(FAMILY_NAMES)}` : `${first} ${r.pick(FATHER_NAMES)} ${r.pick(FAMILY_NAMES)}`;
  };
  const days = (n: number) => {
    const order = [6, 7, 1, 2, 3, 4, 5];
    return order.slice(0, n).map((d) => DAY_LABELS[d]).join(', ');
  };
  let seq = 330000;
  const make = (over: Partial<Record<string, unknown>> = {}): Row => {
    seq += 1;
    const row: Record<string, unknown> = {
      timestamp: ts(),
      full_name: name(),
      university_student_no: String(seq),
      national_id: String(20100000000 + seq),
      card_image: `https://drive.google.com/open?id=demo${seq}`,
      phone: `09${r.int(30, 99)}${r.int(100000, 999999)}`,
      college: r.next() < 0.69 ? COLLEGES[0] : r.next() < 0.93 ? COLLEGES[1] : COLLEGES[2],
      residence: `حلب - ${r.pick(AREAS)}`,
      area_primary: r.pick(AREAS),
      area_secondary: '',
      area_other: '',
      work_days: days(r.pick([5, 5, 5, 4, 4, 3, 6])),
      shift_start: SHIFT_LABELS[r.pick(['08:00', '08:00', '08:00', '10:00', '12:00', '14:00'])],
      ...over,
    };
    return Object.fromEntries(IMPORT_FIELDS.map((f) => [header(f.key), row[f.key] ?? '']));
  };

  const rows: Row[] = [];
  // Sheet row = index + 2.
  rows.push(make({ university_student_no: '٣٣٩٠٥٥' })); // 2: Arabic-Indic digits
  rows.push(make({ university_student_no: `${String.fromCharCode(0x200f)}339056` })); // 3: RLM-prefixed
  rows.push(make({ university_student_no: '323047.0' })); // 4: Excel float artifact
  rows.push(make({ university_student_no: 323048 })); // 5: numeric cell
  rows.push(make({ university_student_no: 'دد' })); // 6: invalid → rejected
  rows.push(make({ phone: '+963 992 504 947' })); // 7
  rows.push(make({ phone: 986659663 })); // 8: numeric phone (sibling)
  rows.push(make({ phone: '0983 108 092' })); // 9
  rows.push(make({ phone: '9.86659663E8' })); // 10: scientific (sibling of row 8)
  rows.push(make({ phone: '+966565324644' })); // 11
  rows.push(make({ phone: '+971501234567' })); // 12
  rows.push(make({ phone: '+905321234567' })); // 13
  rows.push(make({ phone: '+96566012345' })); // 14
  rows.push(make({ phone: '+97336001234' })); // 15
  rows.push(make({ phone: '+4915112345678' })); // 16
  rows.push(make({ full_name: 'سارة الحلبي' })); // 17: two-word name (warning)
  rows.push(make({ full_name: 'ماهر قباني' })); // 18: two-word name (warning)
  rows.push(make({ area_primary: 'أخرى', area_other: 'حي الفرقان' })); // 19: needs mapping
  rows.push(make({ area_primary: 'أخرى', area_other: 'الشعار' })); // 20: needs mapping
  rows.push(make({ area_primary: 'أخرى', area_other: '' })); // 21: other without text
  rows.push(make({ phone: '123009' })); // 22: invalid phone → left empty, asked at first login
  rows.push(make({ phone: '099614538e' })); // 23: invalid phone → left empty, asked at first login
  rows.push(make({ area_secondary: 'جامع النصر' })); // 24: second area
  rows.push(make({ area_secondary: 'الرجاء' })); // 25: second area
  rows.push(make({ area_primary: 'الصنم', area_secondary: 'أخرى', area_other: 'الحمدانية الجديدة' })); // 26
  rows.push(make({ area_primary: 'أخرى', area_secondary: 'أخرى', area_other: 'حلب الجديدة شمالي' })); // 27: needs mapping
  rows.push(make({ area_primary: 'أخرى', area_secondary: 'دوار الشفاء', area_other: 'حي الفرقان' })); // 28: needs mapping
  rows.push(make({ college: 'كلية الصيدلة' })); // 29: new college
  rows.push(make({ work_days: 'السبت، الأحد،الاثنين' })); // 30: Arabic comma
  rows.push(make({ work_days: 'الأحد, الأحد, الإثنين' })); // 31: duplicates in list
  rows.push(make({ shift_start: 'الساعة الثانية ظهرا' })); // 32
  rows.push(make({ shift_start: 'الساعة ال ١٢ ظهرا' })); // 33
  // Duplicate pair A (older first, newer later): rows 34 / 35
  const aTs = ts();
  rows.push(make({ university_student_no: '331101', timestamp: aTs, full_name: 'يوسف منير القديم' }));
  rows.push(make({ university_student_no: '331101', timestamp: new Date(aTs.getTime() + 86_400_000), full_name: 'يوسف منير الأحدث' }));
  // Duplicate pair B (newer first, older later): rows 36 / 37
  const bTs = ts();
  rows.push(make({ university_student_no: '331102', timestamp: new Date(bTs.getTime() + 2 * 86_400_000), full_name: 'رهف عادل الأحدث' }));
  rows.push(make({ university_student_no: '331102', timestamp: bTs, full_name: 'رهف عادل القديم' }));
  // Duplicate pair C with string timestamps: rows 38 / 39
  rows.push(make({ university_student_no: '331103', timestamp: '2025/08/30 09:10:00', full_name: 'حمزة جمال القديم' }));
  rows.push(make({ university_student_no: '331103', timestamp: '2025/08/31 09:10:00', full_name: 'حمزة جمال الأحدث' }));
  rows.push(make({ shift_start: 'الساعة ٩ صباحا' })); // 40: unknown shift → left empty, asked at first login
  rows.push(make({ national_id: '' })); // 41: no national number → imported, password = transport number
  rows.push(make({ national_id: '12ab' })); // 42: invalid national number → rejected
  // 43: only name, university number and national number (student no 330042)
  rows.push(make({ phone: '', college: '', residence: '', area_primary: '', work_days: '', shift_start: '' }));
  while (rows.length < 60) rows.push(make());
  return rows;
}

export function buildWorkbook(): Buffer {
  const ws = XLSX.utils.json_to_sheet(buildRows(), { header: IMPORT_FIELDS.map((f) => f.header), cellDates: true });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Form Responses 1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellDates: true }) as Buffer;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(IMPORT_FILE, buildWorkbook());
  console.log(`wrote ${IMPORT_FILE}`);
}
