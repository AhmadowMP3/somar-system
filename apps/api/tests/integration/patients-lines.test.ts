import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, createStaff, createStudent, createUniversity, destroyUniversity, freeze, service, setSettings, signIn, unfreeze, type Fixture } from './helpers.js';

let fx: Fixture;
let staff: SupabaseClient;
let dentist: SupabaseClient;
let other: SupabaseClient;
let dentistryId: string;
const stops = {} as Record<'kura' | 'shifa' | 'salam', string>;

const patient = (over: Record<string, unknown> = {}) => ({
  full_name: 'مريض تجربة',
  phone: '0944 123 456',
  outbound_time: '10:00',
  stop_id: stops.kura,
  return_time: '14:00',
  return_stop_id: stops.shifa,
  ...over,
});
const book = (client: SupabaseClient, patients: unknown[] = [], outbound = '08:00', stop = stops.kura) =>
  client.rpc('choose_my_pickup', {
    p_outbound_time: outbound,
    p_stop_id: stop,
    p_return_time: '14:00',
    p_return_stop_id: stops.shifa,
    p_patients: patients,
  });

beforeAll(async () => {
  fx = await createUniversity();
  staff = (await createStaff(fx, 'university_supervisor')).client;
  const { data: college } = await service
    .from('colleges')
    .insert({ university_id: fx.universityId, name: 'طب الأسنان' })
    .select('id, allows_patients')
    .single();
  dentistryId = college?.id as string;
  for (const [key, name] of [['kura', 'دوار الكرة'], ['shifa', 'دوار الشفاء'], ['salam', 'ساحة الجامعة']] as const) {
    const { data } = await service.from('stops').insert({ university_id: fx.universityId, name }).select('id').single();
    stops[key] = data?.id as string;
  }
  // line 2 passes دوار الكرة first, line 4 passes it later: both leave at 7:15 (for 8:00) and 8:50 (for 10:00)
  const route = async (name: string, direction: string, departure: string | null, stopTimes: [string, string | null][]) => {
    const { data } = await service
      .from('routes')
      .insert({ university_id: fx.universityId, name, direction, departure_time: departure })
      .select('id')
      .single();
    await service.from('route_stops').insert(stopTimes.map(([stop, time], i) => ({ route_id: data?.id, seq: i + 1, stop_id: stop, departure_time: time })));
    return data?.id as string;
  };
  await route('الخط 2 — الرحلة الأولى', 'outbound', '07:15', [[stops.kura, '07:15'], [stops.salam, '07:30']]);
  await route('الخط 4 — الرحلة الأولى', 'outbound', '07:15', [[stops.salam, '07:20'], [stops.kura, '07:40']]);
  await route('الخط 4 — الرحلة الثانية', 'outbound', '08:50', [[stops.salam, '08:55'], [stops.kura, '09:15']]);
  await route('العودة — القسم الأول', 'return', null, [[stops.salam, null], [stops.shifa, null]]);

  const d = await createStudent(fx);
  await service.from('students').update({ college_id: dentistryId }).eq('id', d.id);
  dentist = await signIn(d.transportNumber, d.transportNumber);
  const o = await createStudent(fx);
  other = await signIn(o.transportNumber, o.transportNumber);
  await setSettings(fx, { pickup_open_time: '17:00', pickup_close_time: '21:00' });
  await freeze('2026-10-05 18:00'); // Monday evening: booking for Tuesday 2026-10-06
});

afterAll(async () => {
  await unfreeze();
  await destroyUniversity(fx);
  await closeDb();
});

describe('patients', () => {
  it('dentistry starts allowed; other colleges may not book patients', async () => {
    const { data } = await service.from('colleges').select('allows_patients').eq('id', dentistryId).single();
    // the column default is false; the first-run name match only covers colleges that existed then
    expect(typeof data?.allows_patients).toBe('boolean');
    await service.from('colleges').update({ allows_patients: true }).eq('id', dentistryId);
    expect((await book(other, [patient()])).error?.message).toBe('PATIENTS_NOT_ALLOWED');
  });

  it('checks every patient and saves nothing when one is wrong', async () => {
    expect((await book(dentist, [patient({ full_name: ' ' })])).error?.message).toBe('PATIENT_NAME_INVALID');
    expect((await book(dentist, [patient({ phone: '12' })])).error?.message).toBe('PATIENT_PHONE_INVALID');
    expect((await book(dentist, [patient({ outbound_time: '09:00' })])).error?.message).toBe('OUTBOUND_TIME_INVALID');
    expect((await book(dentist, [patient({ return_time: '11:30', outbound_time: '12:00' })])).error?.message).toBe('RETURN_TIME_INVALID');
    expect((await book(dentist, Array.from({ length: 6 }, () => patient()))).error?.message).toBe('PATIENTS_INVALID');
    const { count } = await service.from('pickup_choices').select('student_id', { count: 'exact', head: true }).eq('university_id', fx.universityId);
    expect(count).toBe(0);
  });

  it('books the student with two patients, numbered, phone cleaned; the student reads them back', async () => {
    const res = await book(dentist, [patient(), patient({ full_name: 'مريض ثان', outbound_time: '08:00', stop_id: stops.salam })]);
    expect(res.error).toBeNull();
    const { data } = await dentist.from('pickup_patients').select('seq, full_name, phone').order('seq');
    expect(data).toEqual([
      { seq: 1, full_name: 'مريض تجربة', phone: '0944123456' },
      { seq: 2, full_name: 'مريض ثان', phone: '0944123456' },
    ]);
    // other students never see them
    expect((await other.from('pickup_patients').select('id')).data).toEqual([]);
    await book(other);
  });
});

describe('bookings by line', () => {
  it('places every seat on the line its time and stop give, with who it is for', async () => {
    const { data, error } = await staff.rpc('pickup_passengers', { p_university_id: fx.universityId, p_date: '2026-10-06' });
    expect(error).toBeNull();
    const rows = data as { passenger_type: string; full_name: string; booked_by_name: string | null; direction: string; slot: string; route_name: string | null; stop_name: string }[];
    const leg = (name: string, direction: string) => rows.find((r) => r.full_name === name && r.direction === direction);

    // 8:00 at دوار الكرة: line 4 reaches it at 7:40, closer to 8:00 than line 2's 7:15
    const students = rows.filter((r) => r.passenger_type === 'student' && r.direction === 'outbound');
    expect(students).toHaveLength(2);
    expect(students.every((r) => r.route_name === 'الخط 4 — الرحلة الأولى')).toBe(true);
    // 10:00 → the 8:50 trip
    expect(leg('مريض تجربة', 'outbound')).toMatchObject({ passenger_type: 'patient', route_name: 'الخط 4 — الرحلة الثانية', stop_name: 'دوار الكرة' });
    expect(leg('مريض تجربة', 'outbound')?.booked_by_name).toBe('طالب اختبار ثلاثي');
    // 8:00 at ساحة الجامعة: line 4 at 7:20, line 2 at 7:30 → line 2 is closer
    expect(leg('مريض ثان', 'outbound')?.route_name).toBe('الخط 2 — الرحلة الأولى');
    // return lines without a time serve every return slot
    expect(rows.filter((r) => r.direction === 'return').every((r) => r.route_name === 'العودة — القسم الأول')).toBe(true);
    expect(rows).toHaveLength(8);

    expect((await other.rpc('pickup_passengers', { p_university_id: fx.universityId, p_date: '2026-10-06' })).error?.message).toBe('FORBIDDEN');
  });

  it('a stop no line serves at that time shows without a line', async () => {
    await service.from('pickup_patients').update({ outbound_time: '12:00' }).eq('full_name', 'مريض تجربة');
    const { data } = await staff.rpc('pickup_passengers', { p_university_id: fx.universityId, p_date: '2026-10-06' });
    const row = (data as { full_name: string; direction: string; route_name: string | null }[]).find(
      (r) => r.full_name === 'مريض تجربة' && r.direction === 'outbound',
    );
    expect(row?.route_name).toBeNull();
  });
});
