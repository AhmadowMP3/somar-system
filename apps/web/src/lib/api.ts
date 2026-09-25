import { config } from './config';
import { supabase } from './supabase';

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly messageAr: string,
    public readonly details?: unknown,
  ) {
    super(code);
  }
}

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function apiRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = await authHeader();
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(`${config.apiBaseUrl}${path}`, { method, headers, body: payload });
  } catch {
    throw new ApiClientError(0, 'NETWORK', '');
  }
  const json = (await res.json().catch(() => null)) as
    | (T & { ok?: boolean; code?: string; message_ar?: string; details?: unknown })
    | null;
  if (!res.ok) {
    throw new ApiClientError(res.status, json?.code ?? 'INTERNAL', json?.message_ar ?? '', json?.details);
  }
  return json as T;
}

export const api = {
  post: <T>(path: string, body?: unknown) => apiRequest<T>('POST', path, body),
  get: <T>(path: string) => apiRequest<T>('GET', path),
};
