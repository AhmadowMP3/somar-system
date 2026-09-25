import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import pg from 'pg';
import { applyMigrations } from '../../../../scripts/apply-migrations.mjs';

async function waitForRest(url: string, key: string) {
  const deadline = Date.now() + 30_000;
  let consecutive = 0;
  while (Date.now() < deadline) {
    const res = await fetch(`${url}/rest/v1/settings?select=id&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    }).catch(() => null);
    consecutive = res?.ok ? consecutive + 1 : 0;
    if (consecutive >= 3) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('PostgREST did not become ready after the schema reload');
}

/** Loads .env, applies the (re-runnable) migrations, clears any frozen clock and waits for PostgREST. */
export default async function setup() {
  loadEnv({ path: resolve(__dirname, '../../../../.env') });
  const url = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
  process.env.DATABASE_URL = url;
  await applyMigrations(url, () => undefined);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query('delete from private.test_clock');
  await client.end();
  await new Promise((r) => setTimeout(r, 1500));
  await waitForRest(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '');
}
