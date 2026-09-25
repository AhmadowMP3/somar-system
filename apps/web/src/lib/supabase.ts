import { createClient, type PostgrestError } from '@supabase/supabase-js';
import { config, isConfigured } from './config';

export const supabase = createClient(
  isConfigured ? config.supabaseUrl : 'http://localhost.invalid',
  isConfigured ? config.supabaseAnonKey : 'missing',
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'somar-auth' } },
);

export class DbError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
  }
}

/** Throw on a PostgREST error, return the data otherwise. */
export function unwrap<T>(res: { data: T | null; error: PostgrestError | null }): T {
  if (res.error) throw new DbError(res.error.message, res.error.code);
  return res.data as T;
}

export async function signedUrl(bucket: string, path: string | null | undefined, seconds = 3600): Promise<string | null> {
  if (!path) return null;
  const { data } = await supabase.storage.from(bucket).createSignedUrl(path, seconds);
  return data?.signedUrl ?? null;
}

export const PHOTO_BUCKET = 'student-photos';
export const LOGO_BUCKET = 'university-logos';
