import { arShared } from './i18n/ar.js';

export const ROLES = ['admin', 'university_supervisor', 'supervisor', 'student'] as const;
export type Role = (typeof ROLES)[number];
export const SCANNER_ROLES: readonly Role[] = ['admin', 'university_supervisor', 'supervisor'];

/** `{prefix}{separator}{sequence:0000}` — separator is '-' (SHB-0001) or '' (SHB0001). */
export function formatTransportNumber(prefix: string, sequence: number, separator: '-' | '' = '-'): string {
  if (!Number.isInteger(sequence) || sequence < 1) throw new Error('Sequence must be a positive integer');
  return `${prefix.trim().toUpperCase()}${separator}${String(sequence).padStart(4, '0')}`;
}

/** Deterministic synthetic auth email for a login code. */
export function loginCodeToEmail(loginCode: string, domain: string): string {
  return `${loginCode.trim().toLowerCase()}@${domain.trim().toLowerCase()}`;
}

export type PasswordRule = { key: 'minLength' | 'upper' | 'digit' | 'match'; label: string; ok: boolean };

export function checkPassword(password: string, confirm: string | null, minLength: number): PasswordRule[] {
  const rules: PasswordRule[] = [
    { key: 'minLength', label: arShared.password.minLength(minLength), ok: password.length >= minLength },
    { key: 'upper', label: arShared.password.upper, ok: /[A-Z]/.test(password) },
    { key: 'digit', label: arShared.password.digit, ok: /\d/.test(password) },
  ];
  if (confirm !== null) {
    rules.push({ key: 'match', label: arShared.password.match, ok: password.length > 0 && password === confirm });
  }
  return rules;
}

export function isPasswordValid(password: string, confirm: string | null, minLength: number): boolean {
  return checkPassword(password, confirm, minLength).every((r) => r.ok);
}

/** Extract coordinates from a Google Maps link (`@lat,lng`, `?q=lat,lng`, `!3dlat!4dlng`). */
export function parseMapsUrl(url: string | null | undefined): { lat: number; lng: number } | null {
  if (!url) return null;
  let decoded = url;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    decoded = url;
  }
  const num = '(-?\\d{1,3}(?:\\.\\d+)?)';
  const patterns = [
    new RegExp(`!3d${num}!4d${num}`),
    new RegExp(`[?&](?:q|query|ll|destination|center)=${num},\\s*${num}`),
    new RegExp(`@${num},${num}`),
  ];
  for (const re of patterns) {
    const m = re.exec(decoded);
    if (m) {
      const lat = Number(m[1]);
      const lng = Number(m[2]);
      if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
    }
  }
  return null;
}

/** QR payload printed on the card. */
export const QR_PREFIX = 'SMR:';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function qrPayload(token: string): string {
  return `${QR_PREFIX}${token}`;
}

export function parseQrPayload(text: string): string | null {
  const t = text.trim();
  const token = t.toUpperCase().startsWith(QR_PREFIX) ? t.slice(QR_PREFIX.length) : t;
  return UUID_RE.test(token) ? token.toLowerCase() : null;
}
