import QRCode from 'qrcode';
import { useMemo } from 'react';
import { qrPayload } from '@somar/shared';

const QUIET_ZONE = 4;

/** Inline SVG QR (error correction M, 4-module quiet zone). Payload: `SMR:<token>`. */
export function QrCode({ token, className, label }: { token: string; className?: string; label?: string }) {
  const payload = qrPayload(token);
  const { size, path } = useMemo(() => {
    const qr = QRCode.create(payload, { errorCorrectionLevel: 'M' });
    const n = qr.modules.size;
    let d = '';
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (qr.modules.get(x, y)) d += `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`;
      }
    }
    return { size: n + QUIET_ZONE * 2, path: d };
  }, [payload]);
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className={className}
      role="img"
      aria-label={label}
      data-payload={payload}
      shapeRendering="crispEdges"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
