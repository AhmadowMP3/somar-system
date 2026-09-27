/**
 * Fills in the coordinates of stops that have a Google Maps link but no location — the same two
 * passes as «استخراج المواقع الناقصة» in the admin screen: links that lead to coordinates first,
 * then short Plus Codes completed from the centre of that university's located stops.
 * A result far from the city centre is reported and never saved.
 * Dry run by default; `--commit` writes.
 *   npx tsx scripts/fix-stop-locations.ts --env .env.production [--commit] [--skip "اسم،اسم"]
 * `--skip` leaves out stops whose link is known to be wrong (e.g. the same link pasted into several stops).
 */
import { createClient } from '@supabase/supabase-js';
import type { LatLng } from '@somar/shared';
import { resolveMapsLocation } from '../apps/api/src/services/maps-links.js';
import { loadProdEnv } from './prod-env.js';

const MAX_KM_FROM_CENTRE = 25;

const args = process.argv.slice(2);
const envFile = args.includes('--env') ? (args[args.indexOf('--env') + 1] as string) : '.env.production';
const commit = args.includes('--commit');
const skip = new Set(args.includes('--skip') ? (args[args.indexOf('--skip') + 1] as string).split(/[,،]/).map((x) => x.trim()) : []);
const env = loadProdEnv(envFile);
const db = createClient(env.SUPABASE_URL as string, env.SUPABASE_SERVICE_ROLE_KEY as string, { auth: { persistSession: false } });

function km(a: LatLng, b: LatLng): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}
const centre = (pts: LatLng[]): LatLng | null =>
  pts.length ? { lat: pts.reduce((n, p) => n + p.lat, 0) / pts.length, lng: pts.reduce((n, p) => n + p.lng, 0) / pts.length } : null;

const { data: universities } = await db.from('universities').select('id, name').not('name', 'like', '\\_\\_DOCTOR\\_\\_%');
let total = 0;
let fixedTotal = 0;
for (const uni of universities ?? []) {
  const { data: all, error } = await db.from('stops').select('id, name, maps_url, lat, lng').eq('university_id', uni.id).order('name');
  if (error) throw new Error(error.message);
  const located: LatLng[] = (all ?? []).filter((s) => s.lat != null && s.lng != null).map((s) => ({ lat: Number(s.lat), lng: Number(s.lng) }));
  const missing = (all ?? []).filter((s) => s.maps_url && (s.lat == null || s.lng == null) && !skip.has(s.name as string));
  if (!missing.length) continue;
  total += missing.length;

  const found = new Map<string, LatLng & { pass: number }>();
  for (const pass of [1, 2]) {
    const reference = pass === 2 ? centre([...located, ...[...found.values()]]) : null;
    if (pass === 2 && !reference) break;
    for (const s of missing) {
      if (found.has(s.id as string)) continue;
      const r = await resolveMapsLocation(s.maps_url as string, { reference });
      if (r) found.set(s.id as string, { lat: r.lat, lng: r.lng, pass });
      await new Promise((res) => setTimeout(res, 300)); // gentle with Google
    }
  }

  const city = centre([...located, ...[...found.values()]]);
  const rows = [];
  for (const s of missing) {
    const r = found.get(s.id as string);
    const dist = r && city ? km(r, city) : null;
    const far = dist !== null && dist > MAX_KM_FROM_CENTRE;
    let status = !r ? '✗ لم يُعرف' : far ? `⚠ بعيد ${dist?.toFixed(0)} كم — لم يُحفظ` : r.pass === 1 ? '✓ من الرابط' : '✓ من رمز Plus Code';
    if (r && !far && commit) {
      const { error: upErr } = await db.from('stops').update({ lat: r.lat, lng: r.lng }).eq('id', s.id);
      if (upErr) status = `فشل الحفظ: ${upErr.message}`;
    }
    if (r && !far) fixedTotal += 1;
    rows.push({ name: s.name, result: r ? `${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}` : '', km: dist?.toFixed(1) ?? '', status });
  }
  console.log(`\n${uni.name}`);
  console.table(rows);
}
console.log(`\n${commit ? 'حُفظ' : 'تجربة (لم يُحفظ شيء)'}: ${fixedTotal} من ${total}`);
