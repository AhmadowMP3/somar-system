/** Loads a production env file (default .env.production) and derives computed values. Never prints secrets. */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';

export type ProdEnv = Record<string, string>;

export function envFileArg(argv = process.argv.slice(2)): string {
  const i = argv.indexOf('--env');
  return resolve(process.cwd(), i >= 0 && argv[i + 1] ? (argv[i + 1] as string) : '.env.production');
}

export function loadProdEnv(file = envFileArg()): ProdEnv {
  if (!existsSync(file)) throw new Error(`الملف غير موجود: ${file}`);
  const env = parse(readFileSync(file));
  if (!env.DATABASE_URL && env.POSTGRES_HOST && env.POSTGRES_PASSWORD) {
    const user = encodeURIComponent(env.POSTGRES_USER || 'postgres');
    const pass = encodeURIComponent(env.POSTGRES_PASSWORD);
    env.DATABASE_URL = `postgresql://${user}:${pass}@${env.POSTGRES_HOST}:${env.POSTGRES_PORT || '5432'}/${env.POSTGRES_DB || 'postgres'}`;
  }
  if (!env.VITE_SUPABASE_URL && env.SUPABASE_URL) env.VITE_SUPABASE_URL = env.SUPABASE_URL;
  if (!env.VITE_SUPABASE_ANON_KEY && env.SUPABASE_ANON_KEY) env.VITE_SUPABASE_ANON_KEY = env.SUPABASE_ANON_KEY;
  if (!env.VITE_VAPID_PUBLIC_KEY && env.VAPID_PUBLIC_KEY) env.VITE_VAPID_PUBLIC_KEY = env.VAPID_PUBLIC_KEY;
  for (const k of ['SUPABASE_URL', 'VITE_SUPABASE_URL', 'APP_BASE_URL']) if (env[k]) env[k] = env[k].replace(/\/+$/, '');
  return env;
}

/** `eyJ…a7f2c1` */
export function mask(value: string | undefined): string {
  if (!value) return '(فارغ)';
  if (value.length <= 10) return '•'.repeat(value.length);
  return `${value.slice(0, 3)}…${value.slice(-6)}`;
}

export type JwtClaims = { role?: string; iss?: string; iat?: number; exp?: number; ref?: string };

export function decodeJwt(token: string | undefined): { header: { alg?: string }; claims: JwtClaims } | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const dec = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    return { header: dec(parts[0] as string), claims: dec(parts[1] as string) };
  } catch {
    return null;
  }
}

/** A tiny PASS/WARN/FAIL reporter shared by the connect scripts. */
export type Status = 'PASS' | 'WARN' | 'FAIL';
export type CheckResult = { id: string; title: string; status: Status; detail: string; fix?: string };

export class Report {
  results: CheckResult[] = [];
  add(id: string, title: string, status: Status, detail: string, fix?: string) {
    this.results.push({ id, title, status, detail, fix });
    const icon = status === 'PASS' ? '✅' : status === 'WARN' ? '⚠️ ' : '❌';
    console.log(`${icon} ${status.padEnd(4)} ${title} — ${detail}`);
    if (fix && status !== 'PASS') console.log(`         ↳ ${fix}`);
  }
  get failed() {
    return this.results.filter((r) => r.status === 'FAIL').length;
  }
}
