import type { FastifyInstance } from 'fastify';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import {
  accessToken,
  cfg,
  closeDb,
  createStaff,
  createStudent,
  createUniversity,
  db,
  destroyUniversity,
  service,
  type Fixture,
} from './helpers.js';

let app: FastifyInstance;
let fx: Fixture;
let other: Fixture;
let admin: SupabaseClient;
let adminToken: string;
let staffClient: SupabaseClient;
let staffToken: string;
let packageB: string;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  app = (await buildApp(cfg, { logger: false })).app;
  fx = await createUniversity();
  other = await createUniversity();
  const a = await createStaff(fx, 'admin');
  admin = a.client;
  adminToken = await accessToken(admin);
  const us = await createStaff(fx, 'university_supervisor');
  staffClient = us.client;
  staffToken = await accessToken(us.client);
  const { data } = await service
    .from('packages')
    .insert({ university_id: fx.universityId, name: 'باقة جماعية', trips_per_week: 3, semester_start: '2026-09-01', semester_end: '2027-01-31' })
    .select('id')
    .single();
  packageB = data?.id as string;
});

afterAll(async () => {
  await app.close();
  await destroyUniversity(fx);
  await destroyUniversity(other);
  await closeDb();
});

describe('bulk package assignment', () => {
  it('replaces the active subscription of each picked student and reports the rest', async () => {
    const s1 = await createStudent(fx);
    const s2 = await createStudent(fx, { subscribe: false });
    const foreign = await createStudent(other);
    const missing = '00000000-0000-4000-8000-000000000000';

    const { data, error } = await admin.rpc('bulk_assign_subscription', {
      p_student_ids: [s1.id, s2.id, s1.id, foreign.id, missing],
      p_package_id: packageB,
    });
    expect(error).toBeNull();
    const res = data as { assigned: number; failed: { student_id: string; code: string }[] };
    expect(res.assigned).toBe(2);
    expect(res.failed).toEqual(
      expect.arrayContaining([
        { student_id: foreign.id, code: 'WRONG_UNIVERSITY' },
        { student_id: missing, code: 'NOT_FOUND' },
      ]),
    );
    expect(res.failed).toHaveLength(2);

    for (const id of [s1.id, s2.id]) {
      const { data: subs } = await service.from('subscriptions').select('package_id, trips_per_week, starts_on').eq('student_id', id).eq('status', 'active');
      expect(subs).toEqual([{ package_id: packageB, trips_per_week: 3, starts_on: '2026-09-01' }]);
    }
    // the other university's student keeps its own package
    const { data: kept } = await service.from('subscriptions').select('package_id').eq('student_id', foreign.id).eq('status', 'active');
    expect(kept).toEqual([{ package_id: other.packageId }]);

    const { rows } = await db().query(
      `select after from public.audit_log where university_id = $1 and action = 'subscription.bulk_assign' and entity_id = $2`,
      [fx.universityId, packageB],
    );
    expect(rows[0]?.after).toEqual({ assigned: 2, failed: 2 });
  });

  it('is admin only, like the single assignment', async () => {
    const st = await createStudent(fx);
    const { error } = await staffClient.rpc('bulk_assign_subscription', { p_student_ids: [st.id], p_package_id: packageB });
    expect(error?.message).toBe('FORBIDDEN');
    const empty = await admin.rpc('bulk_assign_subscription', { p_student_ids: [], p_package_id: packageB });
    expect(empty.error?.message).toBe('VALIDATION');
  });
});

describe('bulk delete', () => {
  it('deletes the accounts and rows of the picked students of this university only', async () => {
    const a = await createStudent(fx);
    const b = await createStudent(fx);
    const keep = await createStudent(fx);
    const foreign = await createStudent(other);

    const res = await app.inject({
      method: 'POST',
      url: '/api/students/bulk-delete',
      headers: auth(adminToken),
      payload: { university_id: fx.universityId, student_ids: [a.id, b.id, foreign.id] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, deleted: 2, failed: [{ student_id: foreign.id, code: 'NOT_FOUND' }] });

    const { data: left } = await service.from('students').select('id').in('id', [a.id, b.id, keep.id, foreign.id]);
    expect((left ?? []).map((r) => r.id).sort()).toEqual([keep.id, foreign.id].sort());
    const { data: profiles } = await service.from('profiles').select('id').in('id', [a.profileId, b.profileId]);
    expect(profiles).toEqual([]);
    expect((await service.auth.admin.getUserById(a.profileId)).data.user).toBeNull();

    const { rows } = await db().query(`select entity_id from public.audit_log where action = 'student.delete' and university_id = $1`, [fx.universityId]);
    expect(rows.map((r) => r.entity_id).sort()).toEqual([a.id, b.id].sort());
  });

  it('refuses non-admins', async () => {
    const st = await createStudent(fx);
    const res = await app.inject({
      method: 'POST',
      url: '/api/students/bulk-delete',
      headers: auth(staffToken),
      payload: { university_id: fx.universityId, student_ids: [st.id] },
    });
    expect(res.statusCode).toBe(403);
    const { data } = await service.from('students').select('id').eq('id', st.id);
    expect(data).toHaveLength(1);
  });
});

describe('notification to picked students', () => {
  it('reaches exactly the active picked students of the university', async () => {
    const one = await createStudent(fx);
    const two = await createStudent(fx);
    const inactive = await createStudent(fx);
    const notPicked = await createStudent(fx);
    const foreign = await createStudent(other);
    await service.from('students').update({ is_active: false }).eq('id', inactive.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/notifications/broadcast',
      headers: auth(adminToken),
      payload: {
        university_id: fx.universityId,
        title: 'تنبيه للمحددين',
        body: 'تغيير موعد الباص',
        audience: { kind: 'students', student_ids: [one.id, two.id, inactive.id, foreign.id] },
      },
    });
    expect(res.statusCode).toBe(201);
    const { broadcast_id, recipients } = res.json() as { broadcast_id: string; recipients: number };
    expect(recipients).toBe(2);

    const { data: notes } = await service.from('notifications').select('student_id').eq('data->>broadcast_id', broadcast_id);
    expect((notes ?? []).map((r) => r.student_id).sort()).toEqual([one.id, two.id].sort());
    expect((notes ?? []).some((r) => r.student_id === notPicked.id)).toBe(false);
    const { data: b } = await service.from('broadcasts').select('audience, recipients').eq('id', broadcast_id).single();
    expect(b).toEqual({ audience: { kind: 'students', count: 2 }, recipients: 2 });
  });

  it('with no eligible student it sends nothing', async () => {
    const foreign = await createStudent(other);
    const res = await app.inject({
      method: 'POST',
      url: '/api/notifications/broadcast',
      headers: auth(adminToken),
      payload: { university_id: fx.universityId, title: 'x', body: 'y', audience: { kind: 'students', student_ids: [foreign.id] } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('NO_RECIPIENTS');
  });
});
