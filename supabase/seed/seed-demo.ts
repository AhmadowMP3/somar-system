/**
 * Demo data seed (§14). Idempotent: if the demo university already exists it does nothing unless
 * `--reset` is passed, which deletes the demo university, its accounts and all dependent rows first.
 *
 * Usage: npm run seed:demo [-- --reset] [--force-demo]
 * Guard: refuses to run when NODE_ENV=production or when the database already holds any university other than
 * the demo one (identified by name AND prefix), unless --force-demo is passed.
 * Needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (from .env or the environment).
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config as loadEnv } from 'dotenv';
import sharp from 'sharp';
import { addDays, damascusDate, damascusInstant, isoWeekday, loginCodeToEmail, weekStart } from '@somar/shared';
import { loadConfig } from '../../apps/api/src/config.js';
import { provisionStaff, provisionStudent } from '../../apps/api/src/services/provisioning.js';
import {
  AREAS,
  COLLEGES,
  DEMO_UNIVERSITY,
  FAMILY_NAMES,
  FATHER_NAMES,
  FIRST_NAMES_F,
  FIRST_NAMES_M,
  OTHER_AREAS,
  PACKAGES,
  rng,
  STOPS,
} from './data.js';
import { buildWorkbook, IMPORT_FILE } from './generate-import.js';

loadEnv({ path: resolve(process.cwd(), '.env') });
const cfg = loadConfig({ ...process.env, DISABLE_CRON: 'true' });
if (!cfg.SUPABASE_URL || !cfg.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  process.exit(1);
}
const db: SupabaseClient = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export const DEMO_PASSWORD = 'Demo@12345';
const ADMIN_CODE = process.env.BOOTSTRAP_ADMIN_CODE || 'ADMIN';
const ADMIN_PASSWORD = process.env.BOOTSTRAP_ADMIN_PASSWORD || 'Admin@12345';
const r = rng(26);
const today = damascusDate();

function must<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data as T;
}

function demoUniversity() {
  return db
    .from('universities')
    .select('id')
    .eq('transport_prefix', DEMO_UNIVERSITY.transport_prefix)
    .eq('name', DEMO_UNIVERSITY.name)
    .maybeSingle();
}

class GuardError extends Error {}

function abort(lines: string[]): never {
  throw new GuardError(lines.join('\n'));
}

/** Never let demo data reach a real installation. Runs before any write. */
async function guard(args: string[]) {
  if (args.includes('--force-demo')) return;
  if (process.env.NODE_ENV === 'production') {
    abort([
      '⛔ تم إيقاف تحميل البيانات التجريبية: NODE_ENV=production.',
      '   البيانات التجريبية (80 طالباً وهمياً وسجل مسح مزيّف) لا يجوز أن تدخل قاعدة بيانات حقيقية.',
      '   إن كانت هذه قاعدة محلية للتجربة فقط، أعد التشغيل مع --force-demo.',
    ]);
  }
  const host = new URL(cfg.SUPABASE_URL).hostname;
  if (!['localhost', '127.0.0.1', '::1', 'host.docker.internal', 'kong'].includes(host)) {
    abort([
      `⛔ تم إيقاف تحميل البيانات التجريبية: Supabase ليس محلياً (${host}).`,
      '   البيانات التجريبية مخصصة لبيئة المراجعة المحلية فقط.',
      '   استخدم --force-demo فقط لخادم تجربة منفصل وليس للإنتاج.',
    ]);
  }
  const { data, error } = await db.from('universities').select('name, transport_prefix');
  if (error) throw new Error(`guard: ${error.message}`);
  const real = (data ?? []).filter(
    (u) => !(u.name === DEMO_UNIVERSITY.name && u.transport_prefix === DEMO_UNIVERSITY.transport_prefix),
  );
  if (real.length) {
    abort([
      '⛔ تم إيقاف تحميل البيانات التجريبية: قاعدة البيانات تحتوي جامعة حقيقية:',
      ...real.map((u) => `   • ${u.name} (${u.transport_prefix})`),
      '   لن تُخلط بيانات وهمية مع بيانات حقيقية. استخدم --force-demo فقط إن كنت متأكداً أنها قاعدة تجربة.',
    ]);
  }
}

async function reset() {
  const { data: uni } = await demoUniversity();
  if (!uni) return;
  const { data: profiles } = await db.from('profiles').select('id').eq('university_id', uni.id);
  for (const p of profiles ?? []) await db.auth.admin.deleteUser(p.id as string);
  must(await db.from('audit_log').delete().eq('university_id', uni.id), 'audit cleanup');
  must(await db.from('universities').delete().eq('id', uni.id), 'university delete');
  console.log('demo data removed');
}

async function ensureAdmin() {
  const { data: existing } = await db.from('profiles').select('id').ilike('login_code', ADMIN_CODE).maybeSingle();
  if (existing) return existing.id as string;
  const { profileId } = await provisionStaff(db, cfg, {
    login_code: ADMIN_CODE,
    full_name: 'مدير النظام',
    university_id: null,
    password: ADMIN_PASSWORD,
    role: 'admin',
    must_change_password: false,
  });
  return profileId;
}

async function logoPng(): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
    <circle cx="256" cy="256" r="240" fill="#2B2F36"/>
    <circle cx="256" cy="256" r="200" fill="none" stroke="#C9CDD3" stroke-width="16"/>
    <path d="M256 120 L360 380 L256 330 L152 380 Z" fill="#C1121F"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function avatarJpeg(seed: number, female: boolean): Promise<Buffer> {
  const hues = ['#3B5B7A', '#6B4E71', '#2F6F5E', '#7A5C3B', '#4D5B6B', '#5E3B3B', '#35606B'];
  const bg = hues[seed % hues.length];
  const skin = ['#E8C4A0', '#D9A77C', '#C68E5E', '#F1D3B3'][seed % 4];
  const hair = female ? '#3A2A20' : ['#1F1A17', '#3B2B22', '#5A4632'][seed % 3];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">
    <rect width="600" height="600" fill="${bg}"/>
    <ellipse cx="300" cy="560" rx="210" ry="170" fill="#E3E6EA"/>
    ${female ? `<ellipse cx="300" cy="250" rx="150" ry="170" fill="${hair}"/>` : ''}
    <circle cx="300" cy="250" r="115" fill="${skin}"/>
    ${female ? '' : `<path d="M185 225 Q300 110 415 225 Q400 150 300 140 Q200 150 185 225Z" fill="${hair}"/>`}
    <circle cx="258" cy="250" r="10" fill="#222"/><circle cx="342" cy="250" r="10" fill="#222"/>
    <path d="M262 305 Q300 330 338 305" stroke="#8a4b3a" stroke-width="8" fill="none" stroke-linecap="round"/>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer();
}

function distribution<T>(total: number, parts: [T, number][]): T[] {
  const out: T[] = [];
  for (const [value, count] of parts) for (let i = 0; i < count; i++) out.push(value);
  while (out.length < total) out.push(parts[0]![0]);
  return out.slice(0, total);
}

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r.next() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

const WEEK_ORDER = [6, 7, 1, 2, 3, 4, 5];

const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/**
 * Gives every demo student who already has a photo (i.e. who would have passed the first-login setup)
 * a weekly schedule for their work days and marks setup as completed. Idempotent.
 */
async function backfillSchedules(universityId: string): Promise<number> {
  const { data } = await db
    .from('students')
    .select('id, work_days, shift_start')
    .eq('university_id', universityId)
    .not('photo_path', 'is', null)
    .is('setup_completed_at', null);
  const students = (data ?? []) as { id: string; work_days: number[]; shift_start: string }[];
  const rows: Record<string, unknown>[] = [];
  for (const st of students) {
    const [h, m] = st.shift_start.split(':').map(Number);
    const start = (h ?? 8) * 60 + (m ?? 0);
    for (const dow of st.work_days) {
      const outbound = start - 60 + r.pick([0, 15, 30]);
      rows.push({ student_id: st.id, dow, outbound_time: hhmm(outbound), return_time: hhmm(start + r.pick([240, 300, 360, 420])) });
    }
  }
  for (let i = 0; i < rows.length; i += 500) must(await db.from('student_schedule').upsert(rows.slice(i, i + 500)), 'schedules');
  if (students.length) {
    must(
      await db.from('students').update({ setup_completed_at: new Date().toISOString() }).in('id', students.map((s) => s.id)),
      'setup flag',
    );
  }
  return students.length;
}

async function main() {
  const args = process.argv.slice(2);
  await guard(args);
  if (args.includes('--reset')) await reset();

  writeFileSync(IMPORT_FILE, buildWorkbook());
  const adminId = await ensureAdmin();

  const { data: existing } = await demoUniversity();
  if (existing) {
    const filled = await backfillSchedules(existing.id as string);
    console.log(`demo university already exists — nothing to do (use --reset to rebuild)${filled ? `; weekly schedules added for ${filled} students` : ''}`);
    return;
  }

  // university, logo, colleges, areas, packages
  const uni = must(await db.from('universities').insert(DEMO_UNIVERSITY).select('id').single(), 'university') as { id: string };
  const logoPath = `${uni.id}/logo.png`;
  must(await db.storage.from(cfg.SUPABASE_LOGO_BUCKET).upload(logoPath, await logoPng(), { contentType: 'image/png', upsert: true }), 'logo');
  must(await db.from('universities').update({ logo_path: logoPath }).eq('id', uni.id), 'logo path');
  must(await db.from('settings').insert({ university_id: uni.id }), 'settings');

  const colleges = must(
    await db.from('colleges').insert(COLLEGES.map((name) => ({ university_id: uni.id, name }))).select('id, name'),
    'colleges',
  ) as { id: string; name: string }[];
  const areas = must(
    await db.from('areas').insert(AREAS.map((name) => ({ university_id: uni.id, name }))).select('id, name'),
    'areas',
  ) as { id: string; name: string }[];
  const packages = must(
    await db
      .from('packages')
      .insert(PACKAGES.map((p) => ({ ...p, university_id: uni.id, semester_start: today, semester_end: addDays(today, 120) })))
      .select('id, trips_per_week, semester_end'),
    'packages',
  ) as { id: string; trips_per_week: number; semester_end: string }[];

  // stop library (each stop saved once) and routes: 3 outbound (one per main shift) + 1 return
  const library = must(
    await db
      .from('stops')
      .insert(
        STOPS.map((s) => ({
          university_id: uni.id,
          name: s.name,
          area_id: areas.find((a) => a.name === s.name)?.id ?? null,
          maps_url: `https://maps.google.com/?q=${s.lat},${s.lng}`,
          lat: s.lat,
          lng: s.lng,
        })),
      )
      .select('id, name'),
    'stop library',
  ) as { id: string; name: string }[];
  const routeDefs = [
    { name: 'الخط الأول — الشفاء إلى الجامعة', direction: 'outbound', departure_time: '07:00', stops: [0, 1, 2, 5, 14, 15] },
    { name: 'الخط الثاني — الشهباء إلى الجامعة', direction: 'outbound', departure_time: '09:00', stops: [4, 3, 11, 6, 13, 2, 15] },
    { name: 'الخط الثالث — سيف الدولة إلى الجامعة', direction: 'outbound', departure_time: '11:00', stops: [7, 8, 9, 10, 12, 15] },
    { name: 'خط العودة — من الجامعة', direction: 'return', departure_time: '14:30', stops: [15, 2, 1, 0, 4, 7, 9, 10] },
  ];
  for (const def of routeDefs) {
    const route = must(
      await db
        .from('routes')
        .insert({ university_id: uni.id, name: def.name, direction: def.direction, departure_time: def.departure_time, active_days: [6, 7, 1, 2, 3, 4] })
        .select('id')
        .single(),
      'route',
    ) as { id: string };
    const [h, m] = def.departure_time.split(':').map(Number);
    must(
      await db.from('route_stops').insert(
        def.stops.map((idx, i) => {
          const s = STOPS[idx]!;
          const minutes = (h ?? 0) * 60 + (m ?? 0) + i * 7;
          return {
            route_id: route.id,
            seq: i + 1,
            stop_id: library.find((l) => l.name === s.name)?.id,
            departure_time: `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`,
          };
        }),
      ),
      'stops',
    );
  }

  // staff
  const gs = await provisionStaff(db, cfg, {
    login_code: 'GS-01',
    full_name: 'سامر الخطيب',
    phone: '+963933111222',
    university_id: uni.id,
    password: DEMO_PASSWORD,
    role: 'university_supervisor',
    must_change_password: false,
  });
  const supervisors = [gs.profileId];
  for (const [i, name] of ['باسل النجار', 'طارق الحداد'].entries()) {
    const s = await provisionStaff(db, cfg, {
      login_code: `SUP-0${i + 1}`,
      full_name: name,
      phone: `+96394455566${i}`,
      university_id: uni.id,
      password: DEMO_PASSWORD,
      role: 'supervisor',
      must_change_password: false,
    });
    supervisors.push(s.profileId);
  }

  // 80 students
  const dayCounts = shuffle(distribution(80, [[5, 38], [4, 24], [3, 8], [6, 7], [2, 2], [1, 1]] as [number, number][]));
  const shifts = shuffle(distribution(80, [['08:00', 62], ['10:00', 15], ['12:00', 2], ['14:00', 1]] as [string, number][]));
  const collegeIdx = shuffle(distribution(80, [[0, 55], [1, 23], [2, 2]] as [number, number][]));
  const foreign = ['+966565324644', '+971501234567', '+905321234567', '+966501112233', '+971552223344'];

  type Seeded = { id: string; tn: string; profileId: string; days: number[]; shift: string; female: boolean; index: number };
  const students: Seeded[] = [];
  for (let i = 0; i < 80; i++) {
    const female = r.chance(0.55);
    const days = WEEK_ORDER.slice(0, dayCounts[i]).sort((a, b) => a - b);
    const withOther = i >= 70 && i < 78;
    const res = await provisionStudent(
      db,
      cfg,
      uni.id,
      {
        full_name: `${r.pick(female ? FIRST_NAMES_F : FIRST_NAMES_M)} ${r.pick(FATHER_NAMES)} ${r.pick(FAMILY_NAMES)}`,
        university_student_no: String(320100 + i),
        phone_e164: i >= 60 && i < 65 ? (foreign[i - 60] as string) : `+9639${r.int(30, 99)}${r.int(100000, 999999)}`,
        college_id: colleges[collegeIdx[i] ?? 0]!.id,
        residence_text: `حلب - ${r.pick(AREAS)}`,
        area_primary_id: withOther ? null : r.pick(areas).id,
        area_secondary_id: r.chance(0.2) ? r.pick(areas).id : null,
        area_other_text: withOther ? OTHER_AREAS[i % OTHER_AREAS.length]! : null,
        work_days: days,
        shift_start: shifts[i] as '08:00',
      },
      adminId,
    );
    if (!res.ok) throw new Error(`student ${i}: ${res.detail}`);
    students.push({ id: res.studentId, tn: res.transportNumber, profileId: res.profileId, days, shift: shifts[i] as string, female, index: i });
  }

  // demo-ready accounts: SHB-0001..0003 get a known password and no forced change; SHB-0003 is promoted
  for (const s of students.slice(0, 3)) {
    await db.auth.admin.updateUserById(s.profileId, { password: DEMO_PASSWORD });
    await db.from('profiles').update({ must_change_password: false }).eq('id', s.profileId);
  }
  must(await db.rpc('promote_student_to_supervisor', { p_student_id: students[2]!.id }), 'promote');
  supervisors.push(students[2]!.profileId);

  // photos for all but 6 (indexes 74..79 stay without a photo)
  for (const s of students.filter((x) => x.index < 74)) {
    const path = `${uni.id}/${s.id}.jpg`;
    must(await db.storage.from(cfg.SUPABASE_PHOTO_BUCKET).upload(path, await avatarJpeg(s.index, s.female), { contentType: 'image/jpeg', upsert: true }), 'photo');
    await db.from('students').update({ photo_path: path, photo_uploaded_at: new Date().toISOString() }).eq('id', s.id);
  }

  // students with a photo have finished first-login setup: weekly schedule around their shift start
  await backfillSchedules(uni.id);

  // subscriptions for 72 of 80 (90%); history needs them to start 4 weeks back
  const subscribed = students.filter((s) => s.index < 72);
  const subs = new Map<string, { id: string; quota: number }>();
  for (const s of subscribed) {
    const trips = Math.min(6, Math.max(3, s.days.length));
    const pkg = packages.find((p) => p.trips_per_week === trips) ?? packages[0]!;
    const endsOn = s.index >= 66 && s.index < 69 ? addDays(today, 5) : pkg.semester_end;
    const row = must(
      await db
        .from('subscriptions')
        .insert({ student_id: s.id, package_id: pkg.id, trips_per_week: trips, starts_on: addDays(today, -28), ends_on: endsOn, assigned_by: adminId })
        .select('id')
        .single(),
      'subscription',
    ) as { id: string };
    subs.set(s.id, { id: row.id, quota: trips });
  }

  // adjustments: 2 permanent (+1), 3 this-week (+2), 3 students forced to remaining 0 and 3 to remaining 1
  const thisWeek = weekStart(today, DEMO_UNIVERSITY.week_start_dow);
  const adjustments: { subscription_id: string; week_start: string | null; delta_trips: number; reason: string }[] = [];
  const bonus = (s: Seeded) => subs.get(s.id)!;
  for (const s of subscribed.slice(10, 12)) adjustments.push({ subscription_id: bonus(s).id, week_start: null, delta_trips: 1, reason: 'مكافأة دائمة' });
  for (const s of subscribed.slice(12, 15)) adjustments.push({ subscription_id: bonus(s).id, week_start: thisWeek, delta_trips: 2, reason: 'تعويض رحلات' });
  const zero = subscribed.slice(20, 23);
  const one = subscribed.slice(23, 26);

  // scan history: 3 full weeks + the elapsed days of the current week, respecting every invariant
  type ScanRow = Record<string, unknown>;
  const scans: ScanRow[] = [];
  const cancelled: string[] = [];
  const firstDay = addDays(thisWeek, -21);
  for (const s of subscribed) {
    const quotaFor = (ws: string) =>
      bonus(s).quota +
      adjustments.filter((a) => a.subscription_id === bonus(s).id && (a.week_start === null || a.week_start === ws)).reduce((n, a) => n + a.delta_trips, 0);
    const used = new Map<string, number>();
    for (let d = firstDay; d < today; d = addDays(d, 1)) {
      if (!s.days.includes(isoWeekday(d))) continue;
      const ws = weekStart(d, DEMO_UNIVERSITY.week_start_dow);
      const quota = quotaFor(ws);
      const u = used.get(ws) ?? 0;
      if (u >= quota || !r.chance(0.82)) continue;
      used.set(ws, u + 1);
      const stop = r.pick(STOPS);
      const jitter = () => (r.next() - 0.5) * 0.002;
      const sup = r.pick(supervisors);
      const [sh] = s.shift.split(':').map(Number);
      const outAt = damascusInstant(d, `${String((sh ?? 8) - 1).padStart(2, '0')}:${String(r.int(0, 50)).padStart(2, '0')}`);
      const base = {
        student_id: s.id,
        university_id: uni.id,
        service_date: d,
        week_start: ws,
        method: r.chance(0.93) ? 'qr' : 'manual',
        geo_denied: false,
        accuracy_m: r.int(5, 40),
      };
      const outId = crypto.randomUUID();
      scans.push({
        ...base,
        id: outId,
        supervisor_id: sup,
        scanned_at: outAt.toISOString(),
        direction: 'outbound',
        lat: stop.lat + jitter(),
        lng: stop.lng + jitter(),
        remaining_after: quota - (u + 1),
      });
      if (r.chance(0.9)) {
        const back = new Date(outAt.getTime() + (5 * 60 + r.int(0, 150)) * 60_000);
        scans.push({
          ...base,
          id: crypto.randomUUID(),
          supervisor_id: r.pick(supervisors),
          scanned_at: back.toISOString(),
          direction: 'return',
          lat: 36.1781 + jitter(),
          lng: 37.0741 + jitter(),
          remaining_after: quota - (u + 1),
        });
      }
      if (cancelled.length < 4 && r.chance(0.02)) cancelled.push(outId);
    }
    if (zero.includes(s) || one.includes(s)) {
      const target = zero.includes(s) ? 0 : 1;
      const current = quotaFor(thisWeek) - (used.get(thisWeek) ?? 0);
      if (current !== target) {
        adjustments.push({ subscription_id: bonus(s).id, week_start: thisWeek, delta_trips: target - current, reason: 'ضبط رصيد للعرض التجريبي' });
      }
    }
  }
  if (adjustments.length) must(await db.from('subscription_adjustments').insert(adjustments.map((a) => ({ ...a, created_by: adminId }))), 'adjustments');
  for (let i = 0; i < scans.length; i += 500) must(await db.from('scans').insert(scans.slice(i, i + 500)), 'scans');
  for (const id of cancelled) {
    const out = scans.find((x) => x.id === id)!;
    must(
      await db
        .from('scans')
        .update({ cancelled_at: new Date().toISOString(), cancelled_by: adminId, cancel_reason: 'مسح بالخطأ' })
        .eq('student_id', out.student_id as string)
        .eq('service_date', out.service_date as string),
      'cancel',
    );
  }

  // notifications: daily evaluation + one broadcast
  must(await db.rpc('run_daily_jobs', { p_force: true }), 'daily job');
  const broadcast = must(
    await db
      .from('broadcasts')
      .insert({ university_id: uni.id, title: 'أهلاً بكم', body: 'مرحباً بكم في نظام النقل الجامعي من سومر تورز.', audience: { kind: 'university' }, recipients: 80, created_by: adminId })
      .select('id')
      .single(),
    'broadcast',
  ) as { id: string };
  must(
    await db.from('notifications').insert(
      students.map((s) => ({
        university_id: uni.id,
        student_id: s.id,
        audience: { kind: 'university' },
        type: 'BROADCAST',
        title: 'أهلاً بكم',
        body: 'مرحباً بكم في نظام النقل الجامعي من سومر تورز.',
        data: { broadcast_id: broadcast.id },
        created_by: adminId,
        push_sent_at: new Date().toISOString(),
      })),
    ),
    'broadcast notifications',
  );

  console.log(`seeded: 80 students, ${scans.length} scans, ${adjustments.length} adjustments`);
  console.log(`logins (password ${DEMO_PASSWORD} unless noted):`);
  console.log(`  admin           ${ADMIN_CODE} / ${ADMIN_PASSWORD}`);
  console.log('  general sup.    GS-01');
  console.log('  supervisors     SUP-01, SUP-02, and promoted student SHB-0003');
  console.log('  students        SHB-0001, SHB-0002 (others: password = transport number, forced change)');
  console.log(`  emails use ${loginCodeToEmail('x', cfg.SUPABASE_STUDENT_EMAIL_DOMAIN).slice(2)}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof GuardError ? err.message : err);
  process.exitCode = err instanceof GuardError ? 2 : 1;
});
