import { t } from '@/i18n/ar';
import { ApiClientError } from './api';
import { DbError } from './supabase';

/** Arabic message for any error thrown by the data layer or the API. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiClientError) {
    if (err.code === 'NETWORK') return t.errors.network ?? '';
    return err.messageAr || t.shared.api[err.code] || t.errors[err.code] || t.errors.generic || '';
  }
  if (err instanceof DbError) {
    if (err.code === '23505') return t.errors.duplicate ?? '';
    if (err.code === '42501') return t.errors.FORBIDDEN ?? '';
    return t.errors[err.message] || t.errors.generic || '';
  }
  if (err instanceof TypeError) return t.errors.network ?? '';
  return t.errors.generic ?? '';
}
