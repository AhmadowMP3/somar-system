import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, createStudent, createUniversity, destroyUniversity, service, type Fixture } from './helpers.js';

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
