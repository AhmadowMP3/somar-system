/**
 * npm run db:verify -- [--env .env.production]
 * Schema invariants after migrations: tracking/drift, tables, functions, views, RLS + policy counts,
 * critical indexes, empty test clock, and anon negative tests through the REST API.
 */
import type pg from 'pg';
import { connect, migrationStatus } from './db-migrations.js';
import { loadProdEnv, Report, type ProdEnv } from './prod-env.js';

export const APP_TABLES = [
  'universities', 'university_counters', 'colleges', 'areas', 'packages', 'routes', 'route_stops', 'profiles',
  'students', 'subscriptions', 'subscription_adjustments', 'scans', 'settings', 'broadcasts', 'notifications',
  'notification_reads', 'push_subscriptions', 'audit_log', 'stops',
];
const FUNCTIONS = [
  'perform_scan', 'cancel_scan', 'student_week_balance', 'student_dashboard', 'my_scans_today', 'run_daily_jobs',
  'assign_subscription', 'bulk_adjust_package', 'allocate_transport_number', 'provision_student', 'admin_dashboard',
];
const INDEXES = ['scans_one_direction_per_day_idx', 'subscriptions_one_active_idx'];

export async function verifySchema(client: pg.Client, env: ProdEnv, r: Report, printTable = true) {
  const states = await migrationStatus(client);
  const pending = states.filter((s) => s.status === 'pending').map((s) => s.filename);
  const drift = states.filter((s) => s.status === 'drift').map((s) => s.filename);
  r.add('migrations', 'ملفات الترحيل', pending.length || drift.length ? 'FAIL' : 'PASS',
    drift.length ? `تغيّر: ${drift.join(', ')}` : pending.length ? `غير مطبّق: ${pending.join(', ')}` : `${states.length}/${states.length} مطبّقة بدون تغيير`,
    'npm run db:apply -- --env .env.production');

  const tables = await client.query<{ table_name: string; rls: boolean; policies: number }>(
    `select c.relname as table_name, c.relrowsecurity as rls,
            (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and c.relname = any($1)`,
    [APP_TABLES],
  );
  const byName = new Map(tables.rows.map((t) => [t.table_name, t]));
  const missing = APP_TABLES.filter((t) => !byName.has(t));
  const noRls = tables.rows.filter((t) => !t.rls).map((t) => t.table_name);
  r.add('tables', 'جداول التطبيق', missing.length ? 'FAIL' : 'PASS', missing.length ? `ناقص: ${missing.join(', ')}` : `${APP_TABLES.length} جدول`);
  r.add('rls', 'RLS مفعّل على كل جدول', noRls.length ? 'FAIL' : 'PASS', noRls.length ? `بدون RLS: ${noRls.join(', ')}` : 'كل الجداول');
  if (printTable) {
    console.log('         الجدول                       RLS   السياسات');
    for (const t of APP_TABLES) {
      const row = byName.get(t);
      console.log(`         ${t.padEnd(28)} ${row?.rls ? '✓' : '✗'}     ${row?.policies ?? '-'}`);
    }
  }

  const fns = await client.query<{ proname: string }>(
    `select distinct p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = any($1)`,
    [FUNCTIONS],
  );
  const missingFns = FUNCTIONS.filter((f) => !fns.rows.some((x) => x.proname === f));
  r.add('functions', 'الدوال', missingFns.length ? 'FAIL' : 'PASS', missingFns.length ? `ناقص: ${missingFns.join(', ')}` : `${FUNCTIONS.length} دالة`);

  const view = await client.query(`select 1 from pg_views where schemaname = 'public' and viewname = 'v_student_balance'`);
  r.add('views', 'العرض v_student_balance', view.rowCount ? 'PASS' : 'FAIL', view.rowCount ? 'موجود' : 'غير موجود');

  const idx = await client.query<{ indexname: string; indexdef: string }>(
    `select indexname, indexdef from pg_indexes where schemaname = 'public' and indexname = any($1)`,
    [INDEXES],
  );
  const scanIdx = idx.rows.find((i) => i.indexname === INDEXES[0]);
  const subIdx = idx.rows.find((i) => i.indexname === INDEXES[1]);
  r.add('idx-scans', 'فهرس «ذهاب/عودة واحد لكل يوم»', scanIdx && /student_id, service_date, direction/.test(scanIdx.indexdef) && /cancelled_at IS NULL/i.test(scanIdx.indexdef) ? 'PASS' : 'FAIL', scanIdx ? 'UNIQUE … WHERE cancelled_at IS NULL' : 'غير موجود');
  r.add('idx-subs', 'فهرس «اشتراك فعّال واحد»', subIdx && /status = 'active'/.test(subIdx.indexdef) ? 'PASS' : 'FAIL', subIdx ? 'UNIQUE … WHERE status = active' : 'غير موجود');

  const clock = await client.query<{ n: number }>(`select count(*)::int as n from private.test_clock`).catch(() => null);
  r.add('clock', 'ساعة الاختبار فارغة', clock?.rows[0]?.n === 0 ? 'PASS' : 'FAIL', clock ? `${clock.rows[0]?.n} صف` : 'الجدول غير موجود', 'delete from private.test_clock; — وجود صف يجمّد وقت النظام');

  for (const table of ['students', 'scans', 'settings']) {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?select=*&limit=1`, {
      headers: { apikey: env.SUPABASE_ANON_KEY ?? '', Authorization: `Bearer ${env.SUPABASE_ANON_KEY ?? ''}` },
    });
    const body = await res.text();
    const empty = res.status >= 400 || body.trim() === '[]';
    r.add(`anon-${table}`, `مجهول لا يرى ${table}`, empty ? 'PASS' : 'FAIL', `HTTP ${res.status} ${body.slice(0, 40)}`, 'راجع سياسات RLS');
  }
}

if (process.argv[1]?.endsWith('db-verify.ts')) {
  const env = loadProdEnv();
  const r = new Report();
  const client = await connect(env.DATABASE_URL as string);
  try {
    await verifySchema(client, env, r);
  } finally {
    await client.end();
  }
  console.log(r.failed ? `\n${r.failed} فحص فشل.` : '\nكل الفحوص نجحت.');
  process.exitCode = r.failed ? 1 : 0;
}
