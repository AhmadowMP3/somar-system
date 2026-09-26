/**
 * npm run storage:setup -- [--env .env.production]   (idempotent)
 * Private buckets with size/mime limits, storage RLS policies, and an upload → signed URL → fetch → delete round trip.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { connect, MIGRATIONS_DIR } from './db-migrations.js';
import { loadProdEnv, Report, type ProdEnv } from './prod-env.js';

const MIME = ['image/jpeg', 'image/png', 'image/webp'];

function buckets(env: ProdEnv) {
  const mb = Number(env.MAX_PHOTO_MB || 5);
  return [
    { id: env.SUPABASE_PHOTO_BUCKET || 'student-photos', limit: mb * 1024 * 1024 },
    { id: env.SUPABASE_LOGO_BUCKET || 'university-logos', limit: 5 * 1024 * 1024 },
  ];
}

function storageClient(env: ProdEnv) {
  return createClient(env.SUPABASE_URL as string, env.SUPABASE_SERVICE_ROLE_KEY as string, {
    auth: { persistSession: false },
  });
}

export async function ensureBuckets(env: ProdEnv, r: Report) {
  const sb = storageClient(env);
  const { data: existing, error: listErr } = await sb.storage.listBuckets();
  for (const b of buckets(env)) {
    const options = { public: false, fileSizeLimit: b.limit, allowedMimeTypes: MIME };
    let viaApi = !listErr;
    if (viaApi) {
      const exists = existing?.some((x) => x.id === b.id);
      const res = exists ? await sb.storage.updateBucket(b.id, options) : await sb.storage.createBucket(b.id, options);
      if (res.error) viaApi = false;
    }
    if (!viaApi) {
      const client = await connect(env.DATABASE_URL as string);
      try {
        await client.query(
          `insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values ($1, $1, false, $2, $3)
           on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types`,
          [b.id, b.limit, MIME],
        );
      } finally {
        await client.end();
      }
    }
    r.add(`bucket-${b.id}`, `الحاوية ${b.id}`, 'PASS', `خاصة · ${b.limit / 1024 / 1024}MB · ${MIME.join(',')}${viaApi ? '' : ' (عبر SQL)'}`);
  }
}

export async function applyStoragePolicies(env: ProdEnv, r: Report) {
  const sql = readFileSync(join(MIGRATIONS_DIR, '0004_storage.sql'), 'utf8');
  const policies = sql.slice(sql.indexOf('-- Photos live at'));
  const client = await connect(env.DATABASE_URL as string);
  try {
    await client.query(policies);
    const { rows } = await client.query<{ policyname: string }>(
      `select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname in ('student_photos_read','university_logos_read')`,
    );
    r.add('storage-policies', 'سياسات قراءة التخزين', rows.length === 2 ? 'PASS' : 'FAIL', `${rows.length}/2`);
  } finally {
    await client.end();
  }
}

export async function checkBucketsPrivate(env: ProdEnv, r: Report) {
  const { data, error } = await storageClient(env).storage.listBuckets();
  if (error) return r.add('buckets-private', 'الحاويات خاصة', 'FAIL', error.message);
  const ours = buckets(env).map((b) => data.find((x) => x.id === b.id));
  const ok = ours.every((b) => b && !b.public);
  r.add('buckets-private', 'الحاويات موجودة وخاصة', ok ? 'PASS' : 'FAIL', ours.map((b, i) => `${buckets(env)[i]?.id}=${b ? (b.public ? 'عامة!' : 'خاصة') : 'غير موجودة'}`).join(' · '), 'npm run storage:setup -- --env .env.production');
}

/** Upload a ~1 KB probe, sign it for 60 s, fetch it through the public domain, delete it. */
export async function storageRoundTrip(env: ProdEnv, r: Report) {
  const sb = storageClient(env);
  const bucket = env.SUPABASE_PHOTO_BUCKET || 'student-photos';
  const path = `__probe__/${randomBytes(6).toString('hex')}.jpg`;
  const body = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(1020)]);
  try {
    const up = await sb.storage.from(bucket).upload(path, body, { contentType: 'image/jpeg' });
    if (up.error) return r.add('roundtrip', 'رفع ← رابط موقّع ← تنزيل ← حذف', 'FAIL', `رفع: ${up.error.message}`);
    const signed = await sb.storage.from(bucket).createSignedUrl(path, 60);
    if (signed.error || !signed.data) return r.add('roundtrip', 'رفع ← رابط موقّع ← تنزيل ← حذف', 'FAIL', `توقيع: ${signed.error?.message}`);
    const url = new URL(signed.data.signedUrl);
    const res = await fetch(url);
    const got = Buffer.from(await res.arrayBuffer());
    r.add('roundtrip', 'رفع ← رابط موقّع ← تنزيل ← حذف', res.status === 200 && got.equals(body) ? 'PASS' : 'FAIL', `HTTP ${res.status} · ${got.length} بايت`);
    const publicHost = new URL(env.VITE_SUPABASE_URL || (env.SUPABASE_URL as string)).host;
    r.add('signed-host', 'مضيف الرابط الموقّع عام', url.host === publicHost ? 'PASS' : 'FAIL', url.host, 'اضبط SUPABASE_URL على الدومين العام (التطبيق يعيد كتابة الروابط الداخلية تلقائياً)');
  } finally {
    await sb.storage.from(bucket).remove([path]);
  }
}

if (process.argv[1]?.endsWith('storage-setup.ts')) {
  const env = loadProdEnv();
  const r = new Report();
  await ensureBuckets(env, r);
  await applyStoragePolicies(env, r);
  await checkBucketsPrivate(env, r);
  await storageRoundTrip(env, r);
  console.log(r.failed ? `\n${r.failed} فحص فشل.` : '\nكل الفحوص نجحت.');
  process.exitCode = r.failed ? 1 : 0;
}
