import type { FastifyInstance } from 'fastify';
import type { SupabaseClient } from '@supabase/supabase-js';
import * as XLSX from 'xlsx';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import {
  accessToken,
  cfg,
  closeDb,
  createStaff,
  createStudent,
  createUniversity,
  destroyUniversity,
  freeze,
  GEO,
  scan,
  service,
  signIn,
  unfreeze,
  type Fixture,
} from './helpers.js';

// 2026-10-03 is a Saturday.
const SAT = '2026-10-03';

let app: FastifyInstance;
let fx: Fixture;
let adminToken: string;
let admin: SupabaseClient;
let sup: SupabaseClient;

beforeAll(async () => {
  app = (await buildApp(cfg, { logger: false })).app;
  fx = await createUniversity();
  const a = await createStaff(fx, 'admin');
  admin = a.client;
  adminToken = await accessToken(a.client);
  sup = (await createStaff(fx, 'supervisor')).client;
});

afterEach(async () => {
  await unfreeze();
});

afterAll(async () => {
  await unfreeze();
  await app.close();
  await destroyUniversity(fx);
  await closeDb();
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function createMember(body: Record<string, unknown>) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/members',
    headers: auth(adminToken),
    payload: { university_id: fx.universityId, ...body },
  });
  return res;
}

function sheet(rows: unknown[][]): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

function multipart(fields: Record<string, string>, file: Buffer) {
  const boundary = `----somar${Date.now()}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  chunks.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="doctors.xlsx"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function runImport(kind: string, file: Buffer, dryRun: boolean) {
  const body = multipart({ university_id: fx.universityId, kind, dry_run: String(dryRun) }, file);
  const res = await app.inject({ method: 'POST', url: '/api/members/import', headers: { ...body.headers, ...auth(adminToken) }, payload: body.payload });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { summary: { total: number; created: number; updated: number; duplicates: number; rejected: number } };
}

describe('doctors and university employees', () => {
  it('creates a doctor manually: account, transport number, no college / phone needed', async () => {
    const res = await createMember({ kind: 'doctor', full_name: 'د. سامر خالد حداد', job_title: 'استاذ نظري', work_days: [6, 1] });
    expect(res.statusCode, res.body).toBe(201);
    const { student_id, transport_number } = res.json() as { student_id: string; transport_number: string };
    expect(transport_number).toBe(`${fx.prefix}-D001`);
    const { data } = await service.from('students').select('kind, college_id, phone_e164, job_title, work_days, profiles(role)').eq('id', student_id).single();
    expect(data).toMatchObject({ kind: 'doctor', college_id: null, phone_e164: null, job_title: 'استاذ نظري', work_days: [1, 6] });
    expect((data as unknown as { profiles: { role: string } }).profiles.role).toBe('student');
    // the doctor signs in with the transport number like a student
    await signIn(transport_number, transport_number);
  });

  it('doctors and employees each have their own number series, apart from students', async () => {
    const doc = (await createMember({ kind: 'doctor', full_name: 'هلا محمد توتو' })).json() as { transport_number: string };
    const emp = (await createMember({ kind: 'employee', full_name: 'سنا عمار عطري' })).json() as { transport_number: string };
    const st = await createStudent(fx, { subscribe: false });
    expect(doc.transport_number).toBe(`${fx.prefix}-D002`);
    expect(emp.transport_number).toBe(`${fx.prefix}-E001`);
    expect(st.transportNumber).toMatch(new RegExp(`^${fx.prefix}-?\\d{4}$`));
  });

  it('rejects an invalid phone and a one-word name', async () => {
    expect((await createMember({ kind: 'employee', full_name: 'سامر' })).statusCode).toBe(400);
    expect((await createMember({ kind: 'employee', full_name: 'سامر حداد', phone: '12' })).statusCode).toBe(400);
  });

  it('a doctor rides with no package, on any day, without using a quota', async () => {
    const res = await createMember({ kind: 'doctor', full_name: 'ريم سعد رحمة', work_days: [2] });
    const { student_id } = res.json() as { student_id: string };
    const { data: st } = await service.from('students').select('qr_token').eq('id', student_id).single();
    const qr = (st as { qr_token: string }).qr_token;

    // Saturday is not one of her days and she has no subscription.
    await freeze(`${SAT} 07:30`);
    const out = await scan(sup, { p_qr_token: qr, ...GEO });
    expect(out).toMatchObject({ ok: true, direction: 'outbound', unlimited: true, quota: null, remaining_after: null });
    await freeze(`${SAT} 14:00`);
    expect(await scan(sup, { p_qr_token: qr, ...GEO })).toMatchObject({ ok: true, direction: 'return', unlimited: true });

    // next days keep working: no weekly quota
    for (const day of ['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']) {
      await freeze(`${day} 07:30`);
      expect(await scan(sup, { p_qr_token: qr, ...GEO })).toMatchObject({ ok: true, direction: 'outbound' });
    }
  });

  it('students keep their rules (no subscription → rejected)', async () => {
    const st = await createStudent(fx, { subscribe: false });
    await freeze(`${SAT} 07:30`);
    expect(await scan(sup, { p_qr_token: st.qrToken, ...GEO })).toMatchObject({ ok: false, code: 'NO_ACTIVE_SUBSCRIPTION' });
  });

  it('imports doctors from Excel: dedupes repeat submissions, updates on re-import', async () => {
    const file = sheet([
      ['Timestamp', 'اسم الدكتور الثلاثي', 'مواعيد الدوام', 'المهنة', 'مكان السكن', 'ايام الادوام', 'عدد ايام دوام ضمن الاسبوع', 'ملاحظات اضافية او نصائح'],
      [46287.9, 'ناهد محمود ديب', null, null, null, 'الثلاثاء, السبت', 'يومين', null],
      [46288.4, 'زهيدة هندو محمد', 46238, 'محاضر في العيادات', 'الأشرفية', 'الاحد, الجمعة', 'يومين', 'لايوجد'],
      [46288.5, 'د. منتهى عبدالحميد عون', null, 'استاذ نظري', 'حلب الجديدة', 'الاحد', 'يوم واحد', null],
      [46289.5, 'منتهى عبد الحميد عون', null, 'استاذ نظري', 'حلب الجديدة شمالي', 'الاحد, الاثنين', 'يومين', null],
      [null, null, null, null, 'البناية عالزاوية', null, null, null],
    ]);
    const preview = await runImport('doctor', file, true);
    expect(preview.summary).toMatchObject({ total: 4, created: 3, duplicates: 1, rejected: 0 });
    const { count: none } = await service.from('students').select('id', { count: 'exact', head: true }).eq('university_id', fx.universityId).eq('kind', 'doctor').ilike('full_name', '%منتهى%');
    expect(none).toBe(0);

    const first = await runImport('doctor', file, false);
    expect(first.summary).toMatchObject({ created: 3, duplicates: 1 });
    // only name, job and days are imported; residence, hours and notes are ignored
    const { data: muntaha } = await service
      .from('students')
      .select('full_name, job_title, work_days, residence_text, work_hours_text, notes, phone_e164')
      .eq('university_id', fx.universityId)
      .ilike('full_name', '%منتهى%');
    expect(muntaha).toEqual([
      { full_name: 'منتهى عبد الحميد عون', job_title: 'استاذ نظري', work_days: [1, 7], residence_text: null, work_hours_text: null, notes: null, phone_e164: null },
    ]);

    const again = await runImport('doctor', file, false);
    expect(again.summary).toMatchObject({ created: 0, updated: 3 });
    // employees are a separate list: the same names are new there
    expect((await runImport('employee', file, true)).summary).toMatchObject({ created: 3 });
  });

  it('a sheet without a name column is refused', async () => {
    const body = multipart({ university_id: fx.universityId, kind: 'doctor', dry_run: 'true' }, sheet([['المهنة'], ['استاذ']]));
    const res = await app.inject({ method: 'POST', url: '/api/members/import', headers: { ...body.headers, ...auth(adminToken) }, payload: body.payload });
    expect(res.statusCode).toBe(422);
  });

  it('the student list and dashboard counters leave doctors out', async () => {
    const { data: rows } = await admin.from('v_rider_balance').select('kind').eq('university_id', fx.universityId).eq('kind', 'student');
    const { data: dash } = await admin.rpc('admin_dashboard', { p_university_id: fx.universityId });
    expect((dash as { students_total: number }).students_total).toBe(rows?.length);
  });

  it('a doctor dashboard reports the kind', async () => {
    const res = await createMember({ kind: 'employee', full_name: 'لينا ناصر حداد', job_title: 'محاسبة' });
    const { transport_number } = res.json() as { transport_number: string };
    const client = await signIn(transport_number, transport_number);
    const { data } = await client.rpc('student_dashboard');
    expect((data as { student: Record<string, unknown> }).student).toMatchObject({ kind: 'employee', job_title: 'محاسبة' });
  });
});

describe('doctor first login: transport number password, then the nearest stop', () => {
  it('logs in with the transport number, must change it, then picks a library stop once', async () => {
    const res = await createMember({ kind: 'doctor', full_name: 'طارق خالد عتر', job_title: 'محاضر في العيادات', work_days: [2] });
    const { student_id, transport_number } = res.json() as { student_id: string; transport_number: string };
    const client = await signIn(transport_number, transport_number);
    const { data: profile } = await client.from('profiles').select('must_change_password').single();
    expect(profile).toEqual({ must_change_password: true });

    const stop = await service.from('stops').insert({ university_id: fx.universityId, name: 'دوار الشفاء للدكاترة' }).select('id').single();
    const off = await service.from('stops').insert({ university_id: fx.universityId, name: 'نقطة موقوفة', is_active: false }).select('id').single();
    const stopId = stop.data?.id as string;

    expect((await client.rpc('complete_member_setup', { p_stop_id: off.data?.id })).error?.message).toBe('STOP_INVALID');
    expect((await client.rpc('complete_member_setup', { p_stop_id: stopId })).error).toBeNull();
    const { data: row } = await service.from('students').select('home_stop_id, setup_completed_at').eq('id', student_id).single();
    expect(row?.home_stop_id).toBe(stopId);
    expect(row?.setup_completed_at).toBeTruthy();
    expect((await client.rpc('complete_member_setup', { p_stop_id: stopId })).error?.message).toBe('SETUP_LOCKED');

    // deleting the stop from the library just clears the choice
    await service.from('stops').delete().eq('id', stopId);
    const { data: after } = await service.from('students').select('home_stop_id').eq('id', student_id).single();
    expect(after?.home_stop_id).toBeNull();
  });

  it('students cannot use the doctor step', async () => {
    const st = await createStudent(fx, { subscribe: false });
    const client = await signIn(st.transportNumber, st.transportNumber);
    const stop = await service.from('stops').insert({ university_id: fx.universityId, name: 'نقطة طالب' }).select('id').single();
    expect((await client.rpc('complete_member_setup', { p_stop_id: stop.data?.id })).error?.message).toBe('FORBIDDEN');
  });
});
