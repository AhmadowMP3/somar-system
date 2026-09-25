import { describe, expect, it } from 'vitest';
import {
  checkFullName,
  expandNumericString,
  foldArabic,
  formatPhoneDisplay,
  normalizeDigits,
  normalizePhone,
  normalizeStudentNo,
  normalizeText,
  parseShiftStart,
  parseWorkDays,
} from '../src/index.js';

describe('text normalization', () => {
  it('strips Cf characters, trims and collapses whitespace', () => {
    expect(normalizeText('‏  محمد   ‎أحمد ‬ ')).toBe('محمد أحمد');
    expect(normalizeText(null)).toBe('');
  });
  it('maps Arabic-Indic and Eastern digits to ASCII', () => {
    expect(normalizeDigits('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789');
    expect(normalizeDigits('۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789');
  });
  it('folds Arabic letter variants for comparison', () => {
    expect(foldArabic('إدارة الأعمال')).toBe(foldArabic('ادارة الاعمال'));
    expect(foldArabic('مستشفى')).toBe('مستشفي');
    expect(foldArabic('كليـــة')).toBe('كليه');
  });
  it('expands float and scientific notation', () => {
    expect(expandNumericString('323047.0')).toBe('323047');
    expect(expandNumericString('9.86659663E8')).toBe('986659663');
    expect(expandNumericString('3.23047E+5')).toBe('323047');
    expect(expandNumericString('1.5')).toBeNull();
  });
});

describe('student number', () => {
  it.each([
    ['٣٢٣٠٥٥', '323055'],
    ['‏323061', '323061'],
    ['323047.0', '323047'],
    ['3.23047E5', '323047'],
    [' 323 048 ', '323048'],
    [323049, '323049'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeStudentNo(input)).toEqual({ ok: true, value: expected });
  });
  it.each(['دد', '', '12a', '1.5', null])('rejects %s', (input) => {
    expect(normalizeStudentNo(input).ok).toBe(false);
  });
});

describe('phone normalization', () => {
  const cases: [unknown, string][] = [
    ['+963 992 504 947', '+963992504947'],
    ['963992504947', '+963992504947'],
    ['00963992504947', '+963992504947'],
    ['0983 108 092', '+963983108092'],
    ['986659663', '+963986659663'],
    [986659663, '+963986659663'],
    ['9.86659663E8', '+963986659663'],
    ['‎+963-944-123-456', '+963944123456'],
    ['(0944) 123-456', '+963944123456'],
    ['٠٩٤٤١٢٣٤٥٦', '+963944123456'],
    ['+966565324644', '+966565324644'],
    ['00966565324644', '+966565324644'],
    ['+971501234567', '+971501234567'],
    ['+905321234567', '+905321234567'],
    ['+96566012345', '+96566012345'],
    ['+97336001234', '+97336001234'],
    ['+4915112345678', '+4915112345678'],
  ];
  it.each(cases)('%s → %s', (input, expected) => {
    expect(normalizePhone(input)).toEqual({ ok: true, value: expected });
  });

  it('rejects only 123009 and 099614538e from the real-data list', () => {
    const realData = [...cases.map((c) => c[0]), '123009', '099614538e'];
    const rejected = realData.filter((v) => !normalizePhone(v).ok);
    expect(rejected).toEqual(['123009', '099614538e']);
  });

  it('formats Syrian numbers locally and foreign ones with their country code', () => {
    expect(formatPhoneDisplay('+963992504947')).toBe('0992 504 947');
    expect(formatPhoneDisplay('+966565324644')).toMatch(/^\+966/);
  });
});

describe('work days', () => {
  it('parses all day names with both separators, dedupes and sorts', () => {
    expect(parseWorkDays('السبت، الأحد, الاثنين،الثلاثاء, الأربعاء, الخميس, الجمعة')).toEqual({
      ok: true,
      value: [1, 2, 3, 4, 5, 6, 7],
    });
    expect(parseWorkDays('الإثنين, الاثنين, الاحد')).toEqual({ ok: true, value: [1, 7] });
  });
  it('rejects empty and unknown values', () => {
    expect(parseWorkDays('')).toMatchObject({ ok: false, reason: 'empty' });
    expect(parseWorkDays(' ، ')).toMatchObject({ ok: false, reason: 'empty' });
    expect(parseWorkDays('السبت, يوم ما')).toMatchObject({ ok: false, reason: 'unknown' });
  });
});

describe('shift start', () => {
  it.each([
    ['الساعة ٨ صباحا', '08:00'],
    ['الساعة 8 صباحاً', '08:00'],
    ['الساعة ال ١٠ صباحا', '10:00'],
    ['الساعه ال10 صباحا', '10:00'],
    ['الساعة ال ١٢ ظهرا', '12:00'],
    ['الساعة الثانية عشرة ظهرا', '12:00'],
    ['الساعة الثانية ظهرا', '14:00'],
    ['الساعة ٢ ظهراً', '14:00'],
    ['14:00', '14:00'],
  ])('%s → %s', (input, expected) => {
    expect(parseShiftStart(input)).toEqual({ ok: true, value: expected });
  });
  it('rejects unknown values', () => {
    expect(parseShiftStart('الساعة ٩ صباحا').ok).toBe(false);
    expect(parseShiftStart('مسائي').ok).toBe(false);
    expect(parseShiftStart('').ok).toBe(false);
  });
});

describe('names', () => {
  it('requires two words and warns under three', () => {
    expect(checkFullName('محمد')).toEqual({ ok: false, reason: 'short' });
    expect(checkFullName('محمد أحمد')).toEqual({ ok: true, value: 'محمد أحمد', warnNotTriple: true });
    expect(checkFullName('محمد أحمد علي')).toMatchObject({ ok: true, warnNotTriple: false });
  });
});
