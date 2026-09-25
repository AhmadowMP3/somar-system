import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  balance,
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
  type TestStudent,
} from './helpers.js';

const SAT = '2026-10-03';
let fx: Fixture;
let admin: SupabaseClient;
let sup: SupabaseClient;
let gs: SupabaseClient;

beforeAll(async () => {
  fx = await createUniversity({ tripsPerWeek: 3 });
  admin = (await createStaff(fx, 'admin')).client;
  sup = (await createStaff(fx, 'supervisor')).client;
  gs = (await createStaff(fx, 'university_supervisor')).client;
});

afterAll(async () => {
  await unfreeze();
  await destroyUniversity(fx);
  await closeDb();
});

describe('14. adjustments', () => {
  it('permanent and single-week adjustments alter quota; bulk inserts one row per active subscription', async () => {
    const a = await createStudent(fx, { tripsPerWeek: 3 });
    const b = await createStudent(fx, { tripsPerWeek: 3 });
    const c = await createStudent(fx, { tripsPerWeek: 3 });
    // c's subscription is cancelled → must not receive the bulk adjustment
    await service.from('subscriptions').update({ status: 'cancelled' }).eq('student_id', c.id);

    const { data: subA } = await service.from('subscriptions').select('id').eq('student_id', a.id).eq('status', 'active').single();
    await admin.from('subscription_adjustments').insert({ subscription_id: subA?.id, week_start: null, delta_trips: 1 });
    await admin.from('subscription_adjustments').insert({ subscription_id: subA?.id, week_start: SAT, delta_trips: 2 });
    expect((await balance(a.id, SAT)).quota).toBe(3 + 1 + 2);
    expect((await balance(a.id, '2026-10-10')).quota).toBe(3 + 1);

    await freeze(`${SAT} 09:00`);
    const { data: count, error } = await admin.rpc('bulk_adjust_package', { p_package_id: fx.packageId, p_scope: 'this_week', p_delta: 2 });
    expect(error).toBeNull();
    const { count: activeCount } = await service
      .from('subscriptions')
      .select('id', { count: 'exact', head: true })
      .eq('package_id', fx.packageId)
      .eq('status', 'active');
    expect(count).toBe(activeCount);
    const { data: rows } = await service.from('subscription_adjustments').select('subscription_id, week_start').eq('delta_trips', 2).eq('week_start', SAT);
    const bulkRows = (rows ?? []).filter((r) => r.subscription_id !== subA?.id);
    expect(new Set(bulkRows.map((r) => r.subscription_id)).size).toBe(bulkRows.length);
    expect((await balance(b.id, SAT)).quota).toBe(5);
    expect((await balance(b.id, '2026-10-10')).quota).toBe(3);

    const { error: permErr } = await admin.rpc('bulk_adjust_package', { p_package_id: fx.packageId, p_scope: 'permanent', p_delta: 1 });
    expect(permErr).toBeNull();
    expect((await balance(b.id, '2026-10-10')).quota).toBe(4);
    await unfreeze();
  });
});

describe('RLS', () => {
  let s1: TestStudent;
  let s2: TestStudent;
  let student1: SupabaseClient;

  beforeAll(async () => {
    s1 = await createStudent(fx);
    s2 = await createStudent(fx);
    await freeze(`${SAT} 07:30`);
    await scan(sup, { p_qr_token: s2.qrToken, ...GEO });
    await unfreeze();
    await service.storage.from('student-photos').upload(`${fx.universityId}/${s2.id}.jpg`, Buffer.from('fake'), { contentType: 'image/jpeg', upsert: true });
    await service.from('students').update({ photo_path: `${fx.universityId}/${s2.id}.jpg` }).eq('id', s2.id);
    student1 = await signIn(s1.transportNumber, s1.transportNumber);
  });

  it('16. a student cannot read another student\'s row, scans or photo', async () => {
    const own = await student1.from('students').select('id');
    expect(own.data?.map((r) => r.id)).toEqual([s1.id]);
    const otherRow = await student1.from('students').select('id').eq('id', s2.id);
    expect(otherRow.data).toEqual([]);
    const otherScans = await student1.from('scans').select('id').eq('student_id', s2.id);
    expect(otherScans.data).toEqual([]);
    const photo = await student1.storage.from('student-photos').createSignedUrl(`${fx.universityId}/${s2.id}.jpg`, 60);
    expect(photo.data?.signedUrl ?? null).toBeNull();
    const dash = await student1.rpc('student_dashboard', { p_student_id: s2.id });
    expect(dash.error?.message).toBe('FORBIDDEN');
    const bal = await student1.rpc('student_week_balance', { student_id: s2.id });
    expect(bal.error?.message).toBe('FORBIDDEN');
    const direct = await student1.from('students').update({ full_name: 'x y z' }).eq('id', s1.id).select('id');
    expect(direct.data ?? []).toEqual([]);
  });

  it('17. a supervisor cannot select students or insert scans, yet perform_scan works', async () => {
    const rows = await sup.from('students').select('id');
    expect(rows.data).toEqual([]);
    const insert = await sup.from('scans').insert({
      student_id: s1.id,
      university_id: fx.universityId,
      service_date: SAT,
      week_start: SAT,
      direction: 'outbound',
      method: 'qr',
      remaining_after: 0,
    });
    expect(insert.error).not.toBeNull();
    await freeze('2026-10-04 07:30');
    expect(await scan(sup, { p_qr_token: s1.qrToken, ...GEO })).toMatchObject({ ok: true, direction: 'outbound' });
    await unfreeze();
    const mine = await sup.rpc('my_scans_today');
    expect(mine.error).toBeNull();
  });

  it('18. a university supervisor can update a student but cannot write packages, subscriptions or adjustments', async () => {
    const upd = await gs.from('students').update({ residence_text: 'حلب الجديدة' }).eq('id', s1.id).select('id');
    expect(upd.data?.length).toBe(1);
    const pkg = await gs.from('packages').insert({
      university_id: fx.universityId,
      name: 'باقة ممنوعة',
      trips_per_week: 2,
      semester_start: '2026-09-01',
      semester_end: '2026-12-31',
    });
    expect(pkg.error).not.toBeNull();
    const sub = await gs.from('subscriptions').insert({
      student_id: s1.id,
      package_id: fx.packageId,
      trips_per_week: 9,
      starts_on: '2026-09-01',
      ends_on: '2026-12-31',
    });
    expect(sub.error).not.toBeNull();
    const { data: subRow } = await gs.from('subscriptions').select('id').eq('student_id', s1.id).eq('status', 'active').single();
    expect(subRow?.id).toBeTruthy();
    const adj = await gs.from('subscription_adjustments').insert({ subscription_id: subRow?.id, delta_trips: 5 });
    expect(adj.error).not.toBeNull();
    const bulk = await gs.rpc('bulk_adjust_package', { p_package_id: fx.packageId, p_scope: 'permanent', p_delta: 1 });
    expect(bulk.error?.message).toBe('FORBIDDEN');
    const assign = await gs.rpc('assign_subscription', { p_student_id: s1.id, p_package_id: fx.packageId });
    expect(assign.error?.message).toBe('FORBIDDEN');
    const immutable = await gs.from('students').update({ transport_number: 'HACK-0001' }).eq('id', s1.id);
    expect(immutable.error?.message).toBe('IMMUTABLE_FIELD');
  });
});
