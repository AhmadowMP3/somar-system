/**
 * Recreates the routes and stops from the owner's timetable (مواعيد انطلاق الباصات, 2026-10): lines 1–7
 * (first and second trip), the third-period trips of lines 1 and 2, and the four return routes.
 * Safe to re-run: stops already in the library are reused (matched by name, so their map location is
 * kept) and a route that already exists with the same name is skipped. Dry run by default.
 *   npx tsx scripts/restore-routes.ts --env .env.production [--prefix SHB] [--commit]
 */
import { createClient } from '@supabase/supabase-js';
import { foldArabic } from '@somar/shared';
import { loadProdEnv } from './prod-env.js';

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => (args.includes(name) ? (args[args.indexOf(name) + 1] as string) : fallback);
const envFile = arg('--env', '.env.production');
const prefix = arg('--prefix', 'SHB');
const commit = args.includes('--commit');

type Line = { name: string; direction: 'outbound' | 'return'; stops: string[]; times?: string[]; notes?: string };

const t = (from: string, n: number, step = 5) => {
  const [h, m] = from.split(':').map(Number) as [number, number];
  return Array.from({ length: n }, (_, i) => {
    const mm = h * 60 + m + i * step;
    return `${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`;
  });
};

const L1 = ['كازية الشياح (الفيض)', 'ساحة سعد الله جابري', 'شارع قسطاكي حمصي', 'دوار السياسية', 'جامع التوحيد', 'دوار الكلمة الاشرفية', 'جامع الرحمن', 'دوار الدلة', 'دوار النحاس', 'دوار المائل', 'دوار الطب العربي'];
const L2 = ['دوار الكرة', 'مولات سيف دولة', 'اشارات سوق سيف دولة', 'جامع النصر', 'اشارات بريد سيف دولة', 'مسمكة ابو جاسم', 'مستودعات الاعظمية', 'اوتستراد الحمدانية', '1070 شقة'];
const L3 = ['ال بلو مول', 'دوار الصاخور', 'اشارات الميدان', 'دوار الزراعة', 'مفرق العوارض', 'مفرق جزيرة', 'بنك الدم', 'اشارات السريان'];
const L4 = ['دوار عمر ابوريشة', 'دوار الاخوة', 'سحسول', 'ساحة الجامعة', 'اشارات سيرياتيل', 'دوار الكرة', 'محطة الاكسبريس', 'دوار الصنم'];
const L5 = ['دوار الشفاء', 'مبنى بريد حلب جديدة', 'اشارات نيوتاون', 'دوار المتنبي حلب جديدة', 'مشفى الرجاء', 'دوار 3000 شقة', 'دوار سوق الهال القديم (٦٠٦)', 'دوار الموت'];
const L6 = ['دوار الصنم', 'اوتستراد الحمدانية', 'جامع الباسل', 'دوار الصالات', 'دوار سوق الهال القديم (٦٠٦)', 'دوار الرواد', 'دوار 3000 شقة', 'دوار الموت'];
const L7 = ['المهندسين', 'دوار قرطبة', 'دوار الجوية', 'دوار المالية', 'دوار الصحة', 'دوار العمارة', 'دوار الصخرة', 'دوار الشرطة', 'دوار العباس (الباسل سابقا)'];

/** Times exactly as printed in the timetable (including its repeated / out-of-order minutes). */
const LINES: Line[] = [
  { name: 'الخط 1 — الرحلة الأولى', direction: 'outbound', stops: L1, times: t('07:00', 11) },
  { name: 'الخط 1 — الرحلة الثانية', direction: 'outbound', stops: L1, times: t('08:50', 11) },
  { name: 'الخط 2 — الرحلة الأولى', direction: 'outbound', stops: L2, times: ['07:15', '07:20', '07:25', '07:30', '07:30', '07:35', '07:40', '07:45', '07:50'] },
  { name: 'الخط 2 — الرحلة الثانية', direction: 'outbound', stops: L2, times: t('08:50', 9) },
  { name: 'الخط 3 — الرحلة الأولى', direction: 'outbound', stops: L3, times: t('07:15', 8) },
  { name: 'الخط 3 — الرحلة الثانية', direction: 'outbound', stops: L3, times: t('08:50', 8) },
  { name: 'الخط 4 — الرحلة الأولى', direction: 'outbound', stops: L4, times: t('07:15', 8) },
  { name: 'الخط 4 — الرحلة الثانية', direction: 'outbound', stops: L4, times: t('08:50', 8) },
  { name: 'الخط 5 — الرحلة الأولى', direction: 'outbound', stops: L5, times: t('07:15', 8) },
  { name: 'الخط 5 — الرحلة الثانية', direction: 'outbound', stops: L5, times: t('08:50', 8) },
  { name: 'الخط 6 — الرحلة الأولى', direction: 'outbound', stops: L6, times: t('07:15', 8) },
  { name: 'الخط 6 — الرحلة الثانية', direction: 'outbound', stops: L6, times: t('08:50', 8) },
  { name: 'الخط 7 — الرحلة الأولى', direction: 'outbound', stops: L7, times: ['07:15', '07:20', '07:25', '07:25', '07:30', '07:35', '07:40', '07:45', '07:50'] },
  { name: 'الخط 7 — الرحلة الثانية', direction: 'outbound', stops: L7, times: t('08:50', 9) },
  {
    name: 'الخط الأول — الفترة الثالثة',
    direction: 'outbound',
    stops: ['دوار الكرة', 'اشارات سيرياتيل', 'دوار عمر ابوريشة', 'دوار المحافظة', 'جامع الرحمن', 'دوار الطب العربي', 'دوار الغزالي', 'دوار الصحة', 'دوار المالية', 'دوار الجوية'],
    times: t('10:50', 10),
  },
  {
    name: 'الخط الثاني — الفترة الثالثة',
    direction: 'outbound',
    stops: ['دوار قرطبة', 'محطة الاكسبريس', 'دوار الصنم', 'مستودعات الاعظمية', 'مسمكة ابو جاسم', 'اوتستراد الحمدانية', 'دوار الشفاء', 'دوار الشرطة', 'دوار الموت', 'دوار 3000 شقة'],
    times: ['10:50', '11:00', '10:55', '11:05', '11:10', '11:15', '11:25', '11:20', '11:30', '11:35'],
  },
  {
    name: 'العودة — القسم الأول',
    direction: 'return',
    notes: 'خطوط العودة لجميع الفترات',
    stops: ['دوار الصاخور', 'اشارات الميدان', 'مفرق العوارض', 'دوار الزراعة', 'مفرق جزيرة', 'بنك الدم', 'اشارات السريان', 'دوار السياسية', 'جامع التوحيد', 'دوار الكلمة الاشرفية'],
  },
  {
    name: 'العودة — القسم الثاني',
    direction: 'return',
    notes: 'خطوط العودة لجميع الفترات',
    stops: ['جامع الرحمن', 'دوار الطب العربي', 'دوار عمر ابوريشة', 'دوار الاخوة', 'سحسول', 'دوار الكرة', 'اشارات سيرياتيل', 'محطة الاكسبريس', 'دوار الصنم', 'دوار قرطبة'],
  },
  {
    name: 'العودة — القسم الثالث',
    direction: 'return',
    notes: 'خطوط العودة لجميع الفترات',
    stops: ['دوار المالية', 'دوار الجوية', 'دوار الصحة', 'دوار العمارة', 'دوار الصخرة', 'دوار الشرطة', 'دوار العباس (الباسل سابقا)', 'اوتستراد الحمدانية', 'دوار الصالات', 'دوار الرواد'],
  },
  {
    name: 'العودة — القسم الرابع',
    direction: 'return',
    notes: 'خطوط العودة لجميع الفترات',
    stops: ['دوار 3000 شقة', 'دوار الموت', 'دوار الشفاء', 'مسمكة ابو جاسم', 'اشارات نيوتاون', 'مستودعات الاعظمية', '1070 شقة'],
  },
];

for (const l of LINES) {
  if (l.times && l.times.length !== l.stops.length) throw new Error(`${l.name}: ${l.stops.length} stops but ${l.times.length} times`);
}

/** Name key that survives spacing, hamza/taa-marbuta variants and brackets (e.g. «ال بلو مول» = «البلو مول»). */
const key = (name: string) => foldArabic(name).replace(/[\s()\-_.]/g, '');

const env = loadProdEnv(envFile);
const db = createClient(env.SUPABASE_URL as string, env.SUPABASE_SERVICE_ROLE_KEY as string, { auth: { persistSession: false } });

const { data: uni, error: uniErr } = await db.from('universities').select('id, name').eq('transport_prefix', prefix).single();
if (uniErr || !uni) throw new Error(`university ${prefix}: ${uniErr?.message ?? 'not found'}`);
const universityId = uni.id as string;
console.log(`${commit ? 'تنفيذ' : 'تجربة (بدون كتابة)'} على ${new URL(env.SUPABASE_URL as string).host} · ${uni.name}`);

const { data: existingStops, error: stopsErr } = await db.from('stops').select('id, name, is_active, lat').eq('university_id', universityId);
if (stopsErr) throw new Error(stopsErr.message);
const stopByKey = new Map((existingStops ?? []).map((s) => [key(s.name as string), s as { id: string; name: string; is_active: boolean; lat: number | null }]));

const wanted = [...new Map(LINES.flatMap((l) => l.stops).map((n) => [key(n), n])).values()];
const toCreate = wanted.filter((n) => !stopByKey.has(key(n)));
const toReactivate = wanted.map((n) => stopByKey.get(key(n))).filter((s): s is NonNullable<typeof s> => Boolean(s && !s.is_active));
const reused = wanted.length - toCreate.length;
console.log(`نقاط الوقوف: ${wanted.length} مطلوبة · ${reused} موجودة مسبقاً (${wanted.filter((n) => stopByKey.get(key(n))?.lat != null).length} منها لها موقع على الخريطة) · ${toCreate.length} جديدة · ${toReactivate.length} ستُعاد تفعيلها`);
if (toCreate.length) console.log(`  جديدة: ${toCreate.join('، ')}`);

const { data: existingRoutes, error: routesErr } = await db.from('routes').select('id, name').eq('university_id', universityId);
if (routesErr) throw new Error(routesErr.message);
const routeNames = new Set((existingRoutes ?? []).map((r) => key(r.name as string)));
const newLines = LINES.filter((l) => !routeNames.has(key(l.name)));
console.log(`الخطوط: ${LINES.length} · ${LINES.length - newLines.length} موجودة مسبقاً (تُتخطّى) · ${newLines.length} ستُنشأ`);
for (const l of newLines) console.log(`  ${l.direction === 'return' ? '↩' : '→'} ${l.name}: ${l.stops.length} نقطة${l.times ? ` · ${l.times[0]}` : ''}`);

if (!commit) console.log('\nلم يُكتب شيء. أعد التشغيل مع --commit للتنفيذ.');
else await write();

async function write() {
if (toCreate.length) {
  const { data, error } = await db.from('stops').insert(toCreate.map((name) => ({ university_id: universityId, name }))).select('id, name, is_active, lat');
  if (error) throw new Error(`stops: ${error.message}`);
  for (const s of data ?? []) stopByKey.set(key(s.name as string), s as { id: string; name: string; is_active: boolean; lat: number | null });
}
if (toReactivate.length) {
  const { error } = await db.from('stops').update({ is_active: true }).in('id', toReactivate.map((s) => s.id));
  if (error) throw new Error(`stops: ${error.message}`);
}

for (const l of newLines) {
  const { data: route, error } = await db
    .from('routes')
    .insert({ university_id: universityId, name: l.name, direction: l.direction, departure_time: l.times?.[0] ?? null, notes: l.notes ?? null })
    .select('id')
    .single();
  if (error || !route) throw new Error(`${l.name}: ${error?.message}`);
  const { error: rsErr } = await db.from('route_stops').insert(
    l.stops.map((name, i) => ({
      route_id: route.id,
      seq: i + 1,
      stop_id: (stopByKey.get(key(name)) as { id: string }).id,
      departure_time: l.times?.[i] ?? null,
    })),
  );
  if (rsErr) {
    await db.from('routes').delete().eq('id', route.id);
    throw new Error(`${l.name}: ${rsErr.message}`);
  }
  console.log(`✅ ${l.name}`);
}
console.log(`\nتم: ${newLines.length} خط، ${toCreate.length} نقطة جديدة.`);
}
