import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config as loadEnv } from 'dotenv';
import pg from 'pg';
import { loginCodeToEmail } from '@somar/shared';
import { loadConfig, type Config } from '../../src/config.js';
import { provisionStaff, provisionStudent, type StudentData } from '../../src/services/provisioning.js';
import { AREAS, COLLEGES } from '../../../../supabase/seed/data.js';

loadEnv({ path: resolve(__dirname, '../../../../.env') });

export const cfg: Config = loadConfig({ ...process.env, DISABLE_CRON: 'true' });
const clientOpts = { auth: { persistSession: false, autoRefreshToken: false } };
export const service: SupabaseClient = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_SERVICE_ROLE_KEY, clientOpts);

let pool: pg.Pool | null = null;
export function db(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  return pool;
}

export async function closeDb() {
  await pool?.end();
  pool = null;
}

/** Freeze the database clock (Damascus wall time, e.g. '2026-10-03 07:30'). */
export async function freeze(damascusLocal: string) {
  await db().query(
    `insert into private.test_clock (id, frozen_at) values (1, ($1::timestamp at time zone 'Asia/Damascus'))
     on conflict (id) do update set frozen_at = excluded.frozen_at`,
    [damascusLocal],
  );
}

export async function unfreeze() {
  await db().query('delete from private.test_clock');
}

export function uniquePrefix(): string {
  return `T${randomBytes(4).toString('hex').toUpperCase().slice(0, 6)}`;
}

export type Fixture = {
  universityId: string;
  prefix: string;
  collegeId: string;
  areaIds: Record<string, string>;
  packageId: string;
  profileIds: string[];
};

export async function createUniversity(opts: { tripsPerWeek?: number; weekStartDow?: number } = {}): Promise<Fixture> {
  const prefix = uniquePrefix();
  const { data: u, error } = await service
    .from('universities')
    .insert({ name: `جامعة اختبار ${prefix}`, transport_prefix: prefix, week_start_dow: opts.weekStartDow ?? 6 })
    .select('id')
    .single();
  if (error || !u) throw new Error(`university: ${error?.message}`);
  const universityId = u.id as string;
  const { data: colleges } = await service
    .from('colleges')
    .insert(COLLEGES.map((name) => ({ university_id: universityId, name })))
    .select('id, name');
  const { data: areas } = await service
    .from('areas')
    .insert(AREAS.map((name) => ({ university_id: universityId, name })))
    .select('id, name');
  const { data: pkg } = await service
    .from('packages')
    .insert({
      university_id: universityId,
      name: 'باقة اختبار',
      trips_per_week: opts.tripsPerWeek ?? 5,
      semester_start: '2026-09-01',
      semester_end: '2027-01-31',
    })
    .select('id')
    .single();
  await service.from('settings').insert({ university_id: universityId, scan_cooldown_minutes: 5, require_supervisor_geo: true });
  return {
    universityId,
    prefix,
    collegeId: (colleges ?? [])[0]?.id as string,
    areaIds: Object.fromEntries((areas ?? []).map((a) => [a.name as string, a.id as string])),
    packageId: pkg?.id as string,
    profileIds: [],
  };
}

export async function setSettings(fx: Fixture, patch: Record<string, unknown>) {
  const { error } = await service.from('settings').update(patch).eq('university_id', fx.universityId);
  if (error) throw new Error(error.message);
}

export async function signIn(code: string, password: string): Promise<SupabaseClient> {
  const client = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, clientOpts);
  const { error } = await client.auth.signInWithPassword({
    email: loginCodeToEmail(code, cfg.SUPABASE_STUDENT_EMAIL_DOMAIN),
    password,
  });
  if (error) throw new Error(`sign in ${code}: ${error.message}`);
  return client;
}

export async function accessToken(client: SupabaseClient): Promise<string> {
  const { data } = await client.auth.getSession();
  return data.session?.access_token as string;
}

export const STAFF_PASSWORD = 'Staff@12345';

export async function createStaff(fx: Fixture, role: 'supervisor' | 'university_supervisor' | 'admin') {
  const code = `${fx.prefix}-${role.slice(0, 3).toUpperCase()}${randomBytes(2).toString('hex').toUpperCase()}`;
  const { profileId } = await provisionStaff(service, cfg, {
    login_code: code,
    full_name: `موظف ${role}`,
    university_id: role === 'admin' ? null : fx.universityId,
    password: STAFF_PASSWORD,
    role,
    must_change_password: false,
  });
  fx.profileIds.push(profileId);
  return { profileId, code, client: await signIn(code, STAFF_PASSWORD) };
}

export type TestStudent = { id: string; transportNumber: string; profileId: string; qrToken: string };

export async function createStudent(
  fx: Fixture,
  opts: { workDays?: number[]; subscribe?: boolean; startsOn?: string; endsOn?: string; tripsPerWeek?: number; nationalId?: string } = {},
): Promise<TestStudent> {
  const data: StudentData = {
    full_name: 'طالب اختبار ثلاثي',
    university_student_no: String(Math.floor(Math.random() * 1e9)),
    national_id: opts.nationalId ?? null,
    phone_e164: '+963944123456',
    college_id: fx.collegeId,
    residence_text: null,
    area_primary_id: null,
    area_secondary_id: null,
    area_other_text: null,
    work_days: opts.workDays ?? [1, 2, 3, 4, 5, 6, 7],
    shift_start: '08:00',
  };
  const res = await provisionStudent(service, cfg, fx.universityId, data, null);
  if (!res.ok) throw new Error(`student: ${res.detail}`);
  fx.profileIds.push(res.profileId);
  await service.from('profiles').update({ must_change_password: false }).eq('id', res.profileId);
  if (opts.subscribe !== false) {
    const { error } = await service.from('subscriptions').insert({
      student_id: res.studentId,
      package_id: fx.packageId,
      trips_per_week: opts.tripsPerWeek ?? 5,
      starts_on: opts.startsOn ?? '2026-09-01',
      ends_on: opts.endsOn ?? '2027-01-31',
    });
    if (error) throw new Error(error.message);
  }
  const { data: st } = await service.from('students').select('qr_token').eq('id', res.studentId).single();
  return { id: res.studentId, transportNumber: res.transportNumber, profileId: res.profileId, qrToken: st?.qr_token as string };
}

export const GEO = { p_lat: 36.2021, p_lng: 37.1343, p_accuracy: 12 };

export type ScanResponse = {
  ok: boolean;
  code?: string;
  direction?: string;
  quota?: number;
  used?: number;
  remaining_after?: number;
  scan_id?: string | null;
  preview?: boolean;
  minutes_remaining?: number;
  offday_override?: boolean;
  bus?: { id: string; bus_number: string; plate_number: string; seats: number; boarded: number } | null;
};

/** A bus of the fixture's university (inserted as the service role). */
export async function createBus(fx: Fixture, opts: { busNumber?: string; seats?: number; active?: boolean } = {}) {
  const { data, error } = await service
    .from('buses')
    .insert({
      university_id: fx.universityId,
      bus_number: opts.busNumber ?? `B-${uniquePrefix()}`,
      plate_number: '123456',
      seats: opts.seats ?? 30,
      is_active: opts.active ?? true,
    })
    .select('id, bus_number')
    .single();
  if (error || !data) throw new Error(`createBus: ${error?.message}`);
  return data as { id: string; bus_number: string };
}

export async function scan(client: SupabaseClient, args: Record<string, unknown>): Promise<ScanResponse> {
  const { data, error } = await client.rpc('perform_scan', args);
  if (error) throw new Error(`perform_scan: ${error.message}`);
  return data as ScanResponse;
}

export async function balance(studentId: string, onDate: string) {
  const { rows } = await db().query(
    'select (b).week_start::text as week_start, (b).quota, (b).used, (b).remaining from (select private.compute_balance($1, $2::date) b) x',
    [studentId, onDate],
  );
  return rows[0] as { week_start: string; quota: number; used: number; remaining: number };
}

export async function destroyUniversity(fx: Fixture) {
  const { data: profiles } = await service.from('profiles').select('id').eq('university_id', fx.universityId);
  const ids = new Set([...(profiles ?? []).map((p) => p.id as string), ...fx.profileIds]);
  for (const id of ids) await service.auth.admin.deleteUser(id);
  await db().query('delete from public.audit_log where university_id = $1', [fx.universityId]);
  await service.from('universities').delete().eq('id', fx.universityId);
}
