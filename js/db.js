// IndexedDB storage. Everything the app knows lives here, on the device.
//
// Stores
//   projects  {id, name, created, updated}
//   docs      {id, projectId, name, pageCount, size, added, lastPage}
//   files     docId -> ArrayBuffer (the PDF bytes, kept apart so listings stay cheap)
//   ink       [docId, page] -> [{c: color, w: width, p: [x0, y0, x1, y1, ...]}]  (PDF points)
//   thumbs    [docId, page] -> Blob (JPEG)

const DB_NAME = 'af-field';
const DB_VERSION = 1;

let dbPromise;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('projects', { keyPath: 'id' });
        db.createObjectStore('docs', { keyPath: 'id' }).createIndex('projectId', 'projectId');
        db.createObjectStore('files');
        db.createObjectStore('ink');
        db.createObjectStore('thumbs');
      };
      req.onsuccess = () => {
        req.result.onversionchange = () => req.result.close();
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('Storage is in use by another tab.'));
    });
  }
  return dbPromise;
}

// Runs fn inside one transaction; resolves with fn's result once the transaction commits.
async function tx(stores, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
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

const newId = () => (crypto.randomUUID ? crypto.randomUUID()
  : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

const docRange = (docId) => IDBKeyRange.bound([docId, 0], [docId, Infinity]);

// ---- projects ----

export async function listProjects() {
  return tx(['projects', 'docs'], 'readonly', async (projects, docs) => {
    const list = await req(projects.getAll());
    const idx = docs.index('projectId');
    await Promise.all(list.map(async (p) => { p.docCount = await req(idx.count(p.id)); }));
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
  return tx(['projects', 'docs', 'files', 'ink', 'thumbs'], 'readwrite',
    async (projects, docs, files, ink, thumbs) => {
      const ids = await req(docs.index('projectId').getAllKeys(id));
      for (const docId of ids) {
        docs.delete(docId);
        files.delete(docId);
        ink.delete(docRange(docId));
        thumbs.delete(docRange(docId));
      }
      projects.delete(id);
    });
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

export function deleteDoc(id) {
  return tx(['docs', 'files', 'ink', 'thumbs'], 'readwrite', (docs, files, ink, thumbs) => {
    docs.delete(id);
    files.delete(id);
    ink.delete(docRange(id));
    thumbs.delete(docRange(id));
  });
}

// ---- ink ----

export async function getInk(docId, page) {
  return (await tx('ink', 'readonly', (s) => req(s.get([docId, page])))) || [];
}

export function putInk(docId, page, strokes) {
  return tx('ink', 'readwrite', (s) => req(
    strokes.length ? s.put(strokes, [docId, page]) : s.delete([docId, page]),
  ));
}

// Page numbers of this document that carry ink.
export async function inkPages(docId) {
  const keys = await tx('ink', 'readonly', (s) => req(s.getAllKeys(docRange(docId))));
  return new Set(keys.map((k) => k[1]));
}

// ---- thumbnails ----

export const getThumb = (docId, page) => tx('thumbs', 'readonly', (s) => req(s.get([docId, page])));
export const putThumb = (docId, page, blob) => tx('thumbs', 'readwrite', (s) => req(s.put(blob, [docId, page])));
