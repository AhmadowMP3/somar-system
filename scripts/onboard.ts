/**
 * Real-data onboarding (idempotent, one transaction for all rows):
 *
 *   npm run onboard -- --env .env.production \
 *     --name "جامعة الشهباء الخاصة" --prefix SHB --week-start sat \
 *     --start 2026-09-27 --end 2027-01-24 \
 *     --packages "4 أيام أسبوعياً:4:190000,5 أيام أسبوعياً:5:230000" \
 *     [--logo assets/somar_logo.png] [--dry-run]
 *
 * Creates/updates the university (matched by prefix), the 3 colleges, the approved areas from
 * supabase/seed/areas-shahba.txt, and the packages (matched by name). Existing rows are never deleted.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';
import { COLLEGES } from '../supabase/seed/data.js';
import { connect } from './db-migrations.js';
import { loadProdEnv } from './prod-env.js';

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const DAYS: Record<string, number> = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };

function fail(msg: string): never {
  throw new Error(msg);
}

type PackageSpec = { name: string; trips: number; price: number | null };

function parseArgs() {
  const name = arg('name')?.trim() || fail('--name مطلوب');
  const prefix = (arg('prefix') ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{1,10}$/.test(prefix)) fail('--prefix: أحرف إنجليزية كبيرة أو أرقام (حتى 10)');
  const ws = (arg('week-start') ?? '').toLowerCase();
  const weekStart = DAYS[ws] ?? Number(ws);
  if (!(weekStart >= 1 && weekStart <= 7)) fail('--week-start: sat|sun|mon|… أو رقم ISO 1..7');
  const start = arg('start') ?? '';
  const end = arg('end') ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end < start) fail('--start و --end بصيغة YYYY-MM-DD والنهاية بعد البداية');
  const packages: PackageSpec[] = (arg('packages') ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [pname, trips, price] = p.split(':').map((x) => x.trim());
      const t = Number(trips);
      if (!pname || !Number.isInteger(t) || t < 1 || t > 7) fail(`باقة غير صالحة: "${p}" (الصيغة الاسم:الرحلات:السعر)`);
      return { name: pname, trips: t, price: price ? Number(price) : null };
    });
  if (!packages.length) fail('--packages مطلوب');
  return { name, prefix, weekStart, start, end, packages, logo: arg('logo'), dryRun: argv.includes('--dry-run') };
}

async function main() {
  const opts = parseArgs();
  const env = loadProdEnv();
  const areas = readFileSync(resolve('supabase/seed/areas-shahba.txt'), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const client = await connect(env.DATABASE_URL as string);
  const created: string[] = [];
  let universityId = '';
  try {
    await client.query('begin');
    const uni = await client.query<{ id: string; inserted: boolean }>(
      `insert into public.universities (name, transport_prefix, week_start_dow) values ($1, $2, $3)
       on conflict (transport_prefix) do update set name = excluded.name, week_start_dow = excluded.week_start_dow
       returning id, (xmax = 0) as inserted`,
      [opts.name, opts.prefix, opts.weekStart],
    );
    universityId = uni.rows[0]!.id;
    created.push(`${uni.rows[0]!.inserted ? 'أُنشئت' : 'حُدّثت'} الجامعة: ${opts.name} (${opts.prefix}) · بداية الأسبوع ISO ${opts.weekStart}`);

    const col = await client.query(
      `insert into public.colleges (university_id, name) select $1, unnest($2::text[]) on conflict (university_id, name) do nothing`,
      [universityId, COLLEGES],
    );
    created.push(`الكليات: ${col.rowCount} جديدة من ${COLLEGES.length} (${COLLEGES.join('، ')})`);

    const ar = await client.query(
      `insert into public.areas (university_id, name) select $1, unnest($2::text[]) on conflict (university_id, name) do nothing`,
      [universityId, areas],
    );
    created.push(`المناطق المعتمدة: ${ar.rowCount} جديدة من ${areas.length}`);

    for (const p of opts.packages) {
      const upd = await client.query(
        `update public.packages set trips_per_week = $3, price = $4, semester_start = $5, semester_end = $6, is_active = true
         where university_id = $1 and name = $2`,
        [universityId, p.name, p.trips, p.price, opts.start, opts.end],
      );
      if (!upd.rowCount) {
        await client.query(
          `insert into public.packages (university_id, name, trips_per_week, price, semester_start, semester_end) values ($1, $2, $3, $4, $5, $6)`,
          [universityId, p.name, p.trips, p.price, opts.start, opts.end],
        );
      }
      created.push(`الباقة «${p.name}»: ${p.trips} رحلات/أسبوع · السعر ${p.price ?? '—'} · ${opts.start} → ${opts.end} (${upd.rowCount ? 'حُدّثت' : 'جديدة'})`);
    }
    await client.query(
      `insert into public.audit_log (action, entity, entity_id, university_id, after) values ('university.onboard', 'universities', $1, $1, $2)`,
      [universityId, JSON.stringify({ ...opts, logo: undefined })],
    );
    if (opts.dryRun) {
      await client.query('rollback');
      created.unshift('(تجربة فقط — لم يُحفظ شيء)');
    } else {
      await client.query('commit');
    }
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }

  if (!opts.dryRun && opts.logo) {
    const png = await sharp(readFileSync(resolve(opts.logo)))
      .trim({ threshold: 10 })
      .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    const sb = createClient(env.SUPABASE_URL as string, env.SUPABASE_SERVICE_ROLE_KEY as string, { auth: { persistSession: false } });
    const path = `${universityId}/logo.png`;
    const up = await sb.storage.from(env.SUPABASE_LOGO_BUCKET || 'university-logos').upload(path, png, { contentType: 'image/png', upsert: true });
    if (up.error) throw new Error(`رفع الشعار: ${up.error.message}`);
    const { error } = await sb.from('universities').update({ logo_path: path }).eq('id', universityId);
    if (error) throw new Error(error.message);
    created.push(`الشعار: ${opts.logo} → ${path}`);
  }
  for (const line of created) console.log(`✅ ${line}`);
}

main().catch((err: unknown) => {
  console.error(`❌ ${(err as Error).message}`);
  process.exitCode = 1;
});
