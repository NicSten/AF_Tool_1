// Browser-native text rasterization for glyphs outside pdf-lib's built-in
// Latin-1 font encoding. This preserves glyph appearance without flattening
// the underlying one-line PDF; non-Latin labels are image overlays (not searchable).
export const needsCanvasText = (text) => /[^\x20-\x7e\xa1-\xff]/u.test(String(text));

export async function rasterText(out, text, { size, bold = false, color = '#fff', maxWidth = Infinity } = {}) {
  const scale = 4;
  const font = (bold ? 'bold ' : '') + (size * scale) + 'px Arial, "Noto Sans", sans-serif';
  const probe = document.createElement('canvas');
  const context = probe.getContext('2d');
  context.font = font;
  const measured = context.measureText(String(text)).width / scale;
  probe.width = 0;
  const width = Math.max(1, Math.min(maxWidth, measured + size * 0.05));
  const height = size * 1.45;
  const baseline = size * 1.08;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(width * scale));
  canvas.height = Math.max(1, Math.ceil(height * scale));
  try {
    const ctx = canvas.getContext('2d');
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(String(text), 0, baseline * scale, width * scale);
    const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!png) throw new Error('Could not render Unicode text.');
    return { image: await out.embedPng(await png.arrayBuffer()), width, height, baseline };
  } finally {
    canvas.width = canvas.height = 0;
  }
}

// Use vector PDF text when the built-in font can encode it. Otherwise embed
// a transparent PNG of the original text at the same baseline.
export async function drawTextPreservingGlyphs(out, page, text, options, latin) {
  if (!needsCanvasText(text)) {
    page.drawText(latin(text), options);
    return;
  }
  const glyphs = await rasterText(out, text, {
    size: options.size,
    bold: options.bold,
    color: options.colorName === 'grey' ? '#595959' : '#000000',
    maxWidth: options.maxWidth ?? Infinity,
  });
  page.drawImage(glyphs.image, {
    x: options.x,
    y: options.y - glyphs.height + glyphs.baseline,
    width: glyphs.width,
    height: glyphs.height,
  });
}
