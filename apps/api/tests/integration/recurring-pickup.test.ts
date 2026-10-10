import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeDb,
  createStaff,
  createStudent,
  createUniversity,
  destroyUniversity,
  freeze,
  service,
  setSettings,
  signIn,
  unfreeze,
  type Fixture,
  type TestStudent,
} from './helpers.js';

let fx: Fixture;
let other: Fixture;
let a: TestStudent;
let b: TestStudent;
let asA: SupabaseClient;
let asB: SupabaseClient;
let gs: SupabaseClient;
let stopA: string;
let stopB: string;
let foreignStop: string;

beforeAll(async () => {
  fx = await createUniversity();
  other = await createUniversity();
  a = await createStudent(fx);
  b = await createStudent(fx);
  asA = await signIn(a.transportNumber, a.transportNumber);
  asB = await signIn(b.transportNumber, b.transportNumber);
  gs = (await createStaff(fx, 'university_supervisor')).client;
  const { data } = await service
    .from('stops')
    .insert([
      { university_id: fx.universityId, name: 'دوار الصاخور', area_id: fx.areaIds['الرجاء'] },
      { university_id: fx.universityId, name: 'جسر الحج' },
      { university_id: other.universityId, name: 'موقف غريب' },
    ])
    .select('id, name');
  const id = (name: string) => (data ?? []).find((s) => s.name === name)?.id as string;
  stopA = id('دوار الصاخور');
  stopB = id('جسر الحج');
  foreignStop = id('موقف غريب');
});

afterAll(async () => {
  await unfreeze();
  await destroyUniversity(fx);
  await destroyUniversity(other);
  await closeDb();
});

async function recurringCount(recurringId: string) {
  const { count } = await service
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .contains('data', { recurring_id: recurringId });
  return count ?? 0;
}

describe('recurring notifications', () => {
  it('fire once on each chosen weekday at the chosen time, to every active student', async () => {
    // 2026-10-05 is a Monday (1), 2026-10-06 a Tuesday (2), 2026-10-07 a Wednesday (3)
    const { data: rn, error } = await gs
      .from('recurring_notifications')
      .insert({ university_id: fx.universityId, title: 'تذكير', body: 'اختر مكان انطلاقك غداً', days: [1, 3], send_time: '18:00' })
      .select('id')
      .single();
    expect(error).toBeNull();
    const id = rn?.id as string;
    await service.from('recurring_notifications').update({ created_at: '2026-10-01T00:00:00Z' }).eq('id', id);

    await freeze('2026-10-05 17:59');
    await service.rpc('run_recurring_notifications');
    expect(await recurringCount(id)).toBe(0);

    await freeze('2026-10-05 18:00');
    await service.rpc('run_recurring_notifications');
    expect(await recurringCount(id)).toBe(2);

    await freeze('2026-10-05 18:30');
    await service.rpc('run_recurring_notifications');
    expect(await recurringCount(id)).toBe(2); // once per day

    await freeze('2026-10-06 18:05'); // Tuesday is not chosen
    await service.rpc('run_recurring_notifications');
    expect(await recurringCount(id)).toBe(2);

    await freeze('2026-10-07 19:30'); // Wednesday, but more than an hour late: skipped
    await service.rpc('run_recurring_notifications');
    expect(await recurringCount(id)).toBe(2);

    const { data: mine } = await asA.from('notifications').select('type, title').contains('data', { recurring_id: id });
    expect(mine).toEqual([{ type: 'RECURRING', title: 'تذكير' }]);

    // paused → nothing
    await gs.from('recurring_notifications').update({ is_active: false }).eq('id', id);
    await freeze('2026-10-12 18:10');
    await service.rpc('run_recurring_notifications');
    expect(await recurringCount(id)).toBe(2);
  });

  it('only staff of the university manage them, and only the server runs them', async () => {
    const byStudent = await asA
      .from('recurring_notifications')
      .insert({ university_id: fx.universityId, title: 'x', body: 'y', days: [1], send_time: '08:00' });
    expect(byStudent.error).not.toBeNull();
    const noDays = await gs
      .from('recurring_notifications')
      .insert({ university_id: fx.universityId, title: 'x', body: 'y', days: [], send_time: '08:00' });
    expect(noDays.error).not.toBeNull();
    const run = await gs.rpc('run_recurring_notifications');
    expect(run.error).not.toBeNull();
  });
});

describe('tomorrow seat booking', () => {
  const book = (client: SupabaseClient, outbound: string | null, stop: string, ret: string | null, retStop: string) =>
    client.rpc('choose_my_pickup', { p_outbound_time: outbound, p_stop_id: stop, p_return_time: ret, p_return_stop_id: retStop });

  beforeAll(async () => {
    await setSettings(fx, { pickup_open_time: '17:00', pickup_close_time: '21:00' });
  });

  it('opens and closes at the times set in the settings', async () => {
    await freeze('2026-10-05 16:59');
    expect((await asA.rpc('pickup_window')).data).toMatchObject({ open: false, phase: 'before', opens_at: '17:00', closes_at: '21:00', service_date: '2026-10-06' });
    expect((await book(asA, '08:00', stopA, '14:00', stopA)).error?.message).toBe('PICKUP_CLOSED');
    await freeze('2026-10-05 21:00');
    expect((await asA.rpc('pickup_window')).data).toMatchObject({ open: false, phase: 'after' });
    expect((await book(asA, '08:00', stopA, '14:00', stopA)).error?.message).toBe('PICKUP_CLOSED');
  });

  it('takes the fixed bus slots only, the return after the outbound, saves once and locks it', async () => {
    await freeze('2026-10-05 18:00');
    expect((await asA.rpc('pickup_window')).data).toMatchObject({ open: true, phase: 'open' });

    expect((await book(asA, null, stopA, '14:00', stopB)).error?.message).toBe('OUTBOUND_TIME_INVALID');
    expect((await book(asA, '09:00', stopA, '14:00', stopB)).error?.message).toBe('OUTBOUND_TIME_INVALID');
    expect((await book(asA, '08:00', stopA, null, stopB)).error?.message).toBe('RETURN_TIME_INVALID');
    expect((await book(asA, '08:00', stopA, '16:00', stopB)).error?.message).toBe('RETURN_TIME_INVALID');
    // 11:30 is a return slot, but not after a 12:00 outbound
    expect((await book(asA, '12:00', stopA, '11:30', stopB)).error?.message).toBe('RETURN_TIME_INVALID');
    expect((await book(asA, '08:00', stopA, '14:00', foreignStop)).error?.message).toBe('RETURN_STOP_INVALID');
    expect((await book(asA, '08:00', foreignStop, '14:00', stopA)).error?.message).toBe('STOP_INVALID');
    // the old three-argument call is gone
    expect((await asA.rpc('choose_my_pickup', { p_stop_id: stopA, p_return_time: '14:00', p_return_stop_id: stopB })).error).not.toBeNull();

    const ok = await book(asA, '10:00', stopA, '14:00', stopB);
    expect(ok.error).toBeNull();
    expect(ok.data).toBe('2026-10-06');
    expect((await book(asA, '08:00', stopB, '15:30', stopB)).error?.message).toBe('PICKUP_LOCKED');
    expect((await book(asB, '12:00', stopA, '15:30', stopA)).error).toBeNull();

    const { data: own } = await asA.from('pickup_choices').select('service_date, outbound_time, stop_id, return_time, return_stop_id');
    expect(own).toEqual([{ service_date: '2026-10-06', outbound_time: '10:00:00', stop_id: stopA, return_time: '14:00:00', return_stop_id: stopB }]);
    const peek = await asB.from('pickup_choices').select('student_id').eq('student_id', a.id);
    expect(peek.data).toEqual([]);
    const direct = await asB
      .from('pickup_choices')
      .insert({ student_id: b.id, service_date: '2026-10-09', university_id: fx.universityId, stop_id: stopB });
    expect(direct.error).not.toBeNull();
  });

  it('feeds the staff statistics (outbound by time, return by time) and the archive', async () => {
    await freeze('2026-10-06 18:30'); // next evening: a new day
    expect((await book(asA, '08:00', stopB, '15:30', stopB)).error).toBeNull();

    const { data: outbound, error } = await gs.rpc('pickup_outbound_stats', { p_university_id: fx.universityId, p_date: '2026-10-06' });
    expect(error).toBeNull();
    expect(outbound).toEqual([
      { outbound_time: '10:00:00', area_id: fx.areaIds['الرجاء'], area_name: 'الرجاء', stop_id: stopA, stop_name: 'دوار الصاخور', students: 1 },
      { outbound_time: '12:00:00', area_id: fx.areaIds['الرجاء'], area_name: 'الرجاء', stop_id: stopA, stop_name: 'دوار الصاخور', students: 1 },
    ]);
    // the older per-stop totals still work
    const { data: stats } = await gs.rpc('pickup_stats', { p_university_id: fx.universityId, p_date: '2026-10-06' });
    expect(stats).toEqual([{ area_id: fx.areaIds['الرجاء'], area_name: 'الرجاء', stop_id: stopA, stop_name: 'دوار الصاخور', students: 2 }]);
    const { data: back } = await gs.rpc('pickup_return_stats', { p_university_id: fx.universityId, p_date: '2026-10-06' });
    // «جسر الحج» was saved without an area, so it got an area of its own name (every stop is an area)
    expect(back).toEqual([
      { return_time: '14:00:00', area_id: expect.any(String), area_name: 'جسر الحج', stop_id: stopB, stop_name: 'جسر الحج', students: 1 },
      { return_time: '15:30:00', area_id: fx.areaIds['الرجاء'], area_name: 'الرجاء', stop_id: stopA, stop_name: 'دوار الصاخور', students: 1 },
    ]);
    const { data: days } = await gs.rpc('pickup_days', { p_university_id: fx.universityId });
    expect(days).toEqual([
      { service_date: '2026-10-07', students: 1 },
      { service_date: '2026-10-06', students: 2 },
    ]);
    expect((await asA.rpc('pickup_return_stats', { p_university_id: fx.universityId, p_date: '2026-10-06' })).error?.message).toBe('FORBIDDEN');
    expect((await asA.rpc('pickup_outbound_stats', { p_university_id: fx.universityId, p_date: '2026-10-06' })).error?.message).toBe('FORBIDDEN');
  });
});

