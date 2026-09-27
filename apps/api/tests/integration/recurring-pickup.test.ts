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

describe('tomorrow pickup stop', () => {
  it('opens at 18:00, saves for the next day, can be changed, and feeds the staff statistics and archive', async () => {
    await freeze('2026-10-05 17:30');
    const closed = await asA.rpc('choose_my_pickup', { p_stop_id: stopA });
    expect(closed.error?.message).toBe('PICKUP_CLOSED');
    expect((await asA.rpc('pickup_window')).data).toMatchObject({ open: false, service_date: '2026-10-06' });

    await freeze('2026-10-05 18:01');
    expect((await asA.rpc('pickup_window')).data).toMatchObject({ open: true, service_date: '2026-10-06' });
    const first = await asA.rpc('choose_my_pickup', { p_stop_id: stopB });
    expect(first.error).toBeNull();
    expect(first.data).toBe('2026-10-06');
    await asA.rpc('choose_my_pickup', { p_stop_id: stopA }); // change of mind
    await asB.rpc('choose_my_pickup', { p_stop_id: stopA });
    const foreign = await asB.rpc('choose_my_pickup', { p_stop_id: foreignStop });
    expect(foreign.error?.message).toBe('STOP_INVALID');

    const { data: own } = await asA.from('pickup_choices').select('service_date, stop_id');
    expect(own).toEqual([{ service_date: '2026-10-06', stop_id: stopA }]);
    const peek = await asB.from('pickup_choices').select('student_id').eq('student_id', a.id);
    expect(peek.data).toEqual([]);
    const direct = await asB
      .from('pickup_choices')
      .insert({ student_id: b.id, service_date: '2026-10-09', university_id: fx.universityId, stop_id: stopB });
    expect(direct.error).not.toBeNull();

    // next evening: a new day's choice; the previous day stays in the archive
    await freeze('2026-10-06 20:00');
    await asA.rpc('choose_my_pickup', { p_stop_id: stopB });

    const { data: stats, error } = await gs.rpc('pickup_stats', { p_university_id: fx.universityId, p_date: '2026-10-06' });
    expect(error).toBeNull();
    expect(stats).toEqual([{ area_id: fx.areaIds['الرجاء'], area_name: 'الرجاء', stop_id: stopA, stop_name: 'دوار الصاخور', students: 2 }]);
    const { data: days } = await gs.rpc('pickup_days', { p_university_id: fx.universityId });
    expect(days).toEqual([
      { service_date: '2026-10-07', students: 1 },
      { service_date: '2026-10-06', students: 2 },
    ]);
    const denied = await asA.rpc('pickup_stats', { p_university_id: fx.universityId, p_date: '2026-10-06' });
    expect(denied.error?.message).toBe('FORBIDDEN');
  });
});
