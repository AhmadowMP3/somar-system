/**
 * The bus timetable has fixed slots (owner's decision, 2026-10-06): students leave at 8, 10, 12 or 2
 * o'clock and come back at 11:30, 2, 3:30 or 4. Free times saved earlier are rounded to these slots.
 */
export const OUTBOUND_SLOTS = ['08:00', '10:00', '12:00', '14:00'] as const;
export const RETURN_SLOTS = ['11:30', '14:00', '15:30', '16:00'] as const;

const minutes = (hhmm: string) => {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** before 9:00 → 8 · 9:00–10:49 → 10 · 10:50–12:59 → 12 · 13:00 and later → 2. */
export function snapOutbound(time: string): string {
  const t = minutes(time);
  if (t < minutes('09:00')) return '08:00';
  if (t < minutes('10:50')) return '10:00';
  if (t < minutes('13:00')) return '12:00';
  return '14:00';
}

/** up to 11:30 → 11:30 · up to 2 → 2 · up to 3:30 → 3:30 · later → 4. */
export function snapReturn(time: string): string {
  const t = minutes(time);
  if (t <= minutes('11:30')) return '11:30';
  if (t <= minutes('14:00')) return '14:00';
  if (t <= minutes('15:30')) return '15:30';
  return '16:00';
}

/**
 * Both times of one day on the slots; the return must stay after the outbound, so a return that lands
 * on or before it moves to the next return slot (or the last one).
 */
export function snapDay(outbound: string, ret: string): { outbound: string; ret: string } {
  const out = snapOutbound(outbound);
  let back = snapReturn(ret);
  if (minutes(back) <= minutes(out)) back = RETURN_SLOTS.find((s) => minutes(s) > minutes(out)) ?? RETURN_SLOTS[RETURN_SLOTS.length - 1]!;
  return { outbound: out, ret: back };
}
