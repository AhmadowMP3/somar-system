import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { config as loadEnv } from 'dotenv';
import sharp from 'sharp';
import { loadConfig } from '../../apps/api/src/config.js';
import { provisionStaff, provisionStudent } from '../../apps/api/src/services/provisioning.js';
import { AREAS, COLLEGES, DEMO_UNIVERSITY } from '../../supabase/seed/data.js';

loadEnv({ path: resolve(process.cwd(), '.env') });

export const cfg = loadConfig({ ...process.env, DISABLE_CRON: 'true' });
export const service = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
export const ADMIN_CODE = process.env.BOOTSTRAP_ADMIN_CODE || 'ADMIN';
export const ADMIN_PASSWORD = process.env.BOOTSTRAP_ADMIN_PASSWORD || 'Admin@12345';
export const STAFF_PASSWORD = 'Staff@12345';
export const E2E_NAME_PREFIX = 'جامعة اختبار الواجهة';

export type E2EUniversity = {
  id: string;
  prefix: string;
  collegeId: string;
  packageId: string;
  packageName: string;
  tripsPerWeek: number;
  supervisorCode: string;
  stopUrl: string;
};

export async function createE2EUniversity(): Promise<E2EUniversity> {
  const prefix = `E${randomBytes(3).toString('hex').toUpperCase()}`;
  const { data: u, error } = await service
    .from('universities')
    .insert({ name: `${E2E_NAME_PREFIX} ${prefix}`, transport_prefix: prefix, week_start_dow: 6 })
    .select('id')
    .single();
  if (error || !u) throw new Error(error?.message);
  const { data: colleges } = await service.from('colleges').insert(COLLEGES.map((name) => ({ university_id: u.id, name }))).select('id');
  await service.from('areas').insert(AREAS.map((name) => ({ university_id: u.id, name })));
  const today = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
  const end = new Date(Date.now() + 120 * 86_400_000).toISOString().slice(0, 10);
  const { data: pkg } = await service
    .from('packages')
    .insert({ university_id: u.id, name: 'باقة الواجهة 5 أيام', trips_per_week: 5, semester_start: today, semester_end: end })
    .select('id, name')
    .single();
  await service.from('settings').insert({ university_id: u.id, scan_cooldown_minutes: 0, require_supervisor_geo: true });
  const { data: route } = await service
    .from('routes')
    .insert({ university_id: u.id, name: 'خط الواجهة', direction: 'outbound', departure_time: '07:00' })
    .select('id')
    .single();
  const stopUrl = 'https://maps.google.com/?q=36.2021,37.1343';
  const { data: lib } = await service
    .from('stops')
    .insert([
      { university_id: u.id, name: 'ساحة جامعة', maps_url: stopUrl, lat: 36.2021, lng: 37.1343 },
      { university_id: u.id, name: 'الرجاء', maps_url: 'https://maps.google.com/?q=36.2322,37.1389', lat: 36.2322, lng: 37.1389 },
    ])
    .select('id, name');
  const stopId = (name: string) => lib?.find((s) => s.name === name)?.id;
  await service.from('route_stops').insert([
    { route_id: route?.id, seq: 1, stop_id: stopId('ساحة جامعة'), departure_time: '07:05' },
    { route_id: route?.id, seq: 2, stop_id: stopId('الرجاء'), departure_time: '07:15' },
  ]);
  const supervisorCode = `${prefix}-SUP`;
  await provisionStaff(service, cfg, {
    login_code: supervisorCode,
    full_name: 'مشرف الواجهة',
    university_id: u.id,
    password: STAFF_PASSWORD,
    role: 'supervisor',
    must_change_password: false,
  });
  return {
    id: u.id,
    prefix,
    collegeId: colleges?.[0]?.id as string,
    packageId: pkg?.id as string,
    packageName: pkg?.name as string,
    tripsPerWeek: 5,
    supervisorCode,
    stopUrl,
  };
}

export type E2EStudent = { id: string; transportNumber: string; profileId: string; qrToken: string; name: string };

export async function createE2EStudent(
  uni: E2EUniversity,
  opts: { subscribe?: boolean; photo?: boolean; ready?: boolean; password?: string } = {},
): Promise<E2EStudent> {
  const name = `طالب واجهة ${Math.floor(1000 + Math.random() * 9000)}`;
  const res = await provisionStudent(
    service,
    cfg,
    uni.id,
    {
      full_name: name,
      university_student_no: String(Math.floor(Math.random() * 1e9)),
      phone_e164: '+963944555666',
      college_id: uni.collegeId,
      residence_text: null,
      area_primary_id: null,
      area_secondary_id: null,
      area_other_text: null,
      work_days: [1, 2, 3, 4, 5, 6, 7],
      shift_start: '08:00',
    },
    null,
  );
  if (!res.ok) throw new Error(res.detail);
  if (opts.subscribe) {
    const today = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
    await service.from('subscriptions').insert({
      student_id: res.studentId,
      package_id: uni.packageId,
      trips_per_week: uni.tripsPerWeek,
      starts_on: today,
      ends_on: new Date(Date.now() + 100 * 86_400_000).toISOString().slice(0, 10),
    });
  }
  if (opts.photo) {
    const path = `${uni.id}/${res.studentId}.jpg`;
    const jpg = await sharp({ create: { width: 600, height: 600, channels: 3, background: '#35606B' } }).jpeg().toBuffer();
    await service.storage.from(cfg.SUPABASE_PHOTO_BUCKET).upload(path, jpg, { contentType: 'image/jpeg', upsert: true });
    await service.from('students').update({ photo_path: path, photo_uploaded_at: new Date().toISOString() }).eq('id', res.studentId);
  }
  if (opts.ready) {
    await service.auth.admin.updateUserById(res.profileId, { password: opts.password ?? STAFF_PASSWORD });
    await service.from('profiles').update({ must_change_password: false }).eq('id', res.profileId);
  }
  const { data } = await service.from('students').select('qr_token').eq('id', res.studentId).single();
  return { id: res.studentId, transportNumber: res.transportNumber, profileId: res.profileId, qrToken: data?.qr_token as string, name };
}

export async function demoUniversityId(): Promise<string | null> {
  const { data } = await service.from('universities').select('id').eq('transport_prefix', DEMO_UNIVERSITY.transport_prefix).maybeSingle();
  return (data?.id as string) ?? null;
}

export async function destroyE2EUniversities() {
  const { data: unis } = await service.from('universities').select('id').like('name', `${E2E_NAME_PREFIX}%`);
  for (const u of unis ?? []) {
    const { data: profiles } = await service.from('profiles').select('id').eq('university_id', u.id);
    for (const p of profiles ?? []) await service.auth.admin.deleteUser(p.id as string);
    await service.from('audit_log').delete().eq('university_id', u.id);
    await service.from('universities').delete().eq('id', u.id);
  }
}

export async function jpegFile(): Promise<Buffer> {
  return sharp({ create: { width: 900, height: 1200, channels: 3, background: '#6B4E71' } }).jpeg().toBuffer();
}
