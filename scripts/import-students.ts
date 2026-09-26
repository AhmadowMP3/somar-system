/**
 *   npm run import:students -- --file assets/students.xlsx --university SHB --dry-run   → import-preview.xlsx
 *   npm run import:students -- --file assets/students.xlsx --university SHB --commit    → import-result.xlsx
 *   [--env .env.production]
 *
 * Same engine as the admin import wizard (header matching, normalization, latest-timestamp dedupe, per-row
 * provisioning with rollback). Both commands are safe to re-run: existing students are updated, never duplicated,
 * and transport numbers / QR tokens / photos are never touched.
 * import-result.xlsx lists every transport number (= first password) next to the student's name: it contains
 * credentials, is gitignored, and must be kept private.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import * as XLSX from 'xlsx';
import { formatPhoneDisplay } from '@somar/shared';
import { loadConfig } from '../apps/api/src/config.js';
import { runImport, type ImportResult } from '../apps/api/src/services/import.js';
import { loadProdEnv } from './prod-env.js';

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const STATUS: Record<string, string> = { created: 'جديد', updated: 'تحديث', duplicate: 'مكرر', rejected: 'مرفوض' };

function writeSheet(file: string, sheets: { name: string; rows: Record<string, unknown>[] }[]) {
  const wb = XLSX.utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }] };
  for (const s of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(s.rows), s.name);
  writeFileSync(file, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer);
}

function summaryRows(res: ImportResult) {
  return [
    { البند: 'إجمالي الصفوف', العدد: res.summary.total },
    { البند: 'جديد', العدد: res.summary.created },
    { البند: 'تحديث (موجود مسبقاً)', العدد: res.summary.updated },
    { البند: 'مكرر (اعتُمد أحدث تسجيل)', العدد: res.summary.duplicates },
    { البند: 'مرفوض', العدد: res.summary.rejected },
    { البند: 'بحاجة ربط منطقة', العدد: res.needs_area_mapping },
  ];
}

async function main() {
  const file = arg('file');
  const prefix = arg('university')?.toUpperCase();
  const commit = argv.includes('--commit');
  const dryRun = argv.includes('--dry-run');
  if (!file || !prefix || commit === dryRun) {
    throw new Error('الاستخدام: --file <ملف.xlsx> --university <البادئة> (--dry-run | --commit)');
  }
  const env = loadProdEnv();
  const cfg = loadConfig({ ...env, DISABLE_CRON: 'true' });
  const db = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: uni, error } = await db.from('universities').select('id, name').eq('transport_prefix', prefix).maybeSingle();
  if (error || !uni) throw new Error(`لا توجد جامعة بالبادئة ${prefix}`);
  const { data: admin } = await db.from('profiles').select('id').ilike('login_code', env.BOOTSTRAP_ADMIN_CODE || 'ADMIN').maybeSingle();

  console.log(`${commit ? 'استيراد فعلي' : 'معاينة فقط'} → ${uni.name} (${prefix}) · ${file}`);
  const started = Date.now();
  const res = await runImport(db, cfg, {
    universityId: uni.id as string,
    buffer: readFileSync(resolve(file)),
    dryRun: !commit,
    actorId: (admin?.id as string | undefined) ?? null,
  });

  const s = res.summary;
  console.log(`الصفوف ${s.total} · جديد ${s.created} · تحديث ${s.updated} · مكرر ${s.duplicates} · مرفوض ${s.rejected} · بحاجة ربط منطقة ${res.needs_area_mapping}`);
  const rowSheet = res.rows.map((r) => ({
    الصف: r.row_number,
    الحالة: STATUS[r.status] ?? r.status,
    الاسم: r.student_name,
    'الرقم الجامعي': r.university_student_no ?? '',
    'أسباب الرفض': r.reasons.join(' | '),
    ملاحظات: r.warnings.join(' | '),
  }));

  if (!commit) {
    writeSheet('import-preview.xlsx', [
      { name: 'الملخص', rows: summaryRows(res) },
      { name: 'كل الصفوف', rows: rowSheet },
      { name: 'المرفوضة', rows: rowSheet.filter((r) => r.الحالة === STATUS.rejected) },
    ]);
    console.log('✅ كُتب import-preview.xlsx — لم يُحفظ أي شيء في قاعدة البيانات.');
  } else {
    const { data: students } = await db
      .from('students')
      .select('transport_number, full_name, university_student_no, phone_e164, colleges(name)')
      .eq('university_id', uni.id)
      .order('transport_number');
    const accounts = ((students ?? []) as unknown as {
      transport_number: string;
      full_name: string;
      university_student_no: string;
      phone_e164: string;
      colleges: { name: string } | null;
    }[]).map((st) => ({
      'رقم النقل': st.transport_number,
      'كلمة المرور الأولى': st.transport_number,
      الاسم: st.full_name,
      'الرقم الجامعي': st.university_student_no,
      الهاتف: formatPhoneDisplay(st.phone_e164),
      الكلية: st.colleges?.name ?? '',
    }));
    writeSheet('import-result.xlsx', [
      { name: 'الحسابات', rows: accounts },
      { name: 'الملخص', rows: summaryRows(res) },
      { name: 'نتيجة كل صف', rows: rowSheet },
      { name: 'المرفوضة', rows: rowSheet.filter((r) => r.الحالة === STATUS.rejected) },
    ]);
    console.log(`✅ كُتب import-result.xlsx — ${accounts.length} حساب مع رقم النقل وكلمة المرور الأولى. احفظه بمكان خاص.`);
  }
  console.log(`المدة ${((Date.now() - started) / 1000).toFixed(1)} ث`);
}

main().catch((err: unknown) => {
  console.error(`❌ ${(err as Error).message}`);
  process.exitCode = 1;
});
