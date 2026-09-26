/**
 * npm run doctor -- --env .env.production
 * Read-only health check of a live installation: everything it creates it deletes. Exit 0 only with zero FAILs.
 * Writes doctor-report.json. Never freezes the database clock (the scan smoke test uses settings, not time).
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import webpush from 'web-push';
import WebSocket from 'ws';
import { loginCodeToEmail } from '@somar/shared';
import { checkAuth } from './check-auth.js';
import { connect } from './db-migrations.js';
import { verifySchema } from './db-verify.js';
import { decodeJwt, loadProdEnv, mask, Report } from './prod-env.js';
import { checkBucketsPrivate, storageRoundTrip } from './storage-setup.js';

const started = Date.now();
const env = loadProdEnv();
const r = new Report();
const opts = { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: WebSocket as never } };
const GEO = { p_lat: 36.2021, p_lng: 37.1343, p_accuracy: 10 };

async function section(title: string, fn: () => Promise<unknown>) {
  console.log(`\n── ${title}`);
  try {
    await fn();
  } catch (err) {
    r.add(title, title, 'FAIL', (err as Error).message.replaceAll(env.POSTGRES_PASSWORD || '\u0000', '•••'));
  }
}

const timed = async (url: string, init?: RequestInit) => {
  const t = Date.now();
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  return { res, ms: Date.now() - t };
};

// 1 ─ env
await section('1. المتغيرات', async () => {
  const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'DATABASE_URL', 'APP_BASE_URL', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'SUPABASE_STUDENT_EMAIL_DOMAIN', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'BOOTSTRAP_ADMIN_CODE'];
  const missing = required.filter((k) => !env[k]);
  r.add('env', 'المتغيرات المطلوبة موجودة', missing.length ? (missing.every((k) => k.startsWith('VAPID') || k === 'BOOTSTRAP_ADMIN_CODE') ? 'WARN' : 'FAIL') : 'PASS', missing.length ? `ناقص: ${missing.join(', ')}` : `${required.length} متغير`, 'املأها في .env.production');
  const leak = Object.entries(env).filter(([k, v]) => k.startsWith('VITE_') && v && (v === env.SUPABASE_SERVICE_ROLE_KEY || decodeJwt(v)?.claims.role === 'service_role'));
  r.add('env-leak', 'لا مفتاح service_role في VITE_*', leak.length ? 'FAIL' : 'PASS', leak.length ? leak.map(([k]) => k).join(', ') : 'نظيف', 'احذف المفتاح من متغيرات VITE_ فوراً وأعد توليده');
  for (const k of ['SUPABASE_URL', 'VITE_SUPABASE_URL', 'APP_BASE_URL']) {
    r.add(`https-${k}`, `${k} يستخدم HTTPS`, env[k]?.startsWith('https://') ? 'PASS' : 'FAIL', env[k] ?? '(فارغ)', 'الكاميرا والموقع لا يعملان بدون HTTPS');
  }
  if (env.VITE_STUDENT_EMAIL_DOMAIN && env.VITE_STUDENT_EMAIL_DOMAIN !== env.SUPABASE_STUDENT_EMAIL_DOMAIN) {
    r.add('env-domain', 'نطاق البريد متطابق', 'FAIL', `${env.VITE_STUDENT_EMAIL_DOMAIN} ≠ ${env.SUPABASE_STUDENT_EMAIL_DOMAIN}`, 'اجعل VITE_STUDENT_EMAIL_DOMAIN = SUPABASE_STUDENT_EMAIL_DOMAIN');
  }
});

// 2 ─ keys
await section('2. المفاتيح', async () => {
  const anon = decodeJwt(env.SUPABASE_ANON_KEY);
  const svc = decodeJwt(env.SUPABASE_SERVICE_ROLE_KEY);
  r.add('key-anon', 'دور مفتاح anon', anon?.claims.role === 'anon' ? 'PASS' : 'FAIL', `${anon?.claims.role} · ${mask(env.SUPABASE_ANON_KEY)}`);
  r.add('key-service', 'دور مفتاح service_role', svc?.claims.role === 'service_role' ? 'PASS' : 'FAIL', `${svc?.claims.role} · ${mask(env.SUPABASE_SERVICE_ROLE_KEY)}`);
  const days = Math.min(anon?.claims.exp ?? 0, svc?.claims.exp ?? 0) - Date.now() / 1000;
  r.add('key-exp', 'صلاحية المفاتيح', days > 30 * 86400 ? 'PASS' : 'FAIL', `${Math.floor(days / 86400)} يوماً متبقياً`);
  r.add('key-iss', 'نفس المُصدر', anon?.claims.iss === svc?.claims.iss ? 'PASS' : 'FAIL', `${anon?.claims.iss}`);
});

// 3 ─ reachability
await section('3. الوصول إلى Supabase', async () => {
  const headers = { apikey: env.SUPABASE_ANON_KEY ?? '' };
  const auth = await timed(`${env.SUPABASE_URL}/auth/v1/health`, { headers });
  r.add('auth-health', '/auth/v1/health', auth.res.ok ? 'PASS' : 'FAIL', `HTTP ${auth.res.status} · ${auth.ms}ms`);
  const rest = await timed(`${env.SUPABASE_URL}/rest/v1/`, { headers: { ...headers, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` } });
  r.add('rest', '/rest/v1/', rest.res.ok ? 'PASS' : 'FAIL', `HTTP ${rest.res.status} · ${rest.ms}ms`);
  if (env.SUPABASE_INTERNAL_URL) {
    const internal = await timed(`${env.SUPABASE_INTERNAL_URL}/auth/v1/health`, { headers }).catch(() => null);
    r.add('internal', 'الرابط الداخلي', internal?.res.ok ? 'PASS' : 'WARN', internal ? `HTTP ${internal.res.status}` : 'غير متاح من هذا الجهاز (طبيعي إن كان داخل الخادم فقط)');
  }
});

// 4–6 ─ database
let dbDrift: number | null = null;
await section('4–6. قاعدة البيانات والمخطط', async () => {
  const client = await connect(env.DATABASE_URL as string);
  try {
    const { rows } = await client.query<{ v: number; tz: string; now: Date; ext: string }>(
      `select current_setting('server_version_num')::int as v, current_setting('TimeZone') as tz, now() as now,
              (select string_agg(extname, ', ' order by extname) from pg_extension) as ext`,
    );
    const row = rows[0]!;
    dbDrift = Math.abs(Date.now() - row.now.getTime()) / 1000;
    r.add('pg-version', 'إصدار Postgres ≥ 15', row.v >= 150000 ? 'PASS' : 'FAIL', String(row.v));
    r.add('pg-ext', 'الإضافات (pgcrypto)', row.ext.split(', ').includes('pgcrypto') ? 'PASS' : 'FAIL', row.ext);
    r.add('pg-tz', 'منطقة الخادم الزمنية', 'PASS', `${row.tz} (المنطق التجاري يستخدم Asia/Damascus صراحة)`);
    await verifySchema(client, env, r, false);
  } finally {
    await client.end();
  }
});

// 8 ─ auth
await section('8. تسجيل الدخول', async () => {
  await checkAuth(env, r);
});

// 9 ─ storage
await section('9. التخزين', async () => {
  await checkBucketsPrivate(env, r);
  await storageRoundTrip(env, r);
});

// 7 + 11 ─ RLS between students + scan engine smoke test in a throwaway university
await section('7 + 11. عزل الطلاب ومحرك المسح (جامعة مؤقتة)', async () => {
  await scanSmokeTest();
});

// 10 ─ upload size through the public domain
await section('10. حجم الرفع عبر الدومين', async () => {
  const mb = Number(env.MAX_UPLOAD_MB || 10);
  const body = randomBytes(mb * 1024 * 1024);
  const res = await fetch(`${env.APP_BASE_URL}/api/_probe/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/octet-stream' },
    body,
    signal: AbortSignal.timeout(30_000),
  }).catch((err: Error) => ({ ok: false, status: 0, json: async () => ({ error: err.message }) }) as unknown as Response);
  const json = (await res.json().catch(() => ({}))) as { bytes?: number };
  const ok = res.ok && json.bytes === body.length;
  r.add('upload', `رفع ${mb}MB عبر ${new URL(env.APP_BASE_URL ?? 'http://x').host}`, ok ? 'PASS' : 'FAIL', `HTTP ${res.status}${json.bytes ? ` · ${json.bytes} بايت` : ''}`, res.status === 413 ? 'ارفع حد حجم الطلب في Traefik/Coolify' : 'التطبيق غير منشور بعد (المرحلة 9)');
});

// 12 ─ push
await section('12. الإشعارات الفورية', async () => {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    r.add('vapid', 'مفاتيح VAPID', 'FAIL', 'غير موجودة', 'تُولَّد في المرحلة 8');
    return;
  }
  try {
    webpush.setVapidDetails(env.VAPID_SUBJECT || 'mailto:admin@example.com', env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
    r.add('vapid', 'مفاتيح VAPID صالحة', 'PASS', mask(env.VAPID_PUBLIC_KEY));
  } catch (err) {
    r.add('vapid', 'مفاتيح VAPID صالحة', 'FAIL', (err as Error).message);
  }
  r.add('vapid-vite', 'VITE_VAPID_PUBLIC_KEY = VAPID_PUBLIC_KEY', env.VITE_VAPID_PUBLIC_KEY === env.VAPID_PUBLIC_KEY ? 'PASS' : 'FAIL', env.VITE_VAPID_PUBLIC_KEY ? 'متطابقان' : 'فارغ');
});

// 13 ─ app + 14 ─ clock
let appDrift: number | null = null;
await section('13. التطبيق المنشور', async () => {
  const health = await timed(`${env.APP_BASE_URL}/api/healthz`);
  const body = (await health.res.json().catch(() => ({}))) as { ok?: boolean; db?: string };
  const date = health.res.headers.get('date');
  if (date) appDrift = Math.abs(Date.now() - new Date(date).getTime()) / 1000;
  r.add('app-health', '/api/healthz', body.ok && body.db === 'up' ? 'PASS' : 'FAIL', `HTTP ${health.res.status} · ${JSON.stringify(body)}`, 'أكمل إعداد التطبيق في Coolify (المرحلة 9)');
  const html = await (await timed(`${env.APP_BASE_URL}/`)).res.text();
  const m = /window\.__APP_CONFIG__=(\{.*?\});<\/script>/.exec(html);
  const conf = m ? (JSON.parse(m[1] as string) as { supabaseUrl?: string; supabaseAnonKey?: string }) : null;
  const expected = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
  r.add('app-config', 'window.__APP_CONFIG__ يطابق المتغيرات', conf?.supabaseUrl === expected && conf?.supabaseAnonKey === env.VITE_SUPABASE_ANON_KEY ? 'PASS' : 'FAIL', conf ? `supabaseUrl=${conf.supabaseUrl || '(فارغ)'}` : 'غير موجود', 'أضف المتغيرات في Coolify وأعد النشر (المرحلة 9)');
});

await section('14. فرق الساعة', async () => {
  const d1 = dbDrift ?? Number.NaN;
  r.add('clock-db', 'فرق ساعة قاعدة البيانات', d1 < 60 ? 'PASS' : 'FAIL', `${d1.toFixed(1)} ث`);
  if (appDrift !== null) {
    const d2 = appDrift;
    r.add('clock-app', 'فرق ساعة خادم التطبيق', d2 < 60 ? 'PASS' : 'FAIL', `${d2.toFixed(1)} ث`);
  }
});

const seconds = ((Date.now() - started) / 1000).toFixed(1);
writeFileSync('doctor-report.json', JSON.stringify({ at: new Date().toISOString(), seconds: Number(seconds), failed: r.failed, results: r.results }, null, 2));
const warn = r.results.filter((x) => x.status === 'WARN').length;
console.log(`\nالنتيجة: ${r.results.length - r.failed - warn} نجح · ${warn} تحذير · ${r.failed} فشل · ${seconds} ثانية · doctor-report.json`);
process.exitCode = r.failed ? 1 : 0;

// ─────────────────────────────────────────────────────────────────────────────

async function scanSmokeTest() {
  const admin = createClient(env.SUPABASE_URL as string, env.SUPABASE_SERVICE_ROLE_KEY as string, opts);
  const domain = env.SUPABASE_STUDENT_EMAIL_DOMAIN || 'somar.local';
  const tag = `${Date.now().toString(36).toUpperCase()}`;
  const prefix = `DR${tag.slice(-6)}`;
  const userIds: string[] = [];
  let universityId: string | null = null;

  const must = async <T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>, what: string) => {
    const { data, error } = await p;
    if (error) throw new Error(`${what}: ${error.message}`);
    return data as T;
  };
  const account = async (code: string, password: string) => {
    const { data, error } = await admin.auth.admin.createUser({ email: loginCodeToEmail(code, domain), password, email_confirm: true });
    if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
    userIds.push(data.user.id);
    return data.user.id;
  };
  const signIn = async (code: string, password: string): Promise<SupabaseClient> => {
    const c = createClient(env.SUPABASE_URL as string, env.SUPABASE_ANON_KEY as string, opts);
    const { error } = await c.auth.signInWithPassword({ email: loginCodeToEmail(code, domain), password });
    if (error) throw new Error(`signIn: ${error.message}`);
    return c;
  };

  try {
    const uni = await must<{ id: string }>(admin.from('universities').insert({ name: `__DOCTOR__${tag}`, transport_prefix: prefix, week_start_dow: 6 }).select('id').single(), 'university');
    universityId = uni.id;
    await must(admin.from('settings').insert({ university_id: uni.id, scan_cooldown_minutes: 0, require_supervisor_geo: true }), 'settings');
    const college = await must<{ id: string }>(admin.from('colleges').insert({ university_id: uni.id, name: 'كلية الفحص' }).select('id').single(), 'college');
    await must(admin.from('areas').insert({ university_id: uni.id, name: 'منطقة الفحص' }), 'area');
    const today = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
    const pkg = await must<{ id: string }>(admin.from('packages').insert({ university_id: uni.id, name: 'باقة الفحص', trips_per_week: 3, semester_start: today, semester_end: today }).select('id').single(), 'package');

    const password = `Dr!${randomBytes(8).toString('hex')}A1`;
    const supCode = `${prefix}-SUP`;
    const supId = await account(supCode, password);
    await must(admin.from('profiles').insert({ id: supId, login_code: supCode, role: 'supervisor', university_id: uni.id, full_name: 'مشرف الفحص', must_change_password: false }), 'supervisor profile');

    const isoToday = ((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
    let n = 0;
    const student = async (workDays: number[], deltaThisWeek = 0) => {
      n += 1;
      const code = `${prefix}-${String(n).padStart(4, '0')}`;
      const id = await account(code, password);
      await must(admin.from('profiles').insert({ id, login_code: code, role: 'student', university_id: uni.id, full_name: `طالب فحص ${n}`, must_change_password: false }), 'profile');
      const st = await must<{ id: string; qr_token: string }>(
        admin.from('students').insert({ profile_id: id, university_id: uni.id, college_id: college.id, transport_number: code, full_name: `طالب فحص ${n}`, university_student_no: String(900000 + n), phone_e164: '+963944000000', work_days: workDays, shift_start: '08:00' }).select('id, qr_token').single(),
        'student',
      );
      const sub = await must<{ id: string }>(admin.from('subscriptions').insert({ student_id: st.id, package_id: pkg.id, trips_per_week: 3, starts_on: today, ends_on: today }).select('id').single(), 'subscription');
      if (deltaThisWeek) {
        const ws = await must<string>(admin.rpc('week_start', { d: today, dow: 6 }), 'week_start');
        await must(admin.from('subscription_adjustments').insert({ subscription_id: sub.id, week_start: ws, delta_trips: deltaThisWeek }), 'adjustment');
      }
      return { ...st, code };
    };
    const all = [1, 2, 3, 4, 5, 6, 7];
    const a = await student(all);
    const b = await student(all);
    const off = await student(all.filter((d) => d !== isoToday));
    const broke = await student(all, -3);
    const cool = await student(all);

    // 7: student isolation
    const asA = await signIn(a.code, password);
    const other = await asA.from('students').select('id').eq('id', b.id);
    const own = await asA.from('students').select('id');
    r.add('rls-students', 'طالب لا يرى طالباً آخر', (other.data ?? []).length === 0 && own.data?.length === 1 ? 'PASS' : 'FAIL', `يرى نفسه=${own.data?.length ?? 0} · يرى غيره=${other.data?.length ?? 0}`);

    // 11: scan engine
    const sup = await signIn(supCode, password);
    const scan = async (qr: string) => {
      const { data, error } = await sup.rpc('perform_scan', { p_qr_token: qr, ...GEO });
      if (error) throw new Error(`perform_scan: ${error.message}`);
      return data as { ok: boolean; code?: string; direction?: string; remaining_after?: number };
    };
    const s1 = await scan(a.qr_token);
    const s2 = await scan(a.qr_token);
    const s3 = await scan(a.qr_token);
    const s4 = await scan(off.qr_token);
    const s5 = await scan(broke.qr_token);
    await must(admin.from('settings').update({ scan_cooldown_minutes: 5 }).eq('university_id', uni.id), 'cooldown');
    const s6 = await scan(cool.qr_token);
    const s7 = await scan(cool.qr_token);
    const expect = (label: string, cond: boolean, got: unknown) => r.add(`scan-${label}`, `المسح: ${label}`, cond ? 'PASS' : 'FAIL', JSON.stringify(got));
    expect('ذهاب يخصم رحلة', s1.ok && s1.direction === 'outbound' && s1.remaining_after === 2, { d: s1.direction, rem: s1.remaining_after, code: s1.code });
    expect('عودة بلا خصم', s2.ok && s2.direction === 'return' && s2.remaining_after === 2, { d: s2.direction, rem: s2.remaining_after, code: s2.code });
    expect('المسح الثالث مرفوض', !s3.ok && s3.code === 'DAY_COMPLETE', s3.code);
    expect('يوم خارج الدوام مرفوض', !s4.ok && s4.code === 'OFFDAY_BLOCKED', s4.code);
    expect('بلا رصيد مرفوض', !s5.ok && s5.code === 'NO_BALANCE', s5.code);
    expect('فترة منع التكرار', s6.ok && !s7.ok && s7.code === 'COOLDOWN', s7.code);
  } finally {
    for (const id of userIds) await admin.auth.admin.deleteUser(id);
    if (universityId) {
      await admin.from('audit_log').delete().eq('university_id', universityId);
      await admin.from('universities').delete().eq('id', universityId);
    }
    const { data: left } = await admin.from('universities').select('id').like('name', '__DOCTOR__%');
    const { data: users } = await admin.auth.admin.listUsers({ perPage: 1000 });
    const leftUsers = (users?.users ?? []).filter((u) => u.email?.toLowerCase().startsWith(prefix.toLowerCase())).length;
    r.add('cleanup', 'تنظيف الجامعة المؤقتة', (left ?? []).length === 0 && leftUsers === 0 ? 'PASS' : 'FAIL', `جامعات متبقية=${left?.length ?? 0} · حسابات متبقية=${leftUsers}`);
  }
}
