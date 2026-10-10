import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, createStaff, createStudent, createUniversity, destroyUniversity, service, signIn, type Fixture, type TestStudent } from './helpers.js';

let fx: Fixture;
let other: Fixture;
let staff: SupabaseClient;
let foreign: SupabaseClient;
let student: TestStudent;
let asStudent: SupabaseClient;

beforeAll(async () => {
  fx = await createUniversity();
  other = await createUniversity();
  staff = (await createStaff(fx, 'university_supervisor')).client;
  foreign = (await createStaff(other, 'university_supervisor')).client;
  student = await createStudent(fx);
  asStudent = await signIn(student.transportNumber, student.transportNumber);
});

afterAll(async () => {
  await destroyUniversity(fx);
  await destroyUniversity(other);
  await closeDb();
});

async function stop(name: string) {
  const { data } = await service.from('stops').insert({ university_id: fx.universityId, name }).select('id').single();
  return data?.id as string;
}

describe('deleting stops', () => {
  it('deletes an unused stop; only staff of its university may', async () => {
    const id = await stop('نقطة غير مستخدمة');
    expect((await asStudent.rpc('delete_stop', { p_stop_id: id })).error?.message).toBe('FORBIDDEN');
    expect((await foreign.rpc('delete_stop', { p_stop_id: id })).error?.message).toBe('FORBIDDEN');
    const { data, error } = await staff.rpc('delete_stop', { p_stop_id: id });
    expect(error).toBeNull();
    expect(data).toEqual({ deleted: true, routes: [] });
    const { data: left } = await service.from('stops').select('id').eq('id', id);
    expect(left).toEqual([]);
  });

  it('a stop used in routes is kept until the removal from those routes is confirmed', async () => {
    const id = await stop('نقطة في خطين');
    const keep = await stop('نقطة باقية');
    const { data: routes } = await service
      .from('routes')
      .insert([
        { university_id: fx.universityId, name: 'خط ب', direction: 'outbound', departure_time: '07:00' },
        { university_id: fx.universityId, name: 'خط أ', direction: 'return', departure_time: '14:00' },
      ])
      .select('id');
    await service.from('route_stops').insert([
      { route_id: routes?.[0]?.id, stop_id: id, seq: 1, departure_time: '07:00' },
      { route_id: routes?.[0]?.id, stop_id: keep, seq: 2, departure_time: '07:10' },
      { route_id: routes?.[1]?.id, stop_id: id, seq: 1, departure_time: '14:00' },
    ]);

    const first = await staff.rpc('delete_stop', { p_stop_id: id });
    expect(first.data).toEqual({ deleted: false, routes: ['خط أ', 'خط ب'] });
    expect((await service.from('stops').select('id').eq('id', id)).data).toHaveLength(1);

    const confirmed = await staff.rpc('delete_stop', { p_stop_id: id, p_remove_from_routes: true });
    expect(confirmed.data).toEqual({ deleted: true, routes: ['خط أ', 'خط ب'] });
    const { data: remaining } = await service.from('route_stops').select('stop_id').in('route_id', (routes ?? []).map((r) => r.id));
    expect(remaining).toEqual([{ stop_id: keep }]);
  });

  it('past pickup choices keep the deleted stop name in the archive statistics', async () => {
    const id = await stop('نقطة أرشيف');
    await service
      .from('pickup_choices')
      .insert({ student_id: student.id, service_date: '2026-10-06', university_id: fx.universityId, stop_id: id, return_time: '14:00', return_stop_id: id });
    const { data: snap } = await service.from('pickup_choices').select('stop_name, return_stop_name').eq('student_id', student.id).single();
    expect(snap).toEqual({ stop_name: 'نقطة أرشيف', return_stop_name: 'نقطة أرشيف' });

    expect((await staff.rpc('delete_stop', { p_stop_id: id })).data).toEqual({ deleted: true, routes: [] });
    const { data: stats } = await staff.rpc('pickup_stats', { p_university_id: fx.universityId, p_date: '2026-10-06' });
    expect(stats).toEqual([{ area_id: null, area_name: null, stop_id: null, stop_name: 'نقطة أرشيف', students: 1 }]);
    // a booking from before outbound times were asked has none
    const { data: outbound } = await staff.rpc('pickup_outbound_stats', { p_university_id: fx.universityId, p_date: '2026-10-06' });
    expect(outbound).toEqual([{ outbound_time: null, area_id: null, area_name: null, stop_id: null, stop_name: 'نقطة أرشيف', students: 1 }]);
    const { data: back } = await staff.rpc('pickup_return_stats', { p_university_id: fx.universityId, p_date: '2026-10-06' });
    expect(back).toEqual([{ return_time: '14:00:00', area_id: null, area_name: null, stop_id: null, stop_name: 'نقطة أرشيف', students: 1 }]);
  });
});
