import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, createStaff, createStudent, createUniversity, destroyUniversity, service, signIn, type Fixture, type TestStudent } from './helpers.js';

let fx: Fixture;
let gs: SupabaseClient;
let collegeA: string;
let collegeB: string;
let stopAreaId: string;
let s1: TestStudent;

async function schedule(studentId: string, days: number[]) {
  const rows = days.map((dow) => ({ student_id: studentId, dow, outbound_time: '08:00', return_time: '14:00' }));
  const { error } = await service.from('student_schedule').upsert(rows);
  if (error) throw new Error(error.message);
}

/** A rider made through the student path, then turned into a doctor/employee (no college, work days only). */
async function member(kind: 'doctor' | 'employee', patch: Record<string, unknown>) {
  const st = await createStudent(fx, { subscribe: false });
  const { error } = await service.from('students').update({ kind, college_id: null, ...patch }).eq('id', st.id);
  if (error) throw new Error(error.message);
  return st;
}

beforeAll(async () => {
  fx = await createUniversity();
  gs = (await createStaff(fx, 'university_supervisor')).client;
  const { data: colleges } = await service.from('colleges').select('id').eq('university_id', fx.universityId).order('name');
  collegeA = fx.collegeId;
  collegeB = (colleges ?? []).map((c) => c.id as string).find((id) => id !== collegeA) as string;
  const area = fx.areaIds['الرجاء'];

  s1 = await createStudent(fx);
  const s2 = await createStudent(fx);
  const s3 = await createStudent(fx);
  await service.from('students').update({ area_primary_id: area }).in('id', [s1.id, s2.id]);
  await service.from('students').update({ college_id: collegeB }).eq('id', s3.id);
  await schedule(s1.id, [6, 7]);
  await schedule(s2.id, [6]);
  await schedule(s3.id, [6]);

  const stop = await service.from('stops').insert({ university_id: fx.universityId, name: 'دوار الإحصائيات', area_id: fx.areaIds['اوتستراد الحمدانية'] }).select('id, area_id').single();
  stopAreaId = stop.data?.area_id as string;
  const doctor = await member('doctor', { work_days: [1, 6], home_stop_id: stop.data?.id });
  // a stray schedule row must not make a doctor count as a student
  await schedule(doctor.id, [6]);
  await member('employee', { work_days: [6], area_primary_id: area });
});

afterAll(async () => {
  await destroyUniversity(fx);
  await closeDb();
});

type SlotRow = { dow: number; kind: string; slot: string; students: number };
const sum = (rows: SlotRow[], dow: number) => rows.filter((r) => r.dow === dow && r.kind === 'outbound').reduce((n, r) => n + r.students, 0);

describe('attendance statistics by kind and college', () => {
  it('schedule_stats counts students only by default and narrows to one college', async () => {
    const all = await gs.rpc('schedule_stats', { p_university_id: fx.universityId });
    expect(all.error).toBeNull();
    expect(sum(all.data as SlotRow[], 6)).toBe(3);
    expect(sum(all.data as SlotRow[], 7)).toBe(1);

    const one = await gs.rpc('schedule_stats', { p_university_id: fx.universityId, p_college_id: collegeA });
    expect(sum(one.data as SlotRow[], 6)).toBe(2);
    const doctors = await gs.rpc('schedule_stats', { p_university_id: fx.universityId, p_kind: 'doctor' });
    expect(sum(doctors.data as SlotRow[], 6)).toBe(1);
  });

  it('attendance_by_college counts distinct riders per day and college, largest first', async () => {
    const { data, error } = await gs.rpc('attendance_by_college', { p_university_id: fx.universityId });
    expect(error).toBeNull();
    const rows = data as { dow: number; college_id: string | null; riders: number }[];
    expect(rows.filter((r) => r.dow === 6).map((r) => [r.college_id, r.riders])).toEqual([[collegeA, 2], [collegeB, 1]]);
    expect(rows.filter((r) => r.dow === 7).map((r) => [r.college_id, r.riders])).toEqual([[collegeA, 1]]);

    // doctors come by their work days and have no college
    const doc = await gs.rpc('attendance_by_college', { p_university_id: fx.universityId, p_kind: 'doctor' });
    expect((doc.data as { dow: number; college_id: string | null; riders: number }[]).map((r) => [r.dow, r.college_id, r.riders]))
      .toEqual([[1, null, 1], [6, null, 1]]);
  });

  it('work_day_stats groups doctors by their home stop area and employees by their own area', async () => {
    const doc = await gs.rpc('work_day_stats', { p_university_id: fx.universityId, p_kind: 'doctor' });
    expect(doc.error).toBeNull();
    expect((doc.data as { dow: number; area_id: string; riders: number }[]).map((r) => [r.dow, r.area_id, r.riders]))
      .toEqual([[1, stopAreaId, 1], [6, stopAreaId, 1]]);
    const emp = await gs.rpc('work_day_stats', { p_university_id: fx.universityId, p_kind: 'employee' });
    expect(emp.data).toMatchObject([{ dow: 6, area_name: 'الرجاء', riders: 1 }]);
  });

  it('setup_progress follows the kind and college', async () => {
    expect((await gs.rpc('setup_progress', { p_university_id: fx.universityId })).data).toEqual({ total: 3, completed: 0 });
    expect((await gs.rpc('setup_progress', { p_university_id: fx.universityId, p_college_id: collegeB })).data).toEqual({ total: 1, completed: 0 });
    expect((await gs.rpc('setup_progress', { p_university_id: fx.universityId, p_kind: 'employee' })).data).toEqual({ total: 1, completed: 0 });
  });

  it('the dashboard separates students, doctors and employees', async () => {
    const { data } = await gs.rpc('admin_dashboard', { p_university_id: fx.universityId });
    const dash = data as { students_total: number; by_kind: Record<string, { total: number; active: number }> };
    expect(dash.students_total).toBe(3);
    expect(dash.by_kind.student).toMatchObject({ total: 3, active: 3 });
    expect(dash.by_kind.doctor).toMatchObject({ total: 1, active: 1 });
    expect(dash.by_kind.employee).toMatchObject({ total: 1, active: 1 });
  });

  it('riders cannot read the statistics', async () => {
    const asStudent = await signIn(s1.transportNumber, s1.transportNumber);
    expect((await asStudent.rpc('attendance_by_college', { p_university_id: fx.universityId })).error?.message).toBe('FORBIDDEN');
    expect((await asStudent.rpc('work_day_stats', { p_university_id: fx.universityId, p_kind: 'doctor' })).error?.message).toBe('FORBIDDEN');
  });
});
