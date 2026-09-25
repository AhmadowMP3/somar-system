/**
 * `npm run review` — brings up the full local stack (docker-compose.yml) on free ports, applies the
 * migrations, creates a local admin, loads the demo data and waits until /api/healthz reports db: up.
 * Idempotent: re-running reuses the same ports and never duplicates demo data.
 * `npm run review -- --rebuild` rebuilds the app image after code changes (data is kept).
 * `npm run review -- --stop` (npm run review:stop) stops it; add `--wipe` to also delete its data volumes.
 */
import {
  composeEnv,
  DEMO_PASSWORD,
  DEMO_SERVICE_KEY,
  PROJECT,
  range,
  readState,
  REVIEW_ADMIN_PASSWORD,
  pickPort,
  run,
  waitFor,
  writeState,
  type ReviewState,
} from './review-lib.js';

const args = process.argv.slice(2);

async function stop() {
  const state = readState();
  const env = state ? composeEnv(state) : {};
  const wipe = args.includes('--wipe');
  await run('docker', ['compose', '-p', PROJECT, 'down', ...(wipe ? ['-v'] : [])], env);
  console.log(wipe ? 'تم إيقاف بيئة المراجعة وحذف بياناتها.' : 'تم إيقاف بيئة المراجعة (البيانات محفوظة للمرة القادمة).');
}

async function healthy(url: string): Promise<boolean> {
  const res = await fetch(`${url}/api/healthz`);
  if (!res.ok) return false;
  const body = (await res.json()) as { db?: string };
  return body.db === 'up';
}

async function start() {
  const previous = readState();
  const running = previous ? await healthy(previous.appUrl).catch(() => false) : false;
  let state: ReviewState;
  if (previous && running && !args.includes('--rebuild')) {
    state = previous;
    console.log(`بيئة المراجعة تعمل مسبقاً على ${state.appUrl}`);
  } else if (previous && running) {
    state = previous;
    console.log('إعادة بناء التطبيق بعد تعديل الكود (البيانات محفوظة)…');
    await run('docker', ['compose', '-p', PROJECT, 'up', '-d', '--build'], composeEnv(state));
  } else {
    const taken = new Set<number>();
    const reuse = async (port: number | undefined, fallback: number[]) => {
      const candidates = port ? [port, ...fallback] : fallback;
      const chosen = await pickPort(candidates, taken);
      taken.add(chosen);
      return chosen;
    };
    const appPort = await reuse(previous?.appPort, [8080, ...range(8787, 20)]);
    const kongPort = await reuse(previous?.kongPort, range(8000, 20));
    const dbPort = await reuse(previous?.dbPort, [54322, ...range(55432, 20)]);
    state = {
      appPort,
      kongPort,
      dbPort,
      appUrl: `http://localhost:${appPort}`,
      supabaseUrl: `http://localhost:${kongPort}`,
    };
    writeState(state);
    console.log(`المنافذ: التطبيق ${appPort} · Supabase ${kongPort} · قاعدة البيانات ${dbPort}`);
    console.log('تشغيل الحاويات (أول مرة قد تستغرق عدة دقائق)…');
    await run('docker', ['compose', '-p', PROJECT, 'up', '-d', '--build'], composeEnv(state));
  }

  console.log('انتظار جاهزية قاعدة البيانات والتطبيق…');
  await waitFor(() => healthy(state.appUrl), 5 * 60_000, '/api/healthz → db: up');

  const toolEnv = {
    SUPABASE_URL: state.supabaseUrl,
    SUPABASE_SERVICE_ROLE_KEY: DEMO_SERVICE_KEY,
    SUPABASE_ANON_KEY: 'unused',
    SUPABASE_STUDENT_EMAIL_DOMAIN: 'somar.local',
    BOOTSTRAP_ADMIN_CODE: 'ADMIN',
    BOOTSTRAP_ADMIN_PASSWORD: REVIEW_ADMIN_PASSWORD,
    DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${state.dbPort}/postgres`,
    NODE_ENV: 'development',
  };
  console.log('إنشاء حساب المدير المحلي…');
  await run('npx', ['tsx', 'scripts/bootstrap-admin.ts'], toolEnv);
  console.log('تحميل البيانات التجريبية (لا تتكرر عند إعادة التشغيل)…');
  await run('npx', ['tsx', 'supabase/seed/seed-demo.ts'], toolEnv);

  console.log('');
  console.log('══════════════════════════════════════════════');
  console.log(`  افتح النظام: ${state.appUrl}`);
  console.log('══════════════════════════════════════════════');
  console.log('  الدور              رمز الدخول     كلمة المرور');
  console.log(`  مدير النظام        ADMIN          ${REVIEW_ADMIN_PASSWORD}`);
  console.log(`  مشرف عام           GS-01          ${DEMO_PASSWORD}`);
  console.log(`  مشرف               SUP-01         ${DEMO_PASSWORD}`);
  console.log(`  طالب + مشرف        SHB-0003       ${DEMO_PASSWORD}`);
  console.log(`  طالب               SHB-0001       ${DEMO_PASSWORD}`);
  console.log('  طالب جديد (أول دخول) SHB-0075   SHB-0075  ← يطلب تغيير كلمة المرور ثم رفع الصورة');
  console.log('');
  console.log('  للإيقاف: npm run review:stop');
}

(args.includes('--stop') ? stop() : start()).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
