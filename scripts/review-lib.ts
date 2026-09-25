/** Shared helpers for `npm run review`, `review:stop` and `tour` (local review stack only). */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..');
export const STATE_FILE = resolve(ROOT, '.review.json');
export const PROJECT = 'somar-review';

/** Public Supabase demo keys (same as docker-compose.yml). Local review only — never production. */
export const DEMO_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
export const DEMO_SERVICE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
export const REVIEW_ADMIN_PASSWORD = 'Admin@12345';
export const DEMO_PASSWORD = 'Demo@12345';

export type ReviewState = { appPort: number; kongPort: number; dbPort: number; appUrl: string; supabaseUrl: string };

export function readState(): ReviewState | null {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as ReviewState;
  } catch {
    return null;
  }
}

export function writeState(state: ReviewState) {
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({ host, port });
    const finish = (ok: boolean) => {
      socket.destroy();
      done(ok);
    };
    socket.setTimeout(400, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function canListen(port: number): Promise<boolean> {
  return new Promise((done) => {
    const server = createServer();
    server.once('error', () => done(false));
    server.listen({ port, host: '0.0.0.0' }, () => server.close(() => done(true)));
  });
}

/** A port is free when nothing answers on it (IPv4 or IPv6 loopback) and we can bind it. */
export async function isFree(port: number): Promise<boolean> {
  if (await canConnect('127.0.0.1', port)) return false;
  if (await canConnect('::1', port)) return false;
  return canListen(port);
}

export async function pickPort(candidates: number[], taken: Set<number>): Promise<number> {
  for (const p of candidates) {
    if (taken.has(p)) continue;
    if (await isFree(p)) return p;
  }
  throw new Error(`لا يوجد منفذ متاح بين: ${candidates.join(', ')}`);
}

export function range(start: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => start + i);
}

export function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = {}, quiet = false): Promise<void> {
  return new Promise((ok, fail) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: quiet ? 'ignore' : 'inherit',
      shell: process.platform === 'win32',
    });
    child.once('error', fail);
    child.once('exit', (code) => (code === 0 ? ok() : fail(new Error(`${cmd} ${args.join(' ')} → exit ${code}`))));
  });
}

export function composeEnv(state: Pick<ReviewState, 'appPort' | 'kongPort' | 'dbPort'>): NodeJS.ProcessEnv {
  return {
    REVIEW_APP_PORT: String(state.appPort),
    REVIEW_KONG_PORT: String(state.kongPort),
    REVIEW_DB_PORT: String(state.dbPort),
  };
}

export async function waitFor(check: () => Promise<boolean>, timeoutMs: number, label: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`انتهت مهلة الانتظار: ${label}`);
}
