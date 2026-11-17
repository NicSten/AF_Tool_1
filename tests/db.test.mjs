import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange as FakeKeyRange } from 'fake-indexeddb';

globalThis.indexedDB = new IDBFactory();
globalThis.IDBKeyRange = FakeKeyRange;
const db = await import('../js/db.js');

test('backups from this morning do not hide edits from this afternoon', () => {
  const morning = new Date('2026-11-17T08:00:00').getTime();
  const afternoon = new Date('2026-11-17T15:00:00').getTime();
  assert.equal(db.needsBackup({ updated: afternoon, lastBackup: morning }), true);
  assert.equal(db.needsBackup({ updated: afternoon, lastBackup: afternoon, backedUpThrough: morning }), true);
  assert.equal(db.needsBackup({ updated: morning, lastBackup: afternoon, backedUpThrough: morning }), false);
  assert.equal(db.needsBackup({ updated: afternoon }), true);
});

test('failed restore transaction leaves original drawing, ink and project intact', async () => {
  const project = await db.createProject('Original field survey');
  const doc = await db.addDoc(project.id, 'Original.pdf', new Uint8Array([1, 2, 3]).buffer);
  await db.putInk(doc.id, 1, [{ c: '#1456d9', w: 2, p: [10, 10, 20, 20] }], project.id);
  const replacement = {
    project: { ...project, name: 'Replacement', updated: Date.now() + 10 },
    docs: [{ ...doc, name: 'Replacement.pdf' }],
    ink: [], pins: [], photos: [], presets: [],
  };
  // This fails after old records have been scheduled for deletion,
  // verifying the transaction abort restores every prior record.
  await assert.rejects(db.restoreProject(replacement, { stageId: 'missing-stage' }), /missing drawing/);
  assert.equal((await db.getProject(project.id)).name, 'Original field survey');
  assert.equal((await db.getDoc(doc.id)).name, 'Original.pdf');
  assert.deepEqual([...new Uint8Array(await db.getFile(doc.id))], [1, 2, 3]);
  assert.equal((await db.getInk(doc.id, 1)).length, 1);
  await db.stageRestoreEntry('success-stage', 'files', doc.id, new Uint8Array([8, 9]).buffer);
  await db.restoreProject(replacement, { stageId: 'success-stage' });
  assert.equal((await db.getProject(project.id)).name, 'Replacement');
  assert.equal((await db.getDoc(doc.id)).name, 'Replacement.pdf');
  assert.deepEqual([...new Uint8Array(await db.getFile(doc.id))], [8, 9]);
  assert.deepEqual(await db.getInk(doc.id, 1), []);
});
