import QRCode from 'qrcode';
import { qrPayload } from '@somar/shared';
import { t } from '@/i18n/ar';
import { cn } from '@/lib/utils';
import { QrCode } from './QrCode';

type Box = { x: number; y: number; w: number; h: number };
type Template = { src: string; W: number; H: number; box: { photo: Box & { r: number }; name: Box; number: Box; college: Box; qr: Box } };

/**
 * The owner's card designs, cropped to the card edges; boxes are where each value goes, in template
 * pixels. Students: name / transport number / college. Doctors: name / transport number / profession.
 */
const TEMPLATES: Record<CardVariant, Template> = {
  student: {
    src: '/card/template.jpg',
    W: 1034,
    H: 652,
    box: {
      photo: { x: 50, y: 250, w: 228, h: 295, r: 10 },
      name: { x: 313, y: 300, w: 387, h: 45 },
      number: { x: 313, y: 400, w: 387, h: 46 },
      college: { x: 313, y: 500, w: 387, h: 47 },
      qr: { x: 829, y: 331, w: 138, h: 138 },
    },
  },
  doctor: {
    src: '/card/doctor-template.jpg',
    W: 1230,
    H: 749,
    box: {
      photo: { x: 60, y: 290, w: 272, h: 334, r: 12 },
      name: { x: 373, y: 344, w: 462, h: 53 },
      number: { x: 373, y: 458, w: 462, h: 53 },
      college: { x: 373, y: 576, w: 462, h: 53 },
      qr: { x: 995, y: 390, w: 140, h: 140 },
    },
  },
};

const INK = '#16181c';
const RED = '#b0121d';
const FONT = '"Cairo Variable", "Segoe UI", Tahoma, sans-serif';

export type CardVariant = 'student' | 'doctor';

/** Doctors have their own card design; students and university employees use the student one. */
export const cardVariant = (kind: string | null | undefined): CardVariant => (kind === 'doctor' ? 'doctor' : 'student');

export type CardValues = {
  variant?: CardVariant;
  full_name: string;
  transport_number: string;
  /** College, or a doctor's / employee's profession. */
  college: string;
  qr_token: string;
  /** Data URI or URL of the student's photo. */
  photo: string | null;
};

function pos(tpl: Template, b: Box) {
  return {
    left: `${(b.x / tpl.W) * 100}%`,
    top: `${(b.y / tpl.H) * 100}%`,
    width: `${(b.w / tpl.W) * 100}%`,
    height: `${(b.h / tpl.H) * 100}%`,
  };
}

/** Font size (as a share of the card width) that keeps `text` on one line inside a value box. */
function fitSize(tpl: Template, text: string, max: number): number {
  const perChar = 0.5; // average Cairo advance, in em
  const room = (tpl.box.name.w / tpl.W) * 100 * 0.92;
  return Math.min(max, room / Math.max(1, text.length * perChar));
}

/**
 * The student transport card, drawn on the owner's design. Sizes scale with the card width
 * (container query units), so the same markup serves the phone preview and the 85.6 × 54 mm print.
 */
export function CardFace({ card, className, style }: { card: CardValues; className?: string; style?: React.CSSProperties }) {
  const tpl = TEMPLATES[card.variant ?? 'student'];
  const box = tpl.box;
  const text = 'absolute flex items-center justify-center overflow-hidden whitespace-nowrap px-[1.5cqw] font-extrabold leading-none';
  return (
    <article
      className={cn('transport-card relative select-none overflow-hidden rounded-[3.5cqw] bg-white', className)}
      style={{ aspectRatio: `${tpl.W} / ${tpl.H}`, containerType: 'inline-size', ...style }}
      data-testid="transport-card"
      data-variant={card.variant ?? 'student'}
    >
      <img src={tpl.src} alt="" className="absolute inset-0 h-full w-full" draggable={false} />
      <div className="absolute overflow-hidden rounded-[1cqw] bg-[#e4e4e7]" style={pos(tpl, box.photo)}>
        {card.photo ? <img src={card.photo} alt="" className="h-full w-full object-cover" data-testid="card-photo" /> : null}
      </div>
      <p className={text} style={{ ...pos(tpl, box.name), color: INK, fontSize: `${fitSize(tpl, card.full_name, 3.6)}cqw` }}>
        {card.full_name}
      </p>
      <p className={cn(text, 'num tracking-wider')} dir="ltr" style={{ ...pos(tpl, box.number), color: RED, fontSize: '4.2cqw' }}>
        {card.transport_number}
      </p>
      <p className={text} style={{ ...pos(tpl, box.college), color: INK, fontSize: `${fitSize(tpl, card.college, 3.2)}cqw` }}>
        {card.college}
      </p>
      <div className="absolute bg-white" style={pos(tpl, box.qr)}>
        <QrCode token={card.qr_token} className="h-full w-full" label={card.transport_number} />
      </div>
    </article>
  );
}

/** Inlines an image as a data URI, so printing and canvas drawing never wait on (or get blocked by) storage. */
export async function toDataUri(url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image'));
    img.src = src;
  });
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Renders the card to a PNG (twice the template size, about 600 dpi at card size). */
export async function renderCardPng(card: CardValues): Promise<Blob> {
  const tpl = TEMPLATES[card.variant ?? 'student'];
  const { W, H, box: BOX } = tpl;
  const k = 2;
  const canvas = document.createElement('canvas');
  canvas.width = W * k;
  canvas.height = H * k;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas');
  ctx.scale(k, k);
  await Promise.all([document.fonts?.load(`800 40px ${FONT}`), document.fonts?.load(`800 40px ${FONT}`, card.full_name)]).catch(
    () => undefined,
  );

  ctx.drawImage(await loadImage(tpl.src), 0, 0, W, H);

  const p = BOX.photo;
  ctx.save();
  roundRect(ctx, p.x, p.y, p.w, p.h, p.r);
  ctx.clip();
  ctx.fillStyle = '#e4e4e7';
  ctx.fillRect(p.x, p.y, p.w, p.h);
  if (card.photo) {
    const img = await loadImage(card.photo).catch(() => null);
    if (img) {
      const scale = Math.max(p.w / img.width, p.h / img.height);
      const dw = img.width * scale;
      const dh = img.height * scale;
      ctx.drawImage(img, p.x + (p.w - dw) / 2, p.y + (p.h - dh) / 2, dw, dh);
    }
  }
  ctx.restore();

  const write = (value: string, b: Box, color: string, max: number, dir: CanvasDirection) => {
    let size = max;
    ctx.direction = dir;
    ctx.font = `800 ${size}px ${FONT}`;
    while (size > 12 && ctx.measureText(value).width > b.w - 24) {
      size -= 1;
      ctx.font = `800 ${size}px ${FONT}`;
    }
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(value, b.x + b.w / 2, b.y + b.h / 2 + size * 0.06);
  };
  write(card.full_name, BOX.name, INK, 36, 'rtl');
  write(card.transport_number, BOX.number, RED, 42, 'ltr');
  write(card.college, BOX.college, INK, 32, 'rtl');

  const q = BOX.qr;
  const qr = QRCode.create(qrPayload(card.qr_token), { errorCorrectionLevel: 'M' });
  const n = qr.modules.size + 8;
  const cell = q.w / n;
  ctx.fillStyle = '#fff';
  ctx.fillRect(q.x, q.y, q.w, q.h);
  ctx.fillStyle = '#000';
  for (let y = 0; y < qr.modules.size; y++) {
    for (let x = 0; x < qr.modules.size; x++) {
      if (qr.modules.get(x, y)) ctx.fillRect(q.x + (x + 4) * cell, q.y + (y + 4) * cell, cell + 0.02, cell + 0.02);
    }
  }

  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('png'))), 'image/png'));
}

/** Saves the card image to the device (on phones it lands in Downloads / Files). */
export async function downloadCard(card: CardValues): Promise<void> {
  const blob = await renderCardPng(card);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${t.cards.fileName}-${card.transport_number}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
