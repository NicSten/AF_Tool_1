import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange as FakeKeyRange } from 'fake-indexeddb';
import { uniquePhotoNames } from '../js/photo-names.js';

globalThis.indexedDB = new IDBFactory();
globalThis.IDBKeyRange = FakeKeyRange;
const db = await import('../js/db.js');

const pin = (projectId, id, tag = '') => ({
  id, projectId, tag, docId: null, page: null, x: 0, y: 0,
  type: 'breaker', fields: [], notes: '', created: Date.now(), updated: Date.now(),
});

test('simultaneous breaker additions receive distinct auto-generated tags', async () => {
  const project = await db.createProject('Concurrent');
  const count = 20;
  const records = await Promise.all(Array.from({ length: count }, (_, i) =>
    db.putPin(pin(project.id, 'pin-' + i), { autoPrefix: 'BKR' })));
  assert.deepEqual(
    records.map((p) => p.tag).sort(),
    Array.from({ length: count }, (_, i) => 'BKR-' + String(i + 1).padStart(3, '0')),
  );
  assert.equal((await db.listPins(project.id)).length, count);
});

test('the database rejects duplicate custom tags case-insensitively', async () => {
  const project = await db.createProject('Uniqueness');
  const first = await db.putPin(pin(project.id, 'one', 'MAIN/1'));
  assert.equal(first.tag, 'MAIN/1');
  await assert.rejects(
    db.putPin(pin(project.id, 'two', 'main/1')), /already in use/);
  assert.equal(await db.getPin('two'), undefined);
  assert.equal((await db.listPins(project.id)).length, 1);
  // Renaming a pin to its own current tag is legitimate.
  await db.putPin({ ...first, tag: 'MAIN/1' });
});

test('deleting a pin removes only its ink attachments and photos', async () => {
  const project = await db.createProject('Detach ink');
  const doc = await db.addDoc(project.id, 'One line.pdf', new Uint8Array([1, 2]).buffer);
  const p1 = await db.putPin({ ...pin(project.id, 'delete-me', 'BKR-1'), docId: doc.id, page: 1 });
  const p2 = await db.putPin({ ...pin(project.id, 'keep-me', 'BKR-2'), docId: doc.id, page: 1 });
  const original = [
    { pin: p1.id, c: 'red', w: 1, p: [2, 4] },
    { pin: p2.id, c: 'blue', w: 1, p: [3, 8] },
    { c: 'green', w: 1, p: [1, 1] },
  ];
  await db.putInk(doc.id, 1, original, project.id);
  const photo = await db.addPhoto(p1, new Uint8Array([1, 2, 3]).buffer);
  await db.deletePin(p1.id);
  const after = await db.getInk(doc.id, 1);
  assert.equal(after.length, 3);
  assert.equal('pin' in after[0], false);
  assert.equal(after[1].pin, p2.id);
  assert.deepEqual(after[2], original[2]);
  assert.equal(await db.getPin(p1.id), undefined);
  assert.equal(await db.getPhotoData(photo.id), undefined);
});

test('photo names do not collide after sanitizing tags', () => {
  const pins = [{ id: 'a', tag: 'A/1' }, { id: 'b', tag: 'A:1' }, { id: 'c', tag: 'a_1' }];
  const byPin = new Map([
    ['a', [{ id: 'p1', seq: 1 }]],
    ['b', [{ id: 'p2', seq: 1 }]],
    ['c', [{ id: 'p3', seq: 1 }]],
  ]);
  const fn = (p, photo) => p.tag.replace(/[/:]/g, '_') + '_0' + photo.seq + '.jpg';
  const result = uniquePhotoNames(pins, byPin, fn);
  assert.deepEqual([...result.values()], ['A_1_01.jpg', 'A_1_01 (2).jpg', 'a_1_01 (3).jpg']);
  assert.equal(new Set([...result.values()].map((s) => s.toLowerCase())).size, 3);
});

test('the new service worker retains an existing version until reload is requested', async () => {
  const { readFile } = await import('node:fs/promises');
  const sw = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  const installBlock = sw.slice(sw.indexOf("self.addEventListener('install'"), sw.indexOf("self.addEventListener('message'"));
  assert.doesNotMatch(installBlock, /skipWaiting\(\)/);
  assert.match(sw, /ACTIVATE_UPDATE/);
  assert.match(sw, /await caches\.delete\(CACHE\)/);
  assert.doesNotMatch(sw, /cache\.put\(request/);
});
