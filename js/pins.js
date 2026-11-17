// Device pins: creation, the detail sheet (fields, notes, photos) and the in-app camera.

import * as db from './db.js';
import { TYPES, typeOf } from './types.js';
import { dialog, esc, safeName, showError, toast } from './ui.js';

const $ = (sel) => document.querySelector(sel);
const PHOTO_MAX_PX = 6000; // preserve nameplate detail up to 6K on non-JPEG inputs
const PHOTO_QUALITY = 0.82;

export const missingFields = (pin) => pin.fields.filter((f) => !String(f.value ?? '').trim()).map((f) => f.name);

// Photo file names always follow the pin's current tag: BKR-001_01.jpg
export const photoName = (pin, photo) => `${safeName(pin.tag)}_${String(photo.seq).padStart(2, '0')}.jpg`;

export async function createPin({ projectId, docId = null, page = null, x = 0, y = 0, type, preset = null }) {
  const now = Date.now();
  const pin = {
    id: db.newId(), projectId, docId, page, x, y, type,
    tag: '',
    presetId: preset?.id ?? null,
    presetName: preset?.name ?? '',
    fields: (preset?.fields ?? []).map((name) => ({ name, value: '' })),
    notes: '', created: now, updated: now,
  };
  return db.putPin(pin, { autoPrefix: typeOf(type).prefix });
}

// Switches a pin to a preset: its fields come first, values already entered are kept.
function applyPreset(pin, preset) {
  const old = new Map(pin.fields.map((f) => [f.name, f.value]));
  const names = preset?.fields ?? [];
  pin.fields = [
    ...names.map((name) => ({ name, value: old.get(name) ?? '' })),
    ...pin.fields.filter((f) => !names.includes(f.name) && String(f.value).trim()),
  ];
  pin.presetId = preset?.id ?? null;
  pin.presetName = preset?.name ?? '';
}

async function toJpeg(source, sw, sh) {
  if (!(sw > 0 && sh > 0)) throw new Error('The camera did not provide a valid image.');
  const k = Math.min(1, PHOTO_MAX_PX / Math.max(sw, sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sw * k));
  canvas.height = Math.max(1, Math.round(sh * k));
  try {
    canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', PHOTO_QUALITY));
    if (!blob) throw new Error('The photo could not be compressed.');
    return blob.arrayBuffer();
  } finally {
    canvas.width = canvas.height = 0;
  }
}

async function photoBytes(blob) {
  // Keep the full sensor JPEG for readable equipment/nameplate text.
  if (/^image\/jpe?g$/i.test(blob.type)) return blob.arrayBuffer();
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  try { return await toJpeg(bitmap, bitmap.width, bitmap.height); }
  finally { bitmap.close(); }
}

// ---------------------------------------------------------------- camera

class Camera {
  constructor() {
    this.dlg = $('#camera');
    this.video = $('#camera-video');
    this.fileInput = $('#camera-file');
    this.help = $('#camera-help');
    this.useApp = $('#camera-use-app');
    this.torchButton = $('#camera-torch');
    this.zoomControl = $('#camera-zoom');
    this.zoomLabel = $('#camera-zoom-label');
    this.shootButton = $('#camera-shoot');
    this.shootButton.addEventListener('click', () => this._shoot());
    $('#camera-done').addEventListener('click', () => this.dlg.close());
    this.dlg.addEventListener('close', () => this._stop());

    // Must run directly inside this click handler. Clicking the hidden input
    // after an awaited permission prompt loses user activation on Android.
    this.useApp.addEventListener('click', () => {
      this._stop();
      this._fallback('Use your tablet camera or choose an existing image.');
      this.fileInput.click();
    });
    this.torchButton.addEventListener('click', async () => {
      if (!this.track) return;
      const next = !this.torchOn;
      try {
        await this.track.applyConstraints({ advanced: [{ torch: next }] });
        this.torchOn = next;
        this.torchButton.setAttribute('aria-pressed', String(next));
        this.torchButton.textContent = next ? 'Light on' : 'Light off';
      } catch (err) { showError(err, 'Camera light unavailable'); }
    });
    this.zoomControl.addEventListener('input', async () => {
      if (!this.track) return;
      try {
        await this.track.applyConstraints({ advanced: [{ zoom: Number(this.zoomControl.value) }] });
      } catch (err) { showError(err, 'Camera zoom unavailable'); }
    });

    this.fileInput.addEventListener('change', async () => {
      const file = this.fileInput.files[0];
      this.fileInput.value = '';
      if (!file) return;
      try {
        if (!file.type.startsWith('image/')) throw new Error('Select a photo file.');
        await this.onPhoto(await photoBytes(file));
        this.count++;
        this._updateCount();
      } catch (err) { showError(err, 'Photo not saved'); }
    });
  }

  _updateCount() { $('#camera-count').textContent = this.count ? this.count + ' taken' : ''; }

  _fallback(message) {
    this.video.hidden = true;
    this.shootButton.hidden = true;
    this.help.hidden = false;
    this.help.textContent = message;
    this.torchButton.hidden = true;
    this.zoomLabel.hidden = true;
  }

  // onPhoto(buffer) is called after each image; the dialog remains available.
  async open(onPhoto) {
    this.onPhoto = onPhoto;
    this.count = 0;
    this._updateCount();
    this.help.hidden = false;
    this.help.textContent = 'Requesting camera access…';
    this.video.hidden = true;
    this.shootButton.hidden = true;
    this.torchButton.hidden = true;
    this.zoomLabel.hidden = true;
    this.useApp.hidden = false;
    const token = this.token = (this.token || 0) + 1;
    if (!this.dlg.open) this.dlg.showModal();
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera API not available.');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } },
      });
      if (token !== this.token || !this.dlg.open) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      this.track = stream.getVideoTracks()[0];
      this.capture = (typeof ImageCapture !== 'undefined' && this.track)
        ? new ImageCapture(this.track) : null;
      this.video.srcObject = stream;
      this.video.hidden = false;
      this.shootButton.hidden = false;
      this.help.hidden = true;
      await this.video.play();
      await this._configureControls();
    } catch (err) {
      console.warn('In-app camera unavailable', err);
      if (token !== this.token || !this.dlg.open) return;
      this._stop();
      this._fallback('The in-app camera is unavailable. Tap "Use camera app" to take or select a photo.');
    }
  }

  async _configureControls() {
    const capabilities = this.track?.getCapabilities?.() || {};
    this.torchOn = false;
    if (capabilities.torch === true) {
      this.torchButton.hidden = false;
      this.torchButton.textContent = 'Light off';
      this.torchButton.setAttribute('aria-pressed', 'false');
    }
    if (capabilities.zoom && capabilities.zoom.max > capabilities.zoom.min) {
      this.zoomLabel.hidden = false;
      this.zoomControl.min = String(capabilities.zoom.min);
      this.zoomControl.max = String(capabilities.zoom.max);
      this.zoomControl.step = String(capabilities.zoom.step || 0.1);
      this.zoomControl.value = String(this.track.getSettings?.().zoom ?? capabilities.zoom.min);
    }
  }

  async _shoot() {
    if (this.shooting || !this.stream) return;
    this.shooting = true;
    this.shootButton.disabled = true;
    const v = this.video;
    v.classList.add('flash');
    setTimeout(() => v.classList.remove('flash'), 120);
    try {
      let bytes = null;
      if (this.capture?.takePhoto) {
        try {
          const settings = {};
          if (this.capture.getPhotoCapabilities) {
            const cap = await this.capture.getPhotoCapabilities();
            if (cap.imageWidth?.max) settings.imageWidth = cap.imageWidth.max;
            if (cap.imageHeight?.max) settings.imageHeight = cap.imageHeight.max;
          }
          bytes = await photoBytes(await this.capture.takePhoto(settings));
        } catch (err) {
          console.warn('Full-resolution still capture failed; using video frame.', err);
        }
      }
      if (!bytes) {
        if (!v.videoWidth) throw new Error('Camera preview is not ready.');
        bytes = await toJpeg(v, v.videoWidth, v.videoHeight);
      }
      await this.onPhoto(bytes);
      this.count++;
      this._updateCount();
    } catch (err) { showError(err, 'Photo not saved'); }
    finally {
      this.shooting = false;
      this.shootButton.disabled = false;
    }
  }

  _stop() {
    this.token = (this.token || 0) + 1;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.track = null;
    this.capture = null;
    this.video.srcObject = null;
    this.torchOn = false;
  }
}

// ---------------------------------------------------------------- detail sheet

export class PinSheet {
  constructor() {
    this.dlg = $('#pin-sheet');
    this.camera = new Camera();
    this.urls = [];
    const el = this.el = {
      tag: $('#pin-tag'), type: $('#pin-type'), preset: $('#pin-preset'), where: $('#pin-where'),
      goto: $('#pin-goto'), fields: $('#pin-fields'), notes: $('#pin-notes'), photos: $('#pin-photos'),
      ink: $('#pin-ink'), chip: $('#pin-chip'),
    };
    el.type.innerHTML = TYPES.map((t) => `<option value="${t.id}">${esc(t.label)}</option>`).join('');

    $('#pin-close').addEventListener('click', () => this.dlg.close());
    this.dlg.addEventListener('close', () => this._closed());
    el.tag.addEventListener('change', () => this._guard(() => this._changeTag()));
    el.type.addEventListener('change', () => this._guard(() => this._changeType()));
    el.preset.addEventListener('change', () => this._guard(async () => {
      this._collect();
      applyPreset(this.pin, this.presets.find((p) => p.id === el.preset.value));
      await this._save();
      this._renderFields();
    }));
    el.fields.addEventListener('change', () => this._guard(() => { this._collect(); return this._save(); }));
    el.fields.addEventListener('input', (e) => e.target.classList.toggle('missing', !e.target.value.trim()));
    el.fields.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-remove]');
      if (!btn) return;
      this._guard(async () => {
        this._collect();
        this.pin.fields.splice(Number(btn.dataset.remove), 1);
        await this._save();
        this._renderFields();
      });
    });
    $('#pin-add-field').addEventListener('click', () => this._guard(async () => {
      const name = await dialog({ title: 'Add field', value: '', ok: 'Add' });
      if (!name) return;
      this._collect();
      if (this.pin.fields.some((f) => f.name.toLowerCase() === name.toLowerCase())) {
        toast(`This device already has a “${name}” field.`, true);
        return;
      }
      this.pin.fields.push({ name, value: '' });
      await this._save();
      this._renderFields();
    }));
    el.notes.addEventListener('change', () => this._guard(() => { this._collect(); return this._save(); }));
    $('#pin-camera').addEventListener('click', () => this._guard(() => {
      const pin = this.pin;
      return this.camera.open(async (buffer) => {
        await db.addPhoto(pin, buffer);
        if (this.pin === pin) await this._renderPhotos();
        this.onChange?.(pin, pin.id);
      });
    }));
    el.photos.addEventListener('click', (e) => {
      const item = e.target.closest('[data-photo]');
      if (item) this._viewPhoto(item.dataset.photo);
    });
    el.goto.addEventListener('click', () => {
      const { docId, id } = this.pin;
      this.dlg.close();
      location.hash = `#/d/${docId}/pin/${id}`;
    });
    $('#pin-delete').addEventListener('click', () => this._guard(async () => {
      const pin = this.pin;
      const yes = await dialog({
        title: `Delete ${pin.tag}?`,
        body: 'The device, its fields, notes and photos will be permanently removed. Ink stays on the drawing.',
        ok: 'Delete', danger: true,
      });
      if (!yes) return;
      await db.deletePin(pin.id);
      this.pin = null;
      this.dlg.close();
      this.onChange?.(null, pin.id);
    }));
    $('#photo-close').addEventListener('click', () => $('#photo-view').close());
    $('#photo-delete').addEventListener('click', () => this._guard(async () => {
      const photo = this.viewing;
      const yes = await dialog({ title: 'Delete this photo?', ok: 'Delete', danger: true });
      if (!yes) return;
      await db.deletePhoto(photo);
      $('#photo-view').close();
      await this._renderPhotos();
      this.onChange?.(this.pin, this.pin.id);
    }));
  }

  // onChange(pin | null, id) fires after every saved change (null = deleted); onClose when dismissed.
  async open(pinId, { onChange, onClose } = {}) {
    const pin = await db.getPin(pinId);
    if (!pin) { toast('That device no longer exists.', true); return; }
    this.pin = pin;
    this.onChange = onChange;
    this.onClose = onClose;
    this.presets = await db.listPresets();
    const el = this.el;
    el.tag.value = pin.tag;
    el.type.value = pin.type;
    el.notes.value = pin.notes;
    this._renderHead();
    this._renderFields();
    const doc = pin.docId && await db.getDoc(pin.docId);
    el.where.textContent = doc ? `${doc.name} · page ${pin.page}` : 'Not on a drawing';
    el.goto.hidden = !doc;
    const attached = doc ? (await db.getInk(pin.docId, pin.page)).filter((s) => s.pin === pin.id).length : 0;
    el.ink.textContent = attached ? `${attached} ink stroke${attached === 1 ? '' : 's'} attached` : '';
    el.ink.hidden = !attached;
    await this._renderPhotos();
    if (!this.dlg.open) this.dlg.showModal();
    this.dlg.scrollTop = 0;
  }

  async _guard(fn) {
    try { await fn(); } catch (err) { showError(err); }
  }

  _renderHead() {
    const { pin, el, presets } = this;
    el.chip.style.background = typeOf(pin.type).color;
    const options = presets.filter((p) => p.type === pin.type);
    // A preset that was deleted or renamed since is still shown for this pin.
    const known = options.some((p) => p.id === pin.presetId);
    el.preset.innerHTML = '<option value="">No preset</option>'
      + (pin.presetId && !known ? `<option value="${esc(pin.presetId)}">${esc(pin.presetName)}</option>` : '')
      + options.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    el.preset.value = pin.presetId ?? '';
  }

  _renderFields() {
    this.el.fields.innerHTML = this.pin.fields.map((f, i) => `
      <div class="field">
        <label for="pin-f${i}">${esc(f.name)}</label>
        <input id="pin-f${i}" data-i="${i}" type="text" autocomplete="off" autocapitalize="characters"
          class="${String(f.value).trim() ? '' : 'missing'}" value="${esc(f.value)}">
        <button type="button" data-remove="${i}" aria-label="Remove field ${esc(f.name)}">✕</button>
      </div>`).join('') || '<p class="hint">No fields. Pick a preset or add fields.</p>';
  }

  async _renderPhotos() {
    const pin = this.pin;
    const photos = await db.listPhotos(pin.id);
    const data = await Promise.all(photos.map((p) => db.getPhotoData(p.id)));
    if (this.pin !== pin) return;
    this.urls.forEach((u) => URL.revokeObjectURL(u));
    this.urls = data.map((buffer) => URL.createObjectURL(new Blob([buffer], { type: 'image/jpeg' })));
    this.photos = photos;
    this.el.photos.innerHTML = photos.map((p, i) => `
      <button type="button" class="photo" data-photo="${esc(p.id)}">
        <img src="${this.urls[i]}" alt=""><span>${esc(photoName(pin, p))}</span>
      </button>`).join('');
  }

  _viewPhoto(id) {
    const i = this.photos.findIndex((p) => p.id === id);
    if (i < 0) return;
    this.viewing = this.photos[i];
    $('#photo-img').src = this.urls[i];
    $('#photo-name').textContent = photoName(this.pin, this.viewing);
    $('#photo-view').showModal();
  }

  // Reads what is typed in the sheet back into the pin object.
  _collect() {
    const { pin, el } = this;
    for (const input of el.fields.querySelectorAll('input[data-i]')) {
      const field = pin.fields[Number(input.dataset.i)];
      if (field) field.value = input.value.trim();
    }
    pin.notes = el.notes.value.trim();
  }

  async _save(options) {
    const pin = this.pin;
    const saved = await db.putPin(pin, options);
    Object.assign(pin, saved);
    this.onChange?.(pin, pin.id);
  }

  async _changeTag() {
    const { pin, el } = this;
    const tag = el.tag.value.trim();
    const clash = tag && (await db.listPins(pin.projectId))
      .some((p) => p.id !== pin.id && p.tag.toLowerCase() === tag.toLowerCase());
    if (!tag || clash) {
      toast(tag ? `${tag} is already used in this project.` : 'A tag is required.', true);
      el.tag.value = pin.tag;
      return;
    }
    const previous = pin.tag;
    pin.tag = tag;
    el.tag.value = tag;
    try { await this._save(); }
    catch (err) {
      pin.tag = previous;
      el.tag.value = previous;
      throw err;
    }
    await this._renderPhotos();     // photo names follow the tag
  }

  async _changeType() {
    const { pin, el } = this;
    const from = typeOf(pin.type);
    this._collect();
    const before = structuredClone(pin);
    pin.type = el.type.value;
    pin.presetId = null;
    pin.presetName = '';
    const autoPrefix = new RegExp('^' + from.prefix + '-\\d+$', 'i').test(pin.tag)
      ? typeOf(pin.type).prefix : null;
    try { await this._save(autoPrefix ? { autoPrefix } : undefined); }
    catch (err) {
      Object.assign(pin, before);
      el.type.value = before.type;
      el.tag.value = before.tag;
      throw err;
    }
    el.tag.value = pin.tag;
    this._renderHead();
    await this._renderPhotos();
  }

  _closed() {
    const pin = this.pin;
    if (pin) {
      // Catch text that was typed but never committed (e.g. closed with the Back key).
      const before = JSON.stringify([pin.fields, pin.notes]);
      this._collect();
      if (JSON.stringify([pin.fields, pin.notes]) !== before) this._guard(() => this._save());
    }
    this.urls.forEach((u) => URL.revokeObjectURL(u));
    this.urls = [];
    this.el.photos.innerHTML = '';
    const onClose = this.onClose;
    this.pin = null;
    this.onClose = null;
    onClose?.();
  }
}
