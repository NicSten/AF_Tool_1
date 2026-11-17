// Thin wrapper around the vendored pdf.js build. Nothing is fetched from a CDN:
// fonts, CMaps and image decoders are all served from ./vendor so they work offline.

import * as pdfjs from '../vendor/pdfjs/pdf.min.mjs';

const asset = (p) => new URL(`../vendor/pdfjs/${p}`, import.meta.url).href;

pdfjs.GlobalWorkerOptions.workerSrc = asset('pdf.worker.min.mjs');

// `buffer` is handed over to the pdf.js worker and must not be reused by the caller.
export function openPdf(buffer) {
  return pdfjs.getDocument({
    data: buffer,
    cMapUrl: asset('cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: asset('standard_fonts/'),
    wasmUrl: asset('wasm/'),
    iccUrl: asset('iccs/'),
  }).promise;
}

// Releases the document and its worker.
export function closePdf(pdf) {
  return pdf.loadingTask.destroy().catch(() => {});
}

// Renders a page to a small JPEG blob (the longest side is `size` device pixels).
export async function renderThumb(page, size = 360) {
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: size / Math.max(base.width, base.height) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  await page.render({ canvas, viewport }).promise;
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
  canvas.width = 0;
  return blob;
}
