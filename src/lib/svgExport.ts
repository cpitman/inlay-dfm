import type { VectorData } from '@/types';

/** Trigger a browser download of the current design as an SVG file. */
export function downloadSvg(vector: VectorData, filenameHint?: string): void {
  const blob = new Blob([vector.svgString], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = svgFileName(vector, filenameHint);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function svgFileName(vector: VectorData, hint?: string): string {
  const base = (hint ?? vector.fileName).replace(/\.(svg|dxf)$/i, '');
  return `${base || 'design'}.modified.svg`;
}
