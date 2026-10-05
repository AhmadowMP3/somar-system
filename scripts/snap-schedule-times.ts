/**
 * Rounds every saved weekly schedule to the bus slots (owner's decision, 2026-10-06):
 * outbound 8 / 10 / 12 / 2, return 11:30 / 2 / 3:30 / 4 (see packages/shared/src/schedule.ts).
 * Only rows that change are written; re-running changes nothing. Dry run by default.
 *   npx tsx scripts/snap-schedule-times.ts --env .env.production [--commit]
 */
import { createClient } from '@supabase/supabase-js';
import { snapDay } from '@somar/shared';
import { loadProdEnv } from './prod-env.js';

const args = process.argv.slice(2);
const envFile = args.includes('--env') ? (args[args.indexOf('--env') + 1] as string) : '.env.production';
const commit = args.includes('--commit');
const env = loadProdEnv(envFile);
const db = createClient(env.SUPABASE_URL as string, env.SUPABASE_SERVICE_ROLE_KEY as string, { auth: { persistSession: false } });

type Row = { student_id: string; dow: number; outbound_time: string; return_time: string };
const rows: Row[] = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await db
    .from('student_schedule')
    .select('student_id, dow, outbound_time, return_time')
    .order('student_id')
    .order('dow')
    .range(from, from + 999);
  if (error) throw new Error(error.message);
  rows.push(...((data ?? []) as Row[]));
  if ((data ?? []).length < 1000) break;
}

const hhmm = (t: string) => t.slice(0, 5);
const changes = rows
  .map((r) => ({ r, next: snapDay(hhmm(r.outbound_time), hhmm(r.return_time)) }))
  .filter(({ r, next }) => next.outbound !== hhmm(r.outbound_time) || next.ret !== hhmm(r.return_time));

const tally = (pairs: [string, string][]) =>
  Object.entries(pairs.reduce<Record<string, number>>((m, [a, b]) => ((m[`${a} → ${b}`] = (m[`${a} → ${b}`] ?? 0) + 1), m), {}))
    .sort()
    .map(([k, n]) => `${k} (${n})`)
    .join('، ');
console.log(`${commit ? 'تنفيذ' : 'تجربة (بدون كتابة)'} على ${new URL(env.SUPABASE_URL as string).host}`);
console.log(`أيام الدوام المسجّلة: ${rows.length} · ستتغيّر: ${changes.length} · طلاب: ${new Set(changes.map((c) => c.r.student_id)).size}`);
console.log(`الذهاب: ${tally(changes.filter((c) => c.next.outbound !== hhmm(c.r.outbound_time)).map((c) => [hhmm(c.r.outbound_time), c.next.outbound]))}`);
console.log(`العودة: ${tally(changes.filter((c) => c.next.ret !== hhmm(c.r.return_time)).map((c) => [hhmm(c.r.return_time), c.next.ret]))}`);

if (!commit) console.log('\nلم يُكتب شيء. أعد التشغيل مع --commit للتنفيذ.');
else {
  for (let b = 0; b < changes.length; b += 500) {
    const batch = changes.slice(b, b + 500).map(({ r, next }) => ({
      student_id: r.student_id,
      dow: r.dow,
      outbound_time: next.outbound,
      return_time: next.ret,
    }));
    const { error } = await db.from('student_schedule').upsert(batch, { onConflict: 'student_id,dow' });
    if (error) throw new Error(error.message);
  }
  console.log(`\nتم تحديث ${changes.length} يوم دوام.`);
}
