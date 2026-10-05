import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import * as XLSX from 'xlsx';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { IMPORT_EXPECTED, IMPORT_FILE } from '../../../../supabase/seed/generate-import.js';
import {
  accessToken,
  cfg,
  closeDb,
  createStaff,
  createStudent,
  createUniversity,
  db,
  destroyUniversity,
  freeze,
  GEO,
  scan,
  service,
  signIn,
  unfreeze,
  type Fixture,
} from './helpers.js';

type Part = { name: string; value: string } | { name: string; filename: string; contentType: string; data: Buffer };

function multipart(parts: Part[]) {
  const boundary = `----somar${Date.now()}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if ('filename' in p) {
      chunks.push(
        Buffer.from(`Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\nContent-Type: ${p.contentType}\r\n\r\n`),
      );
      chunks.push(p.data, Buffer.from('\r\n'));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n${p.value}\r\n`));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

let app: FastifyInstance;
let fx: Fixture;
let adminToken: string;
let admin: SupabaseClient;

beforeAll(async () => {
  app = (await buildApp(cfg, { logger: false })).app;
  fx = await createUniversity();
  const a = await createStaff(fx, 'admin');
  admin = a.client;
  adminToken = await accessToken(a.client);
});

afterAll(async () => {
  await unfreeze();
  await app.close();
  await destroyUniversity(fx);
  await closeDb();
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe('19. Excel import of demo-import.xlsx', () => {
  const file = () => readFileSync(IMPORT_FILE);
  const run = async (dryRun: boolean) => {
    const body = multipart([
      { name: 'university_id', value: fx.universityId },
      { name: 'dry_run', value: String(dryRun) },
      { name: 'file', filename: 'demo-import.xlsx', contentType: 'application/octet-stream', data: file() },
    ]);
    const res = await app.inject({ method: 'POST', url: '/api/students/import', headers: { ...body.headers, ...auth(adminToken) }, payload: body.payload });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as {
      summary: { total: number; created: number; updated: number; rejected: number; duplicates: number; accepted: number };
      rows: { row_number: number; status: string; reasons: string[] }[];
      needs_area_mapping: number;
    };
  };

  it('previews without writing, commits exact counts, and re-runs idempotently', async () => {
    const preview = await run(true);
    expect(preview.summary).toMatchObject({
      total: IMPORT_EXPECTED.total,
      created: IMPORT_EXPECTED.created,
      updated: 0,
      rejected: IMPORT_EXPECTED.rejected,
      duplicates: IMPORT_EXPECTED.duplicates,
    });
    const { count: none } = await service.from('students').select('id', { count: 'exact', head: true }).eq('university_id', fx.universityId);
    expect(none).toBe(0);

    const commit = await run(false);
    expect(commit.summary).toMatchObject({
      total: IMPORT_EXPECTED.total,
      created: IMPORT_EXPECTED.created,
      updated: 0,
      rejected: IMPORT_EXPECTED.rejected,
      duplicates: IMPORT_EXPECTED.duplicates,
      accepted: IMPORT_EXPECTED.created,
    });
    expect(commit.rows.filter((r) => r.status === 'rejected').map((r) => r.row_number)).toEqual(IMPORT_EXPECTED.rejectedRows);
    expect(commit.needs_area_mapping).toBe(IMPORT_EXPECTED.needsAreaMapping);

    const { data: students } = await service
      .from('students')
      .select('university_student_no, national_id, full_name, phone_e164, college_id, work_days, shift_start, needs_area_mapping, transport_number, profile_id')
      .eq('university_id', fx.universityId);
    expect(students?.length).toBe(IMPORT_EXPECTED.created);
    const winner = students?.find((s) => s.university_student_no === IMPORT_EXPECTED.duplicateNewerFirst.studentNo);
    expect(winner?.full_name).toBe(IMPORT_EXPECTED.duplicateNewerFirst.winningName);
    for (const phone of IMPORT_EXPECTED.foreignPhones) expect(students?.some((s) => s.phone_e164 === phone)).toBe(true);
    expect(students?.filter((s) => s.needs_area_mapping).length).toBe(IMPORT_EXPECTED.needsAreaMapping);
    expect(students?.some((s) => s.university_student_no === '339055')).toBe(true);
    expect(students?.some((s) => s.university_student_no === '339056')).toBe(true);
    expect(students?.some((s) => s.university_student_no === '323047')).toBe(true);
    const numbers = (students ?? []).map((s) => s.transport_number).sort();
    expect(numbers[0]).toBe(`${fx.prefix}-0001`);
    expect(numbers.at(-1)).toBe(`${fx.prefix}-${String(IMPORT_EXPECTED.created).padStart(4, '0')}`);
    const { data: college } = await service.from('colleges').select('id').eq('university_id', fx.universityId).eq('name', 'كلية الصيدلة');
    expect(college?.length).toBe(1);

    // optional answers left empty are imported as empty (asked at first login)
    expect(students?.find((s) => s.university_student_no === IMPORT_EXPECTED.incompleteStudentNo)).toMatchObject({
      phone_e164: null,
      college_id: null,
      work_days: [],
      shift_start: null,
    });

    // the imported student logs in with the national number and must change the password
    const one = students?.[0];
    const client = await signIn(one?.transport_number as string, one?.national_id as string);
    const { data: me } = await client.from('profiles').select('must_change_password, role').single();
    expect(me).toEqual({ must_change_password: true, role: 'student' });

    const again = await run(false);
    expect(again.summary).toMatchObject({ created: 0, updated: IMPORT_EXPECTED.created, rejected: IMPORT_EXPECTED.rejected });
    const { count } = await service.from('students').select('id', { count: 'exact', head: true }).eq('university_id', fx.universityId);
    expect(count).toBe(IMPORT_EXPECTED.created);
    const { count: audits } = await service.from('audit_log').select('id', { count: 'exact', head: true }).eq('university_id', fx.universityId).eq('action', 'import.run');
    expect(audits).toBe(2);
  });

  it('fails with an Arabic message naming a missing required column', async () => {
    const XLSX = await import('xlsx');
    const ws = XLSX.utils.aoa_to_sheet([['Timestamp', 'الرقم جامعي'], ['2025/09/01 10:00:00', '1']]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'x');
    const data = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const body = multipart([
      { name: 'university_id', value: fx.universityId },
      { name: 'dry_run', value: 'true' },
      { name: 'file', filename: 'x.xlsx', contentType: 'application/octet-stream', data },
    ]);
    const res = await app.inject({ method: 'POST', url: '/api/students/import', headers: { ...body.headers, ...auth(adminToken) }, payload: body.payload });
    expect(res.statusCode).toBe(422);
    expect(res.json().message_ar).toContain('الاسم الثلاثي');
  });
});

describe('20. photo upload', () => {
  it('second upload is PHOTO_LOCKED; after admin reset it is allowed again', async () => {
    const st = await createStudent(fx);
    const token = await accessToken(await signIn(st.transportNumber, st.transportNumber));
    const png = await sharp({ create: { width: 800, height: 1000, channels: 3, background: '#c1121f' } }).png().toBuffer();
    const upload = () => {
      const body = multipart([{ name: 'photo', filename: 'me.png', contentType: 'image/png', data: png }]);
      return app.inject({ method: 'POST', url: '/api/me/photo', headers: { ...body.headers, ...auth(token) }, payload: body.payload });
    };
    const first = await upload();
    expect(first.statusCode).toBe(200);
    const { data: stored } = await service.storage.from('student-photos').download(`${fx.universityId}/${st.id}.jpg`);
    const meta = await sharp(Buffer.from(await (stored as Blob).arrayBuffer())).metadata();
    expect(meta).toMatchObject({ format: 'jpeg', width: 600, height: 600 });
    expect(meta.exif).toBeUndefined();

    const second = await upload();
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe('PHOTO_LOCKED');

    const reset = await app.inject({ method: 'POST', url: `/api/students/${st.id}/reset-photo`, headers: auth(adminToken) });
    expect(reset.statusCode).toBe(200);
    expect((await upload()).statusCode).toBe(200);
  });

  it('rejects unsupported types', async () => {
    const st = await createStudent(fx);
    const token = await accessToken(await signIn(st.transportNumber, st.transportNumber));
    const body = multipart([{ name: 'photo', filename: 'x.gif', contentType: 'image/gif', data: Buffer.from('GIF89a') }]);
    const res = await app.inject({ method: 'POST', url: '/api/me/photo', headers: { ...body.headers, ...auth(token) }, payload: body.payload });
    expect(res.statusCode).toBe(415);
  });
});

describe('21-22. notifications', () => {
  it('changing a route departure time creates one notification per active student', async () => {
    const { count: active } = await service
      .from('students')
      .select('id', { count: 'exact', head: true })
      .eq('university_id', fx.universityId)
      .eq('is_active', true);
    const { data: route } = await admin
      .from('routes')
      .insert({ university_id: fx.universityId, name: 'خط الاختبار', direction: 'outbound', departure_time: '07:00' })
      .select('id')
      .single();
    const upd = await admin.from('routes').update({ departure_time: '07:15' }).eq('id', route?.id);
    expect(upd.error).toBeNull();
    const { data: notes } = await service
      .from('notifications')
      .select('student_id, body')
      .eq('university_id', fx.universityId)
      .eq('type', 'SCHEDULE_CHANGED');
    expect(notes?.length).toBe(active);
    expect(new Set(notes?.map((n) => n.student_id)).size).toBe(active);
    expect(notes?.[0]?.body).toContain('7:15 ص');
  });

  it('the daily job is idempotent', async () => {
    const st = await createStudent(fx, { tripsPerWeek: 1, endsOn: '2026-10-06' });
    const sup = (await createStaff(fx, 'supervisor')).client;
    await freeze('2026-10-03 07:30');
    await scan(sup, { p_qr_token: st.qrToken, ...GEO });
    await freeze('2026-10-03 10:00');
    const first = await db().query('select public.run_daily_jobs(true) as r');
    const second = await db().query('select public.run_daily_jobs(true) as r');
    expect(first.rows[0].r.low_balance).toBeGreaterThanOrEqual(1);
    expect(second.rows[0].r.low_balance).toBe(0);
    expect(second.rows[0].r.expiring).toBe(0);
    const { data } = await service.from('notifications').select('type').eq('student_id', st.id).in('type', ['LOW_BALANCE', 'SUBSCRIPTION_EXPIRING']);
    expect(data?.map((d) => d.type).sort()).toEqual(['LOW_BALANCE', 'SUBSCRIPTION_EXPIRING']);
    const { data: digests } = await service
      .from('notifications')
      .select('type')
      .eq('university_id', fx.universityId)
      .is('student_id', null)
      .eq('service_date', '2026-10-03');
    expect(digests?.map((d) => d.type).sort()).toEqual(['EXPIRING_DIGEST', 'LOW_BALANCE_DIGEST']);
    await unfreeze();
  });

  it('broadcast reaches the chosen audience', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/notifications/broadcast',
      headers: auth(adminToken),
      payload: { university_id: fx.universityId, title: 'تنبيه', body: 'لا دوام غداً', audience: { kind: 'college', college_id: fx.collegeId } },
    });
    expect(res.statusCode).toBe(201);
    const { count } = await service
      .from('students')
      .select('id', { count: 'exact', head: true })
      .eq('university_id', fx.universityId)
      .eq('college_id', fx.collegeId)
      .eq('is_active', true);
    expect(res.json().recipients).toBe(count);
  });
});

describe('23. regenerate QR', () => {
  it('invalidates the old token immediately and the new token works', async () => {
    const st = await createStudent(fx);
    const sup = (await createStaff(fx, 'supervisor')).client;
    const res = await app.inject({ method: 'POST', url: `/api/students/${st.id}/regenerate-qr`, headers: auth(adminToken) });
    expect(res.statusCode).toBe(200);
    const newToken = res.json().qr_token as string;
    expect(newToken).not.toBe(st.qrToken);
    await freeze('2026-10-05 07:30');
    expect(await scan(sup, { p_qr_token: st.qrToken, ...GEO })).toMatchObject({ ok: false, code: 'UNKNOWN_QR' });
    expect(await scan(sup, { p_qr_token: newToken, ...GEO })).toMatchObject({ ok: true, direction: 'outbound' });
    await unfreeze();
    const { count } = await service.from('audit_log').select('id', { count: 'exact', head: true }).eq('entity_id', st.id).eq('action', 'qr.regenerate');
    expect(count).toBe(1);
  });

  it('non-admins are forbidden', async () => {
    const st = await createStudent(fx);
    const gs = await createStaff(fx, 'university_supervisor');
    const res = await app.inject({ method: 'POST', url: `/api/students/${st.id}/regenerate-qr`, headers: auth(await accessToken(gs.client)) });
    expect(res.statusCode).toBe(403);
    expect(res.json().message_ar).toBeTruthy();
  });
});

describe('scan endpoint & health', () => {
  it('returns a signed photo URL on success', async () => {
    const st = await createStudent(fx);
    await service.storage.from('student-photos').upload(`${fx.universityId}/${st.id}.jpg`, Buffer.from('jpg'), { contentType: 'image/jpeg', upsert: true });
    await service.from('students').update({ photo_path: `${fx.universityId}/${st.id}.jpg` }).eq('id', st.id);
    const sup = await createStaff(fx, 'supervisor');
    await freeze('2026-10-05 07:30');
    const res = await app.inject({
      method: 'POST',
      url: '/api/scan',
      headers: auth(await accessToken(sup.client)),
      payload: { qr_token: st.qrToken, lat: GEO.p_lat, lng: GEO.p_lng, accuracy: 5 },
    });
    await unfreeze();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.student.photo_url).toMatch(/^http.*token=/);
  });

  it('healthz reports db up', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/healthz' });
    expect(res.json()).toMatchObject({ ok: true, db: 'up' });
  });
});

describe('national number as the initial password', () => {
  const sheet = (rows: unknown[][]) => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  };
  const headers = [
    'Timestamp', 'الاسم الثلاثي', 'الرقم جامعي', 'الرقم الوطني', 'رقم الهاتف المستخدم في الوتس ضمن مجموعة',
    'الكلية التابع اليها', 'المنطقة القريبة اليك', 'اختر أيام دوامك بالاسبوع', 'متى يبدأ دوامك الاسبوعي',
  ];

  it('imports the column, logs in with it, and an admin reset goes back to it', async () => {
    const no = String(700000000 + Math.floor(Math.random() * 1e8));
    const no2 = String(Number(no) + 1);
    const file = sheet([
      headers,
      ['2025/09/01 10:00:00', 'سامي رامي حداد', no, '02010045678', '0944000111', 'كلية طب الأسنان', 'الرجاء', 'السبت, الأحد', '8'],
      ['2025/09/01 10:05:00', 'رنا سامي حداد', no2, null, '0944000112', 'كلية طب الأسنان', 'الرجاء', 'السبت', '10'],
    ]);
    const body = multipart([
      { name: 'university_id', value: fx.universityId },
      { name: 'dry_run', value: 'false' },
      { name: 'file', filename: 'students.xlsx', contentType: 'application/octet-stream', data: file },
    ]);
    const res = await app.inject({ method: 'POST', url: '/api/students/import', headers: { ...body.headers, ...auth(adminToken) }, payload: body.payload });
    expect(res.statusCode, res.body).toBe(200);
    // a row without a national number is imported too: its first password is the transport number
    expect((res.json() as { summary: { created: number; rejected: number } }).summary).toMatchObject({ created: 2, rejected: 0 });

    const { data: rows } = await service
      .from('students')
      .select('id, transport_number, national_id, university_student_no')
      .eq('university_id', fx.universityId)
      .in('university_student_no', [no, no2]);
    const withId = rows?.find((r) => r.university_student_no === no) as { id: string; transport_number: string; national_id: string };
    const without = rows?.find((r) => r.university_student_no === no2) as { transport_number: string; national_id: string | null };
    expect(withId.national_id).toBe('02010045678');
    expect(without.national_id).toBeNull();
    await signIn(withId.transport_number, '02010045678');
    await expect(signIn(withId.transport_number, withId.transport_number)).rejects.toThrow();
    await signIn(without.transport_number, without.transport_number);

    const { data: profile } = await service.from('students').select('profile_id').eq('id', withId.id).single();
    await service.auth.admin.updateUserById((profile as { profile_id: string }).profile_id, { password: 'Changed@123' });
    const reset = await app.inject({ method: 'POST', url: `/api/students/${withId.id}/reset-password`, headers: auth(adminToken) });
    expect(reset.statusCode).toBe(200);
    await signIn(withId.transport_number, '02010045678');
  });
});

describe('package from «مبلغ الشريحة»', () => {
  it('assigns the package whose price matches; a re-import keeps an existing package', async () => {
    await service.from('packages').update({ price: 205 }).eq('id', fx.packageId);
    const { data: three } = await service
      .from('packages')
      .insert({ university_id: fx.universityId, name: 'باقة 3 أيام اختبار', trips_per_week: 3, price: 175, semester_start: '2026-10-03', semester_end: '2027-02-06' })
      .select('id')
      .single();
    const base = 600000000 + Math.floor(Math.random() * 1e7);
    const nos = [String(base), String(base + 1), String(base + 2)];
    const sheetOf = (amounts: unknown[]) => {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.aoa_to_sheet([
          ['الرقم جامعي', 'الاسم الثلاثي', 'الرقم الوطني', 'مبلغ الشريحة'],
          [nos[0], 'باقة خمسة أيام', '02010045001', amounts[0]],
          [nos[1], 'باقة ثلاثة أيام', '02010045002', amounts[1]],
          [nos[2], 'بلا باقة معروفة', '02010045003', amounts[2]],
        ]),
        'S',
      );
      return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    };
    const run = async (file: Buffer, dryRun: boolean) => {
      const body = multipart([
        { name: 'university_id', value: fx.universityId },
        { name: 'dry_run', value: String(dryRun) },
        { name: 'file', filename: 's.xlsx', contentType: 'application/octet-stream', data: file },
      ]);
      const res = await app.inject({ method: 'POST', url: '/api/students/import', headers: { ...body.headers, ...auth(adminToken) }, payload: body.payload });
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as { packages: { name: string | null; count: number }[]; rows: { status: string; transport_number?: string }[] };
    };

    const preview = await run(sheetOf([205, '175', 150]), true);
    expect(preview.packages).toEqual(expect.arrayContaining([
      { name: 'باقة اختبار', count: 1 },
      { name: 'باقة 3 أيام اختبار', count: 1 },
      { name: null, count: 1 },
    ]));
    const commit = await run(sheetOf([205, '175', 150]), false);
    expect(commit.rows.every((r) => r.transport_number)).toBe(true);
    const subsOf = async () => {
      const { data } = await service
        .from('students')
        .select('university_student_no, subscriptions(package_id, status, trips_per_week, starts_on, ends_on)')
        .in('university_student_no', nos);
      type Sub = { package_id: string; status: string; trips_per_week: number; starts_on: string };
      return Object.fromEntries(
        (data ?? []).map((s) => [s.university_student_no, (s.subscriptions as Sub[]).filter((x) => x.status === 'active')]),
      ) as Record<string, Sub[]>;
    };
    let subs = await subsOf();
    expect(subs[nos[0]!]).toEqual([expect.objectContaining({ package_id: fx.packageId, trips_per_week: 5, starts_on: '2026-09-01' })]);
    expect(subs[nos[1]!]).toEqual([expect.objectContaining({ package_id: three?.id, trips_per_week: 3, starts_on: '2026-10-03' })]);
    expect(subs[nos[2]!]).toEqual([]);

    // re-import with changed amounts: existing packages stay, the student without one gets it now
    await run(sheetOf([175, 205, 205]), false);
    subs = await subsOf();
    expect(subs[nos[0]!]?.map((x) => x.package_id)).toEqual([fx.packageId]);
    expect(subs[nos[1]!]?.map((x) => x.package_id)).toEqual([three?.id]);
    expect(subs[nos[2]!]?.map((x) => x.package_id)).toEqual([fx.packageId]);
  });
});

describe('a library stop named in the area column', () => {
  it('is linked through an area of the same name instead of «مناطق بحاجة ربط»', async () => {
    await service.from('stops').insert({ university_id: fx.universityId, name: 'دوار الصالات' });
    const no = String(500000000 + Math.floor(Math.random() * 1e7));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ['الرقم جامعي', 'الاسم الثلاثي', 'الرقم الوطني', 'المنطقة القريبة اليك'],
        [no, 'طالب نقطة وقوف', '02010045999', 'دوار الصالات'],
      ]),
      'S',
    );
    const file = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    for (const dryRun of [true, false]) {
      const body = multipart([
        { name: 'university_id', value: fx.universityId },
        { name: 'dry_run', value: String(dryRun) },
        { name: 'file', filename: 's.xlsx', contentType: 'application/octet-stream', data: file },
      ]);
      const res = await app.inject({ method: 'POST', url: '/api/students/import', headers: { ...body.headers, ...auth(adminToken) }, payload: body.payload });
      expect(res.statusCode, res.body).toBe(200);
      const json = res.json() as { needs_area_mapping: number; rows: { warnings: string[] }[] };
      expect(json.needs_area_mapping).toBe(0);
      expect(json.rows[0]?.warnings.some((w) => w.includes('دوار الصالات'))).toBe(false);
    }
    const { data } = await service
      .from('students')
      .select('needs_area_mapping, areas:areas!students_area_primary_id_fkey(name)')
      .eq('university_id', fx.universityId)
      .eq('university_student_no', no)
      .single();
    expect(data).toMatchObject({ needs_area_mapping: false, areas: { name: 'دوار الصالات' } });
  });
});
