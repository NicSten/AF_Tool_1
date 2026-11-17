// Radial menu for dropping a device pin.
//
// Inner ring: the six device types. Outer ring: the presets of the type the pointer
// is over. It is driven two ways:
//   slide  the pen that long-pressed stays down; the viewer feeds track()/release()
//   tap    if the pen lifts in the centre the menu stays open and sectors can be tapped

import { TYPES } from './types.js';

const R_DEAD = 38;      // centre: nothing selected
const R_TYPE = 124;     // outer edge of the type ring
const R_PRESET = 236;   // outer edge of the preset ring
const R_CANCEL = 330;   // releasing beyond this cancels
const SECTOR = 360 / TYPES.length;
const NS = 'http://www.w3.org/2000/svg';

const polar = (r, deg) => [r * Math.cos((deg * Math.PI) / 180), r * Math.sin((deg * Math.PI) / 180)];

function sectorPath(r0, r1, a0, a1) {
  const [x0, y0] = polar(r1, a0), [x1, y1] = polar(r1, a1);
  const [x2, y2] = polar(r0, a1), [x3, y3] = polar(r0, a0);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${x0} ${y0}A${r1} ${r1} 0 ${large} 1 ${x1} ${y1}L${x2} ${y2}A${r0} ${r0} 0 ${large} 0 ${x3} ${y3}Z`;
}

function svg(tag, attrs, text) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
}

const shorten = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export class Radial {
  // getPresets(typeId) -> [{id, name, fields}]
  constructor(overlay, getPresets) {
    this.overlay = overlay;
    this.getPresets = getPresets;
    this.svg = svg('svg', { class: 'radial' });
    overlay.append(this.svg);
    // Tap mode: the overlay itself receives the pointer.
    overlay.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!this.sticky) return;       // while the pen is sliding, other touches are palms
      this.moved = true;
      this.track(e.clientX, e.clientY);
      this.tapPointer = e.pointerId;
    });
    overlay.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.tapPointer) this.track(e.clientX, e.clientY);
    });
    overlay.addEventListener('pointerup', (e) => {
      if (e.pointerId !== this.tapPointer) return;
      this.tapPointer = null;
      this.release(e.clientX, e.clientY, true);
    });
    overlay.addEventListener('pointercancel', () => { this.tapPointer = null; });
    overlay.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get isOpen() { return !this.overlay.hidden; }

  // (x, y) is where the pin will go, in client coordinates. onPick(typeId, preset | null).
  open(x, y, onPick) {
    this.onPick = onPick;
    this.originX = x;
    this.originY = y;
    // Keep the whole menu on screen when the pin is near an edge.
    const m = R_PRESET + 8;
    this.cx = Math.max(m, Math.min(window.innerWidth - m, x));
    this.cy = Math.max(m, Math.min(window.innerHeight - m, y));
    if (window.innerWidth < 2 * m) this.cx = window.innerWidth / 2;
    if (window.innerHeight < 2 * m) this.cy = window.innerHeight / 2;
    this.type = null;
    this.preset = null;
    this.presets = [];
    this.moved = false;
    this.sticky = false;
    this.tappedType = null;
    this.tapPointer = null;
    this.overlay.hidden = false;
    this._draw();
  }

  close() {
    this.overlay.hidden = true;
    this.onPick = null;
  }

  track(x, y) {
    if (!this.isOpen) return;
    // Ignore jitter around the long-press point so nothing is selected by accident.
    if (!this.moved && Math.hypot(x - this.originX, y - this.originY) < 14) return;
    this.moved = true;
    const dx = x - this.cx, dy = y - this.cy;
    const r = Math.hypot(dx, dy);
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;       // -180..180, 0 = right, 90 = down
    let type = this.type, preset = null;
    if (r < R_DEAD) {
      type = null;
    } else if (r < R_TYPE || !type) {
      const turn = ((angle + 90 + SECTOR / 2) % 360 + 360) % 360;   // 0 at the top sector's start
      type = TYPES[Math.floor(turn / SECTOR)].id;
    } else {
      preset = this._presetAt(angle);
    }
    if (type !== this.type) {
      this.type = type;
      this.presets = type ? this.getPresets(type) : [];
      if (r >= R_TYPE) preset = this._presetAt(angle);
    }
    this.preset = preset;
    this.outside = r > R_CANCEL;
    this._draw();
  }

  // Called when the pointer lifts. Returns true when the menu closed.
  release(x, y, tapped = false) {
    if (!this.isOpen) return true;
    this.track(x, y);
    const r = Math.hypot(x - this.cx, y - this.cy);
    if (!tapped && !this.moved) {
      // The pen lifted without leaving the long-press point: stay open for tapping.
      this.sticky = true;
      return false;
    }
    if (!this.type || this.outside) { this.close(); return true; }
    let preset = this.preset;
    if (tapped && r < R_TYPE) {
      // First tap on a type shows its presets; tapping it again drops a pin without one.
      if (this.presets.length && this.tappedType !== this.type) {
        this.tappedType = this.type;
        return false;
      }
      preset = null;
    } else if (tapped && !preset) {
      this.close();
      return true;
    }
    const pick = this.onPick;
    const type = this.type;
    this.close();
    pick?.(type, preset);
    return true;
  }

  _presetSpan() {
    const n = this.presets.length;
    const width = Math.min(34, 320 / Math.max(n, 1));
    const centre = -90 + TYPES.findIndex((t) => t.id === this.type) * SECTOR;
    return { width, start: centre - (n * width) / 2 };
  }

  _presetAt(angle) {
    const n = this.presets.length;
    if (!n) return null;
    const { width, start } = this._presetSpan();
    const offset = (((angle - start) % 360) + 360) % 360;
    const i = Math.floor(offset / width);
    return i < n ? this.presets[i] : null;
  }

  _draw() {
    const g = svg('g', { transform: `translate(${this.cx} ${this.cy})` });
    g.append(svg('circle', { r: R_TYPE + 2, class: 'radial-back' }));
    TYPES.forEach((t, i) => {
      const mid = -90 + i * SECTOR;
      const active = t.id === this.type;
      g.append(svg('path', {
        d: sectorPath(R_DEAD, R_TYPE, mid - SECTOR / 2 + 1, mid + SECTOR / 2 - 1),
        class: `radial-type${active ? ' active' : ''}`, fill: t.color,
      }));
      const [tx, ty] = polar((R_DEAD + R_TYPE) / 2 + 4, mid);
      g.append(svg('text', { x: tx, y: ty, class: 'radial-label' }, t.label));
    });
    if (this.type) {
      const { width, start } = this._presetSpan();
      this.presets.forEach((p, i) => {
        const a0 = start + i * width;
        const active = p === this.preset;
        g.append(svg('path', {
          d: sectorPath(R_TYPE + 6, R_PRESET, a0 + 0.6, a0 + width - 0.6),
          class: `radial-preset${active ? ' active' : ''}`,
        }));
        const [tx, ty] = polar((R_TYPE + R_PRESET) / 2 + 6, a0 + width / 2);
        g.append(svg('text', { x: tx, y: ty, class: `radial-label small${active ? ' active' : ''}` }, shorten(p.name, 13)));
      });
    }
    g.append(svg('circle', { r: R_DEAD - 3, class: 'radial-hub' }));
    g.append(svg('text', { x: 0, y: 0, class: 'radial-label hub' }, this.type ? '✕' : 'PIN'));
    this.svg.replaceChildren(g);
    // Marks the exact spot the pin will land on.
    this.svg.append(svg('circle', { cx: this.originX, cy: this.originY, r: 6, class: 'radial-origin' }));
  }
}
