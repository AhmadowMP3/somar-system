import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Config } from '../config.js';

const clientOptions = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
};

export type Db = SupabaseClient;

export function createAdminClient(cfg: Config): Db {
  return createClient(cfg.SUPABASE_URL || 'http://invalid.local', cfg.SUPABASE_SERVICE_ROLE_KEY || 'missing', clientOptions);
}

/** A client that acts as the signed-in user (RLS and auth.uid() apply). */
export function createUserClient(cfg: Config, accessToken: string): Db {
  return createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    ...clientOptions,
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

export function createAnonClient(cfg: Config): Db {
  return createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, clientOptions);
}
