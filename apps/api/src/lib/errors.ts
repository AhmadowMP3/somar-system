import { arShared } from '@somar/shared';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly messageAr: string = arShared.api[code] ?? arShared.api.INTERNAL ?? '',
    public readonly details?: unknown,
  ) {
    super(code);
  }
}

export const badRequest = (code = 'VALIDATION', message?: string, details?: unknown) =>
  new ApiError(400, code, message ?? arShared.api[code], details);
export const unauthorized = () => new ApiError(401, 'UNAUTHORIZED');
export const forbidden = () => new ApiError(403, 'FORBIDDEN');
export const notFound = () => new ApiError(404, 'NOT_FOUND');
export const conflict = (code: string) => new ApiError(409, code);

/** Map a PostgREST / Postgres error raised by our SQL functions to an ApiError. */
export function fromDbError(error: { message?: string; code?: string } | null | undefined): ApiError {
  const msg = error?.message ?? '';
  if (msg === 'FORBIDDEN' || error?.code === '42501') return forbidden();
  if (msg === 'NOT_FOUND' || error?.code === 'P0002') return notFound();
  if (error?.code === '23505') return conflict('CONFLICT');
  if (error?.code === '22023' || error?.code === '23514' || error?.code === '22P02') return badRequest('VALIDATION');
  return new ApiError(500, 'INTERNAL');
}
