import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { provisionStaff } from '../../src/services/provisioning.js';
import { accessToken, cfg, closeDb, createStaff, createStudent, createUniversity, destroyUniversity, service, type Fixture } from './helpers.js';

let fx: Fixture;
let prefix: string;

beforeAll(async () => {
  fx = await createUniversity();
  // a prefix ending in a digit is the tricky case for parsing the sequence back out of "PREFIX0002"
  prefix = `${fx.prefix.slice(0, 6)}7`;
  await service.from('universities').update({ transport_separator: '', transport_prefix: prefix }).eq('id', fx.universityId);
});

afterAll(async () => {
  await destroyUniversity(fx);
  await closeDb();
});

describe('transport number format', () => {
  it('uses no separator when the university is configured that way, and still gives numbers back', async () => {
    const st = await createStudent(fx, { subscribe: false });
    expect(st.transportNumber).toBe(`${prefix}0001`);

    const { data: next } = await service.rpc('allocate_transport_number', { p_university_id: fx.universityId });
    expect(next).toBe(`${prefix}0002`);
    const { data: released } = await service.rpc('release_transport_number', {
      p_university_id: fx.universityId,
      p_transport_number: next,
    });
    expect(released).toBe(true);
    const { data: again } = await service.rpc('allocate_transport_number', { p_university_id: fx.universityId });
    expect(again).toBe(`${prefix}0002`);
  });
});

describe('a login code that equals the next transport number (production bug, 2026-10-02)', () => {
  it('is skipped instead of failing every new student forever', async () => {
    const { data: counter } = await service.from('university_counters').select('last_value').eq('university_id', fx.universityId).single();
    const next = (counter as { last_value: number }).last_value + 1;
    const taken = `${prefix}${String(next).padStart(4, '0')}`;
    const { profileId } = await provisionStaff(service, cfg, {
      login_code: taken, full_name: 'مشرف برمز يشبه رقم نقل', university_id: fx.universityId,
      password: 'Staff@12345', role: 'university_supervisor',
    });
    fx.profileIds.push(profileId);
    const st = await createStudent(fx, { subscribe: false });
    expect(st.transportNumber).toBe(`${prefix}${String(next + 1).padStart(4, '0')}`);
  });

  it('the API refuses staff login codes shaped like transport numbers', async () => {
    const app = (await buildApp(cfg, { logger: false })).app;
    try {
      const admin = await createStaff(fx, 'admin');
      const token = await accessToken(admin.client);
      for (const code of [`${prefix}0099`, `${prefix}-0099`, `${prefix}-D001`, `${prefix.toLowerCase()}0100`]) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/supervisors',
          headers: { authorization: `Bearer ${token}` },
          payload: { login_code: code, full_name: 'مشرف اختبار', university_id: fx.universityId, password: 'Staff@12345' },
        });
        expect(res.statusCode, code).toBe(400);
        expect(res.json().code).toBe('LOGIN_CODE_RESERVED');
      }
      const ok = await app.inject({
        method: 'POST',
        url: '/api/supervisors',
        headers: { authorization: `Bearer ${token}` },
        payload: { login_code: `SUP-${prefix}`, full_name: 'مشرف اختبار', university_id: fx.universityId, password: 'Staff@12345' },
      });
      expect(ok.statusCode, ok.body).toBe(201);
    } finally {
      await app.close();
    }
  });
});
