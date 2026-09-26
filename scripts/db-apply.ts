/**
 * npm run db:apply  -- [--env .env.production] [--dry-run] [--force <file>]
 * npm run db:status -- [--env .env.production]
 * Without --env the DATABASE_URL comes from the environment / local .env.
 */
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { applyMigrations, connect, migrationStatus } from './db-migrations.js';
import { loadProdEnv } from './prod-env.js';

const argv = process.argv.slice(2);
const statusOnly = argv.includes('--status');
const dryRun = argv.includes('--dry-run');
const force: string[] = [];
argv.forEach((a, i) => {
  if (a === '--force' && argv[i + 1]) force.push(argv[i + 1] as string);
});

function databaseUrl(): string {
  if (argv.includes('--env')) return loadProdEnv().DATABASE_URL ?? '';
  config({ path: resolve(process.cwd(), '.env') });
  return process.env.DATABASE_URL ?? '';
}

async function main() {
  const url = databaseUrl();
  if (!url) throw new Error('DATABASE_URL غير محدد');
  const host = new URL(url).host;
  const client = await connect(url);
  try {
    if (statusOnly) {
      console.log(`قاعدة البيانات: ${host}`);
      for (const s of await migrationStatus(client)) {
        const label = { applied: '✅ مطبّق', pending: '⏳ معلّق', drift: '❌ تغيّر بعد التطبيق' }[s.status];
        console.log(`${label.padEnd(20)} ${s.filename}${s.appliedAt ? `  (${s.appliedAt})` : ''}`);
      }
      return;
    }
    console.log(`${dryRun ? 'خطة (بدون تنفيذ)' : 'تطبيق'} على ${host}${force.length ? ` · إجبار: ${force.join(', ')}` : ''}`);
    const res = await applyMigrations(client, { dryRun, force });
    for (const f of res.applied) console.log(`${dryRun ? '→ سيُطبّق' : '✅ طُبّق'}   ${f}`);
    for (const f of res.skipped) console.log(`↷ متخطّى (مطبّق سابقاً)   ${f}`);
    if (res.failed) console.log(`❌ فشل   ${res.failed.filename}: ${res.failed.error}`);
    console.log(`\nالملخص: ${dryRun ? 'سيُطبّق' : 'طُبّق'} ${res.applied.length} · متخطّى ${res.skipped.length} · فشل ${res.failed ? 1 : 0}`);
    if (res.failed) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(`❌ ${(err as Error).message}`);
  process.exitCode = 1;
});
