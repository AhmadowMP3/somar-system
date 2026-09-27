/**
 * Open Location Code («Plus Code», e.g. 8G6Q644M+8MW or the short 644M+8MW), as Google Maps
 * puts in share links instead of coordinates. Decoding needs no network; a short code is
 * completed from a nearby reference point (it only names a spot within ~50 km of it).
 * Algorithm: https://github.com/google/open-location-code/blob/main/docs/specification.md
 */
import type { LatLng } from './misc.js';

const ALPHABET = '23456789CFGHJMPQRVWX';
const PAIR_RESOLUTIONS = [20, 1, 0.05, 0.0025, 0.000125];
const SEPARATOR_POSITION = 8;

/** A Plus Code inside any text (full «8G6Q644M+8MW» or short «644M+8MW»), upper-cased. */
export function findPlusCode(text: string): string | null {
  const m = /(?:^|[^0-9A-Z])([23456789CFGHJMPQRVWX]{2,8}\+[23456789CFGHJMPQRVWX]{2,5})(?![0-9A-Z])/i.exec(text.replace(/\s+/g, ' '));
  return m ? (m[1] as string).toUpperCase() : null;
}

function encodePrefix(lat: number, lng: number, length: number): string {
  let latVal = Math.min(Math.max(lat, -90), 90 - 1e-10) + 90;
  let lngVal = ((((lng + 180) % 360) + 360) % 360);
  let code = '';
  for (let i = 0; i < 5 && code.length < length; i += 1) {
    const r = PAIR_RESOLUTIONS[i] as number;
    const la = Math.floor(latVal / r);
    const lo = Math.floor(lngVal / r);
    latVal -= la * r;
    lngVal -= lo * r;
    code += (ALPHABET[la] as string) + (ALPHABET[lo] as string);
  }
  return code.slice(0, length);
}

/** Centre of a full code (8+ characters before the «+»). */
function decodeFull(code: string): LatLng & { latSize: number; lngSize: number } {
  const clean = code.replace('+', '').replace(/0+$/, '');
  let lat = -90;
  let lng = -180;
  let latSize = 20;
  let lngSize = 20;
  const pairs = Math.min(clean.length, 10);
  for (let i = 0; i < pairs; i += 2) {
    const r = PAIR_RESOLUTIONS[i / 2] as number;
    lat += ALPHABET.indexOf(clean[i] as string) * r;
    lng += ALPHABET.indexOf(clean[i + 1] as string) * r;
    latSize = r;
    lngSize = r;
  }
  // grid refinement: 5 rows × 4 columns per extra character
  for (let i = 10; i < clean.length; i += 1) {
    const d = ALPHABET.indexOf(clean[i] as string);
    latSize /= 5;
    lngSize /= 4;
    lat += Math.floor(d / 4) * latSize;
    lng += (d % 4) * lngSize;
  }
  return { lat: lat + latSize / 2, lng: lng + lngSize / 2, latSize, lngSize };
}

function valid(code: string): boolean {
  const sep = code.indexOf('+');
  if (sep < 2 || sep > SEPARATOR_POSITION || sep % 2 === 1) return false;
  return [...code.replace('+', '')].every((c) => ALPHABET.includes(c));
}

/** Coordinates of a Plus Code; a short code needs `reference` (any point in the same city). */
export function decodePlusCode(code: string, reference?: LatLng | null): LatLng | null {
  const c = code.toUpperCase();
  if (!valid(c)) return null;
  const sep = c.indexOf('+');
  if (sep === SEPARATOR_POSITION) {
    const d = decodeFull(c);
    return { lat: round(d.lat), lng: round(d.lng) };
  }
  if (!reference) return null;
  const padding = SEPARATOR_POSITION - sep;
  const resolution = 20 ** (2 - padding / 2);
  const half = resolution / 2;
  const d = decodeFull(encodePrefix(reference.lat, reference.lng, padding) + c);
  let { lat, lng } = d;
  if (reference.lat + half < lat && lat - resolution >= -90) lat -= resolution;
  else if (reference.lat - half > lat && lat + resolution <= 90) lat += resolution;
  if (reference.lng + half < lng) lng -= resolution;
  else if (reference.lng - half > lng) lng += resolution;
  return { lat: round(lat), lng: round(lng) };
}

function round(n: number): number {
  return Math.round(n * 1e7) / 1e7;
}
