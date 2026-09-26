import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, createStaff, createStudent, createUniversity, destroyUniversity, service, signIn, type Fixture } from './helpers.js';

let fx: Fixture;
let other: Fixture;
let gs: SupabaseClient;
let student: SupabaseClient;

beforeAll(async () => {
  fx = await createUniversity();
  other = await createUniversity();
  gs = (await createStaff(fx, 'university_supervisor')).client;
  const st = await createStudent(fx);
  student = await signIn(st.transportNumber, st.transportNumber);
});

afterAll(async () => {
  await destroyUniversity(fx);
  await destroyUniversity(other);
  await closeDb();
});

describe('stop library', () => {
  it('staff manage the library, students only read their own university, routes reference library stops', async () => {
    const created = await gs
      .from('stops')
      .insert({ university_id: fx.universityId, name: 'دوار الشفاء', maps_url: 'https://maps.google.com/?q=36.2,37.1', lat: 36.2, lng: 37.1 })
      .select('id')
      .single();
    expect(created.error).toBeNull();
    const stopId = created.data?.id as string;

    const foreign = await gs.from('stops').insert({ university_id: other.universityId, name: 'غريبة' });
    expect(foreign.error).not.toBeNull();
    const byStudent = await student.from('stops').insert({ university_id: fx.universityId, name: 'طالب' });
    expect(byStudent.error).not.toBeNull();
    const seen = await student.from('stops').select('id');
    expect(seen.data?.map((s) => s.id)).toEqual([stopId]);

    const route = await gs.from('routes').insert({ university_id: fx.universityId, name: 'خط المكتبة', departure_time: '07:00' }).select('id').single();
    const rs = await gs.from('route_stops').insert({ route_id: route.data?.id, seq: 1, stop_id: stopId, departure_time: '07:10' }).select('id').single();
    expect(rs.error).toBeNull();
    const dup = await gs.from('route_stops').insert({ route_id: route.data?.id, seq: 2, stop_id: stopId });
    expect(dup.error).not.toBeNull();

    // editing the library stop is visible through every route
    await gs.from('stops').update({ maps_url: 'https://maps.google.com/?q=36.3,37.2' }).eq('id', stopId);
    const viaRoute = await student.from('route_stops').select('stop:stops(maps_url, name)').eq('id', rs.data?.id as string).single();
    expect(viaRoute.data).toEqual({ stop: { maps_url: 'https://maps.google.com/?q=36.3,37.2', name: 'دوار الشفاء' } });

    // a stop in use cannot be deleted (only deactivated)
    const del = await gs.from('stops').delete().eq('id', stopId);
    expect(del.error).not.toBeNull();

    // changing the stop time notifies students with the library name
    await gs.from('route_stops').update({ departure_time: '07:20' }).eq('id', rs.data?.id as string);
    const { data: notes } = await service
      .from('notifications')
      .select('body')
      .eq('university_id', fx.universityId)
      .eq('type', 'SCHEDULE_CHANGED')
      .like('body', '%دوار الشفاء%');
    expect(notes?.length).toBe(1);
    expect(notes?.[0]?.body).toContain('07:20');
  });
});
