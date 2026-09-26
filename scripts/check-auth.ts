/**
 * Gate 4 check: `npm run check:auth [-- --env .env.production]`
 * GoTrue settings + a synthetic-email probe account (created with the admin API, signed in, always deleted).
 */
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { loadProdEnv, Report, type ProdEnv } from './prod-env.js';

const opts = {
  auth: { persistSession: false, autoRefreshToken: false },
};

export async function authSettings(env: ProdEnv) {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: env.SUPABASE_ANON_KEY ?? '' } });
  return (await res.json()) as { disable_signup?: boolean; mailer_autoconfirm?: boolean; external?: { email?: boolean; phone?: boolean } };
}

/** Creates probe@domain via the admin API, signs in with it, deletes it. Returns null on success or the error text. */
export async function syntheticEmailProbe(env: ProdEnv, domain: string): Promise<string | null> {
  const admin = createClient(env.SUPABASE_URL as string, env.SUPABASE_SERVICE_ROLE_KEY as string, opts);
  const anon = createClient(env.SUPABASE_URL as string, env.SUPABASE_ANON_KEY as string, opts);
  const email = `probe-${randomBytes(4).toString('hex')}@${domain}`;
  const password = `Pr0be!${randomBytes(6).toString('hex')}`;
  let userId: string | null = null;
  try {
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) return created.error?.message ?? 'createUser failed';
    userId = created.data.user.id;
    const signed = await anon.auth.signInWithPassword({ email, password });
    if (signed.error) return signed.error.message;
    await anon.auth.signOut();
    return null;
  } catch (err) {
    return (err as Error).message;
  } finally {
    if (userId) await admin.auth.admin.deleteUser(userId);
  }
}

export async function checkAuth(env: ProdEnv, r: Report) {
  const s = await authSettings(env);
  r.add('signup', 'التسجيل الذاتي مغلق', s.disable_signup === true ? 'PASS' : 'FAIL', `disable_signup=${s.disable_signup}`, 'ضع DISABLE_SIGNUP=true (أو GOTRUE_DISABLE_SIGNUP=true) في خدمة Supabase ثم Restart');
  r.add('email', 'الدخول بالبريد مفعّل', s.external?.email === true ? 'PASS' : 'FAIL', `email=${s.external?.email}`, 'ضع ENABLE_EMAIL_SIGNUP=true ثم Restart');
  r.add('autoconfirm', 'التأكيد التلقائي للبريد', s.mailer_autoconfirm === true ? 'PASS' : 'WARN', `mailer_autoconfirm=${s.mailer_autoconfirm}`, 'ضع ENABLE_EMAIL_AUTOCONFIRM=true ثم Restart (شبكة أمان؛ الكود يؤكد البريد عند الإنشاء)');
  r.add('phone', 'الدخول بالهاتف مغلق', s.external?.phone === false ? 'PASS' : 'WARN', `phone=${s.external?.phone}`, 'ضع ENABLE_PHONE_SIGNUP=false ثم Restart');

  const domain = env.SUPABASE_STUDENT_EMAIL_DOMAIN || 'somar.local';
  const err = await syntheticEmailProbe(env, domain);
  if (!err) {
    r.add('probe', `حساب تجريبي بنطاق ${domain}`, 'PASS', 'إنشاء ← دخول ← حذف');
    return { domain };
  }
  r.add('probe', `حساب تجريبي بنطاق ${domain}`, 'FAIL', err);
  const app = env.APP_BASE_URL ? new URL(env.APP_BASE_URL).hostname : '';
  if (!app) return { domain: null };
  const fallback = `students.${app}`;
  const err2 = await syntheticEmailProbe(env, fallback);
  r.add('probe-fallback', `حساب تجريبي بنطاق ${fallback}`, err2 ? 'FAIL' : 'PASS', err2 ?? 'إنشاء ← دخول ← حذف', 'راجع إعدادات GoTrue');
  return { domain: err2 ? null : fallback };
}

if (process.argv[1]?.endsWith('check-auth.ts')) {
  const env = loadProdEnv();
  const r = new Report();
  const { domain } = await checkAuth(env, r);
  if (domain && domain !== (env.SUPABASE_STUDENT_EMAIL_DOMAIN || 'somar.local')) {
    console.log(`\nيجب تغيير SUPABASE_STUDENT_EMAIL_DOMAIN و VITE_STUDENT_EMAIL_DOMAIN إلى ${domain}`);
  }
  console.log(r.failed ? `\n${r.failed} فحص فشل.` : '\nكل الفحوص نجحت.');
  process.exitCode = r.failed ? 1 : 0;
}
