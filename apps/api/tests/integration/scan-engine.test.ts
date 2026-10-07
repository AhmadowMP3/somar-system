import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  balance,
  closeDb,
  createStaff,
  createStudent,
  createUniversity,
  destroyUniversity,
  freeze,
  GEO,
  scan,
  setSettings,
  unfreeze,
  type Fixture,
} from './helpers.js';

// 2026-10-03 is a Saturday = first day of the week (week_start_dow = 6).
const SAT = '2026-10-03';

let fx: Fixture;
let other: Fixture;
let sup: SupabaseClient;
let admin: SupabaseClient;

beforeAll(async () => {
  fx = await createUniversity();
  other = await createUniversity();
  sup = (await createStaff(fx, 'supervisor')).client;
  admin = (await createStaff(fx, 'admin')).client;
});

afterEach(async () => {
  await unfreeze();
  await setSettings(fx, { scan_cooldown_minutes: 5, allow_offday_override: false, require_supervisor_geo: true });
});

afterAll(async () => {
  await unfreeze();
  await destroyUniversity(fx);
  await destroyUniversity(other);
  await closeDb();
});

describe('perform_scan', () => {
  it('1-2. first scan is outbound (-1), second is return (unchanged)', async () => {
    const st = await createStudent(fx);
    await freeze(`${SAT} 07:30`);
    const before = await balance(st.id, SAT);
    const first = await scan(sup, { p_qr_token: st.qrToken, ...GEO });
    expect(first).toMatchObject({ ok: true, direction: 'outbound', remaining_after: before.remaining - 1 });
    expect((await balance(st.id, SAT)).remaining).toBe(before.remaining - 1);

    await freeze(`${SAT} 14:30`);
    const second = await scan(sup, { p_qr_token: st.qrToken, ...GEO });
    expect(second).toMatchObject({ ok: true, direction: 'return', remaining_after: before.remaining - 1 });
    expect((await balance(st.id, SAT)).remaining).toBe(before.remaining - 1);
  });

  it('3. return is allowed when the remaining balance is already 0', async () => {
    const st = await createStudent(fx, { tripsPerWeek: 1 });
    await freeze(`${SAT} 07:30`);
    expect(await scan(sup, { p_qr_token: st.qrToken, ...GEO })).toMatchObject({ ok: true, direction: 'outbound', remaining_after: 0 });
    await freeze(`${SAT} 15:00`);
    expect(await scan(sup, { p_qr_token: st.qrToken, ...GEO })).toMatchObject({ ok: true, direction: 'return', remaining_after: 0 });
  });

  it('4. third scan the same day is DAY_COMPLETE', async () => {
    const st = await createStudent(fx);
    await freeze(`${SAT} 07:30`);
    await scan(sup, { p_qr_token: st.qrToken, ...GEO });
    await freeze(`${SAT} 14:00`);
    await scan(sup, { p_qr_token: st.qrToken, ...GEO });
    await freeze(`${SAT} 18:00`);
    expect(await scan(sup, { p_qr_token: st.qrToken, ...GEO })).toMatchObject({ ok: false, code: 'DAY_COMPLETE' });
  });

  it('5. cooldown blocks a rescan inside the window and allows it one minute after', async () => {
    const st = await createStudent(fx);
    await freeze(`${SAT} 07:30`);
    await scan(sup, { p_qr_token: st.qrToken, ...GEO });
    await freeze(`${SAT} 07:33`);
    expect(await scan(sup, { p_qr_token: st.qrToken, ...GEO })).toMatchObject({ ok: false, code: 'COOLDOWN', minutes_remaining: 2 });
    await freeze(`${SAT} 07:36`);
    expect(await scan(sup, { p_qr_token: st.qrToken, ...GEO })).toMatchObject({ ok: true, direction: 'return' });
  });

  it('6-7. off-day: allowed without a reason, flagged as an override', async () => {
    const st = await createStudent(fx, { workDays: [1] });
    await freeze(`${SAT} 07:30`);
    const ok = await scan(sup, { p_qr_token: st.qrToken, ...GEO });
    expect(ok).toMatchObject({ ok: true, direction: 'outbound', offday_override: true });
    const { data } = await admin.from('scans').select('offday_override, override_reason').eq('id', ok.scan_id as string).single();
    expect(data).toEqual({ offday_override: true, override_reason: null });
  });

  it('a preview runs the checks and returns the rider without recording a scan', async () => {
    const st = await createStudent(fx, { workDays: [1] });
    await freeze(`${SAT} 07:30`);
    const preview = await scan(sup, { p_qr_token: st.qrToken, ...GEO, p_preview: true });
    expect(preview).toMatchObject({ ok: true, preview: true, scan_id: null, direction: 'outbound', offday_override: true });
    const { count } = await admin.from('scans').select('id', { count: 'exact', head: true }).eq('student_id', st.id);
    expect(count).toBe(0);
    expect(await scan(sup, { p_qr_token: st.qrToken, ...GEO })).toMatchObject({ ok: true, preview: false, direction: 'outbound' });
  });

  it('8. outbound with remaining 0 is NO_BALANCE', async () => {
    const st = await createStudent(fx, { tripsPerWeek: 1 });
    await freeze(`${SAT} 07:30`);
    await scan(sup, { p_qr_token: st.qrToken, ...GEO });
    await freeze('2026-10-04 07:30');
    expect(await scan(sup, { p_qr_token: st.qrToken, ...GEO })).toMatchObject({ ok: false, code: 'NO_BALANCE' });
  });

  it('9. scanning after ends_on is SUBSCRIPTION_EXPIRED', async () => {
    const st = await createStudent(fx, { endsOn: '2026-10-01' });
    await freeze(`${SAT} 07:30`);
    expect(await scan(sup, { p_qr_token: st.qrToken, ...GEO })).toMatchObject({ ok: false, code: 'SUBSCRIPTION_EXPIRED' });
  });

  it('10. unknown QR and another university', async () => {
    await freeze(`${SAT} 07:30`);
    expect(await scan(sup, { p_qr_token: randomUUID(), ...GEO })).toMatchObject({ ok: false, code: 'UNKNOWN_QR' });
    const foreign = await createStudent(other);
    expect(await scan(sup, { p_qr_token: foreign.qrToken, ...GEO })).toMatchObject({ ok: false, code: 'WRONG_UNIVERSITY' });
  });

  it('11. geolocation is required when the setting is on', async () => {
    const st = await createStudent(fx);
    await freeze(`${SAT} 07:30`);
    expect(await scan(sup, { p_qr_token: st.qrToken })).toMatchObject({ ok: false, code: 'GEO_REQUIRED' });
    expect(await scan(sup, { p_qr_token: st.qrToken, ...GEO, p_geo_denied: true })).toMatchObject({ ok: false, code: 'GEO_REQUIRED' });
    await setSettings(fx, { require_supervisor_geo: false });
    expect(await scan(sup, { p_qr_token: st.qrToken, p_geo_denied: true })).toMatchObject({ ok: true });
  });

  it('manual scan by transport number is flagged manual', async () => {
    const st = await createStudent(fx);
    await freeze(`${SAT} 07:30`);
    const res = await scan(sup, { p_transport_number: st.transportNumber.toLowerCase(), ...GEO });
    expect(res).toMatchObject({ ok: true, direction: 'outbound' });
    const { data } = await admin.from('scans').select('method').eq('id', res.scan_id as string).single();
    expect(data?.method).toBe('manual');
  });

  it('12-13. crossing the week boundary resets used without any job; unused trips do not roll over', async () => {
    const st = await createStudent(fx, { tripsPerWeek: 3 });
    // Friday 2026-10-02 belongs to the week that started Saturday 2026-09-26.
    await freeze('2026-10-02 07:30');
    await scan(sup, { p_qr_token: st.qrToken, ...GEO });
    const friday = await balance(st.id, '2026-10-02');
    expect(friday).toMatchObject({ week_start: '2026-09-26', quota: 3, used: 1, remaining: 2 });

    await freeze(`${SAT} 00:05`);
    const saturday = await balance(st.id, SAT);
    expect(saturday).toMatchObject({ week_start: SAT, quota: 3, used: 0, remaining: 3 });
    const res = await scan(sup, { p_qr_token: st.qrToken, ...GEO });
    expect(res).toMatchObject({ ok: true, direction: 'outbound', quota: 3, remaining_after: 2 });
  });

  it('15. cancelling an outbound also cancels that day\'s return and restores the trip', async () => {
    const st = await createStudent(fx);
    await freeze(`${SAT} 07:30`);
    const out = await scan(sup, { p_qr_token: st.qrToken, ...GEO });
    await freeze(`${SAT} 14:00`);
    const ret = await scan(sup, { p_qr_token: st.qrToken, ...GEO });
    expect((await balance(st.id, SAT)).used).toBe(1);

    const { data, error } = await admin.rpc('cancel_scan', { p_scan_id: out.scan_id, p_reason: 'مسح خاطئ' });
    expect(error).toBeNull();
    expect((data as { cancelled_ids: string[] }).cancelled_ids.sort()).toEqual([out.scan_id, ret.scan_id].sort());
    expect((await balance(st.id, SAT)).used).toBe(0);

    const { error: noReason } = await admin.rpc('cancel_scan', { p_scan_id: out.scan_id, p_reason: ' ' });
    expect(noReason?.message).toBe('REASON_REQUIRED');
    const { error: supErr } = await sup.rpc('cancel_scan', { p_scan_id: out.scan_id, p_reason: 'x' });
    expect(supErr?.message).toBe('FORBIDDEN');
  });

  it('students cannot scan', async () => {
    const st = await createStudent(fx);
    const { signIn } = await import('./helpers.js');
    const client = await signIn(st.transportNumber, st.transportNumber);
    expect(await scan(client, { p_qr_token: st.qrToken, ...GEO })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
  });
});
