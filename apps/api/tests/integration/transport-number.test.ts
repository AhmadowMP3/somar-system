import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, createStudent, createUniversity, destroyUniversity, service, type Fixture } from './helpers.js';

let fx: Fixture;

beforeAll(async () => {
  fx = await createUniversity();
  await service.from('universities').update({ transport_separator: '' }).eq('id', fx.universityId);
});

afterAll(async () => {
  await destroyUniversity(fx);
  await closeDb();
});

describe('transport number format', () => {
  it('uses no separator when the university is configured that way, and still gives numbers back', async () => {
    const st = await createStudent(fx, { subscribe: false });
    expect(st.transportNumber).toBe(`${fx.prefix}0001`);

    const { data: next } = await service.rpc('allocate_transport_number', { p_university_id: fx.universityId });
    expect(next).toBe(`${fx.prefix}0002`);
    const { data: released } = await service.rpc('release_transport_number', {
      p_university_id: fx.universityId,
      p_transport_number: next,
    });
    expect(released).toBe(true);
    const { data: again } = await service.rpc('allocate_transport_number', { p_university_id: fx.universityId });
    expect(again).toBe(`${fx.prefix}0002`);
  });
});
