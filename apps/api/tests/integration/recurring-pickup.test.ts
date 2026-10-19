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
  // Tuesday 2026-10-06 is booked on Monday evening
  let lineA: string; // 7:00 trip → the 8:00 slot
  let lineB: string; // 8:50 trip → the 10:00 slot
  let mondayOnly: string;
  const book = (client: SupabaseClient, outbound: string | null, route: string | null, stop: string) =>
    client.rpc('choose_my_pickup', { p_outbound_time: outbound, p_route_id: route, p_stop_id: stop });

  beforeAll(async () => {
    await setSettings(fx, { pickup_open_time: '17:00', pickup_close_time: '21:00' });
    const line = async (name: string, departure: string, stops: [string, string | null][], days: number[] | null = null) => {
      const { data } = await service
        .from('routes')
        .insert({ university_id: fx.universityId, name, direction: 'outbound', departure_time: departure, active_days: days })
        .select('id')
        .single();
      await service.from('route_stops').insert(stops.map(([stop, time], i) => ({ route_id: data?.id, seq: i + 1, stop_id: stop, departure_time: time })));
      return data?.id as string;
    };
    lineA = await line('خط أ — الرحلة الأولى', '07:00', [[stopA, '07:30'], [stopB, '07:45']]);
    // stopB has no time on this trip: it is not offered
    lineB = await line('خط أ — الرحلة الثانية', '08:50', [[stopA, '09:20'], [stopB, null]]);
    mondayOnly = await line('خط الإثنين', '07:10', [[stopB, '07:20']], [1]);
  });

  it('opens and closes at the times set in the settings', async () => {
    await freeze('2026-10-05 16:59');
    expect((await asA.rpc('pickup_window')).data).toMatchObject({ open: false, phase: 'before', opens_at: '17:00', closes_at: '21:00', service_date: '2026-10-06' });
    expect((await book(asA, '08:00', lineA, stopA)).error?.message).toBe('PICKUP_CLOSED');
    await freeze('2026-10-05 21:00');
    expect((await asA.rpc('pickup_window')).data).toMatchObject({ open: false, phase: 'after' });
    expect((await book(asA, '08:00', lineA, stopA)).error?.message).toBe('PICKUP_CLOSED');
  });

  it("offers each trip's lines that run tomorrow, with only the stops that have a time on the line", async () => {
    await freeze('2026-10-05 18:00');
    const { data, error } = await asA.rpc('pickup_options');
    expect(error).toBeNull();
    const rows = (data as { slot: string; route_id: string; stop_id: string; stop_time: string }[]).filter((r) =>
      [lineA, lineB, mondayOnly].includes(r.route_id),
    );
    expect(rows).toEqual([
      expect.objectContaining({ slot: '08:00:00', route_id: lineA, stop_id: stopA, stop_time: '07:30:00' }),
      expect.objectContaining({ slot: '08:00:00', route_id: lineA, stop_id: stopB, stop_time: '07:45:00' }),
      expect.objectContaining({ slot: '10:00:00', route_id: lineB, stop_id: stopA, stop_time: '09:20:00' }),
    ]);
  });

  it('takes a stop of a line of the chosen trip only, keeps the line and the stop time, saves once and locks it', async () => {
    await freeze('2026-10-05 18:00');
    expect((await book(asA, null, lineA, stopA)).error?.message).toBe('OUTBOUND_TIME_INVALID');
    expect((await book(asA, '09:00', lineA, stopA)).error?.message).toBe('OUTBOUND_TIME_INVALID');
    // the line is not a 10:00 trip / the stop has no time on that line / the line does not run on Tuesday
    expect((await book(asA, '10:00', lineA, stopA)).error?.message).toBe('STOP_INVALID');
    expect((await book(asA, '10:00', lineB, stopB)).error?.message).toBe('STOP_INVALID');
    expect((await book(asA, '08:00', mondayOnly, stopB)).error?.message).toBe('STOP_INVALID');
    expect((await book(asA, '08:00', lineA, foreignStop)).error?.message).toBe('STOP_INVALID');
    // the return is no longer booked
    expect(
      (await asA.rpc('choose_my_pickup', { p_outbound_time: '08:00', p_stop_id: stopA, p_return_time: '14:00', p_return_stop_id: stopB })).error,
    ).not.toBeNull();

    const ok = await book(asA, '10:00', lineB, stopA);
    expect(ok.error).toBeNull();
    expect(ok.data).toBe('2026-10-06');
    expect((await book(asA, '08:00', lineA, stopB)).error?.message).toBe('PICKUP_LOCKED');
    expect((await book(asB, '08:00', lineA, stopA)).error).toBeNull();

    const { data: own } = await asA
      .from('pickup_choices')
      .select('service_date, outbound_time, stop_id, outbound_route_id, outbound_route_name, outbound_stop_time, return_time');
    expect(own).toEqual([
      {
        service_date: '2026-10-06',
        outbound_time: '10:00:00',
        stop_id: stopA,
        outbound_route_id: lineB,
        outbound_route_name: 'خط أ — الرحلة الثانية',
        outbound_stop_time: '09:20:00',
        return_time: null,
      },
    ]);
    const peek = await asB.from('pickup_choices').select('student_id').eq('student_id', a.id);
    expect(peek.data).toEqual([]);
    const direct = await asB
      .from('pickup_choices')
      .insert({ student_id: b.id, service_date: '2026-10-09', university_id: fx.universityId, stop_id: stopB });
    expect(direct.error).not.toBeNull();
  });

  it('shows staff each seat on the line it was booked on, and feeds the archive', async () => {
    const { data: seats, error } = await gs.rpc('pickup_passengers', { p_university_id: fx.universityId, p_date: '2026-10-06' });
    expect(error).toBeNull();
    expect(seats).toHaveLength(2);
    expect(seats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ direction: 'outbound', slot: '08:00:00', route_id: lineA, stop_seq: 1, stop_time: '07:30:00' }),
        expect.objectContaining({ direction: 'outbound', slot: '10:00:00', route_id: lineB, stop_seq: 1, stop_time: '09:20:00' }),
      ]),
    );

    await freeze('2026-10-06 18:30'); // next evening: a new day (Wednesday)
    expect((await book(asA, '08:00', lineA, stopB)).error).toBeNull();
    const { data: days } = await gs.rpc('pickup_days', { p_university_id: fx.universityId });
    expect(days).toEqual([
      { service_date: '2026-10-07', students: 1 },
      { service_date: '2026-10-06', students: 2 },
    ]);
    expect((await asA.rpc('pickup_passengers', { p_university_id: fx.universityId, p_date: '2026-10-06' })).error?.message).toBe('FORBIDDEN');
  });
});
