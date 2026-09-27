import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeDb,
  createStaff,
  createStudent,
  createUniversity,
  db,
  destroyUniversity,
  GEO,
  service,
  signIn,
  STAFF_PASSWORD,
  type Fixture,
  type TestStudent,
} from './helpers.js';

let fx: Fixture;
let admin: SupabaseClient;
let st: TestStudent;
let limited: { profileId: string; code: string; client: SupabaseClient };
let scanner: { profileId: string; code: string; client: SupabaseClient };

beforeAll(async () => {
  fx = await createUniversity();
  admin = (await createStaff(fx, 'admin')).client;
  st = await createStudent(fx);
  limited = await createStaff(fx, 'university_supervisor');
  scanner = await createStaff(fx, 'supervisor');
});

afterAll(async () => {
  await destroyUniversity(fx);
  await closeDb();
});

async function role(profileId: string) {
  const { data } = await service.from('profiles').select('role, permissions').eq('id', profileId).single();
  return data as { role: string; permissions: string[] | null };
}

describe('supervisor page permissions', () => {
  it('only the admin sets them, and the role follows the chosen pages', async () => {
    const self = await limited.client.rpc('set_staff_permissions', { p_profile_id: limited.profileId, p_permissions: ['routes', 'audit'] });
    expect(self.error?.message).toBe('FORBIDDEN');
    // row security hides the own row from updates: nothing changes
    const direct = await limited.client.from('profiles').update({ permissions: ['audit'] }).eq('id', limited.profileId).select();
    expect(direct.data ?? []).toEqual([]);
    expect((await role(limited.profileId)).permissions).toBeNull();

    const empty = await admin.rpc('set_staff_permissions', { p_profile_id: limited.profileId, p_permissions: [] });
    expect(empty.error?.message).toBe('PERMISSIONS_REQUIRED');

    const ok = await admin.rpc('set_staff_permissions', { p_profile_id: limited.profileId, p_permissions: ['routes', 'scan', 'routes'] });
    expect(ok.data).toBe('university_supervisor');
    expect(await role(limited.profileId)).toEqual({ role: 'university_supervisor', permissions: ['routes', 'scan'] });

    // a scanner given a staff page becomes a university supervisor, and back
    expect((await admin.rpc('set_staff_permissions', { p_profile_id: scanner.profileId, p_permissions: ['scan', 'pickups'] })).data).toBe(
      'university_supervisor',
    );
    expect((await admin.rpc('set_staff_permissions', { p_profile_id: scanner.profileId, p_permissions: ['scan'] })).data).toBe('supervisor');
    expect(await role(scanner.profileId)).toEqual({ role: 'supervisor', permissions: ['scan'] });
  });

  it('the database enforces the pages: allowed writes work, others are refused', async () => {
    // fresh sign-in so the session reflects the new role
    const client = await signIn(limited.code, STAFF_PASSWORD);
    const { data: route, error } = await client
      .from('routes')
      .insert({ university_id: fx.universityId, name: 'خط بصلاحية', direction: 'outbound', departure_time: '07:00' })
      .select('id')
      .single();
    expect(error).toBeNull();
    expect(route?.id).toBeTruthy();

    const area = await client.from('areas').insert({ university_id: fx.universityId, name: 'منطقة ممنوعة' }).select();
    expect(area.error).not.toBeNull();
    const studentEdit = await client.from('students').update({ residence_text: 'x' }).eq('id', st.id).select();
    expect(studentEdit.data ?? []).toEqual([]);
    expect((await client.rpc('schedule_stats', { p_university_id: fx.universityId })).error?.message).toBe('FORBIDDEN');
    expect((await client.rpc('pickup_days', { p_university_id: fx.universityId })).error?.message).toBe('FORBIDDEN');
    expect((await client.rpc('admin_dashboard', { p_university_id: fx.universityId })).error?.message).toBe('FORBIDDEN');
    const audit = await client.from('audit_log').select('id').limit(1);
    expect(audit.data).toEqual([]);
    expect((await client.rpc('has_permission', { p_key: 'routes' })).data).toBe(true);
    expect((await client.rpc('has_permission', { p_key: 'students' })).data).toBe(false);

    // scanning is allowed because 'scan' was chosen
    const scan = await client.rpc('perform_scan', { p_qr_token: st.qrToken, ...GEO });
    expect((scan.data as { ok: boolean; code?: string }).code).not.toBe('FORBIDDEN');
  });

  it('a university supervisor without the scan page cannot scan; null keeps the old full access', async () => {
    await admin.rpc('set_staff_permissions', { p_profile_id: limited.profileId, p_permissions: ['students'] });
    const client = await signIn(limited.code, STAFF_PASSWORD);
    const scan = await client.rpc('perform_scan', { p_qr_token: st.qrToken, ...GEO });
    expect((scan.data as { ok: boolean; code: string }).code).toBe('FORBIDDEN');

    const legacy = await createStaff(fx, 'university_supervisor');
    expect((await legacy.client.rpc('has_permission', { p_key: 'audit' })).data).toBe(true);
    expect((await legacy.client.rpc('schedule_stats', { p_university_id: fx.universityId })).error).toBeNull();
    const plainScanner = await createStaff(fx, 'supervisor');
    expect((await plainScanner.client.rpc('has_permission', { p_key: 'scan' })).data).toBe(true);
    expect((await plainScanner.client.rpc('has_permission', { p_key: 'routes' })).data).toBe(false);
  });

  it('a student promoted to scanner cannot be given staff pages', async () => {
    const promoted = await createStudent(fx);
    const promote = await admin.rpc('promote_student_to_supervisor', { p_student_id: promoted.id });
    expect(promote.error).toBeNull();
    expect((await role(promoted.profileId)).role).toBe('supervisor');
    const res = await admin.rpc('set_staff_permissions', { p_profile_id: promoted.profileId, p_permissions: ['scan', 'routes'] });
    expect(res.error?.message).toBe('STUDENT_SUPERVISOR_SCAN_ONLY');
  });
});

describe('realtime publication', () => {
  it('publishes every app table', async () => {
    const { rows } = await db().query<{ tablename: string }>(
      `select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'`,
    );
    const published = rows.map((r) => r.tablename);
    for (const table of ['students', 'scans', 'routes', 'route_stops', 'stops', 'notifications', 'pickup_choices', 'profiles', 'audit_log']) {
      expect(published).toContain(table);
    }
  });
});
