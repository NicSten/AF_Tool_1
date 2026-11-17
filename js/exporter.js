// Export (CSV + photos + annotated PDFs) and full project backup / restore, all as ZIP
// files built on the device. Loaded on demand because it pulls in pdf-lib.

import * as db from './db.js';
import { closePdf, openPdf } from './pdf.js';
import { photoName } from './pins.js';
import { csvCell } from './csv.js';
import { needsCanvasText, rasterText, drawTextPreservingGlyphs } from './pdf-text.js';
import { validateBackup, entryLimit, verifyBackupEntry } from './backup-validation.js';
import { uniquePhotoNames } from './photo-names.js';
import { TYPES, typeOf } from './types.js';
import { safeName } from './ui.js';
import { pathOf } from './viewer.js';
import { strFromU8, strToU8, Unzip, UnzipInflate, Zip, ZipDeflate, ZipPassThrough } from '../vendor/fflate/fflate.js';
import * as PDF from '../vendor/pdf-lib/pdf-lib.esm.min.js';

const BACKUP_FORMAT = 'af-field-backup';
const BACKUP_VERSION = 1;
const RASTER_MAX_PX = 3600;       // long side of a page image when a PDF can't be edited directly
const INDEX_PHOTO_PX = 1000;      // photos are downscaled for the index pages

const pad = (n) => String(n).padStart(2, '0');
const dateStamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeStamp = (d = new Date()) => `${dateStamp(d)}_${pad(d.getHours())}${pad(d.getMinutes())}`;
export const backupFileName = (name, d = new Date()) => `${safeName(name)}_backup_${timeStamp(d)}.zip`;
export const exportFileName = (name, d = new Date()) => `${safeName(name)}_export_${dateStamp(d)}.zip`;

// ---------------------------------------------------------------- zip

// Stream output to a confirmed file, or temporary origin-private storage (OPFS).
// Only browsers without OPFS need to keep the ZIP output chunks in memory.
async function zipWriter(destination = null) {
  let writable = destination, temporary = null;
  if (!writable && navigator.storage?.getDirectory) {
    try {
      const directory = await navigator.storage.getDirectory();
      const name = 'af-archive-' + db.newId() + '.zip';
      const handle = await directory.getFileHandle(name, { create: true });
      writable = await handle.createWritable();
      temporary = { directory, name, handle };
    } catch (err) {
      console.warn('Temporary file storage unavailable; using Blob output.', err);
    }
  }
  const chunks = [];
  let failure = null, queued = Promise.resolve();
  let resolveFinished, rejectFinished;
  const finished = new Promise((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });
  finished.catch(() => {});
  const zip = new Zip((err, chunk, final) => {
    if (err) { failure = err; rejectFinished(err); return; }
    if (chunk?.length) {
      if (writable) queued = queued.then(() => writable.write(chunk)).catch((e) => { failure = e; });
      else chunks.push(chunk);
    }
    if (final) resolveFinished();
  });
  const cleanup = async () => {
    if (temporary) {
      try { await temporary.directory.removeEntry(temporary.name); }
      catch (err) { console.warn('Could not remove temporary archive', err); }
    }
  };
  return {
    async add(name, data, compress = false) {
      if (failure) throw failure;
      if (!data) throw new Error('An archive file is missing: ' + name);
      const entry = compress ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name);
      zip.add(entry);
      entry.push(data instanceof Uint8Array ? data : new Uint8Array(data), true);
      await queued; // backpressure: never queue hundreds of large photo writes
      if (failure) throw failure;
    },
    async end() {
      zip.end();
      await finished;
      await queued;
      if (failure) throw failure;
      if (writable) {
        await writable.close(); // verified only after the file writer closes
        return { blob: temporary ? await temporary.handle.getFile() : null, cleanup };
      }
      return { blob: new Blob(chunks, { type: 'application/zip' }), cleanup };
    },
    async abort() {
      try { await writable?.abort?.(); } catch { /* already closed */ }
      await cleanup();
    },
  };
}


// Returns names that are unique within one folder ("E-101", "E-101 (2)", ...).
function uniqueNamer() {
  const used = new Set();
  return (name) => {
    let out = name;
    for (let i = 2; used.has(out.toLowerCase()); i++) out = `${name} (${i})`;
    used.add(out.toLowerCase());
    return out;
  };
}

// ---------------------------------------------------------------- csv

function csvFor(pins, docById, photosByPin, photoNames) {
  const fieldNames = [];
  for (const pin of pins) for (const f of pin.fields) if (!fieldNames.includes(f.name)) fieldNames.push(f.name);
  const rows = [['Tag', 'Drawing', 'Page', 'Preset', ...fieldNames, 'Notes', 'Photos']];
  for (const pin of pins) {
    const values = new Map(pin.fields.map((f) => [f.name, f.value]));
    rows.push([
      pin.tag, docById.get(pin.docId)?.name ?? '', pin.page ?? '', pin.presetName,
      ...fieldNames.map((name) => values.get(name) ?? ''),
      pin.notes,
      (photosByPin.get(pin.id) || []).map((p) => photoNames.get(p.id)).join('; '),
    ]);
  }
  // BOM so Excel reads UTF-8; CRLF line ends per RFC 4180.
  return strToU8(`﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`);
}

// ---------------------------------------------------------------- annotated pdf

// The built-in PDF fonts only cover Latin-1; anything else becomes "?".
const latin = (s) => String(s)
  .replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
  .replace(/…/g, '...').replace(/[^\x20-\x7e\xa1-\xff]/g, '?');

function hexColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  return PDF.rgb((n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function invert([a, b, c, d, e, f]) {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

// Size of pin markers on a sheet: readable on a D-size plot without swamping a letter page.
const tagSize = (w, h) => Math.max(7, Math.min(16, Math.max(w, h) / 160));

// Same geometry as pathOf() in the viewer, as PDF path operators.
function strokeOps(stroke) {
  const a = stroke.p;
  const ops = [PDF.setStrokingColor(hexColor(stroke.c)), PDF.setLineWidth(stroke.w), PDF.moveTo(a[0], a[1])];
  if (a.length === 2) {
    ops.push(PDF.lineTo(a[0] + 0.01, a[1]));
  } else {
    let x0 = a[0], y0 = a[1];
    for (let i = 2; i < a.length - 2; i += 2) {
      const cx = a[i], cy = a[i + 1];
      const x = (cx + a[i + 2]) / 2, y = (cy + a[i + 3]) / 2;
      // Quadratic -> cubic control points.
      ops.push(PDF.appendBezierCurve(
        x0 + (2 / 3) * (cx - x0), y0 + (2 / 3) * (cy - y0),
        x + (2 / 3) * (cx - x), y + (2 / 3) * (cy - y), x, y,
      ));
      x0 = x; y0 = y;
    }
    ops.push(PDF.lineTo(a[a.length - 2], a[a.length - 1]));
  }
  ops.push(PDF.stroke());
  return ops;
}

// Where a pin's dot and tag box go, in top-left page coordinates (shared by both renderers).
function pinGeometry(pin, size, textWidth) {
  const boxH = size * 1.5;
  const box = { x: pin.x + size * 0.8, y: pin.y - boxH - size * 0.3, w: textWidth + size * 0.9, h: boxH };
  return { r: size * 0.5, box, textX: box.x + size * 0.45, textY: box.y + size * 1.08 };
}

function pinOps(pin, size, font, fontKey, widthOverride = null, skipText = false) {
  const text = latin(pin.tag);
  const { r, box, textX, textY } = pinGeometry(pin, size, widthOverride ?? font.widthOfTextAtSize(text, size));
  const k = 0.5523 * r;
  const { x, y } = pin;
  const ops = [
    PDF.setFillingColor(hexColor(typeOf(pin.type).color)),
    PDF.setStrokingColor(PDF.rgb(1, 1, 1)),
    PDF.setLineWidth(size * 0.12),
    PDF.moveTo(x + r, y),
    PDF.appendBezierCurve(x + r, y + k, x + k, y + r, x, y + r),
    PDF.appendBezierCurve(x - k, y + r, x - r, y + k, x - r, y),
    PDF.appendBezierCurve(x - r, y - k, x - k, y - r, x, y - r),
    PDF.appendBezierCurve(x + k, y - r, x + r, y - k, x + r, y),
    PDF.closePath(), PDF.fillAndStroke(),
    PDF.moveTo(box.x, box.y), PDF.lineTo(box.x + box.w, box.y), PDF.lineTo(box.x + box.w, box.y + box.h),
    PDF.lineTo(box.x, box.y + box.h), PDF.closePath(), PDF.fillAndStroke(),
  ];
  if (!skipText) ops.push(
    PDF.beginText(),
    PDF.setFontAndSize(fontKey, size),
    PDF.setFillingColor(PDF.rgb(1, 1, 1)),
    PDF.setTextMatrix(1, 0, 0, -1, textX, textY),
    PDF.showText(font.encodeText(text)),
    PDF.endText(),
  );
  return ops;
}

// Draws ink and pin tags straight into the original PDF, so the drawing stays vector.
async function annotateVector(out, jsPdf, inkByPage, pinsByPage) {
  const font = await out.embedFont(PDF.StandardFonts.HelveticaBold);
  const pages = new Set([...inkByPage.keys(), ...pinsByPage.keys()]);
  for (const n of pages) {
    const viewport = (await jsPdf.getPage(n)).getViewport({ scale: 1 });
    const page = out.getPage(n - 1);
    page.node.normalize();        // isolates our drawing from whatever state the page content leaves behind
    // Ink and pins are stored in pdf.js viewport space; this maps them back to PDF user space
    // and takes care of page rotation and non-zero page origins.
    const ops = [
      PDF.pushGraphicsState(),
      PDF.concatTransformationMatrix(...invert(viewport.transform)),
      PDF.setLineCap(PDF.LineCapStyle.Round),
      PDF.setLineJoin(PDF.LineJoinStyle.Round),
    ];
    for (const stroke of inkByPage.get(n) || []) ops.push(...strokeOps(stroke));
    const pins = pinsByPage.get(n) || [];
    if (pins.length) {
      const fontKey = page.node.newFontDictionary('AFTag', font.ref);
      const size = tagSize(viewport.width, viewport.height);
      for (const pin of pins) {
        const unicode = needsCanvasText(pin.tag);
        if (!unicode) {
          ops.push(...pinOps(pin, size, font, fontKey));
          continue;
        }
        const glyphs = await rasterText(out, pin.tag, { size, bold: true });
        ops.push(...pinOps(pin, size, font, fontKey, glyphs.width, true));
        const { textX, textY } = pinGeometry(pin, size, glyphs.width);
        const key = page.node.newXObject('AFUnicode', glyphs.image.ref);
        ops.push(
          PDF.pushGraphicsState(),
          PDF.concatTransformationMatrix(glyphs.width, 0, 0, -glyphs.height,
            textX, textY - glyphs.baseline + glyphs.height),
          PDF.drawObject(key),
          PDF.popGraphicsState(),
        );
      }
    }
    ops.push(PDF.popGraphicsState());
    page.pushOperators(...ops);
  }
}

// Fallback for PDFs pdf-lib can't edit (e.g. encrypted): every page becomes an image with
// the ink and pins painted on.
async function annotateRaster(jsPdf, inkByPage, pinsByPage) {
  const out = await PDF.PDFDocument.create();
  for (let n = 1; n <= jsPdf.numPages; n++) {
    const jsPage = await jsPdf.getPage(n);
    const base = jsPage.getViewport({ scale: 1 });
    const k = Math.min(2.5, RASTER_MAX_PX / Math.max(base.width, base.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(base.width * k);
    canvas.height = Math.round(base.height * k);
    await jsPage.render({ canvas, viewport: jsPage.getViewport({ scale: k }) }).promise;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.lineCap = ctx.lineJoin = 'round';
    for (const stroke of inkByPage.get(n) || []) {
      ctx.strokeStyle = stroke.c;
      ctx.lineWidth = stroke.w;
      ctx.stroke(pathOf(stroke));
    }
    const size = tagSize(base.width, base.height);
    ctx.font = `bold ${size}px Helvetica, Arial, sans-serif`;
    for (const pin of pinsByPage.get(n) || []) {
      const { r, box, textX, textY } = pinGeometry(pin, size, ctx.measureText(pin.tag).width);
      ctx.fillStyle = typeOf(pin.type).color;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = size * 0.12;
      ctx.beginPath();
      ctx.arc(pin.x, pin.y, r, 0, Math.PI * 2);
      ctx.rect(box.x, box.y, box.w, box.h);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.fillText(pin.tag, textX, textY);
    }
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    canvas.width = 0;
    const image = await out.embedJpg(await blob.arrayBuffer());
    out.addPage([base.width, base.height]).drawImage(image, { x: 0, y: 0, width: base.width, height: base.height });
  }
  return out;
}

async function shrinkPhoto(buffer) {
  const bitmap = await createImageBitmap(new Blob([buffer], { type: 'image/jpeg' }));
  const k = Math.min(1, INDEX_PHOTO_PX / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * k);
  canvas.height = Math.round(bitmap.height * k);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.75));
  canvas.width = 0;
  return blob.arrayBuffer();
}

// Appends letter-size pages with a 3 x 2 grid of photos, captioned with file name and tag.
async function addPhotoIndex(out, title, subtitle, entries) {
  if (!entries.length) return;
  const bold = await out.embedFont(PDF.StandardFonts.HelveticaBold);
  const regular = await out.embedFont(PDF.StandardFonts.Helvetica);
  const W = 792, H = 612, M = 36, GAP = 14, COLS = 3, ROWS = 2, HEAD = 46, CAPTION = 30;
  const cellW = (W - 2 * M - (COLS - 1) * GAP) / COLS;
  const cellH = (H - 2 * M - HEAD - (ROWS - 1) * GAP) / ROWS;
  const black = PDF.rgb(0, 0, 0), grey = PDF.rgb(0.35, 0.35, 0.35);
  const perPage = COLS * ROWS;
  const pageCount = Math.ceil(entries.length / perPage);
  for (let i = 0; i < entries.length; i++) {
    const slot = i % perPage;
    if (slot === 0) {
      const page = out.addPage([W, H]);
      await drawTextPreservingGlyphs(out, page, title, { x: M, y: H - M - 16, size: 16, font: bold, color: black, bold: true }, latin);
      await drawTextPreservingGlyphs(out, page, `${subtitle}  ·  page ${i / perPage + 1} of ${pageCount}`, { x: M, y: H - M - 32, size: 9, font: regular, color: grey, colorName: 'grey' }, latin);
    }
    const page = out.getPage(out.getPageCount() - 1);
    const { pin, name, data } = entries[i];
    const image = await out.embedJpg(await shrinkPhoto(await data()));
    const x = M + (slot % COLS) * (cellW + GAP);
    const top = H - M - HEAD - Math.floor(slot / COLS) * (cellH + GAP);
    const boxH = cellH - CAPTION;
    const k = Math.min(cellW / image.width, boxH / image.height);
    const w = image.width * k, h = image.height * k;
    page.drawImage(image, { x: x + (cellW - w) / 2, y: top - boxH + (boxH - h) / 2, width: w, height: h });
    await drawTextPreservingGlyphs(out, page, name, { x, y: top - boxH - 12, size: 9, font: bold, color: black, bold: true, maxWidth: cellW }, latin);
    const where = pin.page ? `page ${pin.page}` : 'not on a drawing';
    const detail = [pin.tag, pin.presetName || typeOf(pin.type).label, where].join('  ·  ');
    await drawTextPreservingGlyphs(out, page, detail, { x, y: top - boxH - 23, size: 8, font: regular, color: grey, maxWidth: cellW, colorName: 'grey' }, latin);
  }
}

async function annotatedPdf(doc, project, inkByPage, pins, photoEntries, forceRaster) {
  const buffer = await db.getFile(doc.id);
  const pinsByPage = new Map();
  for (const pin of pins) {
    if (!pinsByPage.has(pin.page)) pinsByPage.set(pin.page, []);
    pinsByPage.get(pin.page).push(pin);
  }
  let out = null;
  let jsPdf = null;
  try {
    if (!forceRaster) {
      try {
        out = await PDF.PDFDocument.load(new Uint8Array(buffer), { updateMetadata: false });
        if (inkByPage.size || pinsByPage.size) {
          // pdf.js takes ownership of what it is given, and pdf-lib still needs the original bytes.
          jsPdf = await openPdf(buffer.slice(0));
          if (jsPdf.numPages !== out.getPageCount()) throw new Error('page count mismatch');
          await annotateVector(out, jsPdf, inkByPage, pinsByPage);
        }
      } catch (err) {
        console.warn(`"${doc.name}" could not be edited directly; exporting it as page images.`, err);
        out = null;
      }
    }
    if (!out) {
      if (jsPdf) await closePdf(jsPdf);
      jsPdf = await openPdf(buffer.slice(0));
      out = await annotateRaster(jsPdf, inkByPage, pinsByPage);
    }
  } finally {
    if (jsPdf) await closePdf(jsPdf);
  }
  await addPhotoIndex(out, `Photo index - ${doc.name}`, `${project.name}  ·  ${dateStamp()}`, photoEntries);
  return out.save();
}

// ---------------------------------------------------------------- export

// Builds the hand-off ZIP: csv/<Type>.csv, photos/<tag>_NN.jpg, pdf/<drawing>_annotated.pdf
export async function exportProject(projectId, setStatus = () => {}, { forceRaster = false, writable = null } = {}) {
  const { project, docs, ink, pins, photos } = await db.dumpProject(projectId);
  pins.sort((a, b) => a.tag.localeCompare(b.tag, undefined, { numeric: true }));
  const docById = new Map(docs.map((d) => [d.id, d]));
  const pinById = new Map(pins.map((p) => [p.id, p]));
  const photosByPin = new Map();
  for (const photo of photos.sort((a, b) => a.seq - b.seq)) {
    if (!pinById.has(photo.pinId)) continue;
    if (!photosByPin.has(photo.pinId)) photosByPin.set(photo.pinId, []);
    photosByPin.get(photo.pinId).push(photo);
  }
  // Generate each sanitized filename once. ZIP entries, CSV references, and
  // annotated PDF indexes must all use the same collision-free map.
  const photoNames = uniquePhotoNames(pins, photosByPin, photoName);
  const zip = await zipWriter(writable);

  try {
  setStatus('Writing device tables…');
  for (const type of TYPES) {
    const ofType = pins.filter((p) => p.type === type.id);
    if (ofType.length) await zip.add(`csv/${type.label}.csv`, csvFor(ofType, docById, photosByPin, photoNames), true);
  }

  const photoEntries = (list) => list.flatMap((pin) => (photosByPin.get(pin.id) || []).map((photo) => ({
    pin, name: photoNames.get(photo.id), data: () => db.getPhotoData(photo.id),
  })));
  const allPhotos = photoEntries(pins);
  for (const [i, entry] of allPhotos.entries()) {
    setStatus(`Adding photo ${i + 1} of ${allPhotos.length}…`);
    await zip.add(`photos/${entry.name}`, await entry.data());
  }

  const unique = uniqueNamer();
  for (const [i, doc] of docs.entries()) {
    setStatus(`Annotating drawing ${i + 1} of ${docs.length}: ${doc.name}`);
    const inkByPage = new Map(ink.filter((e) => e.docId === doc.id).map((e) => [e.page, e.strokes]));
    const onDoc = pins.filter((p) => p.docId === doc.id);
    const bytes = await annotatedPdf(doc, project, inkByPage, onDoc, photoEntries(onDoc), forceRaster);
    await zip.add(`pdf/${unique(safeName(doc.name))}_annotated.pdf`, bytes);
  }
  // Photos of devices that are not pinned on any drawing get an index of their own.
  const loose = photoEntries(pins.filter((p) => !docById.has(p.docId)));
  if (loose.length) {
    const out = await PDF.PDFDocument.create();
    await addPhotoIndex(out, 'Photo index - devices not on a drawing', `${project.name}  ·  ${dateStamp()}`, loose);
    await zip.add('pdf/Devices not on a drawing_photo index.pdf', await out.save());
  }

  setStatus('Finishing ZIP…');
  return { ...(await zip.end()), name: exportFileName(project.name) };
  } catch (err) {
    await zip.abort();
    throw err;
  }
}

// ---------------------------------------------------------------- backup / restore

// One ZIP holding everything needed to rebuild the project on any tablet:
//   backup.json  project, drawings, ink, pins, photo records, presets
//   files/<docId>.pdf, thumbs/<docId>.jpg, photos/<photoId>.jpg
export async function backupProject(projectId, setStatus = () => {}, { writable = null, now = new Date() } = {}) {
  const data = await db.dumpProject(projectId);
  if (!data.project) throw new Error('This project no longer exists.');
  const snapshotUpdated = data.project.updated;
  data.project = { ...data.project, lastBackup: now.getTime(), backedUpThrough: snapshotUpdated };
  const zip = await zipWriter(writable);
  try {
    await zip.add('backup.json', strToU8(JSON.stringify({
      format: BACKUP_FORMAT, version: BACKUP_VERSION, exported: now.toISOString(), ...data,
    })), true);
    for (const [i, doc] of data.docs.entries()) {
      setStatus('Backing up drawing ' + (i + 1) + ' of ' + data.docs.length + '…');
      await zip.add('files/' + doc.id + '.pdf', await db.getFile(doc.id));
      const thumb = await db.getThumb(doc.id, 1);
      if (thumb) await zip.add('thumbs/' + doc.id + '.jpg', await thumb.arrayBuffer());
    }
    for (const [i, photo] of data.photos.entries()) {
      setStatus('Backing up photo ' + (i + 1) + ' of ' + data.photos.length + '…');
      await zip.add('photos/' + photo.id + '.jpg', await db.getPhotoData(photo.id));
    }
    setStatus('Finishing ZIP…');
    return {
      ...(await zip.end()), name: backupFileName(data.project.name, now),
      time: now.getTime(), snapshotUpdated,
    };
  } catch (err) {
    await zip.abort();
    throw err;
  }
}


// Metadata validation is provided by the separately tested backup-validation module.

// Unzip incrementally. Store one finished PDF/photo at a time in a temporary
// IndexedDB store instead of retaining the entire expanded archive in RAM.
export async function readBackup(file) {
  const stageId = db.newId();
  const seen = new Set();
  const pending = [];
  let data = null, manifest = null, failure = null, started = false;
  const unzip = new Unzip((entry) => {
    if (failure) return;
    const name = entry.name;
    if (!started && name !== 'backup.json') {
      failure = new Error('Invalid backup: backup.json must be the first ZIP entry.');
      return;
    }
    started = true;
    if (seen.has(name) || (data && !manifest.allowed.has(name)) || (!data && name !== 'backup.json')) {
      failure = new Error('Invalid backup: unexpected or repeated archive file ' + name);
      return;
    }
    if (entry.originalSize != null && entry.originalSize > entryLimit(name)) {
      failure = new Error('Backup validation failed: archive entry is too large: ' + name);
      return;
    }
    const chunks = [];
    let length = 0;
    entry.ondata = (err, bytes, final) => {
      if (err) { failure = new Error('Could not decompress ' + name); return; }
      if (failure) return;
      if (bytes?.length) {
        length += bytes.length;
        if (length > entryLimit(name)) {
          failure = new Error('Backup validation failed: oversized archive entry: ' + name);
          return;
        }
        chunks.push(bytes.slice());
      }
      if (!final) return;
      const output = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
      if (name === 'backup.json') {
        try { data = JSON.parse(strFromU8(output)); }
        catch { failure = new Error('Backup metadata (backup.json) contains invalid JSON.'); return; }
        try { manifest = validateBackup(data); }
        catch (e) { failure = e; return; }
      } else {
        try { verifyBackupEntry(name, output, manifest); }
        catch (err) { failure = err; return; }
        const m = /^(files|photos|thumbs)\/([A-Za-z0-9_-]+)\.(pdf|jpg)$/.exec(name);
        if (!m) { failure = new Error('Backup has an invalid archive path.'); return; }
        const [, kind, id] = m;
        const value = kind === 'thumbs' ? new Blob([output], { type: 'image/jpeg' }) : output.buffer;
        pending.push(db.stageRestoreEntry(stageId, kind, id, value));
      }
      seen.add(name);
    };
    entry.start();
  });
  unzip.register(UnzipInflate);
  try {
    // File.stream() reads only small chunks; never file.arrayBuffer() on tablet.
    if (!file.stream) throw new Error('This browser cannot stream ZIP files.');
    const reader = file.stream().getReader();
    let count = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        unzip.push(value, false);
        if (pending.length) await Promise.all(pending.splice(0));
        if (failure) throw failure;
        if (++count % 8 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      }
      unzip.push(new Uint8Array(0), true);
      if (pending.length) await Promise.all(pending.splice(0));
      if (failure) throw failure;
    } finally {
      reader.releaseLock();
    }
    if (!data) throw new Error('That ZIP is not an AF Field backup (export ZIPs cannot be restored).');
    for (const name of manifest.required) {
      if (!seen.has(name)) throw new Error('Backup is incomplete: missing ' + name);
    }
    return { data, stageId };
  } catch (err) {
    await Promise.allSettled(pending);
    await db.clearRestoreStaging(stageId);
    if (err instanceof Error) throw err;
    throw new Error('That file is not a readable ZIP.');
  }
}

export async function restoreBackup({ data, stageId }) {
  try {
    await db.restoreProject(data, { stageId });
    return data.project;
  } finally {
    await db.clearRestoreStaging(stageId);
  }
}

