import { expect, test, type Page } from '@playwright/test';
import { IMPORT_EXPECTED, IMPORT_FILE } from '../../supabase/seed/generate-import.js';
import {
  ADMIN_CODE,
  ADMIN_PASSWORD,
  createE2EStudent,
  createE2EUniversity,
  demoUniversityId,
  jpegFile,
  service,
  STAFF_PASSWORD,
  freezeClock,
  type E2EUniversity,
} from './fixtures.js';

let uni: E2EUniversity;

test.beforeAll(async () => {
  uni = await createE2EUniversity();
});

/**
 * Service workers are blocked in these runs, so web push is simulated: by default the device
 * already has a subscription (every user must have one to get past the mandatory gate).
 * Setting `window.__E2E_PUSH_OFF` before load starts the device without one.
 */
function fakePush() {
  const w = window as unknown as { __E2E_PUSH_OFF?: boolean };
  let subscribed: boolean | null = null;
  const on = () => subscribed ?? !w.__E2E_PUSH_OFF;
  const sub = {
    endpoint: 'https://push.e2e.invalid/device',
    toJSON: () => ({ endpoint: 'https://push.e2e.invalid/device', keys: { p256dh: 'e2e', auth: 'e2e' } }),
    unsubscribe: async () => true,
  };
  const pushManager = {
    getSubscription: async () => (on() ? sub : null),
    subscribe: async () => {
      subscribed = true;
      return sub;
    },
  };
  const reg = { scope: '/', pushManager };
  const sw = navigator.serviceWorker as unknown as Record<string, unknown>;
  Object.defineProperty(sw, 'ready', { get: () => Promise.resolve(reg) });
  sw.getRegistration = async () => reg;
  sw.register = async () => reg;
  Object.defineProperty(Notification, 'permission', { get: () => (on() ? 'granted' : 'default') });
  Notification.requestPermission = async () => 'granted';
}

test.beforeEach(async ({ context }) => {
  await context.addInitScript(fakePush);
  await context.route('**/api/push/subscribe', (route) => route.fulfill({ json: { ok: true, enabled: true } }));
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
  // the list closes after a choice and the field shows the chosen area
  await expect(page.getByTestId('setup-area-options')).toHaveCount(0);
  await expect(page.getByTestId('setup-area-search')).toHaveValue('الرجاء');
  // nothing overflows sideways on a narrow phone
  await page.setViewportSize({ width: 360, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
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

test('6. student routes: outbound above return; a stop opens with the stored Google Maps link', async ({ page }) => {
  const st = await createE2EStudent(uni, { subscribe: true, photo: true, ready: true });
  const { data: ret } = await service
    .from('routes')
    .insert({ university_id: uni.id, name: 'خط العودة للواجهة', direction: 'return', departure_time: '14:00' })
    .select('id')
    .single();
  await login(page, st.transportNumber, STAFF_PASSWORD);
  await expect(page).toHaveURL(/\/$/);
  await page.getByRole('link', { name: 'الخطوط' }).click();
  // outbound routes are listed first, return routes below them
  const outbound = page.getByTestId('routes-outbound');
  const back = page.getByTestId('routes-return');
  await expect(outbound).toContainText('خط الواجهة');
  await expect(back).toContainText('خط العودة للواجهة');
  await expect(outbound).not.toContainText('خط العودة للواجهة');
  const [top, bottom] = await Promise.all([outbound.boundingBox(), back.boundingBox()]);
  expect((top?.y ?? 0) < (bottom?.y ?? 0)).toBe(true);
  await outbound.getByTestId('route-toggle').first().click();
  await page.getByTestId('stop-button').first().click();
  const link = page.getByTestId('maps-link');
  await expect(link).toHaveText(/الاتجاهات على خرائط غوغل/);
  await expect(link).toHaveAttribute('href', uni.stopUrl);
  await service.from('routes').delete().eq('id', ret?.id as string);
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
  await visit(['/', '/trips', '/packages', '/routes', '/notifications', '/account', '/password', '/pickup']);
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
    '/admin/pickups',
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

test('10. notifications are mandatory: the app stays behind the gate until they are enabled', async ({ page }) => {
  const st = await createE2EStudent(uni, { subscribe: true, photo: true, ready: true });
  await page.addInitScript(() => {
    (window as unknown as { __E2E_PUSH_OFF?: boolean }).__E2E_PUSH_OFF = true;
  });
  await login(page, st.transportNumber, STAFF_PASSWORD);
  await expect(page.getByTestId('push-gate')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'فعّل الإشعارات للمتابعة' })).toBeVisible();
  await page.goto('/trips');
  await expect(page.getByTestId('push-gate')).toBeVisible();
  await page.getByTestId('push-enable').click();
  await expect(page.getByTestId('push-gate')).toHaveCount(0);
  await expect(page.getByTestId('credit-footer')).toBeVisible();
});

test('11. one tap on «تنزيل التطبيق» opens the browser install dialog', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByTestId('install-app')).toHaveCount(0);
  await page.evaluate(() => {
    const e = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      prompt: async () => {
        (window as unknown as { __prompted?: boolean }).__prompted = true;
      },
      userChoice: Promise.resolve({ outcome: 'accepted' }),
    });
    window.dispatchEvent(e);
  });
  await page.getByTestId('install-app').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __prompted?: boolean }).__prompted)).toBe(true);
  await expect(page.getByTestId('install-app')).toHaveCount(0);
});

test('12. the weekly schedule is edited only by the admin; the student has no way to change it', async ({ page }) => {
  const st = await createE2EStudent(uni, { subscribe: true, photo: true, ready: true });
  await login(page, st.transportNumber, STAFF_PASSWORD);
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/account');
  await expect(page.getByRole('link', { name: 'مكان السكن وجدول الدوام' })).toHaveCount(0);
  await page.goto('/schedule');
  await expect(page.getByText('الصفحة غير موجودة')).toBeVisible();

  await page.context().clearCookies();
  await page.evaluate(() => localStorage.clear());
  await login(page, ADMIN_CODE, ADMIN_PASSWORD);
  await expect(page).toHaveURL(/\/admin$/);
  await pickUniversity(page, uni.id);
  await page.goto(`/admin/students/${st.id}`);
  await page.getByTestId('edit-schedule').click();
  for (const dow of [1, 2, 3, 4, 5, 6, 7]) await page.getByTestId(`day-${dow}`).setChecked(dow === 2);
  await page.getByTestId('out-2').fill('09:00');
  await page.getByTestId('ret-2').fill('08:00');
  await page.getByTestId('schedule-save').click();
  await expect(page.getByRole('alert').filter({ hasText: 'وقت العودة يجب أن يكون بعد وقت الذهاب' })).toBeVisible();
  await page.getByTestId('ret-2').fill('15:30');
  await page.getByTestId('schedule-save').click();
  const card = page.getByTestId('student-schedule');
  await expect(card.getByRole('listitem')).toHaveCount(1);
  await expect(card).toContainText('الثلاثاء');
  await expect(card).toContainText('15:30');
});

test('13. the student sees the card on the new design and downloads it as an image', async ({ page }) => {
  const st = await createE2EStudent(uni, { subscribe: true, photo: true, ready: true });
  await login(page, st.transportNumber, STAFF_PASSWORD);
  await expect(page).toHaveURL(/\/$/);
  await page.getByTestId('my-card').click();
  const card = page.getByRole('dialog').getByTestId('transport-card');
  await expect(card).toContainText(st.transportNumber);
  await expect(card).toContainText(st.name);
  await expect(card.locator('svg[data-payload]')).toHaveAttribute('data-payload', `SMR:${st.qrToken}`);
  await expect(card.getByTestId('card-photo')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
  await expect(card.locator('img').first()).toHaveJSProperty('complete', true);
  expect(await card.locator('img').first().evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1034);

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download-card').click()]);
  expect(download.suggestedFilename()).toBe(`بطاقة-النقل-${st.transportNumber}.png`);
  const path = await download.path();
  const { default: sharp } = await import('sharp');
  const meta = await sharp(path).metadata();
  expect([meta.format, meta.width, meta.height]).toEqual(['png', 2068, 1304]);
});

test('14. admin schedules a weekly notification for several days at a set time, and can pause it', async ({ page }) => {
  await login(page, ADMIN_CODE, ADMIN_PASSWORD);
  await expect(page).toHaveURL(/\/admin$/);
  await pickUniversity(page, uni.id);
  await page.goto('/admin/notifications');
  await page.getByTestId('recurring-add').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('العنوان').fill('تذكير اختيار المكان');
  await dialog.getByLabel('نص الإشعار').fill('اختر مكان انطلاقك لغد من التطبيق');
  await dialog.getByTestId('recurring-save').click();
  await expect(dialog.getByRole('alert')).toHaveText('اختر يوماً واحداً على الأقل');
  await dialog.getByText('الاثنين', { exact: true }).click();
  await dialog.getByText('الأربعاء', { exact: true }).click();
  await dialog.getByTestId('recurring-time').fill('18:00');
  await dialog.getByTestId('recurring-save').click();
  const list = page.getByTestId('recurring-list');
  await expect(list).toContainText('تذكير اختيار المكان');
  await expect(list).toContainText('كل الاثنين، الأربعاء الساعة 18:00');
  await list.getByRole('switch').click();
  await expect(list).toContainText('متوقف');
});

test('15. tomorrow pickup: window from the settings, one locked choice of stop + return time + drop-off, admin sees both', async ({ page }) => {
  const st = await createE2EStudent(uni, { subscribe: true, photo: true, ready: true });
  const { data: ret } = await service
    .from('routes')
    .insert({ university_id: uni.id, name: 'عودة الواجهة', direction: 'return', departure_time: '14:00' })
    .select('id')
    .single();
  await service.from('settings').update({ pickup_open_time: '18:30', pickup_close_time: '22:00' }).eq('university_id', uni.id);
  try {
    await freezeClock('2026-10-05 18:00');
    await login(page, st.transportNumber, STAFF_PASSWORD);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId('pickup-home')).toContainText('يفتح الاختيار كل يوم من الساعة 18:30 حتى الساعة 22:00');
    await page.getByTestId('pickup-home').click();
    await expect(page.getByTestId('pickup-closed')).toBeVisible();

    await freezeClock('2026-10-05 19:00');
    await page.reload();
    await expect(page.getByTestId('pickup-open')).toBeVisible();
    await expect(page.getByText('ليوم الثلاثاء', { exact: false })).toBeVisible();
    await page.getByTestId('pickup-save').click();
    await expect(page.getByRole('alert')).toHaveText('اختر مكان الذهاب ووقت العودة ومكان النزول');
    await page.getByTestId('pickup-stop-search').fill('ساحة');
    await page.getByTestId('pickup-stop-options').getByText('ساحة جامعة', { exact: true }).click();
    await page.getByTestId('pickup-return-times').getByRole('radio', { name: '14:00' }).click();
    await page.getByTestId('pickup-return-stop-search').fill('رجاء');
    await page.getByTestId('pickup-return-stop-options').getByText('الرجاء', { exact: true }).click();
    await page.getByTestId('pickup-save').click();
    await page.getByRole('dialog').getByRole('button', { name: 'تأكيد' }).click();
    const locked = page.getByTestId('pickup-locked');
    await expect(locked.getByTestId('pickup-current')).toHaveText('ساحة جامعة');
    await expect(locked.getByTestId('pickup-current-return')).toHaveText('الرجاء — الساعة 14:00');
    await expect(page.getByTestId('pickup-save')).toHaveCount(0);

    await page.context().clearCookies();
    await page.evaluate(() => localStorage.clear());
    await login(page, ADMIN_CODE, ADMIN_PASSWORD);
    await expect(page).toHaveURL(/\/admin$/);
    await pickUniversity(page, uni.id);
    await page.goto('/admin/pickups');
    await expect(page.getByTestId('pickup-summary')).toContainText('اختار 1 من أصل');
    const areas = page.getByTestId('pickup-areas');
    await expect(areas).toContainText('بدون منطقة');
    await areas.getByTestId('pickup-stop-row').filter({ hasText: 'ساحة جامعة' }).click();
    await expect(areas).toContainText(st.transportNumber);
    const returns = page.getByTestId('pickup-returns');
    await expect(returns).toContainText('عودة الساعة 14:00');
    await expect(returns).toContainText('الرجاء');

    // the window times are edited in the settings
    await page.goto('/admin/settings');
    await page.getByLabel('نطاق الإعدادات').selectOption('university');
    await expect(page.getByTestId('pickup_open_time')).toHaveValue('18:30');
    await page.getByTestId('pickup_open_time').fill('17:00');
    await page.getByTestId('pickup_close_time').fill('16:00');
    await page.getByRole('button', { name: 'حفظ' }).click();
    await expect(page.getByText('ساعة الإغلاق يجب أن تكون بعد ساعة الفتح')).toBeVisible();
    await page.getByTestId('pickup_close_time').fill('23:00');
    await page.getByRole('button', { name: 'حفظ' }).click();
    await expect(page.getByText('تم حفظ الإعدادات')).toBeVisible();
    const { data: saved } = await service.from('settings').select('pickup_open_time, pickup_close_time').eq('university_id', uni.id).single();
    expect(saved).toEqual({ pickup_open_time: '17:00:00', pickup_close_time: '23:00:00' });
  } finally {
    await freezeClock(null);
    await service.from('pickup_choices').delete().eq('student_id', st.id);
    await service.from('routes').delete().eq('id', ret?.id as string);
  }
});
