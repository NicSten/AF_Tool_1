// PDF viewer with a vector ink layer.
//
// Coordinates: "page space" is PDF points of the page at scale 1 (after the page's own
// rotation). The view maps page -> screen as  screen = page * s + (tx, ty)  in CSS px.
//
// Rendering uses three stacked layers so large sheets stay sharp without huge canvases:
//   base    whole page at modest resolution, moved with a CSS transform (instant pan/zoom)
//   detail  just the visible region at full device resolution, re-rendered when the view settles
//   ink     vector strokes redrawn at the current view; `live` holds the stroke in progress
//   pins    one DOM element per device pin, positioned from the view each frame
//
// Pen input: drawing a stroke, erasing, lassoing ink (to attach it to a pin), dragging a
// pin, and - on a long press - the radial menu that drops a new pin.

import * as db from './db.js';
import { closePdf, openPdf, renderThumb } from './pdf.js';
import { createPin, missingFields } from './pins.js';
import { Radial } from './radial.js';
import { typeOf } from './types.js';
import { esc, showError, toast } from './ui.js';

export const COLORS = ['#e0162b', '#1456d9', '#0a8f3c'];

const PEN_WIDTH_PX = 2.6;     // stroke width on screen at the moment of drawing
const ERASER_RADIUS_PX = 14;
const MAX_SCALE = 10;         // CSS px per PDF point
const BASE_MAX_PIXELS = 8e6;
const UNDO_LIMIT = 200;
const PALM_QUIET_MS = 350;    // touches are ignored this long after the pen lifts
const LONG_PRESS_MS = 550;
const HOLD_SLOP_PX = 8;       // movement allowed during a long press / before a pin drag starts
const LASSO_INSIDE = 0.6;     // share of a stroke's points that must lie inside the loop

const pathCache = new WeakMap();
const boxCache = new WeakMap();

export function pathOf(stroke) {
  let path = pathCache.get(stroke);
  if (!path) {
    const a = stroke.p;
    path = new Path2D();
    path.moveTo(a[0], a[1]);
    if (a.length === 2) {
      path.lineTo(a[0] + 0.01, a[1]);
    } else {
      // Quadratic segments through midpoints: smooth, and passes near every sample.
      for (let i = 2; i < a.length - 2; i += 2) {
        path.quadraticCurveTo(a[i], a[i + 1], (a[i] + a[i + 2]) / 2, (a[i + 1] + a[i + 3]) / 2);
      }
      path.lineTo(a[a.length - 2], a[a.length - 1]);
    }
    pathCache.set(stroke, path);
  }
  return path;
}

function boxOf(stroke) {
  let box = boxCache.get(stroke);
  if (!box) {
    const a = stroke.p;
    box = [a[0], a[1], a[0], a[1]];
    for (let i = 2; i < a.length; i += 2) {
      if (a[i] < box[0]) box[0] = a[i]; else if (a[i] > box[2]) box[2] = a[i];
      if (a[i + 1] < box[1]) box[1] = a[i + 1]; else if (a[i + 1] > box[3]) box[3] = a[i + 1];
    }
    boxCache.set(stroke, box);
  }
  return box;
}

// True when the segment (ax,ay)-(bx,by) passes within `r` of any part of the stroke.
function strokeHit(stroke, ax, ay, bx, by, r) {
  const reach = r + stroke.w / 2;
  const box = boxOf(stroke);
  if (Math.max(ax, bx) < box[0] - reach || Math.min(ax, bx) > box[2] + reach
    || Math.max(ay, by) < box[1] - reach || Math.min(ay, by) > box[3] + reach) return false;
  const a = stroke.p;
  if (a.length === 2) return segDist(ax, ay, bx, by, a[0], a[1], a[0], a[1]) <= reach;
  for (let i = 0; i < a.length - 2; i += 2) {
    if (segDist(ax, ay, bx, by, a[i], a[i + 1], a[i + 2], a[i + 3]) <= reach) return true;
  }
  return false;
}

function pointSegDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

function segmentsCross(ax, ay, bx, by, cx, cy, dx, dy) {
  const o = (px, py, qx, qy, rx, ry) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  return o(ax, ay, bx, by, cx, cy) !== o(ax, ay, bx, by, dx, dy)
    && o(cx, cy, dx, dy, ax, ay) !== o(cx, cy, dx, dy, bx, by);
}

function segDist(ax, ay, bx, by, cx, cy, dx, dy) {
  if (segmentsCross(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.min(
    pointSegDist(ax, ay, cx, cy, dx, dy), pointSegDist(bx, by, cx, cy, dx, dy),
    pointSegDist(cx, cy, ax, ay, bx, by), pointSegDist(dx, dy, ax, ay, bx, by),
  );
}

function insidePolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i], yi = poly[i + 1], xj = poly[j], yj = poly[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round2 = (v) => Math.round(v * 100) / 100;

export class Viewer {
  constructor(root, { sheet }) {
    this.onError = showError;
    this.sheet = sheet;
    const $ = (sel) => root.querySelector(sel);
    this.el = {
      title: $('#doc-title'), stage: $('#stage'), base: $('#layer-base'), detail: $('#layer-detail'),
      ink: $('#layer-ink'), live: $('#layer-live'), busy: $('#stage-busy'), thumbs: $('#thumbs'),
      pageLabel: $('#page-label'), prev: $('#btn-prev'), next: $('#btn-next'),
      undo: $('#btn-undo'), redo: $('#btn-redo'), eye: $('#btn-eye'), eraser: $('#btn-eraser'),
      thumbsBtn: $('#btn-thumbs'), fit: $('#btn-fit'), pens: [...root.querySelectorAll('.pen')],
      pinLayer: $('#pin-layer'), lasso: $('#btn-lasso'), devices: $('#btn-devices'),
      lassoBar: $('#lasso-bar'), lassoText: $('#lasso-text'), lassoDetach: $('#lasso-detach'),
      lassoCancel: $('#lasso-cancel'),
    };
    this.pins = [];
    this.pinEls = new Map();
    this.presets = [];
    this.radial = new Radial(document.querySelector('#radial'), (type) => this.presets.filter((p) => p.type === type));
    this.inkCtx = this.el.ink.getContext('2d');
    // The in-progress stroke gets its own low-latency canvas; committed ink stays on a normal one.
    this.liveCtx = this.el.live.getContext('2d', { desynchronized: true });

    this.tool = 'pen';
    this.color = 0;
    this.inkVisible = true;
    this.view = { s: 1, tx: 0, ty: 0 };
    this.touches = new Map();     // active finger pointers taking part in pan/zoom
    this.ignored = new Set();     // rejected pointers (palm, or cancelled by the pen)
    this.penSeenAt = -1e9;
    this.penUpAt = -1e9;
    this.thumbUrls = [];
    this.gen = 0;                 // bumped on every page change / close to drop stale async work

    this._bindToolbar();
    this._bindPointer();
    new ResizeObserver(() => this._resize()).observe(this.el.stage);
    this._setThumbsOpen(localStorage.getItem('thumbsOpen') !== '0');
    this._syncToolbar();
  }

  // ---------------------------------------------------------------- lifecycle

  async open(docId, pinId = null) {
    await this.close();
    const gen = this.gen;
    this._busy(true);
    const [doc, buffer] = await Promise.all([db.getDoc(docId), db.getFile(docId)]);
    if (!doc || !buffer) throw new Error('This drawing is no longer on the device.');
    const pdf = await openPdf(buffer);
    if (gen !== this.gen) { closePdf(pdf); return; }
    this.doc = doc;
    this.pdf = pdf;
    this.history = new Map();   // page -> {undo: [], redo: []}, kept while the document is open
    [this.inked, this.pins, this.presets] = await Promise.all([
      db.inkPages(docId), db.listDocPins(docId), db.listPresets(),
    ]);
    if (gen !== this.gen) return;
    this.el.title.textContent = doc.name;
    this.el.devices.href = `#/p/${doc.projectId}/pins`;
    this._buildThumbs();
    const pin = pinId && this.pins.find((p) => p.id === pinId);
    await this.goto(clamp(pin ? pin.page : doc.lastPage || 1, 1, pdf.numPages));
    if (pin) this.focusPin(pinId);
  }

  // Brings a pin into view (changing page if needed) and flashes it.
  async focusPin(pinId) {
    const pin = this.pins.find((p) => p.id === pinId);
    if (!pin || !this.pdf) return;
    if (pin.page !== this.pageNum) await this.goto(pin.page);
    if (!this.page || pin.page !== this.pageNum) return;
    const s = clamp(this._fitView().s * 3, this.view.s, this._limits().max);
    this._animateTo({ s, tx: this.W / 2 - pin.x * s, ty: this.H / 2 - pin.y * s });
    const el = this.pinEls.get(pinId);
    if (el) {
      el.classList.add('pulse');
      setTimeout(() => el.classList.remove('pulse'), 2600);
    }
  }

  async close() {
    this.gen++;
    this._cancelRenders();
    this._stopAnim();
    this._dropPointers();
    this.radial.close();
    this.touches.clear();
    this.ignored.clear();
    this.page = null;
    this.strokes = [];
    this.pins = [];
    this.focusPinId = null;
    this._setSelection(null);
    this._renderPins();
    this.el.base.style.visibility = 'hidden';
    this.el.detail.style.visibility = 'hidden';
    this._clear(this.inkCtx);
    this._clear(this.liveCtx);
    this.thumbObserver?.disconnect();
    this.thumbUrls.forEach((u) => URL.revokeObjectURL(u));
    this.thumbUrls = [];
    this.el.thumbs.replaceChildren();
    const pdf = this.pdf;
    this.pdf = null;
    this.doc = null;
    if (pdf) await closePdf(pdf);
  }

  async goto(n) {
    if (!this.pdf) return;
    n = clamp(n, 1, this.pdf.numPages);
    const gen = ++this.gen;
    this._cancelRenders();
    this._stopAnim();
    this._dropPointers();
    this.radial.close();
    this._setSelection(null);
    this.page = null;
    this.pageNum = n;
    this._renderPins();
    this.el.base.style.visibility = 'hidden';
    this.el.detail.style.visibility = 'hidden';
    this._clear(this.inkCtx);
    this._clear(this.liveCtx);
    this._busy(true);
    this._syncToolbar();
    this._markThumb();

    const { pdf, doc } = this;
    const [page, strokes] = await Promise.all([pdf.getPage(n), db.getInk(doc.id, n)]);
    if (gen !== this.gen) return;
    const vp = page.getViewport({ scale: 1 });
    this.page = page;
    this.pw = vp.width;
    this.ph = vp.height;
    this.strokes = strokes;
    if (!this.history.has(n)) this.history.set(n, { undo: [], redo: [] });
    this.detailView = null;
    this._resize();
    this.view = this._fitView();
    this._renderPins();
    this._syncToolbar();
    this._invalidate();
    db.updateDoc(doc.id, { lastPage: n }).catch(() => {});
    await this._renderBase(gen);
  }

  // ---------------------------------------------------------------- view

  _fitView() {
    const { W, H, pw, ph } = this;
    const s = Math.min((W - 16) / pw, (H - 16) / ph);
    return { s, tx: (W - pw * s) / 2, ty: (H - ph * s) / 2 };
  }

  _limits() {
    const fit = this._fitView().s;
    return { min: fit * 0.5, max: Math.max(MAX_SCALE, fit * 4) };
  }

  _setView(s, tx, ty) {
    const { W, H, pw, ph } = this;
    // Keep a good part of the sheet on screen so it can't be lost off the edge.
    const mx = Math.min(W, pw * s) * 0.3, my = Math.min(H, ph * s) * 0.3;
    this.view = {
      s,
      tx: clamp(tx, mx - pw * s, W - mx),
      ty: clamp(ty, my - ph * s, H - my),
    };
    this._invalidate();
  }

  _zoomAt(x, y, factor) {
    const { min, max } = this._limits();
    const { s, tx, ty } = this.view;
    const s2 = clamp(s * factor, min, max);
    this._setView(s2, x - (x - tx) * (s2 / s), y - (y - ty) * (s2 / s));
  }

  _animateTo(target) {
    this._stopAnim();
    const from = { ...this.view };
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / 180);
      const e = 1 - (1 - t) ** 3;
      // Interpolate scale geometrically so the zoom feels even.
      const s = from.s * (target.s / from.s) ** e;
      this._setView(s, from.tx + (target.tx - from.tx) * e, from.ty + (target.ty - from.ty) * e);
      this.anim = t < 1 ? requestAnimationFrame(step) : 0;
    };
    this.anim = requestAnimationFrame(step);
  }

  _stopAnim() {
    if (this.anim) cancelAnimationFrame(this.anim);
    this.anim = 0;
  }

  fit() {
    if (this.page) this._animateTo(this._fitView());
  }

  _resize() {
    const stage = this.el.stage;
    const W = stage.clientWidth, H = stage.clientHeight;
    if (!W || !H) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const changed = W !== this.W || H !== this.H || dpr !== this.dpr;
    this.W = W; this.H = H; this.dpr = dpr;
    if (!changed) return;
    for (const c of [this.el.ink, this.el.live]) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    if (this.page) this._setView(this.view.s, this.view.tx, this.view.ty);
  }

  // Coalesces all view/ink changes into one paint per frame so layers never drift apart.
  _invalidate() {
    if (this.framePending) return;
    this.framePending = true;
    requestAnimationFrame(() => {
      this.framePending = false;
      this._paint();
    });
  }

  _paint() {
    if (!this.page) return;
    const { s, tx, ty } = this.view;
    this.el.base.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    const d = this.detailView;
    if (d) {
      const k = s / d.s;
      this.el.detail.style.transform = `translate(${tx - d.tx * k}px, ${ty - d.ty * k}px) scale(${k})`;
    }
    this._drawInk();
    for (const pin of this.pins) {
      const el = this.pinEls.get(pin.id);
      if (el) el.style.transform = `translate(${pin.x * s + tx}px, ${pin.y * s + ty}px)`;
    }
    if (!d || d.s !== s || d.tx !== tx || d.ty !== ty || d.W !== this.W || d.H !== this.H) {
      clearTimeout(this.detailTimer);
      this.detailTimer = setTimeout(() => this._renderDetail(), 140);
    }
  }

  // ---------------------------------------------------------------- pdf rendering

  _cancelRenders() {
    clearTimeout(this.detailTimer);
    this.baseTask?.cancel();
    this.detailTask?.cancel();
    this.baseTask = this.detailTask = null;
  }

  async _renderBase(gen) {
    const { page, pw, ph } = this;
    const scale = Math.min(this._fitView().s * this.dpr * 1.25, Math.sqrt(BASE_MAX_PIXELS / (pw * ph)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(pw * scale));
    canvas.height = Math.max(1, Math.round(ph * scale));
    const task = page.render({ canvas, viewport: page.getViewport({ scale: canvas.width / pw }) });
    this.baseTask = task;
    try {
      await task.promise;
    } catch (err) {
      canvas.width = 0;
      if (gen === this.gen && err?.name !== 'RenderingCancelledException') {
        this._busy(false);
        this.onError(err);
      }
      return;
    }
    if (gen !== this.gen) { canvas.width = 0; return; }
    const base = this.el.base;
    base.width = canvas.width;
    base.height = canvas.height;
    base.getContext('2d').drawImage(canvas, 0, 0);
    canvas.width = 0;
    base.style.width = `${pw}px`;
    base.style.height = `${ph}px`;
    base.style.visibility = 'visible';
    this._busy(false);
    this._paint();
  }

  // Renders only what is on screen, at device resolution, then swaps it in.
  async _renderDetail() {
    const page = this.page;
    if (!page) return;
    this.detailTask?.cancel();
    const { W, H } = this;
    const dpr = Math.min(this.dpr, 2);
    const v = { ...this.view, W, H };
    const off = document.createElement('canvas');
    off.width = Math.round(W * dpr);
    off.height = Math.round(H * dpr);
    const viewport = page.getViewport({ scale: v.s * dpr, offsetX: v.tx * dpr, offsetY: v.ty * dpr });
    const task = page.render({ canvas: off, viewport });
    this.detailTask = task;
    try {
      await task.promise;
    } catch {
      off.width = 0;
      return;
    }
    if (this.detailTask !== task || this.page !== page) { off.width = 0; return; }
    const detail = this.el.detail;
    detail.width = off.width;
    detail.height = off.height;
    // Copy only the part covered by the sheet; outside it the stage background shows through.
    const x0 = Math.max(0, Math.floor(v.tx * dpr)), y0 = Math.max(0, Math.floor(v.ty * dpr));
    const x1 = Math.min(off.width, Math.ceil((v.tx + this.pw * v.s) * dpr));
    const y1 = Math.min(off.height, Math.ceil((v.ty + this.ph * v.s) * dpr));
    if (x1 > x0 && y1 > y0) {
      detail.getContext('2d').drawImage(off, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
    }
    off.width = 0;
    detail.style.width = `${W}px`;
    detail.style.height = `${H}px`;
    detail.style.visibility = 'visible';
    this.detailView = v;
    this._paint();
  }

  _busy(on) {
    this.el.busy.hidden = !on;
  }

  // ---------------------------------------------------------------- ink

  _clear(ctx) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  }

  _drawInk() {
    const ctx = this.inkCtx;
    this._clear(ctx);
    if (!this.inkVisible || !this.page) return;
    const { s, tx, ty } = this.view;
    const d = this.dpr;
    ctx.setTransform(d * s, 0, 0, d * s, d * tx, d * ty);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // While erasing, show the strokes that would remain.
    const strokes = this.drawing?.remaining || this.strokes;
    // Halo behind lassoed ink and behind ink attached to the pin whose details are open.
    ctx.strokeStyle = 'rgba(255, 194, 26, 0.6)';
    for (const stroke of strokes) {
      if (!this.selection?.has(stroke) && !(this.focusPinId && stroke.pin === this.focusPinId)) continue;
      ctx.lineWidth = stroke.w + 9 / s;
      ctx.stroke(pathOf(stroke));
    }
    for (const stroke of strokes) {
      ctx.strokeStyle = stroke.c;
      ctx.lineWidth = stroke.w;
      ctx.stroke(pathOf(stroke));
    }
  }

  _commit(strokes) {
    const h = this.history.get(this.pageNum);
    h.undo.push(this.strokes);
    if (h.undo.length > UNDO_LIMIT) h.undo.shift();
    h.redo.length = 0;
    this._setStrokes(strokes);
  }

  _setStrokes(strokes) {
    this.strokes = strokes;
    this._setSelection(null);
    const { doc, pageNum } = this;
    if (strokes.length) this.inked.add(pageNum); else this.inked.delete(pageNum);
    db.putInk(doc.id, pageNum, strokes, doc.projectId).catch((err) => this.onError(err, 'Ink could not be saved'));
    this._markThumb();
    this._syncToolbar();
    this._invalidate();
  }

  undo() {
    const h = this.history?.get(this.pageNum);
    if (!h?.undo.length || this.drawing) return;
    h.redo.push(this.strokes);
    this._showInk(true);
    this._setStrokes(h.undo.pop());
  }

  redo() {
    const h = this.history?.get(this.pageNum);
    if (!h?.redo.length || this.drawing) return;
    h.undo.push(this.strokes);
    this._showInk(true);
    this._setStrokes(h.redo.pop());
  }

  _showInk(on) {
    this.inkVisible = on;
    this._syncToolbar();
    this._invalidate();
  }

  // ---------------------------------------------------------------- pins

  _renderPins() {
    this.pinEls.clear();
    const els = [];
    if (this.page) {
      for (const pin of this.pins) {
        if (pin.page !== this.pageNum) continue;
        const el = document.createElement('div');
        el.className = `pin${missingFields(pin).length ? ' incomplete' : ''}`;
        el.dataset.id = pin.id;
        el.setAttribute('role', 'button');
        el.setAttribute('aria-label', `Device ${pin.tag}`);
        el.style.setProperty('--c', typeOf(pin.type).color);
        el.innerHTML = `<span class="pin-dot"></span><span class="pin-tag">${esc(pin.tag)}</span>`;
        this.pinEls.set(pin.id, el);
        els.push(el);
      }
    }
    this.el.pinLayer.replaceChildren(...els);
    this._invalidate();
  }

  async _dropPin(page, x, y, type, preset) {
    const { doc } = this;
    try {
      const pin = await createPin({ projectId: doc.projectId, docId: doc.id, page, x, y, type, preset });
      if (this.doc !== doc) return;
      this.pins.push(pin);
      this._renderPins();
      this._openPin(pin.id);
    } catch (err) {
      this.onError(err, 'The pin was not saved');
    }
  }

  _openPin(id) {
    const { doc } = this;
    this.focusPinId = id;
    this._invalidate();
    this.sheet.open(id, {
      onChange: (pin, pinId) => {
        if (this.doc !== doc) return;
        this.pins = this.pins.filter((p) => p.id !== pinId);
        if (pin && pin.docId === doc.id) this.pins.push(pin);
        this._renderPins();
      },
      onClose: () => { this.focusPinId = null; this._invalidate(); },
    });
  }

  _tapPin(id) {
    if (this.selection) this._attach(id); else this._openPin(id);
  }

  // ---------------------------------------------------------------- lasso

  _setSelection(strokes) {
    this.selection = strokes?.size ? strokes : null;
    const el = this.el;
    el.lassoBar.hidden = !this.selection;
    if (this.selection) {
      const n = this.selection.size;
      el.lassoText.textContent = `${n} stroke${n === 1 ? '' : 's'} selected — tap a pin to attach`;
      el.lassoDetach.hidden = ![...this.selection].some((st) => st.pin);
    }
    this._invalidate();
  }

  _lasso(poly) {
    const picked = new Set();
    if (poly.length >= 6) {
      for (const stroke of this.strokes) {
        const a = stroke.p;
        let inside = 0;
        for (let i = 0; i < a.length; i += 2) if (insidePolygon(a[i], a[i + 1], poly)) inside++;
        if (inside >= (a.length / 2) * LASSO_INSIDE) picked.add(stroke);
      }
    }
    if (!picked.size) toast('No ink inside the loop.');
    this._setSelection(picked);
  }

  _attach(pinId) {
    const sel = this.selection;
    const pin = this.pins.find((p) => p.id === pinId);
    if (!sel || !pin) return;
    this._commit(this.strokes.map((st) => (sel.has(st) ? { ...st, pin: pinId } : st)));
    toast(`${sel.size} stroke${sel.size === 1 ? '' : 's'} attached to ${pin.tag}`);
  }

  _detach() {
    const sel = this.selection;
    if (!sel) return;
    this._commit(this.strokes.map((st) => {
      if (!sel.has(st) || !st.pin) return st;
      const { pin, ...rest } = st;
      return rest;
    }));
    toast('Ink detached');
  }

  // ---------------------------------------------------------------- pointer input

  // Abandons whatever the pen is doing (page change, close).
  _dropPointers() {
    clearTimeout(this.holdTimer);
    this.drawing = null;
    this.pinPress = null;
    this.menuPointer = null;
    this.mousePan = null;
  }

  // The pen has rested in one spot: discard the dot it drew and offer the pin menu.
  _longPress() {
    const d = this.drawing;
    if (!d || (d.erase && d.remaining !== this.strokes)) return;
    this.drawing = null;
    this._clear(this.liveCtx);
    this._drawInk();
    const [px, py] = this._toPage(d.x0, d.y0);
    const { s, tx, ty } = this.view;
    const page = this.pageNum;
    this.menuPointer = d.id;
    this.radial.open(this.rect.left + px * s + tx, this.rect.top + py * s + ty,
      (type, preset) => this._dropPin(page, px, py, type, preset));
  }

  _bindPointer() {
    const stage = this.el.stage;
    stage.addEventListener('pointerdown', (e) => this._down(e));
    stage.addEventListener('pointermove', (e) => this._move(e));
    stage.addEventListener('pointerup', (e) => this._up(e, false));
    stage.addEventListener('pointercancel', (e) => this._up(e, true));
    stage.addEventListener('contextmenu', (e) => e.preventDefault());
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!this.page || this.drawing) return;
      this._stopAnim();
      const p = this._pos(e);
      this._zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0015)));
    }, { passive: false });
  }

  _pos(e) {
    const r = this.rect || this.el.stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _down(e) {
    if (!this.page) return;
    e.preventDefault();
    this.rect = this.el.stage.getBoundingClientRect();
    const type = e.pointerType;
    const now = performance.now();

    if (type === 'touch') {
      // Palm rejection: no touches while the pen is down or has just lifted, and no
      // large contact patches while the pen is hovering nearby.
      const size = Math.max(e.width || 0, e.height || 0);
      const penNear = now - this.penSeenAt < 1500;
      if (this.drawing || now - this.penUpAt < PALM_QUIET_MS || size > 80 || (penNear && size > 45)
        || this.touches.size >= 2) {
        this.ignored.add(e.pointerId);
        return;
      }
      this._stopAnim();
      this._capture(e);
      const p = this._pos(e);
      const pinId = e.target.closest?.('.pin')?.dataset.id;
      this.touches.set(e.pointerId, { x: p.x, y: p.y, x0: p.x, y0: p.y, t0: now, pinId });
      if (this.touches.size > 1) this.lastTap = null;
      return;
    }

    if (type === 'pen') this.penSeenAt = now;
    if (type === 'mouse' && e.button !== 0) {       // middle / right button drags the sheet
      this._capture(e);
      this.mousePan = { id: e.pointerId, ...this._pos(e) };
      return;
    }
    if (this.drawing || this.pinPress || this.menuPointer != null) return;

    // Pen (or left mouse button on a desktop) draws. Any fingers already down are a palm.
    for (const id of this.touches.keys()) this.ignored.add(id);
    this.touches.clear();
    this._stopAnim();
    this._capture(e);
    const pinEl = e.target.closest?.('.pin');
    if (pinEl) {                                   // tap opens the pin, drag moves it
      const pin = this.pins.find((q) => q.id === pinEl.dataset.id);
      if (pin) this.pinPress = { id: e.pointerId, pin, ...this._pos(e), moved: false };
      return;
    }
    // Pen eraser end (button 5 / buttons 32) and the barrel button both erase.
    const erase = this.tool === 'eraser' || e.button === 5 || (e.buttons & 32) !== 0
      || (type === 'pen' && (e.button === 2 || (e.buttons & 2) !== 0));
    const p = this._pos(e);
    if (!this.inkVisible) this._showInk(true);
    const lasso = !erase && this.tool === 'lasso';
    this.drawing = { id: e.pointerId, erase, lasso, x: p.x, y: p.y, x0: p.x, y0: p.y };
    clearTimeout(this.holdTimer);
    this.holdTimer = setTimeout(() => this._longPress(), LONG_PRESS_MS);
    if (erase) {
      this.drawing.remaining = this.strokes;
      this._eraseTo(p.x, p.y);
    } else {
      this.drawing.pts = [];
      this.drawing.width = PEN_WIDTH_PX / this.view.s;
      this._addPoint(p.x, p.y, true);
      const ctx = this.liveCtx;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.setLineDash(lasso ? [7, 7] : []);
      ctx.strokeStyle = ctx.fillStyle = lasso ? '#111' : COLORS[this.color];
      ctx.lineWidth = lasso ? 2 : PEN_WIDTH_PX;
      ctx.beginPath();
      ctx.arc(p.x, p.y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _capture(e) {
    try { this.el.stage.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
  }

  _move(e) {
    const type = e.pointerType;
    if (type === 'pen') this.penSeenAt = performance.now();
    const id = e.pointerId;

    if (this.menuPointer === id) {
      this.radial.track(e.clientX, e.clientY);
      return;
    }

    if (this.pinPress?.id === id) {
      const press = this.pinPress;
      const p = this._pos(e);
      // Pins stay put while ink is selected, so a tap-to-attach can't nudge one.
      if (!press.moved && !this.selection && Math.hypot(p.x - press.x, p.y - press.y) > HOLD_SLOP_PX) press.moved = true;
      if (press.moved) {
        [press.pin.x, press.pin.y] = this._toPage(p.x, p.y).map(round2);
        this._invalidate();
      }
      return;
    }

    if (this.drawing?.id === id) {
      e.preventDefault();
      const start = this.drawing;
      const batch = e.getCoalescedEvents?.() || [];
      for (const ev of batch.length ? batch : [e]) {
        const p = this._pos(ev);
        if (Math.hypot(p.x - start.x0, p.y - start.y0) > HOLD_SLOP_PX) clearTimeout(this.holdTimer);
        if (this.drawing.erase) this._eraseTo(p.x, p.y); else this._inkTo(p.x, p.y);
      }
      return;
    }

    if (this.mousePan?.id === id) {
      const p = this._pos(e);
      this._setView(this.view.s, this.view.tx + p.x - this.mousePan.x, this.view.ty + p.y - this.mousePan.y);
      this.mousePan.x = p.x; this.mousePan.y = p.y;
      return;
    }

    const touch = this.touches.get(id);
    if (!touch) return;
    e.preventDefault();
    const p = this._pos(e);
    if (this.touches.size === 1) {
      this._setView(this.view.s, this.view.tx + p.x - touch.x, this.view.ty + p.y - touch.y);
    } else {
      // Two fingers: zoom about the midpoint and follow it, using before/after positions.
      const other = [...this.touches.entries()].find(([k]) => k !== id)[1];
      const d0 = Math.hypot(touch.x - other.x, touch.y - other.y) || 1;
      const d1 = Math.hypot(p.x - other.x, p.y - other.y) || 1;
      const m0x = (touch.x + other.x) / 2, m0y = (touch.y + other.y) / 2;
      const m1x = (p.x + other.x) / 2, m1y = (p.y + other.y) / 2;
      const { min, max } = this._limits();
      const { s, tx, ty } = this.view;
      const s2 = clamp(s * (d1 / d0), min, max);
      this._setView(s2, m1x - (m0x - tx) * (s2 / s), m1y - (m0y - ty) * (s2 / s));
    }
    touch.x = p.x; touch.y = p.y;
  }

  _up(e, cancelled) {
    const id = e.pointerId;
    const now = performance.now();
    if (this.ignored.delete(id)) return;

    if (this.menuPointer === id) {
      this.menuPointer = null;
      if (e.pointerType === 'pen') this.penUpAt = this.penSeenAt = now;
      if (cancelled) this.radial.close(); else this.radial.release(e.clientX, e.clientY);
      return;
    }

    if (this.pinPress?.id === id) {
      const press = this.pinPress;
      this.pinPress = null;
      if (e.pointerType === 'pen') this.penUpAt = this.penSeenAt = now;
      if (press.moved) db.putPin(press.pin).catch((err) => this.onError(err, 'The pin was not saved'));
      else if (!cancelled) this._tapPin(press.pin.id);
      return;
    }

    if (this.drawing?.id === id) {
      if (e.pointerType === 'pen') this.penUpAt = this.penSeenAt = now;
      this._finishStroke();
      return;
    }
    if (this.mousePan?.id === id) { this.mousePan = null; return; }

    const touch = this.touches.get(id);
    if (!touch) return;
    this.touches.delete(id);
    if (cancelled || this.touches.size) { this.lastTap = null; return; }
    // Double tap toggles between fit and a close-up of the tapped spot.
    const isTap = now - touch.t0 < 280 && Math.hypot(touch.x - touch.x0, touch.y - touch.y0) < 12;
    if (!isTap) { this.lastTap = null; return; }
    if (touch.pinId) { this.lastTap = null; this._tapPin(touch.pinId); return; }
    const last = this.lastTap;
    if (last && now - last.t < 320 && Math.hypot(touch.x - last.x, touch.y - last.y) < 40) {
      this.lastTap = null;
      const fit = this._fitView();
      if (this.view.s > fit.s * 1.4) {
        this._animateTo(fit);
      } else {
        const s2 = Math.min(fit.s * 3.5, this._limits().max);
        const k = s2 / this.view.s;
        this._animateTo({ s: s2, tx: touch.x - (touch.x - this.view.tx) * k, ty: touch.y - (touch.y - this.view.ty) * k });
      }
    } else {
      this.lastTap = { t: now, x: touch.x, y: touch.y };
    }
  }

  // Screen point -> page point, kept on the sheet.
  _toPage(x, y) {
    const { s, tx, ty } = this.view;
    return [clamp((x - tx) / s, 0, this.pw), clamp((y - ty) / s, 0, this.ph)];
  }

  _addPoint(x, y, force) {
    const d = this.drawing;
    if (!force && Math.hypot(x - d.x, y - d.y) < 1) return false;   // drop sub-pixel jitter
    const [px, py] = this._toPage(x, y);
    d.pts.push(round2(px), round2(py));
    return true;
  }

  _inkTo(x, y) {
    const d = this.drawing;
    const fromX = d.x, fromY = d.y;
    if (!this._addPoint(x, y, false)) return;
    const ctx = this.liveCtx;
    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.lineTo(x, y);
    ctx.stroke();
    d.x = x; d.y = y;
  }

  _eraseTo(x, y) {
    const d = this.drawing;
    const [ax, ay] = this._toPage(d.x, d.y);
    const [bx, by] = this._toPage(x, y);
    const r = ERASER_RADIUS_PX / this.view.s;
    const kept = d.remaining.filter((stroke) => !strokeHit(stroke, ax, ay, bx, by, r));
    if (kept.length !== d.remaining.length) {
      d.remaining = kept;
      this._invalidate();
    }
    d.x = x; d.y = y;
    const ctx = this.liveCtx;
    this._clear(ctx);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#111';
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.beginPath();
    ctx.arc(x, y, ERASER_RADIUS_PX, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  _finishStroke() {
    const d = this.drawing;
    this.drawing = null;
    clearTimeout(this.holdTimer);
    this.liveCtx.setLineDash([]);
    if (d.erase) {
      if (d.remaining !== this.strokes) this._commit(d.remaining);
    } else if (d.lasso) {
      this._lasso(d.pts);
    } else if (d.pts.length) {
      this._commit([...this.strokes, { c: COLORS[this.color], w: round2(d.width), p: d.pts }]);
    }
    // Paint the committed ink before wiping the live layer so the stroke never blinks.
    this._drawInk();
    this._clear(this.liveCtx);
  }

  // ---------------------------------------------------------------- toolbar

  _bindToolbar() {
    const el = this.el;
    el.pens.forEach((btn, i) => {
      btn.style.setProperty('--ink', COLORS[i]);
      btn.addEventListener('click', () => { this.tool = 'pen'; this.color = i; this._setSelection(null); this._syncToolbar(); });
    });
    const pick = (tool) => { this.tool = tool; this._setSelection(null); this._syncToolbar(); };
    el.eraser.addEventListener('click', () => pick('eraser'));
    el.lasso.addEventListener('click', () => pick('lasso'));
    el.lassoDetach.addEventListener('click', () => this._detach());
    el.lassoCancel.addEventListener('click', () => this._setSelection(null));
    el.undo.addEventListener('click', () => this.undo());
    el.redo.addEventListener('click', () => this.redo());
    el.eye.addEventListener('click', () => this._showInk(!this.inkVisible));
    el.fit.addEventListener('click', () => this.fit());
    el.prev.addEventListener('click', () => this.goto(this.pageNum - 1));
    el.next.addEventListener('click', () => this.goto(this.pageNum + 1));
    el.thumbsBtn.addEventListener('click', () => this._setThumbsOpen(el.thumbs.hidden));
    el.pageLabel.addEventListener('click', () => this._setThumbsOpen(el.thumbs.hidden));
    el.thumbs.addEventListener('click', (e) => {
      const item = e.target.closest('[data-page]');
      if (item) this.goto(Number(item.dataset.page));
    });
    window.addEventListener('keydown', (e) => {
      if (!this.pdf || this.sheet.dlg.open || e.target.closest?.('input, textarea, select, dialog')) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); }
      else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); this.redo(); }
      else if (e.key === 'PageDown' || e.key === 'ArrowRight') this.goto(this.pageNum + 1);
      else if (e.key === 'PageUp' || e.key === 'ArrowLeft') this.goto(this.pageNum - 1);
    });
  }

  _syncToolbar() {
    const el = this.el;
    const total = this.pdf?.numPages || 0;
    const h = this.history?.get(this.pageNum);
    el.pens.forEach((btn, i) => btn.setAttribute('aria-pressed', String(this.tool === 'pen' && this.color === i)));
    el.eraser.setAttribute('aria-pressed', String(this.tool === 'eraser'));
    el.lasso.setAttribute('aria-pressed', String(this.tool === 'lasso'));
    el.eye.setAttribute('aria-pressed', String(!this.inkVisible));
    el.eye.querySelector('use').setAttribute('href', this.inkVisible ? '#i-eye' : '#i-eye-off');
    el.eye.setAttribute('aria-label', this.inkVisible ? 'Hide ink' : 'Show ink');
    el.undo.disabled = !h?.undo.length;
    el.redo.disabled = !h?.redo.length;
    el.prev.disabled = !total || this.pageNum <= 1;
    el.next.disabled = !total || this.pageNum >= total;
    el.pageLabel.textContent = total ? `${this.pageNum} / ${total}` : '–';
  }

  // ---------------------------------------------------------------- thumbnails

  _setThumbsOpen(open) {
    this.el.thumbs.hidden = !open;
    this.el.thumbsBtn.setAttribute('aria-pressed', String(open));
    localStorage.setItem('thumbsOpen', open ? '1' : '0');
    if (open) this._markThumb(true);
  }

  _buildThumbs() {
    const { pdf, el } = this;
    const items = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const item = document.createElement('button');
      item.className = 'thumb';
      item.dataset.page = n;
      item.setAttribute('aria-label', `Page ${n}`);
      item.innerHTML = `<span class="thumb-img"></span><span class="thumb-num">${n}</span>`;
      items.push(item);
    }
    el.thumbs.replaceChildren(...items);
    // Thumbnails render lazily, one at a time, as they scroll into view.
    this.thumbQueue = [];
    this.thumbObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        this.thumbObserver.unobserve(entry.target);
        this.thumbQueue.push(entry.target);
      }
      this._pumpThumbs();
    }, { root: el.thumbs, rootMargin: '300px' });
    items.forEach((item) => this.thumbObserver.observe(item));
  }

  async _pumpThumbs() {
    if (this.thumbBusy) return;
    this.thumbBusy = true;
    const { pdf, doc } = this;
    try {
      while (this.thumbQueue.length && this.pdf === pdf) {
        const item = this.thumbQueue.shift();
        const n = Number(item.dataset.page);
        let blob = await db.getThumb(doc.id, n);
        if (!blob) {
          blob = await renderThumb(await pdf.getPage(n));
          if (blob) db.putThumb(doc.id, n, blob).catch(() => {});
        }
        if (this.pdf !== pdf || !blob) continue;
        const url = URL.createObjectURL(blob);
        this.thumbUrls.push(url);
        const img = new Image();
        img.alt = '';
        img.src = url;
        item.querySelector('.thumb-img').replaceChildren(img);
      }
    } catch (err) {
      if (this.pdf === pdf) console.warn('Thumbnail failed', err);
    } finally {
      this.thumbBusy = false;
    }
  }

  _markThumb(scroll = true) {
    for (const item of this.el.thumbs.children) {
      const n = Number(item.dataset.page);
      const current = n === this.pageNum;
      item.classList.toggle('current', current);
      item.classList.toggle('inked', !!this.inked?.has(n));
      if (current && scroll && !this.el.thumbs.hidden) item.scrollIntoView({ block: 'nearest' });
    }
  }
}
