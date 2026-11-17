// Validation is intentionally pure so malformed, incomplete or incompatible
// backups can be rejected before any existing project is modified.
const FORMAT = 'af-field-backup';
const VERSION = 1;
const MAX = {
  docs: 5000, ink: 100000, pins: 250000, photos: 250000, presets: 20000,
};
export const MAX_ENTRY_BYTES = {
  'backup.json': 32 * 1024 * 1024,
  files: 400 * 1024 * 1024,
  thumbs: 8 * 1024 * 1024,
  photos: 100 * 1024 * 1024,
};

const idOK = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
const bad = (message) => { throw new Error('Backup validation failed: ' + message); };
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const posInt = (v) => Number.isInteger(v) && v > 0;
const list = (data, name) => {
  if (!Array.isArray(data[name])) bad('missing or invalid "' + name + '" list.');
  if (data[name].length > MAX[name]) bad('too many entries in "' + name + '" list.');
  return data[name];
};
const uniqueIds = (records, name) => {
  const ids = new Set();
  for (const record of records) {
    if (!idOK(record?.id)) bad('invalid ' + name + ' ID.');
    if (ids.has(record.id)) bad('duplicate ' + name + ' ID: ' + record.id);
    ids.add(record.id);
  }
  return ids;
};

export function validateBackup(data) {
  if (!data || data.format !== FORMAT || !idOK(data.project?.id)
      || typeof data.project.name !== 'string' || !data.project.name.trim())
    bad('this ZIP is not a supported AF Field backup.');
  if (!Number.isInteger(data.version) || data.version < 1)
    bad('missing or invalid format version.');
  if (data.version > VERSION) bad('this backup is from a newer app version. Update the app.');
  if (!finite(data.project.updated) || !finite(data.project.created))
    bad('invalid project timestamps.');
  const docs = list(data, 'docs');
  const ink = list(data, 'ink');
  const pins = list(data, 'pins');
  const photos = list(data, 'photos');
  const presets = list(data, 'presets');
  const docIds = uniqueIds(docs, 'drawing');
  const pinIds = uniqueIds(pins, 'device');
  uniqueIds(photos, 'photo');
  uniqueIds(presets, 'preset');
  const photoSequences = new Set();

  for (const doc of docs) {
    if (doc.projectId !== data.project.id || typeof doc.name !== 'string'
        || !posInt(doc.size) || !Number.isInteger(doc.pageCount) || doc.pageCount < 0)
      bad('invalid drawing record: ' + doc.id);
  }
  for (const pin of pins) {
    if (pin.projectId !== data.project.id || !posInt(pin.created) || !finite(pin.updated)
        || typeof pin.tag !== 'string' || !pin.tag.trim()
        || typeof pin.type !== 'string' || !Array.isArray(pin.fields)
        || pin.fields.some((field) => typeof field?.name !== 'string'
            || typeof field?.value !== 'string'))
      bad('invalid device record: ' + pin.id);
    if (pin.docId != null && (!docIds.has(pin.docId) || !posInt(pin.page)))
      bad('device references a nonexistent drawing/page: ' + pin.id);
    // Duplicate tags are not rejected: projects created before tag allocation
    // was made atomic can legitimately contain them. See renameDuplicateTags.
  }
  for (const photo of photos) {
    if (photo.projectId !== data.project.id || !pinIds.has(photo.pinId)
        || !posInt(photo.seq) || !posInt(photo.size))
      bad('invalid photo record: ' + photo.id);
    const sequenceKey = photo.pinId + ':' + photo.seq;
    if (photoSequences.has(sequenceKey)) bad('duplicate photo sequence: ' + sequenceKey);
    photoSequences.add(sequenceKey);
  }
  const inkKeys = new Set();
  for (const record of ink) {
    if (!docIds.has(record?.docId) || !posInt(record.page)
        || !Array.isArray(record.strokes) || record.strokes.length > 100000)
      bad('invalid ink page record.');
    const key = record.docId + ':' + record.page;
    if (inkKeys.has(key)) bad('duplicate ink page record: ' + key);
    inkKeys.add(key);
    for (const stroke of record.strokes) {
      if (typeof stroke?.c !== 'string' || !finite(stroke.w) || stroke.w <= 0
          || !Array.isArray(stroke.p) || stroke.p.length < 2
          || stroke.p.length % 2 !== 0 || stroke.p.some((v) => !finite(v))
          || (stroke.pin != null && !pinIds.has(stroke.pin)))
        bad('invalid ink stroke or dangling device attachment.');
    }
  }
  for (const preset of presets) {
    if (typeof preset.type !== 'string' || typeof preset.name !== 'string'
        || !Array.isArray(preset.fields)
        || preset.fields.some((field) => typeof field !== 'string'))
      bad('invalid preset: ' + preset.id);
  }
  const required = new Set(['backup.json']);
  const allowed = new Set(required);
  const expectedSizes = new Map();
  for (const doc of docs) {
    const name = 'files/' + doc.id + '.pdf';
    required.add(name);
    expectedSizes.set(name, doc.size);
    allowed.add('thumbs/' + doc.id + '.jpg');
  }
  for (const photo of photos) {
    const name = 'photos/' + photo.id + '.jpg';
    required.add(name);
    expectedSizes.set(name, photo.size);
  }
  for (const name of required) allowed.add(name);
  return { required, allowed, expectedSizes };
}

export function entryLimit(name) {
  if (name === 'backup.json') return MAX_ENTRY_BYTES['backup.json'];
  const folder = name.split('/')[0];
  return MAX_ENTRY_BYTES[folder] ?? 0;
}

export function verifyBackupEntry(name, bytes, manifest) {
  const maximum = entryLimit(name);
  if (!maximum || !bytes?.byteLength || bytes.byteLength > maximum)
    bad('invalid or oversized archive entry: ' + name);
  const expected = manifest?.expectedSizes.get(name);
  if (expected != null && bytes.byteLength !== expected)
    bad('wrong file size for ' + name + '.');
  if (name.startsWith('files/') && !hasPdfHeader(bytes))
    bad('PDF file header is invalid: ' + name);
  if ((name.startsWith('photos/') || name.startsWith('thumbs/'))
      && !(bytes[0] === 255 && bytes[1] === 216))
    bad('JPEG file header is invalid: ' + name);
}

// PDF readers (including pdf.js, which accepts drawings on import) look for
// the %PDF- header anywhere in the first 1024 bytes, not only at offset 0.
export function hasPdfHeader(bytes) {
  const end = Math.min(bytes.length - 5, 1024);
  for (let i = 0; i <= end; i++) {
    if (bytes[i] === 37 && bytes[i + 1] === 80 && bytes[i + 2] === 68
        && bytes[i + 3] === 70 && bytes[i + 4] === 45) return true;
  }
  return false;
}

// Older projects may hold the same tag on several devices (case-insensitive).
// Keep the earliest-created device's tag and give later ones a unique suffix,
// so such backups restore instead of being rejected. Mutates pins in place
// and returns [{ id, from, to }] for each renamed device.
export function renameDuplicateTags(pins) {
  const key = (tag) => tag.trim().toLowerCase();
  const taken = new Set(pins.map((pin) => key(pin.tag)));
  const kept = new Set();
  const renamed = [];
  const ordered = [...pins].sort((a, b) => (a.created - b.created) || (a.id < b.id ? -1 : 1));
  for (const pin of ordered) {
    const base = pin.tag.trim();
    if (!kept.has(key(base))) { kept.add(key(base)); continue; }
    let n = 2, tag;
    do tag = base + ' (' + n++ + ')'; while (taken.has(key(tag)));
    taken.add(key(tag));
    kept.add(key(tag));
    renamed.push({ id: pin.id, from: pin.tag, to: tag });
    pin.tag = tag;
  }
  return renamed;
}
