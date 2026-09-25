/**
 * `npm run tour` — captures screenshots/01…16 of the running review stack (`npm run review` first)
 * at a 390×844 mobile viewport. Scan screens run inside a temporary "tour" university that is deleted
 * at the end, so the demo data is never modified. Set PW_CHANNEL=chromium to use Playwright's Chromium
 * instead of the installed Microsoft Edge.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';
import { damascusDate, weekStart } from '@somar/shared';
import { loadConfig } from '../apps/api/src/config.js';
import { provisionStaff, provisionStudent } from '../apps/api/src/services/provisioning.js';
import { AREAS, COLLEGES, DEMO_UNIVERSITY } from '../supabase/seed/data.js';
import { IMPORT_FILE } from '../supabase/seed/generate-import.js';
import { DEMO_PASSWORD, DEMO_SERVICE_KEY, readState, REVIEW_ADMIN_PASSWORD, ROOT } from './review-lib.js';

const OUT = resolve(ROOT, 'screenshots');
const VIEWPORT = { width: 390, height: 844 };
const TOUR_PASSWORD = 'Tour@12345';

const state = readState();
if (!state) {
  console.error('شغّل npm run review أولاً.');
  process.exit(1);
}
const cfg = loadConfig({
  SUPABASE_URL: state.supabaseUrl,
  SUPABASE_SERVICE_ROLE_KEY: DEMO_SERVICE_KEY,
  SUPABASE_ANON_KEY: 'unused',
  SUPABASE_STUDENT_EMAIL_DOMAIN: 'somar.local',
  DISABLE_CRON: 'true',
});
const db = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function must<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>, what: string): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`${what}: ${error.message}`);
  return data as T;
}

type Tour = { universityId: string; supervisorCode: string; fresh: string; scanner: string; empty: string };

async function setupTour(): Promise<Tour> {
  const prefix = `TR${Date.now().toString().slice(-5)}`;
  const uni = await must<{ id: string }>(
    db.from('universities').insert({ name: `جامعة الجولة ${prefix}`, transport_prefix: prefix, week_start_dow: 6 }).select('id').single(),
    'university',
  );
  await must(db.from('settings').insert({ university_id: uni.id, scan_cooldown_minutes: 0, require_supervisor_geo: true }), 'settings');
  const [college] = await must<{ id: string }[]>(db.from('colleges').insert(COLLEGES.map((name) => ({ university_id: uni.id, name }))).select('id'), 'colleges');
  await must(db.from('areas').insert(AREAS.map((name) => ({ university_id: uni.id, name }))), 'areas');
  const today = damascusDate();
  const pkg = await must<{ id: string }>(
    db.from('packages').insert({ university_id: uni.id, name: '5 أيام أسبوعياً', trips_per_week: 5, semester_start: today, semester_end: '2099-12-31' }).select('id').single(),
    'package',
  );
  const supervisorCode = `${prefix}-SUP`;
  await provisionStaff(db, cfg, { login_code: supervisorCode, full_name: 'باسل المشرف', university_id: uni.id, password: TOUR_PASSWORD, role: 'supervisor', must_change_password: false });

  const student = async (name: string, trips: number, photo: boolean) => {
    const res = await provisionStudent(db, cfg, uni.id, {
      full_name: name,
      university_student_no: String(Math.floor(Math.random() * 1e9)),
      phone_e164: '+963944123456',
      college_id: college!.id,
      residence_text: null,
      area_primary_id: null,
      area_secondary_id: null,
      area_other_text: null,
      work_days: [1, 2, 3, 4, 5, 6, 7],
      shift_start: '08:00',
    }, null);
    if (!res.ok) throw new Error(res.detail);
    const sub = await must<{ id: string }>(
      db.from('subscriptions').insert({ student_id: res.studentId, package_id: pkg.id, trips_per_week: 5, starts_on: today, ends_on: '2099-12-31' }).select('id').single(),
      'subscription',
    );
    if (trips !== 5) {
      await must(db.from('subscription_adjustments').insert({ subscription_id: sub.id, week_start: weekStart(today, 6), delta_trips: trips - 5, reason: 'جولة' }), 'adjustment');
    }
    if (photo) {
      const jpg = await sharp({ create: { width: 600, height: 600, channels: 3, background: '#35606B' } })
        .composite([{ input: Buffer.from('<svg width="600" height="600"><circle cx="300" cy="250" r="120" fill="#E8C4A0"/><ellipse cx="300" cy="560" rx="210" ry="170" fill="#E3E6EA"/></svg>') }])
        .jpeg()
        .toBuffer();
      const path = `${uni.id}/${res.studentId}.jpg`;
      await must(db.storage.from('student-photos').upload(path, jpg, { contentType: 'image/jpeg', upsert: true }), 'photo');
      await must(db.from('students').update({ photo_path: path, photo_uploaded_at: new Date().toISOString() }).eq('id', res.studentId), 'photo path');
    }
    return res.transportNumber;
  };
  const fresh = await student('ليلى سمير الحلبي', 5, false);
  const scanner = await student('يوسف محمد الخطيب', 5, true);
  const empty = await student('رهف عادل النجار', 0, true);
  return { universityId: uni.id, supervisorCode, fresh, scanner, empty };
}

async function teardown(tour: Tour | null) {
  if (!tour) return;
  const profiles = await must<{ id: string }[]>(db.from('profiles').select('id').eq('university_id', tour.universityId), 'profiles');
  for (const p of profiles) await db.auth.admin.deleteUser(p.id);
  await db.from('audit_log').delete().eq('university_id', tour.universityId);
  await db.from('universities').delete().eq('id', tour.universityId);
}

async function newContext(browser: Browser, viewport = VIEWPORT): Promise<BrowserContext> {
  return browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    isMobile: viewport.width < 600,
    hasTouch: viewport.width < 600,
    locale: 'ar-SY',
    timezoneId: 'Asia/Damascus',
    permissions: ['geolocation', 'camera'],
    geolocation: { latitude: 36.2021, longitude: 37.1343, accuracy: 10 },
    serviceWorkers: 'block',
    baseURL: state!.appUrl,
  });
}

async function login(page: Page, code: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('رقم النقل (أو رقم المشرف)').fill(code);
  await page.getByLabel('كلمة المرور', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'دخول' }).click();
}

async function shot(page: Page, name: string, fullPage = false) {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(700);
  await page.screenshot({ path: resolve(OUT, `${name}.png`), fullPage });
  console.log(`✓ screenshots/${name}.png`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const channel = process.env.PW_CHANNEL === 'chromium' ? undefined : (process.env.PW_CHANNEL ?? 'msedge');
  const browser = await chromium.launch({
    channel,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  let tour: Tour | null = null;
  try {
    tour = await setupTour();
    const demo = await must<{ id: string }>(db.from('universities').select('id').eq('transport_prefix', DEMO_UNIVERSITY.transport_prefix).single(), 'demo university');

    // Student first login → password change → photo
    let ctx = await newContext(browser);
    let page = await ctx.newPage();
    await page.goto('/login');
    await shot(page, '01-login');
    await login(page, tour.fresh, tour.fresh);
    await page.waitForURL(/\/password$/);
    await page.getByLabel('كلمة المرور الجديدة').fill('Somar@2026');
    await page.getByLabel('تأكيد كلمة المرور').fill('Somar@2026');
    await shot(page, '02-forced-password-change');
    await page.getByRole('button', { name: 'تغيير كلمة المرور' }).click();
    await page.waitForURL(/\/login$/);
    await login(page, tour.fresh, 'Somar@2026');
    await page.waitForURL(/\/photo$/);
    const jpg = await sharp({ create: { width: 800, height: 1000, channels: 3, background: '#6B4E71' } }).jpeg().toBuffer();
    await page.getByTestId('photo-file-input').setInputFiles({ name: 'me.jpg', mimeType: 'image/jpeg', buffer: jpg });
    await shot(page, '03-photo-upload');
    await ctx.close();

    // Demo student
    ctx = await newContext(browser);
    page = await ctx.newPage();
    await login(page, 'SHB-0001', DEMO_PASSWORD);
    await page.getByTestId('remaining').waitFor();
    await shot(page, '04-student-home');
    await page.goto('/trips');
    await shot(page, '05-trips');
    await page.goto('/routes');
    await shot(page, '06-routes');
    await ctx.close();

    // Supervisor scanning
    ctx = await newContext(browser);
    page = await ctx.newPage();
    await login(page, tour.supervisorCode, TOUR_PASSWORD);
    await page.waitForURL(/\/scan$/);
    await page.getByText('تم تحديد الموقع').waitFor();
    await page.getByRole('button', { name: 'بدء المسح' }).click();
    await page.waitForTimeout(2500);
    await shot(page, '07-scan-camera');
    await page.getByRole('button', { name: 'إيقاف الكاميرا' }).click();
    const manual = async (code: string) => {
      await page.getByTestId('manual-input').fill(code);
      await page.getByTestId('manual-submit').click();
      await page.getByTestId('scan-result').waitFor();
      await page.getByText('جارٍ التحقق…').waitFor({ state: 'detached' }).catch(() => undefined);
      await page
        .waitForFunction(() => { const img = document.querySelector('img[data-testid="scan-photo"]') as HTMLImageElement | null; return !img || (img.complete && img.naturalWidth > 0); }, null, { timeout: 15_000 })
        .catch(() => undefined);
      await page.waitForTimeout(500);
    };
    await manual(tour.scanner);
    await shot(page, '08-scan-success-outbound');
    await page.getByTestId('scan-close').click();
    await manual(tour.scanner);
    await shot(page, '09-scan-success-return');
    await page.getByTestId('scan-close').click();
    await manual(tour.empty);
    await shot(page, '10-scan-rejected-no-balance');
    await ctx.close();

    // Admin
    ctx = await newContext(browser);
    page = await ctx.newPage();
    await login(page, 'ADMIN', REVIEW_ADMIN_PASSWORD);
    await page.waitForURL(/\/admin$/);
    await page.getByRole('combobox', { name: 'الجامعة' }).filter({ visible: true }).first().selectOption(demo.id);
    await shot(page, '11-admin-dashboard');
    await page.goto('/admin/students');
    await shot(page, '12-admin-students');
    await page.goto('/admin/import');
    await page.getByTestId('import-file').setInputFiles(IMPORT_FILE);
    await page.getByTestId('import-analyze').click();
    await page.getByTestId('import-preview').click();
    await page.getByTestId('count-total').waitFor();
    await shot(page, '13-import-preview');
    await page.goto('/admin/scans');
    await shot(page, '14-scans-log');
    await page.goto('/admin/settings');
    await shot(page, '15-settings');
    await ctx.close();

    // Print sheet at a wider viewport so a whole A4 page fits
    ctx = await newContext(browser, { width: 820, height: 1180 });
    page = await ctx.newPage();
    await login(page, 'ADMIN', REVIEW_ADMIN_PASSWORD);
    await page.waitForURL(/\/admin$/);
    await page.goto(`/admin/cards?university=${demo.id}`);
    await page.getByTestId('print-sheet').first().waitFor({ timeout: 60_000 });
    await page.emulateMedia({ media: 'print' });
    await page.getByTestId('print-sheet').first().screenshot({ path: resolve(OUT, '16-print-cards-a4.png') });
    console.log('✓ screenshots/16-print-cards-a4.png');
    await ctx.close();

    writeFileSync(resolve(OUT, 'README.md'), README);
  } finally {
    await teardown(tour);
    await browser.close();
  }
}

const README = `# لقطات جولة النظام

التُقطت هذه الصور تلقائياً بالأمر \`npm run tour\` على بيئة المراجعة المحلية (\`npm run review\`) بحجم شاشة موبايل 390×844.

| الملف | ماذا تُظهر |
|---|---|
| 01-login.png | شاشة تسجيل الدخول برقم النقل وكلمة المرور |
| 02-forced-password-change.png | تغيير كلمة المرور الإجباري عند أول دخول مع شروط كلمة المرور |
| 03-photo-upload.png | رفع الصورة الشخصية الإجباري (لا يمكن تغييرها لاحقاً إلا من الإدارة) |
| 04-student-home.png | الرئيسية للطالب: رقم النقل، رمز QR، الرحلات المتبقية هذا الأسبوع |
| 05-trips.png | رحلاتي: السجل مجمّعاً حسب اليوم مع شارات ذهاب/عودة |
| 06-routes.png | الخطوط ونقاط الوقوف مع المواعيد |
| 07-scan-camera.png | شاشة الكاميرا عند المشرف مع إطار المسح |
| 08-scan-success-outbound.png | مسح ناجح «ذهاب»: الصورة والاسم والرصيد بعد الخصم |
| 09-scan-success-return.png | المسح الثاني في نفس اليوم «عودة» والرصيد لم يتغير |
| 10-scan-rejected-no-balance.png | رفض المسح بسبب عدم وجود رصيد |
| 11-admin-dashboard.png | لوحة التحكم ومؤشراتها ومخطط آخر 7 أيام |
| 12-admin-students.png | جدول الطلاب مع الفلاتر (يتحول إلى بطاقات على الموبايل) |
| 13-import-preview.png | معاينة استيراد ملف Excel مع العدادات وأسباب الرفض |
| 14-scans-log.png | سجل المسح مع الفلاتر والموقع وإمكانية الإلغاء |
| 15-settings.png | الإعدادات ومنها «السماح للمشرف بتجاوز أيام الدوام» |
| 16-print-cards-a4.png | صفحة A4 من بطاقات النقل (10 بطاقات) كما تُطبع |

الشاشات 01–03 و07–10 استخدمت جامعة مؤقتة تُحذف تلقائياً بعد الجولة، فلا تتغير البيانات التجريبية.
`;

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
