import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.string().default('production'),
  APP_BASE_URL: z.string().default('http://localhost:8080'),
  SUPABASE_URL: z.string().default(''),
  SUPABASE_ANON_KEY: z.string().default(''),
  SUPABASE_SERVICE_ROLE_KEY: z.string().default(''),
  SUPABASE_STUDENT_EMAIL_DOMAIN: z.string().default('somar.local'),
  SUPABASE_PHOTO_BUCKET: z.string().default('student-photos'),
  SUPABASE_LOGO_BUCKET: z.string().default('university-logos'),
  VITE_SUPABASE_URL: z.string().default(''),
  VITE_SUPABASE_ANON_KEY: z.string().default(''),
  VITE_API_BASE_URL: z.string().default('/api'),
  VITE_APP_NAME: z.string().default(''),
  VAPID_PUBLIC_KEY: z.string().default(''),
  VAPID_PRIVATE_KEY: z.string().default(''),
  VAPID_SUBJECT: z.string().default('mailto:admin@example.com'),
  DISABLE_CRON: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  WEB_DIST_DIR: z.string().default(resolve(here, '../../web/dist')),
  /** OSRM-compatible routing service for route map paths; empty = straight lines between stops. */
  ROUTING_URL: z.string().default('https://router.project-osrm.org'),
});

export type Config = z.infer<typeof envSchema> & { version: string };

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(here, '../package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.parse(env);
  return { ...parsed, version: readVersion() };
}

/** The Supabase URL as seen by browsers (may differ from the server-side SUPABASE_URL behind a private network). */
export function publicSupabaseUrl(cfg: Config): string {
  return cfg.VITE_SUPABASE_URL || cfg.SUPABASE_URL;
}

/** Rewrites a URL issued by Supabase for the server so that browsers can reach it. */
export function toPublicUrl(cfg: Config, url: string): string {
  const trim = (u: string) => (u.endsWith('/') ? u.slice(0, -1) : u);
  const pub = trim(publicSupabaseUrl(cfg));
  const internal = trim(cfg.SUPABASE_URL);
  return pub && internal && pub !== internal && url.startsWith(internal) ? pub + url.slice(internal.length) : url;
}

/** Public, browser-safe runtime configuration injected into index.html. */
export function publicRuntimeConfig(cfg: Config) {
  return {
    supabaseUrl: publicSupabaseUrl(cfg),
    supabaseAnonKey: cfg.VITE_SUPABASE_ANON_KEY || cfg.SUPABASE_ANON_KEY,
    apiBaseUrl: cfg.VITE_API_BASE_URL || '/api',
    vapidPublicKey: cfg.VAPID_PUBLIC_KEY,
    emailDomain: cfg.SUPABASE_STUDENT_EMAIL_DOMAIN,
    appName: cfg.VITE_APP_NAME,
  };
}
