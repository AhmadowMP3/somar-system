/**
 * Migration runner for self-hosted Supabase (no project ref / `supabase db push`).
 * Tracks applied files in public._schema_migrations with a SHA-256 checksum; each file runs in its own transaction.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pg from 'pg';

export const MIGRATIONS_DIR = resolve(import.meta.dirname, '..', 'supabase', 'migrations');

export type MigrationFile = { filename: string; checksum: string; sql: string };
export type MigrationState = MigrationFile & {
  status: 'applied' | 'pending' | 'drift';
  appliedAt?: string;
  recordedChecksum?: string;
};

export function readMigrations(): MigrationFile[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((filename) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8').replace(/\r\n/g, '\n');
      return { filename, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

const TRACKING_SQL = `
create table if not exists public._schema_migrations (
  filename text primary key,
  checksum text not null,
  applied_at timestamptz not null default now()
);
alter table public._schema_migrations enable row level security;
revoke all on public._schema_migrations from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public._schema_migrations from anon, authenticated';
  end if;
end $$;`;

export async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15_000 });
  await client.connect();
  return client;
}

export async function migrationStatus(client: pg.Client): Promise<MigrationState[]> {
  await client.query(TRACKING_SQL);
  const { rows } = await client.query<{ filename: string; checksum: string; applied_at: Date }>(
    'select filename, checksum, applied_at from public._schema_migrations',
  );
  const recorded = new Map(rows.map((r) => [r.filename, r]));
  return readMigrations().map((m) => {
    const rec = recorded.get(m.filename);
    if (!rec) return { ...m, status: 'pending' };
    return {
      ...m,
      status: rec.checksum === m.checksum ? 'applied' : 'drift',
      appliedAt: rec.applied_at.toISOString(),
      recordedChecksum: rec.checksum,
    };
  });
}

export type ApplyResult = { applied: string[]; skipped: string[]; failed: { filename: string; error: string } | null };

export async function applyMigrations(client: pg.Client, opts: { dryRun: boolean; force: string[] }): Promise<ApplyResult> {
  const states = await migrationStatus(client);
  const drift = states.filter((s) => s.status === 'drift' && !opts.force.includes(s.filename));
  if (drift.length) {
    throw new Error(
      `تغيّر محتوى ملف سبق تطبيقه: ${drift.map((d) => d.filename).join(', ')}. لن يُعاد تطبيقه تلقائياً؛ راجع التغيير ثم استخدم --force <file>.`,
    );
  }
  const result: ApplyResult = { applied: [], skipped: [], failed: null };
  for (const s of states) {
    const run = s.status === 'pending' || opts.force.includes(s.filename);
    if (!run) {
      result.skipped.push(s.filename);
      continue;
    }
    if (opts.dryRun) {
      result.applied.push(s.filename);
      continue;
    }
    try {
      await client.query('begin');
      await client.query(s.sql);
      await client.query(
        `insert into public._schema_migrations (filename, checksum) values ($1, $2)
         on conflict (filename) do update set checksum = excluded.checksum, applied_at = now()`,
        [s.filename, s.checksum],
      );
      await client.query('commit');
      result.applied.push(s.filename);
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      result.failed = { filename: s.filename, error: (err as Error).message };
      break;
    }
  }
  if (!opts.dryRun && result.applied.length) await client.query("notify pgrst, 'reload schema'");
  return result;
}
