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

describe('duplicate_route', () => {
  it('copies the route with its stops and times; only staff of that university may do it', async () => {
    const lib = await gs
      .from('stops')
      .insert([
        { university_id: fx.universityId, name: 'نقطة أ' },
        { university_id: fx.universityId, name: 'نقطة ب' },
      ])
      .select('id, name');
    const src = await gs
      .from('routes')
      .insert({ university_id: fx.universityId, name: 'خط المصدر', direction: 'outbound', departure_time: '08:00', active_days: [5, 6] })
      .select('id')
      .single();
    await gs.from('route_stops').insert([
      { route_id: src.data?.id, seq: 1, stop_id: lib.data?.[0]?.id, departure_time: '08:05' },
      { route_id: src.data?.id, seq: 2, stop_id: lib.data?.[1]?.id, departure_time: '08:15' },
    ]);

    const { data: copyId, error } = await gs.rpc('duplicate_route', { p_route_id: src.data?.id, p_name: 'خط المصدر (نسخة)' });
    expect(error).toBeNull();
    const copy = await service
      .from('routes')
      .select('name, direction, departure_time, active_days, route_stops(seq, stop_id, departure_time)')
      .eq('id', copyId as string)
      .single();
    expect(copy.data?.name).toBe('خط المصدر (نسخة)');
    expect(copy.data?.active_days).toEqual([5, 6]);
    const stops = [...(copy.data?.route_stops ?? [])].sort((a, b) => a.seq - b.seq);
    expect(stops.map((s) => [s.stop_id, s.departure_time])).toEqual([
      [lib.data?.[0]?.id, '08:05:00'],
      [lib.data?.[1]?.id, '08:15:00'],
    ]);

    const byStudent = await student.rpc('duplicate_route', { p_route_id: src.data?.id });
    expect(byStudent.error?.message).toBe('FORBIDDEN');
    const otherGs = (await createStaff(other, 'university_supervisor')).client;
    const byOther = await otherGs.rpc('duplicate_route', { p_route_id: src.data?.id });
    expect(byOther.error?.message).toBe('FORBIDDEN');
  });
});

describe('deleting a route', () => {
  it('removes the route with its stop order; library stops stay; students cannot delete', async () => {
    const stop = await gs.from('stops').insert({ university_id: fx.universityId, name: 'نقطة خط محذوف' }).select('id').single();
    const route = await gs.from('routes').insert({ university_id: fx.universityId, name: 'خط للحذف' }).select('id').single();
    const routeId = route.data?.id as string;
    await gs.from('route_stops').insert({ route_id: routeId, seq: 1, stop_id: stop.data?.id });

    const byStudent = await student.from('routes').delete().eq('id', routeId).select('id');
    expect(byStudent.data ?? []).toEqual([]);

    const del = await gs.from('routes').delete().eq('id', routeId).select('id');
    expect(del.error).toBeNull();
    expect(del.data).toEqual([{ id: routeId }]);
    const { count: left } = await service.from('route_stops').select('id', { count: 'exact', head: true }).eq('route_id', routeId);
    expect(left).toBe(0);
    const { data: kept } = await service.from('stops').select('id').eq('id', stop.data?.id as string);
    expect(kept?.length).toBe(1);
  });
});

describe('«مناطق بحاجة ربط» with library stops', () => {
  it('links a written place to a stop (creating its area) and auto-links exact name matches', async () => {
    const stopA = await gs.from('stops').insert({ university_id: fx.universityId, name: 'دوار السياسية' }).select('id').single();
    await gs.from('stops').insert({ university_id: fx.universityId, name: 'دوار المحافظة' });
    const make = async (text: string) => {
      const st = await createStudent(fx);
      await service.from('students').update({ area_primary_id: null, area_other_text: text }).eq('id', st.id);
      return st.id;
    };
    const exactStop = await make('دوار  المحافظه'); // spacing / taa marbuta differ
    const exactArea = await make('الرجاء ');
    const viaPicker = await make('قرب دوار السياسية');
    const unknown = await make('مكان غير معروف');

    // picking a stop in the list
    const picked = await gs.rpc('map_area_other_text_to_stop', { p_university_id: fx.universityId, p_other_text: 'قرب دوار السياسية', p_stop_id: stopA.data?.id });
    expect(picked.error).toBeNull();
    expect(picked.data).toBe(1);
    const { data: stopRow } = await service.from('stops').select('area_id, areas(name)').eq('id', stopA.data?.id as string).single();
    expect((stopRow as unknown as { areas: { name: string } }).areas.name).toBe('دوار السياسية');

    // one click for exact matches (an area, and a stop that has no area yet)
    const auto = await gs.rpc('auto_map_area_texts', { p_university_id: fx.universityId });
    expect(auto.error).toBeNull();
    expect(auto.data).toEqual({ places: 2, students: 2 });
    const { data: rows } = await service
      .from('students')
      .select('id, needs_area_mapping, areas:areas!students_area_primary_id_fkey(name)')
      .in('id', [exactStop, exactArea, viaPicker, unknown]);
    const byId = Object.fromEntries((rows ?? []).map((r) => [r.id, r as unknown as { needs_area_mapping: boolean; areas: { name: string } | null }]));
    expect(byId[exactStop]?.areas?.name).toBe('دوار المحافظة');
    expect(byId[exactArea]?.areas?.name).toBe('الرجاء');
    expect(byId[viaPicker]?.areas?.name).toBe('دوار السياسية');
    expect(byId[unknown]?.needs_area_mapping).toBe(true);

    // students cannot use it
    expect((await student.rpc('auto_map_area_texts', { p_university_id: fx.universityId })).error).not.toBeNull();
  });
});
