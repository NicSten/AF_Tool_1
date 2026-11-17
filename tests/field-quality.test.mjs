import test from 'node:test';
import assert from 'node:assert/strict';
import { csvCell } from '../js/csv.js';
import { validateBackup, verifyBackupEntry, entryLimit } from '../js/backup-validation.js';
import { needsCanvasText } from '../js/pdf-text.js';

const valid = () => ({
  format: 'af-field-backup', version: 1, exported: '2026-11-17T00:00:00Z',
  project: { id: 'survey-1', name: 'Survey', created: 123, updated: 456 },
  docs: [{ id: 'doc-1', projectId: 'survey-1', name: 'SLD.pdf', size: 6, pageCount: 1 }],
  pins: [{
    id: 'pin-1', projectId: 'survey-1', docId: 'doc-1', page: 1,
    tag: 'BKR-001', type: 'breaker', fields: [{ name: 'Frame', value: '400A' }],
    notes: '', created: 123, updated: 456,
  }],
  photos: [{ id: 'photo-1', projectId: 'survey-1', pinId: 'pin-1', seq: 1, size: 4 }],
  ink: [{
    docId: 'doc-1', page: 1,
    strokes: [{ c: '#e0162b', w: 2, p: [1, 1, 2, 2], pin: 'pin-1' }],
  }],
  presets: [{ id: 'preset-1', type: 'breaker', name: 'MCCB', fields: ['Frame'] }],
});

test('spreadsheet formula cells are forced to text without breaking ordinary CSV', () => {
  for (const raw of ['=SUM(1,2)', '+1+2', '-12', '@cmd', '  =1+1', '\t=1+1']) {
    const escaped = csvCell(raw);
    assert.ok(escaped.startsWith("'") || escaped.startsWith('"'), raw + ': ' + escaped);
    assert.ok(escaped.includes("'"), raw + ': expected leading apostrophe');
  }
  assert.equal(csvCell('400 A'), '400 A');
  assert.equal(csvCell('A-10'), 'A-10');
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
  assert.equal(csvCell('=SUM(1,2)'), '"\\'=SUM(1,2)"');
});

test('valid backup metadata carries exact expected sizes and archive paths', () => {
  const manifest = validateBackup(valid());
  assert.equal(manifest.expectedSizes.get('files/doc-1.pdf'), 6);
  assert.ok(manifest.required.has('photos/photo-1.jpg'));
  assert.ok(manifest.allowed.has('thumbs/doc-1.jpg'));
  assert.equal(manifest.allowed.has('photos/unknown.jpg'), false);
  verifyBackupEntry('files/doc-1.pdf', new Uint8Array([37,80,68,70,45,65]), manifest);
  verifyBackupEntry('photos/photo-1.jpg', new Uint8Array([255,216,0,1]), manifest);
});

test('malformed metadata, unexpected references and duplicates are rejected', () => {
  const scenarios = [
    (b) => { b.docs = {}; },
    (b) => { b.photos[0].pinId = 'unknown'; },
    (b) => { b.pins[0].docId = 'unknown'; },
    (b) => { b.pins.push({ ...b.pins[0], id: 'pin-2', tag: 'bkr-001' }); },
    (b) => { b.docs.push({ ...b.docs[0] }); },
    (b) => { b.ink[0].strokes[0].pin = 'unknown'; },
    (b) => { b.photos[0].size = -10; },
    (b) => { b.version = 99; },
  ];
  for (const change of scenarios) {
    const backup = valid(); change(backup);
    assert.throws(() => validateBackup(backup), /Backup validation failed/);
  }
});

test('ZIP files with mismatched sizes and incorrect PDF/JPEG headers are rejected', () => {
  const manifest = validateBackup(valid());
  assert.throws(() => verifyBackupEntry('files/doc-1.pdf', new Uint8Array([1,2,3,4,5,6]), manifest), /PDF file header/);
  assert.throws(() => verifyBackupEntry('photos/photo-1.jpg', new Uint8Array([5,6,7,8]), manifest), /JPEG file header/);
  assert.throws(() => verifyBackupEntry('photos/photo-1.jpg', new Uint8Array([255,216,1,2,3]), manifest), /wrong file size/);
  assert.equal(entryLimit('a.txt'), 0);
  assert.ok(entryLimit('photos/photo.jpg') > 4);
});

test('non-Latin tags request glyph overlays, while ASCII remains vector text', () => {
  assert.equal(needsCanvasText('BKR-001'), false);
  assert.equal(needsCanvasText('Étage 2'), false);
  assert.equal(needsCanvasText('断路器-01'), true);
  assert.equal(needsCanvasText('Щит 10'), true);
  assert.equal(needsCanvasText('Breaker – 1'), true);
});

test('camera fallback is user-click activated instead of automatic after permission', async () => {
  const fs = await import('node:fs/promises');
  const pins = await fs.readFile(new URL('../js/pins.js', import.meta.url), 'utf8');
  assert.match(pins, /this\.useApp\.addEventListener\('click', \(\) => \{/);
  assert.match(pins, /this\.fileInput\.click\(\);/);
  assert.match(pins, /this\.capture\.takePhoto\(settings\)/);
  assert.doesNotMatch(pins, /catch \(err\) \{[\s\S]{0,150}this\.fileInput\.click\(\)/);
});
