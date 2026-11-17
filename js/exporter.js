// Export (CSV + photos + annotated PDFs) and full project backup / restore, all as ZIP
// files built on the device. Loaded on demand because it pulls in pdf-lib.

import * as db from './db.js';
import { closePdf, openPdf } from './pdf.js';
import { photoName } from './pins.js';
import { TYPES, typeOf } from './types.js';
import { safeName } from './ui.js';
import { pathOf } from './viewer.js';
import { strFromU8, strToU8, unzipSync, Zip, ZipDeflate, ZipPassThrough } from '../vendor/fflate/fflate.js';
import * as PDF from '../vendor/pdf-lib/pdf-lib.esm.min.js';

const BACKUP_FORMAT = 'af-field-backup';
const BACKUP_VERSION = 1;
const RASTER_MAX_PX = 3600;       // long side of a page image when a PDF can't be edited directly
const INDEX_PHOTO_PX = 1000;      // photos are downscaled for the index pages

const pad = (n) => String(n).padStart(2, '0');
const dateStamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeStamp = (d = new Date()) => `${dateStamp(d)}_${pad(d.getHours())}${pad(d.getMinutes())}`;

// ---------------------------------------------------------------- zip

// Streams entries into a Blob. PDFs and JPEGs are stored as-is (already compressed).
function zipWriter() {
  const chunks = [];
  let settle;
  const finished = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  const zip = new Zip((err, chunk, final) => {
    if (err) { settle.reject(err); return; }
    chunks.push(chunk);
    if (final) settle.resolve(new Blob(chunks, { type: 'application/zip' }));
  });
  return {
    add(name, data, compress = false) {
      const entry = compress ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name);
      zip.add(entry);
      entry.push(data instanceof Uint8Array ? data : new Uint8Array(data), true);
    },
    end() { zip.end(); return finished; },
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

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function csvFor(pins, docById, photosByPin) {
  const fieldNames = [];
  for (const pin of pins) for (const f of pin.fields) if (!fieldNames.includes(f.name)) fieldNames.push(f.name);
  const rows = [['Tag', 'Drawing', 'Page', 'Preset', ...fieldNames, 'Notes', 'Photos']];
  for (const pin of pins) {
    const values = new Map(pin.fields.map((f) => [f.name, f.value]));
    rows.push([
      pin.tag, docById.get(pin.docId)?.name ?? '', pin.page ?? '', pin.presetName,
      ...fieldNames.map((name) => values.get(name) ?? ''),
      pin.notes,
      (photosByPin.get(pin.id) || []).map((p) => photoName(pin, p)).join('; '),
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

function pinOps(pin, size, font, fontKey) {
  const text = latin(pin.tag);
  const { r, box, textX, textY } = pinGeometry(pin, size, font.widthOfTextAtSize(text, size));
  const k = 0.5523 * r;
  const { x, y } = pin;
  return [
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
    PDF.beginText(),
    PDF.setFontAndSize(fontKey, size),
    PDF.setFillingColor(PDF.rgb(1, 1, 1)),
    PDF.setTextMatrix(1, 0, 0, -1, textX, textY),     // flip back: page space here has y pointing down
    PDF.showText(font.encodeText(text)),
    PDF.endText(),
  ];
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
      for (const pin of pins) ops.push(...pinOps(pin, size, font, fontKey));
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
      page.drawText(latin(title), { x: M, y: H - M - 16, size: 16, font: bold, color: black });
      page.drawText(latin(`${subtitle}  ·  page ${i / perPage + 1} of ${pageCount}`), { x: M, y: H - M - 32, size: 9, font: regular, color: grey });
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
    page.drawText(latin(name), { x, y: top - boxH - 12, size: 9, font: bold, color: black });
    const where = pin.page ? `page ${pin.page}` : 'not on a drawing';
    const detail = [pin.tag, pin.presetName || typeOf(pin.type).label, where].join('  ·  ');
    page.drawText(latin(detail), { x, y: top - boxH - 23, size: 8, font: regular, color: grey, maxWidth: cellW });
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
export async function exportProject(projectId, setStatus = () => {}, { forceRaster = false } = {}) {
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
  const zip = zipWriter();

  setStatus('Writing device tables…');
  for (const type of TYPES) {
    const ofType = pins.filter((p) => p.type === type.id);
    if (ofType.length) zip.add(`csv/${type.label}.csv`, csvFor(ofType, docById, photosByPin), true);
  }

  const photoEntries = (list) => list.flatMap((pin) => (photosByPin.get(pin.id) || []).map((photo) => ({
    pin, name: photoName(pin, photo), data: () => db.getPhotoData(photo.id),
  })));
  const allPhotos = photoEntries(pins);
  for (const [i, entry] of allPhotos.entries()) {
    setStatus(`Adding photo ${i + 1} of ${allPhotos.length}…`);
    zip.add(`photos/${entry.name}`, await entry.data());
  }

  const unique = uniqueNamer();
  for (const [i, doc] of docs.entries()) {
    setStatus(`Annotating drawing ${i + 1} of ${docs.length}: ${doc.name}`);
    const inkByPage = new Map(ink.filter((e) => e.docId === doc.id).map((e) => [e.page, e.strokes]));
    const onDoc = pins.filter((p) => p.docId === doc.id);
    const bytes = await annotatedPdf(doc, project, inkByPage, onDoc, photoEntries(onDoc), forceRaster);
    zip.add(`pdf/${unique(safeName(doc.name))}_annotated.pdf`, bytes);
  }
  // Photos of devices that are not pinned on any drawing get an index of their own.
  const loose = photoEntries(pins.filter((p) => !docById.has(p.docId)));
  if (loose.length) {
    const out = await PDF.PDFDocument.create();
    await addPhotoIndex(out, 'Photo index - devices not on a drawing', `${project.name}  ·  ${dateStamp()}`, loose);
    zip.add('pdf/Devices not on a drawing_photo index.pdf', await out.save());
  }

  setStatus('Finishing ZIP…');
  return { blob: await zip.end(), name: `${safeName(project.name)}_export_${dateStamp()}.zip` };
}

// ---------------------------------------------------------------- backup / restore

// One ZIP holding everything needed to rebuild the project on any tablet:
//   backup.json  project, drawings, ink, pins, photo records, presets
//   files/<docId>.pdf, thumbs/<docId>.jpg, photos/<photoId>.jpg
export async function backupProject(projectId, setStatus = () => {}) {
  const data = await db.dumpProject(projectId);
  const now = new Date();
  data.project = { ...data.project, lastBackup: now.getTime() };
  const zip = zipWriter();
  zip.add('backup.json', strToU8(JSON.stringify({
    format: BACKUP_FORMAT, version: BACKUP_VERSION, exported: now.toISOString(), ...data,
  })), true);
  for (const [i, doc] of data.docs.entries()) {
    setStatus(`Backing up drawing ${i + 1} of ${data.docs.length}…`);
    zip.add(`files/${doc.id}.pdf`, await db.getFile(doc.id));
    const thumb = await db.getThumb(doc.id, 1);
    if (thumb) zip.add(`thumbs/${doc.id}.jpg`, await thumb.arrayBuffer());
  }
  for (const [i, photo] of data.photos.entries()) {
    setStatus(`Backing up photo ${i + 1} of ${data.photos.length}…`);
    zip.add(`photos/${photo.id}.jpg`, await db.getPhotoData(photo.id));
  }
  setStatus('Finishing ZIP…');
  return {
    blob: await zip.end(),
    name: `${safeName(data.project.name)}_backup_${timeStamp(now)}.zip`,
    time: now.getTime(),
  };
}

// Opens a backup ZIP and checks it before anything on the device is touched.
export async function readBackup(file) {
  let entries;
  try {
    entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
  } catch {
    throw new Error('That file is not a readable ZIP.');
  }
  if (!entries['backup.json']) throw new Error('That ZIP is not an AF Field backup (an export ZIP cannot be restored).');
  const data = JSON.parse(strFromU8(entries['backup.json']));
  if (data.format !== BACKUP_FORMAT || !data.project?.id) throw new Error('That ZIP is not an AF Field backup.');
  if (data.version > BACKUP_VERSION) throw new Error('This backup was made by a newer version of the app. Update the app first.');
  for (const doc of data.docs) if (!entries[`files/${doc.id}.pdf`]) throw new Error(`The backup is incomplete: “${doc.name}” is missing.`);
  for (const photo of data.photos) if (!entries[`photos/${photo.id}.jpg`]) throw new Error('The backup is incomplete: a photo is missing.');
  return { data, entries };
}

export async function restoreBackup({ data, entries }) {
  const own = (u8) => (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? u8.buffer : u8.slice().buffer);
  const files = new Map(data.docs.map((d) => [d.id, own(entries[`files/${d.id}.pdf`])]));
  const photoData = new Map(data.photos.map((p) => [p.id, own(entries[`photos/${p.id}.jpg`])]));
  const thumbs = new Map();
  for (const doc of data.docs) {
    const thumb = entries[`thumbs/${doc.id}.jpg`];
    if (thumb) thumbs.set(doc.id, new Blob([thumb], { type: 'image/jpeg' }));
  }
  await db.restoreProject(data, { files, photoData, thumbs });
  return data.project;
}
