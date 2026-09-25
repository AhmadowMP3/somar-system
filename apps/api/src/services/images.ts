import sharp from 'sharp';
import { ApiError } from '../lib/errors.js';

export const PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** Validate + normalize a student photo: EXIF stripped, 600×600 center crop, JPEG q82. */
export async function processStudentPhoto(buffer: Buffer, mimetype: string, maxMb: number): Promise<Buffer> {
  if (!PHOTO_MIME_TYPES.includes(mimetype)) throw new ApiError(415, 'PHOTO_TYPE');
  if (buffer.length > maxMb * 1024 * 1024) throw new ApiError(413, 'PHOTO_SIZE');
  try {
    const meta = await sharp(buffer).metadata();
    if (!meta.format || !['jpeg', 'png', 'webp'].includes(meta.format)) throw new ApiError(415, 'PHOTO_TYPE');
    return await sharp(buffer)
      .rotate()
      .resize(600, 600, { fit: 'cover', position: 'centre' })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(400, 'PHOTO_INVALID');
  }
}

export async function processLogo(buffer: Buffer): Promise<Buffer> {
  try {
    return await sharp(buffer)
      .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
  } catch {
    throw new ApiError(400, 'PHOTO_INVALID');
  }
}

/** Confirms the native sharp binding loads; logged at startup. */
export async function sharpSelfTest(): Promise<string | null> {
  try {
    await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } })
      .jpeg()
      .toBuffer();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
