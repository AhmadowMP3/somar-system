/**
 * Generates the app logo and PWA icons from the brand master `assets/somar_logo.png`
 * (transparent PNG). Usage: npx tsx scripts/generate-icons.ts
 */
import { resolve } from 'node:path';
import sharp from 'sharp';

const SOURCE = resolve('assets/somar_logo.png');
const dir = resolve('apps/web/public/icons');

/** Logo with its transparent margins removed. */
async function trimmed(): Promise<Buffer> {
  return sharp(SOURCE).trim({ threshold: 10 }).png().toBuffer();
}

async function square(art: Buffer, size: number, padding: number, background: string, file: string) {
  const inner = Math.round(size * (1 - padding * 2));
  const fitted = await sharp(art).resize(inner, inner, { fit: 'contain', background: '#00000000' }).png().toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background } })
    .composite([{ input: fitted, gravity: 'center' }])
    .png({ compressionLevel: 9 })
    .toFile(resolve(dir, file));
}

/** Monochrome white silhouette for the Android notification badge. */
async function badge(art: Buffer) {
  const size = 72;
  const alpha = await sharp(art).resize(60, 60, { fit: 'contain', background: '#00000000' }).extractChannel(3).toBuffer();
  const white = await sharp({ create: { width: 60, height: 60, channels: 3, background: '#FFFFFF' } }).joinChannel(alpha).png().toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: '#00000000' } })
    .composite([{ input: white, gravity: 'center' }])
    .png()
    .toFile(resolve(dir, 'badge-72.png'));
}

const art = await trimmed();
await sharp(art).resize({ width: 360, withoutEnlargement: true }).png({ palette: true, quality: 95, compressionLevel: 9 }).toFile(resolve(dir, 'logo.png'));
await square(art, 192, 0.08, '#FFFFFF', 'icon-192.png');
await square(art, 512, 0.08, '#FFFFFF', 'icon-512.png');
await square(art, 192, 0.2, '#FFFFFF', 'maskable-192.png');
await square(art, 512, 0.2, '#FFFFFF', 'maskable-512.png');
await square(art, 180, 0.1, '#FFFFFF', 'apple-touch-icon.png');
await square(art, 48, 0.02, '#00000000', 'favicon.png');
await badge(art);
console.log('logo and icons generated in', dir);
