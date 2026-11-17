// IndexedDB storage. Everything the app knows lives here, on the device.
//
// Stores
//   projects  {id, name, created, updated}
//   docs      {id, projectId, name, pageCount, size, added, lastPage}
//   files     docId -> ArrayBuffer (the PDF bytes, kept apart so listings stay cheap)
//   ink       [docId, page] -> [{c: color, w: width, p: [x0, y0, x1, y1, ...]}]  (PDF points)
//   thumbs    [docId, page] -> Blob (JPEG)
//   pins      {id, projectId, docId|null, page|null, x, y, type, tag, presetId, presetName,
//              fields: [{name, value}], notes, created, updated}   (docId null = not on a drawing)
//   photos    {id, pinId, projectId, seq, size, created}   (file name is derived from the pin's tag)
//   photoData photoId -> ArrayBuffer (JPEG)
//   presets   {id, type, name, fields: [name], order}   (shared by all projects)
//
// A stroke may carry `pin: pinId` when it has been attached to a device with the lasso.

import { DEFAULT_PRESETS } from './types.js';

const DB_NAME = 'af-field';
const DB_VERSION = 2;

let dbPromise;

function openDb() {
  if (!dbPromise) {
    const opening = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      req.onupgradeneeded = (e) => {
        const db = req.result;
        if (e.oldVersion < 1) {
          db.createObjectStore('projects', { keyPath: 'id' });
          db.createObjectStore('docs', { keyPath: 'id' }).createIndex('projectId', 'projectId');
          db.createObjectStore('files');
          db.createObjectStore('ink');
          db.createObjectStore('thumbs');
        }
        if (e.oldVersion < 2) {
          const pins = db.createObjectStore('pins', { keyPath: 'id' });
          pins.createIndex('projectId', 'projectId');
          pins.createIndex('docId', 'docId');
          const photos = db.createObjectStore('photos', { keyPath: 'id' });
          photos.createIndex('projectId', 'projectId');
          photos.createIndex('pinId', 'pinId');
          db.createObjectStore('photoData');
          const presets = db.createObjectStore('presets', { keyPath: 'id' });
          DEFAULT_PRESETS.forEach((p) => presets.put(p));
        }
      };
      req.onsuccess = () => {
        const connection = req.result;
        // A blocked request may eventually succeed after its caller gave up.
        // Close it rather than caching a handle that no caller owns.
        if (settled) { connection.close(); return; }
        settled = true;
        connection.onversionchange = () => {
          connection.close();
          if (dbPromise === opening) dbPromise = null;
        };
        resolve(connection);
      };
      req.onerror = () => fail(req.error || new Error('Could not open local storage.'));
      req.onblocked = () => fail(new Error('Storage is in use by another tab. Close other copies and retry.'));
    });
    dbPromise = opening;
    opening.catch(() => { if (dbPromise === opening) dbPromise = null; });
  }
  return dbPromise;
}

// Runs fn inside one transaction; resolves with fn's result once the transaction commits.
async function tx(stores, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    let t;
    try { t = db.transaction(stores, mode); }
    catch (err) {
      // A previous connection was invalidated by an upgrade. The next
      // operation will create a fresh connection instead of keeping it forever.
      if (err.name === 'InvalidStateError') dbPromise = null;
      reject(err);
      return;
    }
    let result;
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Storage transaction aborted'));
    Promise.resolve(fn(...[].concat(stores).map((s) => t.objectStore(s))))
      .then((r) => { result = r; })
      .catch((err) => { try { t.abort(); } catch { /* already finished */ } reject(err); });
  });
}

const req = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

export const newId = () => (crypto.randomUUID ? crypto.randomUUID()
  : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

const docRange = (docId) => IDBKeyRange.bound([docId, 0], [docId, Number.MAX_SAFE_INTEGER]);

// ---- projects ----

export async function listProjects() {
  return tx(['projects', 'docs', 'pins'], 'readonly', async (projects, docs, pins) => {
    const list = await req(projects.getAll());
    const docIdx = docs.index('projectId'), pinIdx = pins.index('projectId');
    await Promise.all(list.map(async (p) => {
      [p.docCount, p.pinCount] = await Promise.all([req(docIdx.count(p.id)), req(pinIdx.count(p.id))]);
    }));
    return list.sort((a, b) => b.updated - a.updated);
  });
}

export const getProject = (id) => tx('projects', 'readonly', (s) => req(s.get(id)));

export async function createProject(name) {
  const now = Date.now();
  const project = { id: newId(), name, created: now, updated: now };
  await tx('projects', 'readwrite', (s) => req(s.put(project)));
  return project;
}

export function renameProject(id, name) {
  return tx('projects', 'readwrite', async (s) => {
    const p = await req(s.get(id));
    if (p) await req(s.put({ ...p, name, updated: Date.now() }));
  });
}

export function deleteProject(id) {
  return tx(['projects', 'docs', 'files', 'ink', 'thumbs', 'pins', 'photos', 'photoData'], 'readwrite',
    async (projects, docs, files, ink, thumbs, pins, photos, photoData) => {
      const [docIds, pinIds, photoIds] = await Promise.all([
        req(docs.index('projectId').getAllKeys(id)),
        req(pins.index('projectId').getAllKeys(id)),
        req(photos.index('projectId').getAllKeys(id)),
      ]);
      for (const docId of docIds) {
        docs.delete(docId);
        files.delete(docId);
        ink.delete(docRange(docId));
        thumbs.delete(docRange(docId));
      }
      pinIds.forEach((k) => pins.delete(k));
      photoIds.forEach((k) => { photos.delete(k); photoData.delete(k); });
      projects.delete(id);
    });
}

// Marks the project as changed (drives the "not backed up" warning).
export function touchProject(id) {
  return tx('projects', 'readwrite', async (s) => {
    const p = await req(s.get(id));
    if (p) s.put({ ...p, updated: Date.now() });
  });
}

export function setBackedUp(id, time) {
  return tx('projects', 'readwrite', async (s) => {
    const p = await req(s.get(id));
    if (p) s.put({ ...p, lastBackup: time });
  });
}

// True when the project has changes that are not in a backup and no backup was made today.
export function needsBackup(project) {
  const last = project.lastBackup || 0;
  if (project.updated <= last) return false;
  return new Date(last).toDateString() !== new Date().toDateString();
}

// ---- documents ----

export async function listDocs(projectId) {
  const list = await tx('docs', 'readonly', (s) => req(s.index('projectId').getAll(projectId)));
  return list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

export const getDoc = (id) => tx('docs', 'readonly', (s) => req(s.get(id)));
export const getFile = (docId) => tx('files', 'readonly', (s) => req(s.get(docId)));

export async function addDoc(projectId, name, buffer) {
  const now = Date.now();
  const doc = { id: newId(), projectId, name, pageCount: 0, size: buffer.byteLength, added: now, lastPage: 1 };
  await tx(['projects', 'docs', 'files'], 'readwrite', async (projects, docs, files) => {
    docs.put(doc);
    files.put(buffer, doc.id);
    const p = await req(projects.get(projectId));
    if (p) projects.put({ ...p, updated: now });
  });
  return doc;
}

export function updateDoc(id, patch) {
  return tx('docs', 'readwrite', async (s) => {
    const d = await req(s.get(id));
    if (d) await req(s.put({ ...d, ...patch }));
  });
}

// Devices pinned on the drawing are kept, as devices that are not on a drawing.
export function deleteDoc(id) {
  return tx(['docs', 'files', 'ink', 'thumbs', 'pins', 'projects'], 'readwrite',
    async (docs, files, ink, thumbs, pins, projects) => {
      const doc = await req(docs.get(id));
      for (const pin of await req(pins.index('docId').getAll(id))) {
        pins.put({ ...pin, docId: null, page: null, x: 0, y: 0 });
      }
      docs.delete(id);
      files.delete(id);
      ink.delete(docRange(id));
      thumbs.delete(docRange(id));
      const p = doc && await req(projects.get(doc.projectId));
      if (p) projects.put({ ...p, updated: Date.now() });
    });
}

// ---- ink ----

export async function getInk(docId, page) {
  return (await tx('ink', 'readonly', (s) => req(s.get([docId, page])))) || [];
}

export function putInk(docId, page, strokes, projectId) {
  return tx(['ink', 'projects'], 'readwrite', async (s, projects) => {
    if (strokes.length) s.put(strokes, [docId, page]); else s.delete([docId, page]);
    const p = projectId && await req(projects.get(projectId));
    if (p) projects.put({ ...p, updated: Date.now() });
  });
}

// Page numbers of this document that carry ink.
export async function inkPages(docId) {
  const keys = await tx('ink', 'readonly', (s) => req(s.getAllKeys(docRange(docId))));
  return new Set(keys.map((k) => k[1]));
}

// ---- thumbnails ----

export const getThumb = (docId, page) => tx('thumbs', 'readonly', (s) => req(s.get([docId, page])));
export const putThumb = (docId, page, blob) => tx('thumbs', 'readwrite', (s) => req(s.put(blob, [docId, page])));

// ---- pins (devices) ----

const byTag = (a, b) => a.tag.localeCompare(b.tag, undefined, { numeric: true });

export async function listPins(projectId) {
  return (await tx('pins', 'readonly', (s) => req(s.index('projectId').getAll(projectId)))).sort(byTag);
}

export const listDocPins = (docId) => tx('pins', 'readonly', (s) => req(s.index('docId').getAll(docId)));
export const getPin = (id) => tx('pins', 'readonly', (s) => req(s.get(id)));

// Allocate tags while holding the same readwrite transaction as the insert.
// IndexedDB serializes overlapping write transactions, so simultaneous pin
// creation cannot allocate the same auto tag.
function nextTagFromPins(existing, prefix, exceptId = null) {
  if (typeof prefix !== 'string' || !/^[a-z0-9_-]+$/i.test(prefix))
    throw new Error('Invalid device tag prefix.');
  const escaped = prefix.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp('^' + escaped + '-(\\d+)$', 'i');
  let max = 0;
  for (const pin of existing) {
    if (pin.id === exceptId) continue;
    const match = pattern.exec(pin.tag);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return prefix + '-' + String(max + 1).padStart(3, '0');
}

export function putPin(pin, { autoPrefix = null } = {}) {
  return tx(['pins', 'projects'], 'readwrite', async (pins, projects) => {
    const project = await req(projects.get(pin.projectId));
    if (!project) throw new Error('The project no longer exists.');
    const existing = await req(pins.index('projectId').getAll(pin.projectId));
    const tag = autoPrefix ? nextTagFromPins(existing, autoPrefix, pin.id) : String(pin.tag ?? '').trim();
    if (!tag) throw new Error('A device tag is required.');
    if (existing.some((other) => other.id !== pin.id && other.tag.toLowerCase() === tag.toLowerCase()))
      throw new Error('Device tag "' + tag + '" is already in use in this project.');
    const now = Date.now();
    const saved = { ...pin, tag, updated: now };
    await req(pins.put(saved));
    await req(projects.put({ ...project, updated: now }));
    return saved;
  });
}

// Delete pin metadata and clear every stroke's attachment within ONE
// transaction. The ink itself is retained on its original drawing.
export function deletePin(id) {
  return tx(['pins', 'photos', 'photoData', 'projects', 'docs', 'ink'], 'readwrite',
    async (pins, photos, photoData, projects, docs, ink) => {
      const pin = await req(pins.get(id));
      if (!pin) return;
      for (const key of await req(photos.index('pinId').getAllKeys(id))) {
        photos.delete(key);
        photoData.delete(key);
      }
      for (const docId of await req(docs.index('projectId').getAllKeys(pin.projectId))) {
        for (const key of await req(ink.getAllKeys(docRange(docId)))) {
          const strokes = await req(ink.get(key));
          if (!strokes?.some((stroke) => stroke.pin === id)) continue;
          ink.put(strokes.map((stroke) => {
            if (stroke.pin !== id) return stroke;
            const { pin: attachedPin, ...detached } = stroke;
            return detached;
          }), key);
        }
      }
      pins.delete(id);
      const project = await req(projects.get(pin.projectId));
      if (project) projects.put({ ...project, updated: Date.now() });
    });
}

// Preview only: saving an automatically assigned tag must go through
// putPin(pin, { autoPrefix }) to allocate and write it atomically.
export async function nextTag(projectId, prefix) {
  return nextTagFromPins(await listPins(projectId), prefix);
}

// ---- photos ----

const bySeq = (a, b) => a.seq - b.seq;

export async function listPhotos(pinId) {
  return (await tx('photos', 'readonly', (s) => req(s.index('pinId').getAll(pinId)))).sort(bySeq);
}

export async function listProjectPhotos(projectId) {
  return (await tx('photos', 'readonly', (s) => req(s.index('projectId').getAll(projectId)))).sort(bySeq);
}

export const getPhotoData = (id) => tx('photoData', 'readonly', (s) => req(s.get(id)));

export async function addPhoto(pin, buffer) {
  return tx(['photos', 'photoData', 'projects'], 'readwrite', async (photos, photoData, projects) => {
    const existing = await req(photos.index('pinId').getAll(pin.id));
    const photo = {
      id: newId(), pinId: pin.id, projectId: pin.projectId,
      seq: existing.reduce((m, p) => Math.max(m, p.seq), 0) + 1,
      size: buffer.byteLength, created: Date.now(),
    };
    photos.put(photo);
    photoData.put(buffer, photo.id);
    const p = await req(projects.get(pin.projectId));
    if (p) projects.put({ ...p, updated: Date.now() });
    return photo;
  });
}

export function deletePhoto(photo) {
  return tx(['photos', 'photoData', 'projects'], 'readwrite', async (photos, photoData, projects) => {
    photos.delete(photo.id);
    photoData.delete(photo.id);
    const p = await req(projects.get(photo.projectId));
    if (p) projects.put({ ...p, updated: Date.now() });
  });
}

// ---- presets ----

export async function listPresets() {
  const list = await tx('presets', 'readonly', (s) => req(s.getAll()));
  return list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
}

export const putPreset = (preset) => tx('presets', 'readwrite', (s) => req(s.put(preset)));
export const deletePreset = (id) => tx('presets', 'readwrite', (s) => req(s.delete(id)));

// ---- backup / restore ----

// Everything about a project except the large binaries (PDFs, photos), which the
// caller streams one at a time with getFile / getPhotoData.
export function dumpProject(projectId) {
  return tx(['projects', 'docs', 'ink', 'pins', 'photos', 'presets'], 'readonly',
    async (projects, docs, ink, pins, photos, presets) => {
      const project = await req(projects.get(projectId));
      const docList = await req(docs.index('projectId').getAll(projectId));
      const inkList = [];
      for (const doc of docList) {
        const [keys, values] = await Promise.all([req(ink.getAllKeys(docRange(doc.id))), req(ink.getAll(docRange(doc.id)))]);
        keys.forEach((key, i) => inkList.push({ docId: doc.id, page: key[1], strokes: values[i] }));
      }
      return {
        project,
        docs: docList,
        ink: inkList,
        pins: await req(pins.index('projectId').getAll(projectId)),
        photos: await req(photos.index('projectId').getAll(projectId)),
        presets: await req(presets.getAll()),
      };
    });
}

// Writes a dumped project back. `files`, `photoData` and `thumbs` map ids to binary data.
// Presets that already exist on this device are left as they are.
export async function restoreProject(data, { files, photoData, thumbs }) {
  await deleteProject(data.project.id);
  return tx(['projects', 'docs', 'files', 'ink', 'thumbs', 'pins', 'photos', 'photoData', 'presets'], 'readwrite',
    async (projects, docs, fileStore, ink, thumbStore, pins, photos, photoStore, presets) => {
      projects.put(data.project);
      for (const doc of data.docs) {
        docs.put(doc);
        fileStore.put(files.get(doc.id), doc.id);
        if (thumbs.has(doc.id)) thumbStore.put(thumbs.get(doc.id), [doc.id, 1]);
      }
      data.ink.forEach((entry) => ink.put(entry.strokes, [entry.docId, entry.page]));
      data.pins.forEach((pin) => pins.put(pin));
      for (const photo of data.photos) {
        photos.put(photo);
        photoStore.put(photoData.get(photo.id), photo.id);
      }
      const have = new Set(await req(presets.getAllKeys()));
      data.presets.filter((p) => !have.has(p.id)).forEach((p) => presets.put(p));
    });
}
