/**
 * Generates the PWA icons (regular, maskable, apple-touch, badge) from public/icons/logo.svg.
 * Usage: npx tsx scripts/generate-icons.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';

const dir = resolve('apps/web/public/icons');
const logo = readFileSync(resolve(dir, 'logo.svg'));

async function icon(size: number, file: string, padding: number, background: string) {
  const inner = Math.round(size * (1 - padding * 2));
  const art = await sharp(logo, { density: 512 }).resize(inner, inner, { fit: 'contain', background: '#00000000' }).png().toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background } })
    .composite([{ input: art, gravity: 'center' }])
    .png()
    .toFile(resolve(dir, file));
}

async function badge() {
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72"><text x="36" y="50" text-anchor="middle" font-family="Arial Black, Arial" font-size="36" font-weight="900" fill="#fff">ST</text></svg>`,
  );
  await sharp(svg).resize(72, 72).png().toFile(resolve(dir, 'badge-72.png'));
}

await icon(192, 'icon-192.png', 0.06, '#FFFFFF');
await icon(512, 'icon-512.png', 0.06, '#FFFFFF');
await icon(192, 'maskable-192.png', 0.18, '#FFFFFF');
await icon(512, 'maskable-512.png', 0.18, '#FFFFFF');
await icon(180, 'apple-touch-icon.png', 0.1, '#FFFFFF');
await badge();
console.log('icons generated in', dir);
