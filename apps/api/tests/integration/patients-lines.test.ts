import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, createStaff, createStudent, createUniversity, destroyUniversity, freeze, service, setSettings, signIn, unfreeze, type Fixture } from './helpers.js';

let fx: Fixture;
let staff: SupabaseClient;
let dentist: SupabaseClient;
let other: SupabaseClient;
let dentistryId: string;
const stops = {} as Record<'kura' | 'shifa' | 'salam', string>;
const lines = {} as Record<'line2' | 'line4' | 'line4b', string>;

const patient = (over: Record<string, unknown> = {}) => ({
  full_name: 'مريض تجربة',
  phone: '0944 123 456',
  outbound_time: '10:00',
  route_id: lines.line4b,
  stop_id: stops.kura,
  ...over,
});
const book = (client: SupabaseClient, patients: unknown[] = [], route = lines.line4) =>
  client.rpc('choose_my_pickup', { p_outbound_time: '08:00', p_route_id: route, p_stop_id: stops.kura, p_patients: patients });

beforeAll(async () => {
  fx = await createUniversity();
  staff = (await createStaff(fx, 'university_supervisor')).client;
  const { data: college } = await service.from('colleges').insert({ university_id: fx.universityId, name: 'طب الأسنان' }).select('id').single();
  dentistryId = college?.id as string;
  for (const [key, name] of [['kura', 'دوار الكرة'], ['shifa', 'دوار الشفاء'], ['salam', 'ساحة الجامعة']] as const) {
    const { data } = await service.from('stops').insert({ university_id: fx.universityId, name }).select('id').single();
    stops[key] = data?.id as string;
  }
  const route = async (name: string, departure: string, stopTimes: [string, string][]) => {
    const { data } = await service
      .from('routes')
      .insert({ university_id: fx.universityId, name, direction: 'outbound', departure_time: departure })
      .select('id')
      .single();
    await service.from('route_stops').insert(stopTimes.map(([stop, time], i) => ({ route_id: data?.id, seq: i + 1, stop_id: stop, departure_time: time })));
    return data?.id as string;
  };
  // دوار الكرة is on two lines of the first trip: the student picks the bus
  lines.line2 = await route('الخط 2 — الرحلة الأولى', '07:15', [[stops.kura, '07:15'], [stops.salam, '07:30']]);
  lines.line4 = await route('الخط 4 — الرحلة الأولى', '07:15', [[stops.salam, '07:20'], [stops.kura, '07:40']]);
  lines.line4b = await route('الخط 4 — الرحلة الثانية', '08:50', [[stops.salam, '08:55'], [stops.kura, '09:15']]);

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
  it('only students of a college with the switch on may book patients', async () => {
    expect((await book(dentist, [patient()])).error?.message).toBe('PATIENTS_NOT_ALLOWED');
    await service.from('colleges').update({ allows_patients: true }).eq('id', dentistryId);
    expect((await book(other, [patient()])).error?.message).toBe('PATIENTS_NOT_ALLOWED');
  });

  it('checks every patient and saves nothing when one is wrong', async () => {
    expect((await book(dentist, [patient({ full_name: ' ' })])).error?.message).toBe('PATIENT_NAME_INVALID');
    expect((await book(dentist, [patient({ phone: '12' })])).error?.message).toBe('PATIENT_PHONE_INVALID');
    expect((await book(dentist, [patient({ outbound_time: '09:00' })])).error?.message).toBe('OUTBOUND_TIME_INVALID');
    // the 10:00 patient cannot ride a line of the 8:00 trip
    expect((await book(dentist, [patient({ route_id: lines.line2 })])).error?.message).toBe('STOP_INVALID');
    expect((await book(dentist, Array.from({ length: 6 }, () => patient()))).error?.message).toBe('PATIENTS_INVALID');
    const { count } = await service.from('pickup_choices').select('student_id', { count: 'exact', head: true }).eq('university_id', fx.universityId);
    expect(count).toBe(0);
  });

  it('books the student with two patients, each on its own line, phone cleaned; the student reads them back', async () => {
    const res = await book(dentist, [patient(), patient({ full_name: 'مريض ثان', outbound_time: '08:00', route_id: lines.line2, stop_id: stops.salam })]);
    expect(res.error).toBeNull();
    const { data } = await dentist.from('pickup_patients').select('seq, full_name, phone, outbound_route_name, outbound_stop_time').order('seq');
    expect(data).toEqual([
      { seq: 1, full_name: 'مريض تجربة', phone: '0944123456', outbound_route_name: 'الخط 4 — الرحلة الثانية', outbound_stop_time: '09:15:00' },
      { seq: 2, full_name: 'مريض ثان', phone: '0944123456', outbound_route_name: 'الخط 2 — الرحلة الأولى', outbound_stop_time: '07:30:00' },
    ]);
    // other students never see them
    expect((await other.from('pickup_patients').select('id')).data).toEqual([]);
    expect((await book(other, [], lines.line2)).error).toBeNull();
  });
});

describe('bookings by line', () => {
  it('lists every seat on its booked line with who it is for, outbound only', async () => {
    const { data, error } = await staff.rpc('pickup_passengers', { p_university_id: fx.universityId, p_date: '2026-10-06' });
    expect(error).toBeNull();
    const rows = data as { passenger_type: string; full_name: string; booked_by_name: string | null; direction: string; route_name: string | null; stop_time: string }[];
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.direction === 'outbound')).toBe(true);
    // the same stop, two students, two buses: each kept the line they picked
    expect(rows.filter((r) => r.passenger_type === 'student').map((r) => [r.route_name, r.stop_time]).sort()).toEqual([
      ['الخط 2 — الرحلة الأولى', '07:15:00'],
      ['الخط 4 — الرحلة الأولى', '07:40:00'],
    ]);
    expect(rows.find((r) => r.full_name === 'مريض تجربة')).toMatchObject({ passenger_type: 'patient', route_name: 'الخط 4 — الرحلة الثانية', booked_by_name: 'طالب اختبار ثلاثي' });

    expect((await other.rpc('pickup_passengers', { p_university_id: fx.universityId, p_date: '2026-10-06' })).error?.message).toBe('FORBIDDEN');
  });
});
