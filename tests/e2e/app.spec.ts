import { expect, test, type Page } from '@playwright/test';
import { IMPORT_EXPECTED, IMPORT_FILE } from '../../supabase/seed/generate-import.js';
import {
  ADMIN_CODE,
  ADMIN_PASSWORD,
  createE2EStudent,
  createE2EUniversity,
  demoUniversityId,
  jpegFile,
  STAFF_PASSWORD,
  type E2EUniversity,
} from './fixtures.js';

let uni: E2EUniversity;

test.beforeAll(async () => {
  uni = await createE2EUniversity();
});

async function login(page: Page, code: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('رقم النقل (أو رقم المشرف)').fill(code);
  await page.getByLabel('كلمة المرور', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'دخول' }).click();
}

async function pickUniversity(page: Page, id: string) {
  const picker = page.getByRole('combobox', { name: 'الجامعة' }).filter({ visible: true }).first();
  await picker.selectOption(id);
}

test('1. student first login → forced password change → sign-out → login → forced photo → dashboard', async ({ page }) => {
  const st = await createE2EStudent(uni, { subscribe: true });
  await login(page, st.transportNumber, st.transportNumber);

  await expect(page).toHaveURL(/\/password$/);
  await expect(page.getByRole('heading', { name: 'تغيير كلمة المرور' })).toBeVisible();
  const newPassword = 'Somar@2026x';
  await page.getByLabel('كلمة المرور الجديدة').fill(newPassword);
  await page.getByLabel('تأكيد كلمة المرور').fill(newPassword);
  await page.getByRole('button', { name: 'تغيير كلمة المرور' }).click();

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('status')).toContainText('يرجى تسجيل الدخول مجدداً');

  await login(page, st.transportNumber, newPassword);
  await expect(page).toHaveURL(/\/photo$/);
  await page.getByTestId('photo-file-input').setInputFiles({ name: 'me.jpg', mimeType: 'image/jpeg', buffer: await jpegFile() });
  await page.getByRole('button', { name: 'تأكيد ورفع الصورة' }).click();

  // first-login setup: area (searchable) + weekly departure/return times
  await expect(page).toHaveURL(/\/setup$/);
  await page.getByTestId('setup-area-search').fill('رجاء');
  await page.getByTestId('setup-area-options').getByText('الرجاء', { exact: true }).click();
  for (const dow of [1, 2, 3, 4, 5, 7]) await page.getByTestId(`day-${dow}`).uncheck();
  await page.getByTestId('day-6').check();
  await page.getByTestId('out-6').fill('07:30');
  await page.getByTestId('ret-6').fill('14:00');
  await page.getByTestId('setup-save').click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('transport-number')).toHaveText(st.transportNumber);
  await expect(page.getByTestId('remaining')).toContainText(String(uni.tripsPerWeek));
  await expect(page.getByTestId('remaining')).toContainText(`${uni.tripsPerWeek} من ${uni.tripsPerWeek}`);
});

test('2. supervisor manual scan: popup, X re-arms, second scan is a return with unchanged balance', async ({ page }) => {
  const st = await createE2EStudent(uni, { subscribe: true, photo: true, ready: true });
  await login(page, uni.supervisorCode, STAFF_PASSWORD);
  await expect(page).toHaveURL(/\/scan$/);
  await expect(page.getByText('تم تحديد الموقع')).toBeVisible();

  await page.getByTestId('manual-input').fill(st.transportNumber);
  await page.getByTestId('manual-submit').click();
  const popup = page.getByTestId('scan-result');
  await expect(popup.getByTestId('scan-name')).toHaveText(st.name);
  await expect(popup.getByTestId('scan-photo')).toBeVisible();
  await expect(popup.getByTestId('scan-direction')).toContainText('ذهاب');
  await expect(popup.getByTestId('scan-remaining')).toHaveText(String(uni.tripsPerWeek - 1));

  await popup.getByTestId('scan-close').click();
  await expect(popup).toBeHidden();
  await expect(page.getByTestId('manual-input')).toBeEnabled();

  await page.getByTestId('manual-input').fill(st.transportNumber);
  await page.getByTestId('manual-submit').click();
  await expect(popup.getByTestId('scan-direction')).toContainText('عودة');
  await expect(popup.getByTestId('scan-remaining')).toHaveText(String(uni.tripsPerWeek - 1));
  await popup.getByTestId('scan-close').click();
  await expect(page.getByTestId('my-scans').locator('li')).toHaveCount(2);
});

test('3. admin import wizard: preview counts, commit, export rejected rows, mapping banner', async ({ page }) => {
  await login(page, ADMIN_CODE, ADMIN_PASSWORD);
  await expect(page).toHaveURL(/\/admin$/);
  await pickUniversity(page, uni.id);
  await page.goto('/admin/import');
  await pickUniversity(page, uni.id);

  await page.getByTestId('import-file').setInputFiles(IMPORT_FILE);
  await page.getByTestId('import-analyze').click();
  await page.getByTestId('import-preview').click();
  await expect(page.getByTestId('count-total')).toHaveText(String(IMPORT_EXPECTED.total));
  await expect(page.getByTestId('count-created')).toHaveText(String(IMPORT_EXPECTED.created));
  await expect(page.getByTestId('count-duplicates')).toHaveText(String(IMPORT_EXPECTED.duplicates));
  await expect(page.getByTestId('count-rejected')).toHaveText(String(IMPORT_EXPECTED.rejected));

  await page.getByTestId('import-commit').click();
  await expect(page.getByText('اكتمل الاستيراد')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('count-created')).toHaveText(String(IMPORT_EXPECTED.created));
  await expect(page.getByTestId('mapping-banner')).toContainText(String(IMPORT_EXPECTED.needsAreaMapping));

  const download = page.waitForEvent('download');
  await page.getByTestId('export-rejected').click();
  expect((await download).suggestedFilename()).toMatch(/\.xlsx$/);
});

test('4. admin assigns a package, then adds 2 trips to all subscribers; the student quota changes', async ({ page }) => {
  const st = await createE2EStudent(uni, { photo: true });
  await login(page, ADMIN_CODE, ADMIN_PASSWORD);
  await expect(page).toHaveURL(/\/admin$/);
  await pickUniversity(page, uni.id);

  await page.goto(`/admin/students/${st.id}`);
  await page.getByTestId('assign-package').click();
  await page.getByTestId('assign-select').selectOption(uni.packageId);
  await page.getByTestId('assign-submit').click();
  await expect(page.getByTestId('detail-package')).toHaveText(uni.packageName);
  await expect(page.getByTestId('detail-quota-value')).toHaveText(String(uni.tripsPerWeek));

  await page.goto('/admin/packages');
  await pickUniversity(page, uni.id);
  await page.getByTestId(`bulk-${uni.packageId}`).filter({ visible: true }).first().click();
  await page.getByTestId('bulk-delta').fill('2');
  await page.getByTestId('bulk-next').click();
  await page.getByRole('button', { name: 'تأكيد' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'تمت إضافة التعديل' })).toBeVisible();

  await page.goto(`/admin/students/${st.id}`);
  await expect(page.getByTestId('detail-quota-value')).toHaveText(String(uni.tripsPerWeek + 2));
});

test('5. print view renders 10 cards per A4 sheet with a scannable QR payload', async ({ page }) => {
  const st = await createE2EStudent(uni, { subscribe: true, photo: true });
  const demo = await demoUniversityId();
  await login(page, ADMIN_CODE, ADMIN_PASSWORD);
  await expect(page).toHaveURL(/\/admin$/);

  await page.goto(`/admin/cards?university=${demo}`);
  const sheets = page.getByTestId('print-sheet');
  await expect(sheets.first()).toBeVisible({ timeout: 60_000 });
  await expect(sheets.first().getByTestId('transport-card')).toHaveCount(10);
  expect(await sheets.count()).toBeGreaterThanOrEqual(8);

  await page.goto(`/admin/cards?ids=${st.id}`);
  const card = page.getByTestId('transport-card');
  await expect(card).toHaveCount(1);
  await expect(card.locator('svg[data-payload]')).toHaveAttribute('data-payload', `SMR:${st.qrToken}`);
  await expect(card).toContainText(st.transportNumber);
  const box = await card.boundingBox();
  expect(Math.round(((box?.width ?? 0) / 96) * 25.4)).toBe(86);
  await expect(card.getByTestId('card-photo')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
});

test('6. a student opens a stop and the Google Maps link carries the stored URL', async ({ page }) => {
  const st = await createE2EStudent(uni, { subscribe: true, photo: true, ready: true });
  await login(page, st.transportNumber, STAFF_PASSWORD);
  await expect(page).toHaveURL(/\/$/);
  await page.getByRole('link', { name: 'الخطوط' }).click();
  await page.getByTestId('route-toggle').first().click();
  await page.getByTestId('stop-button').first().click();
  const link = page.getByTestId('maps-link');
  await expect(link).toHaveText(/الاتجاهات على خرائط غوغل/);
  await expect(link).toHaveAttribute('href', uni.stopUrl);
});

const CREDIT = 'This System is made by Trinode';

/** Latin words allowed in the UI: product/format names and data values (codes, numbers). */
const ALLOWED_LATIN = new Set(['QR', 'PDF', 'Excel', 'xlsx', 'JPEG', 'PNG', 'WEBP', 'iPhone', 'Safari', 'OpenStreetMap']);

async function englishWords(page: Page): Promise<string[]> {
  // The vendor credit is intentionally English (owner's request); every other word must be Arabic.
  const text = (await page.locator('body').innerText()).replaceAll(CREDIT, '');
  const words = text.match(/[A-Za-z][A-Za-z0-9-]*/g) ?? [];
  return [...new Set(words)].filter((w) => !ALLOWED_LATIN.has(w) && !/^[A-Z0-9]+(-[A-Z0-9]+)*$/.test(w));
}

test('7. no English text is visible on the main screens of every role', async ({ page }) => {
  const st = await createE2EStudent(uni, { subscribe: true, photo: true, ready: true });
  const offenders: string[] = [];
  const visit = async (paths: string[]) => {
    for (const path of paths) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(500);
      for (const w of await englishWords(page)) offenders.push(`${path}: ${w}`);
    }
  };
  await page.goto('/login');
  for (const w of await englishWords(page)) offenders.push(`/login: ${w}`);

  await login(page, st.transportNumber, STAFF_PASSWORD);
  await expect(page).toHaveURL(/\/$/);
  await visit(['/', '/trips', '/packages', '/routes', '/notifications', '/account', '/password', '/schedule']);
  await page.context().clearCookies();
  await page.evaluate(() => localStorage.clear());

  await login(page, uni.supervisorCode, STAFF_PASSWORD);
  await expect(page).toHaveURL(/\/scan$/);
  await visit(['/scan']);
  await page.evaluate(() => localStorage.clear());

  await login(page, ADMIN_CODE, ADMIN_PASSWORD);
  await expect(page).toHaveURL(/\/admin$/);
  await visit([
    '/admin',
    '/admin/universities',
    '/admin/colleges',
    '/admin/areas',
    '/admin/areas/mapping',
    '/admin/packages',
    '/admin/routes',
    '/admin/students',
    `/admin/students/${st.id}`,
    '/admin/students/new',
    '/admin/import',
    '/admin/supervisors',
    '/admin/scans',
    '/admin/notifications',
    '/admin/settings',
    '/admin/audit',
    '/admin/stats',
    '/admin/stops',
    `/admin/cards?ids=${st.id}`,
  ]);
  expect(offenders).toEqual([]);
});

test('8. admin saves a stop once in the library and adds it to a route from the dropdown', async ({ page }) => {
  await login(page, ADMIN_CODE, ADMIN_PASSWORD);
  await expect(page).toHaveURL(/\/admin$/);
  await pickUniversity(page, uni.id);
  await page.goto('/admin/stops');
  await pickUniversity(page, uni.id);
  await page.getByTestId('stop-add').click();
  await page.getByTestId('stop-name').fill('جسر الحج');
  await page.getByTestId('stop-url').fill('https://www.google.com/maps/@36.1893,37.1561,17z');
  await page.getByTestId('stop-save').click();
  await expect(page.getByText('جسر الحج').filter({ visible: true }).first()).toBeVisible();

  await page.goto('/admin/routes');
  await pickUniversity(page, uni.id);
  await page.getByTestId('route-toggle').first().click();
  await page.getByRole('button', { name: 'إضافة نقطة وقوف' }).first().click();
  const options = page.getByTestId('stop-options');
  await expect(options.getByText('ساحة جامعة')).toHaveCount(0);
  await page.getByTestId('stop-search').fill('جسر');
  await expect(options.getByRole('option')).toHaveCount(1);
  await options.getByText('جسر الحج').click();
  await page.getByLabel('موعد الانطلاق').last().fill('07:25');
  await page.getByTestId('route-stop-save').click();
  await expect(page.getByText('جسر الحج').filter({ visible: true }).first()).toBeVisible();

  // duplicate the route: the copy opens for editing and keeps the stops
  await page.getByRole('button', { name: 'نسخ الخط' }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'حفظ' }).click();
  await expect(page.getByText('خط الواجهة (نسخة)').first()).toBeVisible();

  // copy a stop to another route: a route that already has it is disabled
  await page.getByTestId('copy-stop').first().click();
  const targets = page.getByTestId('copy-targets');
  // the original and its copy hold the same stops, so the other route is listed but disabled
  await expect(targets.getByRole('button')).toHaveCount(1);
  await expect(targets.getByRole('button')).toBeDisabled();
  await expect(targets).toContainText('موجودة في هذا الخط');
});

test('9. adding a university is locked with an upgrade message; the credit footer is on every screen', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByTestId('credit-footer')).toHaveText(CREDIT);
  await login(page, ADMIN_CODE, ADMIN_PASSWORD);
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByTestId('credit-footer')).toHaveText(CREDIT);
  await page.goto('/admin/universities');
  await page.getByTestId('add-university-locked').click();
  await expect(page.getByTestId('locked-message')).toHaveText('رقّي باقتك مع أحمد سباغ لتفتحلك');
  await expect(page.getByLabel('اسم الجامعة')).toHaveCount(0);
});
