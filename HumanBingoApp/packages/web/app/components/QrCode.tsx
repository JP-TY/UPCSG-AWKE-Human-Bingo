'use client';

import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

export function QrCode({ value, payload }: { value: string; payload: string }) {
  const matrix = useMemo(() => {
    try {
      const code = qrcode(0, 'L');
      code.addData(value);
      code.make();
      const size = code.getModuleCount();
      const path = Array.from({ length: size }, (_, row) =>
        Array.from({ length: size }, (_, column) =>
          code.isDark(row, column) ? `M${column} ${row}h1v1h-1z` : '',
        ).join(''),
      ).join('');
      return { size, path };
    } catch {
      return { size: 0, path: '' };
    }
  }, [value]);

  return (
    <svg
      className="qr-presentation"
      viewBox={`0 0 ${matrix.size} ${matrix.size}`}
      role="img"
      aria-label="QR code for the invitation link"
      data-qr-payload={payload}
      shapeRendering="crispEdges"
    >
      <title>Scan to open the Human Bingo invitation</title>
      <rect width={matrix.size} height={matrix.size} className="qr-presentation__paper" />
      <path d={matrix.path} className="qr-presentation__modules" />
    </svg>
  );
}
