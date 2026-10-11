import QRCode from 'qrcode';
import { useMemo } from 'react';
import { qrPayload } from '@somar/shared';

const QUIET_ZONE = 4;

/** Inline SVG QR of any text (error correction M, 4-module quiet zone). */
export function QrSvg({ value, className, label }: { value: string; className?: string; label?: string }) {
  const { size, path } = useMemo(() => {
    const qr = QRCode.create(value, { errorCorrectionLevel: 'M' });
    const n = qr.modules.size;
    let d = '';
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (qr.modules.get(x, y)) d += `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`;
      }
    }
    return { size: n + QUIET_ZONE * 2, path: d };
  }, [value]);
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className={className}
      role="img"
      aria-label={label}
      data-payload={value}
      shapeRendering="crispEdges"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

/** Pixels per module of the bitmap: crisp at any on-screen size the code is shown at. */
const SCALE = 12;

/** The QR as a black-on-white PNG data URL. */
function qrPng(value: string): string | null {
  const qr = QRCode.create(value, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const side = (n + QUIET_ZONE * 2) * SCALE;
  const canvas = document.createElement('canvas');
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, side, side);
  ctx.fillStyle = '#000';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (qr.modules.get(x, y)) ctx.fillRect((x + QUIET_ZONE) * SCALE, (y + QUIET_ZONE) * SCALE, SCALE, SCALE);
    }
  }
  return canvas.toDataURL('image/png');
}

/**
 * A rider's QR (payload `SMR:<token>`), shown to be scanned. Phones with a system-wide "dark mode for
 * apps / websites" (Huawei, Honor, Samsung, Xiaomi…) recolour light page content, which turned the code
 * grey-on-grey and hard to scan. So it is a bitmap image (recolouring rewrites drawn shapes, not photo
 * pixels) inside a box that opts out of forced darkening (`color-scheme: only light`, `forced-color-adjust`).
 */
export function QrCode({ token, className, label }: { token: string; className?: string; label?: string }) {
  const payload = qrPayload(token);
  const png = useMemo(() => (typeof document === 'undefined' ? null : qrPng(payload)), [payload]);
  return (
    <span
      className="inline-block rounded-lg bg-white p-1"
      style={{ colorScheme: 'only light', forcedColorAdjust: 'none', backgroundColor: '#fff' }}
      data-payload={payload}
    >
      {png ? (
        <img
          src={png}
          alt={label ?? ''}
          className={className}
          style={{ imageRendering: 'pixelated', filter: 'none' }}
          draggable={false}
          data-testid="qr-image"
        />
      ) : (
        <QrSvg value={payload} className={className} label={label} />
      )}
    </span>
  );
}
