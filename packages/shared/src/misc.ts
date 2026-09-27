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

export type LatLng = { lat: number; lng: number };

const NUM = '(-?\\d{1,3}(?:\\.\\d+)?)';

function firstMatch(text: string, patterns: RegExp[], order: 'latlng' | 'lnglat' = 'latlng'): LatLng | null {
  for (const re of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    const [lat, lng] = order === 'latlng' ? [a, b] : [b, a];
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0)) return { lat, lng };
  }
  return null;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

/**
 * Extract coordinates from a Google Maps link. The exact place (`!3d…!4d…`) wins over query
 * forms (`?q=`, `/search/lat,lng`, `geo:`, plain «lat, lng») and those over the viewport centre
 * (`@lat,lng`). Short share links (maps.app.goo.gl, goo.gl/maps) carry no coordinates: see isShortMapsLink.
 */
export function parseMapsUrl(url: string | null | undefined): LatLng | null {
  if (!url) return null;
  const decoded = safeDecode(url.trim());
  return firstMatch(decoded, [
    new RegExp(`!3d${NUM}!4d${NUM}`),
    new RegExp(`[?&](?:q|query|ll|sll|destination|daddr|center|cbll)=(?:loc:)?\\s*${NUM},\\s*${NUM}`),
    new RegExp(`/(?:search|place|dir)/(?:[^/?]*/)*?${NUM},\\s*${NUM}`),
    new RegExp(`^geo:${NUM},${NUM}`),
    // plain coordinates copied from Google Maps: «36.2021, 37.1343»
    new RegExp(`^\\s*${NUM}\\s*[,،]\\s*${NUM}\\s*$`),
    new RegExp(`@${NUM},${NUM}`),
  ]);
}

/** Share links that only redirect to the real map link (the app's «Share» button makes these). */
export function isShortMapsLink(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url.trim());
    return u.hostname === 'maps.app.goo.gl' || (u.hostname === 'goo.gl' && u.pathname.startsWith('/maps')) || u.hostname === 'g.co';
  } catch {
    return false;
  }
}

/** Coordinates inside a Google Maps page, when its final address still has none (last resort). */
export function coordsFromMapsHtml(html: string): LatLng | null {
  const text = html.replace(/&amp;/g, '&');
  return (
    firstMatch(text, [
      new RegExp(`center=${NUM}(?:%2C|,)${NUM}`),
      new RegExp(`!3d${NUM}!4d${NUM}`),
      new RegExp(`/@${NUM},${NUM}`),
    ]) ??
    // window.APP_INITIALIZATION_STATE=[[[altitude,lng,lat] …
    firstMatch(text, [new RegExp(`APP_INITIALIZATION_STATE=\\[\\[\\[-?\\d+(?:\\.\\d+)?,${NUM},${NUM}\\]`)], 'lnglat')
  );
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
