import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError, badRequest } from './errors.js';

export type UploadedFile = { buffer: Buffer; filename: string; mimetype: string };

/** Read a multipart body into memory: all fields plus the first file. */
export async function readMultipart(
  request: FastifyRequest,
): Promise<{ fields: Record<string, string>; file: UploadedFile | null }> {
  if (!request.isMultipart()) throw new ApiError(400, 'FILE_REQUIRED');
  const fields: Record<string, string> = {};
  let file: UploadedFile | null = null;
  for await (const part of request.parts()) {
    if (part.type === 'file') {
      const buffer = await part.toBuffer();
      if (!file) file = { buffer, filename: part.filename, mimetype: part.mimetype };
    } else {
      fields[part.fieldname] = String(part.value ?? '');
    }
  }
  return { fields, file };
}

const rowSelectionSchema = z.array(z.number().int().min(1)).max(20_000);

/** The «rows» field of an import: a JSON array of the sheet row numbers to import, or absent for all. */
export function readRowSelection(fields: Record<string, string>): number[] | undefined {
  if (fields.rows === undefined || fields.rows === '') return undefined;
  try {
    return rowSelectionSchema.parse(JSON.parse(fields.rows));
  } catch {
    throw badRequest('VALIDATION');
  }
}
