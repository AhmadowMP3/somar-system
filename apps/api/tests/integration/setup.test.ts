import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, createStaff, createStudent, createUniversity, destroyUniversity, service, signIn, type Fixture, type TestStudent } from './helpers.js';

let fx: Fixture;
let other: Fixture;
let a: TestStudent;
let b: TestStudent;
let asA: SupabaseClient;
let asB: SupabaseClient;
let gs: SupabaseClient;

beforeAll(async () => {
  fx = await createUniversity();
  other = await createUniversity();
  a = await createStudent(fx, { workDays: [1] });
  b = await createStudent(fx, { workDays: [1] });
  asA = await signIn(a.transportNumber, a.transportNumber);
  asB = await signIn(b.transportNumber, b.transportNumber);
  gs = (await createStaff(fx, 'university_supervisor')).client;
});

afterAll(async () => {
  await destroyUniversity(fx);
  await destroyUniversity(other);
  await closeDb();
});

describe('first-login setup and schedule statistics', () => {
  it('saves area, residence and weekly times; the chosen days become the work days', async () => {
    const area = fx.areaIds['الرجاء'];
    const { error } = await asA.rpc('save_my_setup', {
      p_area_id: area,
      p_residence: 'قرب الجامع',
      p_schedule: [
        { dow: 6, outbound: '07:30', return: '14:00' },
        { dow: 7, outbound: '09:30', return: '15:00' },
      ],
    });
    expect(error).toBeNull();
    const { data } = await service.from('students').select('area_primary_id, residence_text, work_days, setup_completed_at').eq('id', a.id).single();
    expect(data).toMatchObject({ area_primary_id: area, residence_text: 'قرب الجامع', work_days: [6, 7] });
    expect(data?.setup_completed_at).toBeTruthy();

    // re-saving replaces the schedule
    await asA.rpc('save_my_setup', { p_area_id: area, p_residence: '', p_schedule: [{ dow: 6, outbound: '08:00', return: '13:00' }] });
    const { data: rows } = await asA.from('student_schedule').select('dow, outbound_time, return_time');
    expect(rows).toEqual([{ dow: 6, outbound_time: '08:00:00', return_time: '13:00:00' }]);
  });

  it('rejects invalid input and hides one student\'s schedule from another', async () => {
    const area = fx.areaIds['الرجاء'];
    const bad = await asB.rpc('save_my_setup', { p_area_id: area, p_residence: '', p_schedule: [{ dow: 6, outbound: '14:00', return: '08:00' }] });
    expect(bad.error?.message).toBe('SCHEDULE_INVALID');
    const empty = await asB.rpc('save_my_setup', { p_area_id: area, p_residence: '', p_schedule: [] });
    expect(empty.error?.message).toBe('SCHEDULE_REQUIRED');
    const foreignArea = await asB.rpc('save_my_setup', { p_area_id: other.areaIds['الرجاء'], p_residence: '', p_schedule: [{ dow: 6, outbound: '08:00', return: '13:00' }] });
    expect(foreignArea.error?.message).toBe('AREA_REQUIRED');

    const peek = await asB.from('student_schedule').select('dow').eq('student_id', a.id);
    expect(peek.data).toEqual([]);
    const write = await asB.from('student_schedule').insert({ student_id: b.id, dow: 1, outbound_time: '08:00', return_time: '09:00' });
    expect(write.error).not.toBeNull();
  });

  it('staff see per-day, per-area, per-time counts and setup progress; students do not', async () => {
    await asB.rpc('save_my_setup', { p_area_id: fx.areaIds['الرجاء'], p_residence: '', p_schedule: [{ dow: 6, outbound: '08:00', return: '14:00' }] });
    const { data, error } = await gs.rpc('schedule_stats', { p_university_id: fx.universityId });
    expect(error).toBeNull();
    const rows = data as { dow: number; kind: string; slot: string; area_name: string; students: number }[];
    expect(rows.find((r) => r.dow === 6 && r.kind === 'outbound' && r.slot === '08:00:00')).toMatchObject({ area_name: 'الرجاء', students: 2 });
    expect(rows.filter((r) => r.dow === 6 && r.kind === 'return').map((r) => [r.slot, r.students]).sort()).toEqual([
      ['13:00:00', 1],
      ['14:00:00', 1],
    ]);
    const { data: progress } = await gs.rpc('setup_progress', { p_university_id: fx.universityId });
    expect(progress).toEqual({ total: 2, completed: 2 });
    const denied = await asA.rpc('schedule_stats', { p_university_id: fx.universityId });
    expect(denied.error?.message).toBe('FORBIDDEN');
  });
});
