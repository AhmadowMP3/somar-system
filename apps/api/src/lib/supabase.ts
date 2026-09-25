import { createClient, type SupabaseClient, type SupabaseClientOptions } from '@supabase/supabase-js';
import WebSocket from 'ws';
import type { Config } from '../config.js';

type RealtimeTransport = NonNullable<NonNullable<SupabaseClientOptions<'public'>['realtime']>['transport']>;

/** Node 20 has no global WebSocket; supabase-js needs a transport for its (unused) realtime client. */
const clientOptions = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  realtime: { transport: WebSocket as unknown as RealtimeTransport },
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
