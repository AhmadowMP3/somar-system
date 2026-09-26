import { describe, expect, it } from 'vitest';
import {
  addDays,
  checkPassword,
  damascusDate,
  formatTransportNumber,
  isPasswordValid,
  isoWeekday,
  loginCodeToEmail,
  matchHeaders,
  parseMapsUrl,
  parseQrPayload,
  qrPayload,
  weekStart,
  IMPORT_FIELDS,
} from '../src/index.js';

describe('week start (Saturday = 6)', () => {
  it('returns the same day on the start day and walks back otherwise', () => {
    expect(isoWeekday('2026-09-26')).toBe(6);
    expect(weekStart('2026-09-26', 6)).toBe('2026-09-26');
    expect(weekStart('2026-09-25', 6)).toBe('2026-09-19');
    expect(weekStart('2026-10-02', 6)).toBe('2026-09-26');
  });
  it('crosses month and year boundaries', () => {
    expect(weekStart('2026-10-01', 6)).toBe('2026-09-26');
    expect(weekStart('2027-01-01', 6)).toBe('2026-12-26');
    expect(weekStart('2027-01-02', 6)).toBe('2027-01-02');
    expect(weekStart('2024-03-01', 6)).toBe('2024-02-24');
  });
  it('supports other week-start days', () => {
    expect(weekStart('2026-09-25', 7)).toBe('2026-09-20');
    expect(weekStart('2026-09-25', 1)).toBe('2026-09-21');
  });
  it('derives dates in Damascus time, not UTC', () => {
    expect(damascusDate(new Date('2026-09-25T20:59:59Z'))).toBe('2026-09-25');
    expect(damascusDate(new Date('2026-09-25T21:00:00Z'))).toBe('2026-09-26');
    expect(weekStart(damascusDate(new Date('2026-09-25T21:30:00Z')), 6)).toBe('2026-09-26');
    expect(damascusDate(new Date('2026-12-31T21:00:00Z'))).toBe('2027-01-01');
  });
  it('adds days across boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('transport numbers and login', () => {
  it('pads to four digits', () => {
    expect(formatTransportNumber('SHB', 1)).toBe('SHB-0001');
    expect(formatTransportNumber('shb', 42)).toBe('SHB-0042');
    expect(formatTransportNumber('SHB', 12345)).toBe('SHB-12345');
    expect(formatTransportNumber('SHB', 1, '')).toBe('SHB0001');
    expect(() => formatTransportNumber('SHB', 0)).toThrow();
  });
  it('derives the synthetic email', () => {
    expect(loginCodeToEmail(' SHB-0001 ', 'somar.local')).toBe('shb-0001@somar.local');
  });
});

describe('password policy', () => {
  it('checks every rule', () => {
    expect(isPasswordValid('Abcdef1!', 'Abcdef1!', 8)).toBe(true);
    const failed = (pw: string, c: string | null = pw) =>
      checkPassword(pw, c, 8)
        .filter((r) => !r.ok)
        .map((r) => r.key);
    expect(failed('abcdef1!')).toEqual(['upper']);
    expect(failed('Abcdefg!')).toEqual(['digit']);
    expect(failed('Abcdefg1')).toEqual(['symbol']);
    expect(failed('Ab1!')).toEqual(['minLength']);
    expect(failed('Abcdef1!', 'Abcdef1?')).toEqual(['match']);
  });
});

describe('header matching', () => {
  const headers = IMPORT_FIELDS.map((f) => f.header);
  it('matches exact headers', () => {
    const { mapping, missing } = matchHeaders(headers);
    expect(missing).toEqual([]);
    expect(mapping.area_primary).toBe('المنطقة القريبة اليك');
    expect(mapping.area_secondary).toBe('المنطقة القريبة اليك 2');
  });
  it('tolerates trailing spaces, RLM, tatweel and letter variants', () => {
    const noisy = headers.map((h) => `‏${h.replace('ال', 'الـ')}  `);
    noisy[2] = 'الرقم الجامعي ';
    const { mapping, missing } = matchHeaders(noisy);
    expect(missing).toEqual([]);
    expect(mapping.university_student_no).toBe('الرقم الجامعي ');
    expect(mapping.phone).toBe(noisy[4]);
    expect(mapping.area_secondary).toBe(noisy[8]);
  });
  it('reports missing required columns instead of guessing', () => {
    const { missing } = matchHeaders(headers.filter((h) => h !== 'الاسم الثلاثي'));
    expect(missing).toEqual(['full_name']);
  });
});

describe('maps links and QR payloads', () => {
  it('parses coordinates from common link formats', () => {
    expect(parseMapsUrl('https://maps.google.com/?q=36.2021,37.1343')).toEqual({ lat: 36.2021, lng: 37.1343 });
    expect(parseMapsUrl('https://www.google.com/maps/place/X/@36.21,37.15,17z')).toEqual({ lat: 36.21, lng: 37.15 });
    expect(parseMapsUrl('https://www.google.com/maps/place/X/data=!3d36.2!4d37.1')).toEqual({ lat: 36.2, lng: 37.1 });
    expect(parseMapsUrl('https://maps.app.goo.gl/abc')).toBeNull();
  });
  it('round-trips the QR payload', () => {
    const token = '3f2b1c9e-8d7a-4b6c-9e5f-1a2b3c4d5e6f';
    expect(qrPayload(token)).toBe(`SMR:${token}`);
    expect(parseQrPayload(`SMR:${token.toUpperCase()}`)).toBe(token);
    expect(parseQrPayload('hello')).toBeNull();
  });
});
