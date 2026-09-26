/**
 * Gate 3 check: `npm run check:env [-- --env .env.production]`
 * Keys (role claims, same instance), no service key in VITE_* or the web sources, Postgres connectivity.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { decodeJwt, loadProdEnv, mask, Report } from './prod-env.js';

const env = loadProdEnv();
const r = new Report();

const anon = decodeJwt(env.SUPABASE_ANON_KEY);
const service = decodeJwt(env.SUPABASE_SERVICE_ROLE_KEY);
r.add('anon', 'مفتاح anon', anon?.claims.role === 'anon' ? 'PASS' : 'FAIL', `role=${anon?.claims.role ?? '؟'} · ${mask(env.SUPABASE_ANON_KEY)}`, 'انسخ SERVICE_SUPABASEANON_KEY كاملاً إلى SUPABASE_ANON_KEY');
r.add('service', 'مفتاح service_role', service?.claims.role === 'service_role' ? 'PASS' : 'FAIL', `role=${service?.claims.role ?? '؟'} · ${mask(env.SUPABASE_SERVICE_ROLE_KEY)}`, 'انسخ SERVICE_SUPABASESERVICE_KEY كاملاً إلى SUPABASE_SERVICE_ROLE_KEY');

const now = Date.now() / 1000;
for (const [name, k] of [['anon', anon], ['service_role', service]] as const) {
  const exp = k?.claims.exp;
  if (exp) r.add(`exp-${name}`, `صلاحية مفتاح ${name}`, exp > now + 30 * 86400 ? 'PASS' : 'FAIL', `ينتهي ${new Date(exp * 1000).toISOString().slice(0, 10)}`, 'ولّد مفاتيح جديدة من JWT_SECRET');
}

// Same instance: both keys must be accepted by this gateway (each is verified against the instance's JWT secret).
async function acceptedBy(key: string | undefined): Promise<number> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/`, { headers: { apikey: key ?? '', Authorization: `Bearer ${key ?? ''}` } });
  return res.status;
}
const sameIss = anon?.claims.iss === service?.claims.iss;
const [anonStatus, serviceStatus] = await Promise.all([acceptedBy(env.SUPABASE_ANON_KEY), acceptedBy(env.SUPABASE_SERVICE_ROLE_KEY)]);
const bothAccepted = anonStatus < 400 && serviceStatus < 400;
r.add('instance', 'المفتاحان من نفس النسخة', bothAccepted && sameIss ? 'PASS' : 'FAIL', `iss=${anon?.claims.iss ?? '؟'} · REST anon=${anonStatus} service=${serviceStatus}`, 'تأكد أن المفتاحين من نفس خدمة Supabase وأن SUPABASE_URL يشير إليها');

// No service key anywhere public
const leaks = Object.entries(env).filter(([k, v]) => k.startsWith('VITE_') && v && (v === env.SUPABASE_SERVICE_ROLE_KEY || decodeJwt(v)?.claims.role === 'service_role'));
function scan(dir: string, out: string[]) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (f === 'node_modules' || f === 'dist') continue;
    if (statSync(p).isDirectory()) scan(p, out);
    else if (env.SUPABASE_SERVICE_ROLE_KEY && readFileSync(p, 'utf8').includes(env.SUPABASE_SERVICE_ROLE_KEY)) out.push(p);
  }
  return out;
}
const webLeaks = scan(resolve('apps/web'), []);
r.add('leak', 'مفتاح service_role غير مكشوف للواجهة', leaks.length || webLeaks.length ? 'FAIL' : 'PASS', leaks.length || webLeaks.length ? [...leaks.map(([k]) => k), ...webLeaks].join('، ') : 'لا يوجد في أي VITE_* ولا في apps/web', 'احذف المفتاح من هذه المواضع فوراً');

// Postgres
if (!env.DATABASE_URL) {
  r.add('pg', 'الاتصال بـ Postgres', 'FAIL', 'DATABASE_URL غير مكتمل', 'املأ POSTGRES_HOST و POSTGRES_PORT و POSTGRES_PASSWORD');
} else {
  const client = new pg.Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 10_000, ssl: false });
  try {
    await client.connect();
    const { rows } = await client.query(
      `select split_part(version(), ' on ', 1) as version, now()::text as now, (now() at time zone 'Asia/Damascus')::text as damascus,
              current_setting('TimeZone') as tz, (select string_agg(extname || ' ' || extversion, ', ' order by extname) from pg_extension) as ext`,
    );
    const row = rows[0] as { version: string; now: string; damascus: string; tz: string; ext: string };
    const major = Number(/PostgreSQL (\d+)/.exec(row.version)?.[1] ?? 0);
    r.add('pg', 'الاتصال بـ Postgres', major >= 15 ? 'PASS' : 'FAIL', `${row.version} · ${mask(env.POSTGRES_HOST)}:${env.POSTGRES_PORT}`, 'يلزم Postgres 15 أو أحدث');
    console.log(`         الوقت (الخادم): ${row.now}  ·  TimeZone=${row.tz}`);
    console.log(`         الوقت بتوقيت دمشق: ${row.damascus}`);
    console.log(`         الإضافات: ${row.ext}`);
  } catch (err) {
    r.add('pg', 'الاتصال بـ Postgres', 'FAIL', (err as Error).message.replace(env.POSTGRES_PASSWORD ?? '\u0000', '•••'), 'تحقق من المنفذ العام وكلمة السر، وأن جدار الحماية يسمح بالمنفذ');
  } finally {
    await client.end().catch(() => undefined);
  }
}

console.log(r.failed ? `\n${r.failed} فحص فشل.` : '\nكل الفحوص نجحت.');
process.exitCode = r.failed ? 1 : 0;
