/**
 * Applies supabase/migrations/*.sql in order to DATABASE_URL (all files are re-runnable),
 * then asks PostgREST to reload its schema cache.
 * Usage: DATABASE_URL=postgresql://... node scripts/apply-migrations.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'supabase', 'migrations');
const url = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

export async function applyMigrations(connectionString = url, log = console.log) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      await client.query(readFileSync(join(dir, file), 'utf8'));
      log(`applied ${file}`);
    }
    await client.query("notify pgrst, 'reload schema'");
  } finally {
    await client.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  applyMigrations().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
