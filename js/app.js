// App shell: routing between screens, project and drawing management, PDF import,
// the device list, the preset manager, export / backup, and offline plumbing.

import * as db from './db.js';
import { closePdf, openPdf, renderThumb } from './pdf.js';
import { createPin, missingFields, PinSheet } from './pins.js';
import { TYPES, typeOf } from './types.js';
import { busy, dialog, esc, offerFile, plural, safeName, showError, toast } from './ui.js';
import { Viewer } from './viewer.js';

const $ = (sel) => document.querySelector(sel);
const views = {
  projects: $('#view-projects'), project: $('#view-project'), pins: $('#view-pins'),
  presets: $('#view-presets'), viewer: $('#view-viewer'),
};

const fmtSize = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB`
  : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`);
const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const fmtDateTime = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// Wraps event handlers so a failure is shown instead of vanishing.
const guard = (fn) => async (...args) => {
  try { await fn(...args); } catch (err) { showError(err); }
};

const sheet = new PinSheet();
const viewer = new Viewer(views.viewer, { sheet });

// ---------------------------------------------------------------- projects screen

async function showProjects() {
  const projects = await db.listProjects();
  $('#project-list').innerHTML = projects.length ? projects.map((p) => `
    <div class="card" data-id="${esc(p.id)}" data-name="${esc(p.name)}">
      <a class="card-main" href="#/p/${esc(p.id)}">
        <div class="card-text">
          <div class="card-name">${esc(p.name)}</div>
          <div class="card-meta">${plural(p.docCount, 'drawing')} · ${plural(p.pinCount, 'device')} · ${fmtDate(p.updated)}</div>
          ${backupWarning(p, p.docCount + p.pinCount) ? `<div class="card-warn">⚠ ${esc(backupWarning(p, 1))}</div>` : ''}
        </div>
      </a>
      <div class="card-actions">
        <button data-act="rename" aria-label="Rename project"><svg class="icon"><use href="#i-edit"/></svg></button>
        <button data-act="delete" aria-label="Delete project"><svg class="icon"><use href="#i-trash"/></svg></button>
      </div>
    </div>`).join('')
    : '<div class="empty"><strong>No projects yet</strong>Create a project, then add its one-line PDFs. Everything is stored on this tablet and works without signal.</div>';
  updateStatus();
}

// Text of the backup warning for a project, or '' when none is due.
function backupWarning(project, contentCount) {
  if (!contentCount || !db.needsBackup(project)) return '';
  return project.lastBackup
    ? `Changes since last backup (${fmtDateTime(project.lastBackup)})`
    : 'Never backed up';
}

$('#btn-new-project').addEventListener('click', guard(async () => {
  const name = await dialog({ title: 'New project', value: '', ok: 'Create' });
  if (!name) return;
  const project = await db.createProject(name);
  location.hash = `#/p/${project.id}`;
}));

$('#project-list').addEventListener('click', guard(async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const { id, name } = btn.closest('.card').dataset;
  if (btn.dataset.act === 'rename') {
    const next = await dialog({ title: 'Rename project', value: name, ok: 'Save' });
    if (next) await db.renameProject(id, next);
  } else {
    const yes = await dialog({
      title: `Delete “${name}”?`,
      body: 'All drawings, ink, devices and photos in this project will be permanently removed from this tablet.',
      ok: 'Delete', danger: true,
    });
    if (yes) await db.deleteProject(id);
  }
  showProjects();
}));

$('#btn-restore').addEventListener('click', () => $('#restore-input').click());

$('#restore-input').addEventListener('change', guard(async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const { readBackup, restoreBackup } = await import('./exporter.js');
  const backup = await busy('Reading backup…', () => readBackup(file));
  try {
    const { project, docs, pins, exported } = backup.data;
    const existing = await db.getProject(project.id);
    const renamed = backup.renamedTags?.length
      ? ` ${plural(backup.renamedTags.length, 'device')} shared a tag with another device and will be renamed (for example ${backup.renamedTags[0].from} → ${backup.renamedTags[0].to}).`
      : '';
    const summary = `${plural(docs.length, 'drawing')} and ${plural(pins.length, 'device')}, backed up ${fmtDateTime(exported)}.${renamed}`;
    const yes = await dialog(existing ? {
      title: `Replace “${existing.name}”?`,
      body: `This project is already on this tablet. Restoring replaces it with the backup: ${summary} Anything added since that backup will be lost.`,
      ok: 'Replace', danger: true,
    } : { title: `Restore “${project.name}”?`, body: `The backup holds ${summary}`, ok: 'Restore' });
    if (!yes) return;
    await busy('Restoring…', () => restoreBackup(backup));
    toast(`“${project.name}” restored`);
    showProjects();
  } finally {
    // Cancelled restores and failed confirmations must not consume storage.
    await db.clearRestoreStaging(backup.stageId);
  }
}));

// ---------------------------------------------------------------- project (drawings) screen

let currentProject = null;
let cardThumbUrls = [];

async function showProject(id) {
  const project = await db.getProject(id);
  if (!project) { location.hash = '#/'; return; }
  currentProject = project;
  $('#project-title').textContent = project.name;
  $('#btn-project-devices').href = `#/p/${id}/pins`;
  const [docs, pins] = await Promise.all([db.listDocs(id), db.listPins(id)]);
  const warning = backupWarning(project, docs.length + pins.length);
  $('#backup-warning').hidden = !warning;
  $('#backup-warning-text').textContent = warning;
  cardThumbUrls.forEach((u) => URL.revokeObjectURL(u));
  cardThumbUrls = [];
  const thumbs = await Promise.all(docs.map((d) => db.getThumb(d.id, 1).catch(() => null)));
  $('#doc-list').innerHTML = docs.length ? docs.map((d, i) => {
    let style = '';
    if (thumbs[i]) {
      const url = URL.createObjectURL(thumbs[i]);
      cardThumbUrls.push(url);
      style = ` style="background-image:url(${url})"`;
    }
    const pinned = pins.filter((p) => p.docId === d.id).length;
    return `
    <div class="card" data-id="${esc(d.id)}" data-name="${esc(d.name)}">
      <a class="card-main" href="#/d/${esc(d.id)}">
        <div class="card-thumb"${style}></div>
        <div class="card-text">
          <div class="card-name">${esc(d.name)}</div>
          <div class="card-meta">${plural(d.pageCount, 'page')} · ${plural(pinned, 'device')} · ${fmtSize(d.size)}</div>
        </div>
      </a>
      <div class="card-actions">
        <button data-act="rename" aria-label="Rename drawing"><svg class="icon"><use href="#i-edit"/></svg></button>
        <button data-act="delete" aria-label="Delete drawing"><svg class="icon"><use href="#i-trash"/></svg></button>
      </div>
    </div>`;
  }).join('')
    : '<div class="empty"><strong>No drawings yet</strong>Tap “Add PDFs” to copy one-line diagrams onto this tablet.</div>';
}

$('#btn-add-pdf').addEventListener('click', () => $('#file-input').click());

$('#file-input').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  const project = currentProject;
  if (!files.length || !project) return;
  let added = 0;
  for (const [i, file] of files.entries()) {
    toast(`Adding ${i + 1} of ${files.length}: ${file.name}`);
    let doc;
    try {
      const buffer = await file.arrayBuffer();
      doc = await db.addDoc(project.id, file.name.replace(/\.pdf$/i, ''), buffer);
      // Open it once to confirm it is a readable PDF, count pages and make the cover thumbnail.
      const pdf = await openPdf(buffer);
      try {
        await db.updateDoc(doc.id, { pageCount: pdf.numPages });
        const thumb = await renderThumb(await pdf.getPage(1));
        if (thumb) await db.putThumb(doc.id, 1, thumb);
      } finally {
        closePdf(pdf);
      }
      added++;
    } catch (err) {
      if (doc) await db.deleteDoc(doc.id).catch(() => {});
      const reason = err?.name === 'PasswordException' ? 'it is password protected'
        : err?.name === 'InvalidPDFException' ? 'it is not a valid PDF' : null;
      if (reason) toast(`“${file.name}” was not added: ${reason}.`, true);
      else showError(err, `“${file.name}” was not added`);
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  if (added) toast(`${plural(added, 'drawing')} added`);
  if (currentProject === project && route().view === 'project') showProject(project.id);
});

$('#doc-list').addEventListener('click', guard(async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const { id, name } = btn.closest('.card').dataset;
  if (btn.dataset.act === 'rename') {
    const next = await dialog({ title: 'Rename drawing', value: name, ok: 'Save' });
    if (next) await db.updateDoc(id, { name: next });
  } else {
    const yes = await dialog({
      title: `Delete “${name}”?`,
      body: 'The PDF and its ink will be permanently removed from this tablet. Devices pinned on it stay in the device list, without a location.',
      ok: 'Delete', danger: true,
    });
    if (yes) await db.deleteDoc(id);
  }
  showProject(currentProject.id);
}));

// ---- export & backup

// The native save picker must be requested directly from the button gesture,
// before PDF processing or an awaited import causes activation to expire.
async function directFileWriter(name) {
  if (!window.showSaveFilePicker) return { writable: null };
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: name,
      types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }],
    });
    return { writable: await handle.createWritable() };
  } catch (err) {
    if (err?.name === 'AbortError') return { cancelled: true };
    throw err;
  }
}

// OPFS output files can be removed when the user is finished. For a normal
// browser download, retain the File snapshot while the download starts.
async function releaseArchive(result, delivery) {
  if (delivery === 'download') {
    setTimeout(() => result.cleanup?.(), 120000);
  } else {
    await result.cleanup?.();
  }
}

$('#btn-export').addEventListener('click', guard(async () => {
  const project = currentProject;
  const { writable, cancelled } = await directFileWriter(safeName(project.name) + '_export.zip');
  if (cancelled) return;
  const result = await busy('Preparing export…', async (setStatus) => {
    const { exportProject } = await import('./exporter.js');
    return exportProject(project.id, setStatus, { writable });
  });
  let delivery = 'saved';
  try {
    if (!writable) delivery = await offerFile(result.blob, result.name);
    if (delivery === 'saved') toast('Export file saved.');
    else if (delivery === 'share') toast('Archive handed to the selected app.');
    else if (delivery === 'download') toast('Download started; check that the file appears in Downloads.');
  } finally {
    await releaseArchive(result, delivery);
  }
}));

const backupNow = guard(async () => {
  const project = currentProject;
  const { writable, cancelled } = await directFileWriter(safeName(project.name) + '_backup.zip');
  if (cancelled) return;
  const result = await busy('Preparing backup…', async (setStatus) => {
    const { backupProject } = await import('./exporter.js');
    return backupProject(project.id, setStatus, { writable });
  });
  let delivery = 'saved', verified = !!writable;
  try {
    if (!writable) {
      delivery = await offerFile(result.blob, result.name);
      if (delivery) {
        verified = !!(await dialog({
          title: 'Confirm the backup was saved',
          body: delivery === 'download'
            ? 'Check that the ZIP is present in Downloads before confirming. The browser cannot verify that a download completed.'
            : 'Confirm that your selected app saved or transferred the ZIP successfully. Sharing alone does not guarantee a durable copy.',
          ok: 'I verified the file',
        }));
      }
    }
    if (verified) {
      await db.setBackedUp(project.id, result.time, result.snapshotUpdated);
      toast('Backup verified: ' + result.name);
    } else {
      toast('Backup warning remains until a saved copy is verified.', true);
    }
    if (currentProject === project && route().view === 'project') showProject(project.id);
  } finally {
    await releaseArchive(result, delivery);
  }
});
$('#btn-backup').addEventListener('click', backupNow);
$('#btn-backup-now').addEventListener('click', backupNow);

// ---------------------------------------------------------------- device list

const pinFilter = { type: 'all', missingOnly: false };

async function showPins(projectId) {
  const project = await db.getProject(projectId);
  if (!project) { location.hash = '#/'; return; }
  currentProject = project;
  $('#pins-title').textContent = `Devices — ${project.name}`;
  $('#pins-back').href = `#/p/${projectId}`;
  const [pins, docs, photos] = await Promise.all([db.listPins(projectId), db.listDocs(projectId), db.listProjectPhotos(projectId)]);
  const docById = new Map(docs.map((d) => [d.id, d]));
  const photoCount = new Map();
  photos.forEach((p) => photoCount.set(p.pinId, (photoCount.get(p.pinId) || 0) + 1));
  const incomplete = pins.filter((p) => missingFields(p).length);

  const chip = (key, label, count, pressed) => `<button class="chip" data-filter="${key}" aria-pressed="${pressed}">${esc(label)}<b>${count}</b></button>`;
  $('#pin-filters').innerHTML = chip('all', 'All', pins.length, pinFilter.type === 'all')
    + TYPES.map((t) => chip(t.id, t.label, pins.filter((p) => p.type === t.id).length, pinFilter.type === t.id)).join('')
    + chip('missing', '⚠ Missing fields', incomplete.length, pinFilter.missingOnly);

  const shown = pins.filter((p) => (pinFilter.type === 'all' || p.type === pinFilter.type)
    && (!pinFilter.missingOnly || missingFields(p).length));
  $('#pin-list').innerHTML = shown.length ? shown.map((p) => {
    const type = typeOf(p.type);
    const missing = missingFields(p);
    const doc = docById.get(p.docId);
    const n = photoCount.get(p.id) || 0;
    return `
    <button class="row" data-id="${esc(p.id)}">
      <span><span class="row-tag" style="--c:${type.color}">${esc(p.tag)}</span></span>
      <span>${esc(type.label)}<br><span class="row-sub">${esc(p.presetName || 'No preset')}</span></span>
      <span class="row-sub">${doc ? `${esc(doc.name)} · page ${p.page}` : 'Not on a drawing'}</span>
      ${missing.length
    ? `<span class="row-missing">⚠ ${missing.length} missing: ${esc(missing.slice(0, 3).join(', '))}${missing.length > 3 ? '…' : ''}</span>`
    : '<span class="row-ok">Complete</span>'}
      <span class="row-photos">${n ? plural(n, 'photo') : 'No photos'}</span>
    </button>`;
  }).join('')
    : `<div class="empty"><strong>${pins.length ? 'No devices match' : 'No devices yet'}</strong>${pins.length
      ? 'Change the filter above.'
      : 'Open a drawing and long-press with the pen to drop a pin, or tap “Add device” for equipment that is not on a drawing.'}</div>`;
}

$('#pin-filters').addEventListener('click', guard(async (e) => {
  const key = e.target.closest('[data-filter]')?.dataset.filter;
  if (!key) return;
  if (key === 'missing') pinFilter.missingOnly = !pinFilter.missingOnly; else pinFilter.type = key;
  await showPins(currentProject.id);
}));

const refreshPins = () => { if (route().view === 'pins') showPins(currentProject.id).catch(showError); };

$('#pin-list').addEventListener('click', guard(async (e) => {
  const id = e.target.closest('.row')?.dataset.id;
  if (!id) return;
  const pin = await db.getPin(id);
  if (!pin) return;
  // Pins on a drawing jump to their spot; devices without a location open their details.
  if (pin.docId) location.hash = `#/d/${pin.docId}/pin/${pin.id}`;
  else await sheet.open(id, { onChange: refreshPins });
}));

function pickType() {
  const dlg = $('#type-picker');
  $('#type-picker-list').innerHTML = TYPES.map((t) => `<button class="btn" data-type="${t.id}" style="--c:${t.color}">${esc(t.label)}</button>`).join('');
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue || null), { once: true }));
}
$('#type-picker-list').addEventListener('click', (e) => {
  const type = e.target.closest('[data-type]')?.dataset.type;
  if (type) $('#type-picker').close(type);
});
$('#type-picker-cancel').addEventListener('click', () => $('#type-picker').close(''));

$('#btn-add-device').addEventListener('click', guard(async () => {
  const type = await pickType();
  if (!type) return;
  const pin = await createPin({ projectId: currentProject.id, type });
  await showPins(currentProject.id);
  await sheet.open(pin.id, { onChange: refreshPins });
}));

// ---------------------------------------------------------------- preset manager

let presetType = TYPES[0].id;

async function showPresets() {
  const presets = await db.listPresets();
  $('#preset-types').innerHTML = TYPES.map((t) => `<button class="chip" data-type="${t.id}" aria-pressed="${t.id === presetType}">${esc(t.label)}<b>${presets.filter((p) => p.type === t.id).length}</b></button>`).join('');
  const shown = presets.filter((p) => p.type === presetType);
  $('#preset-list').innerHTML = shown.length ? shown.map((p) => `
    <div class="card" data-id="${esc(p.id)}">
      <div class="card-main">
        <div class="card-text">
          <div class="card-name">${esc(p.name)}</div>
          <div class="preset-fields">${p.fields.length ? esc(p.fields.join(' · ')) : 'No fields'}</div>
        </div>
      </div>
      <div class="card-actions">
        <button data-act="edit" aria-label="Edit preset"><svg class="icon"><use href="#i-edit"/></svg></button>
        <button data-act="delete" aria-label="Delete preset"><svg class="icon"><use href="#i-trash"/></svg></button>
      </div>
    </div>`).join('')
    : `<div class="empty"><strong>No ${esc(typeOf(presetType).label.toLowerCase())} presets</strong>Tap “Add preset” to create one.</div>`;
}

const presetFieldRow = (value = '') => `
  <div class="field">
    <input type="text" autocomplete="off" maxlength="40" placeholder="Field name" value="${esc(value)}">
    <button type="button" data-remove aria-label="Remove field">✕</button>
  </div>`;

// Resolves with {name, fields} or null.
function editPreset(preset) {
  const dlg = $('#preset-dialog');
  $('#preset-dialog-title').textContent = `${preset ? 'Edit' : 'New'} ${typeOf(presetType).label.toLowerCase()} preset`;
  $('#preset-name').value = preset?.name ?? '';
  $('#preset-fields').innerHTML = (preset?.fields ?? ['']).map(presetFieldRow).join('');
  dlg.returnValue = 'cancel';
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'ok') { resolve(null); return; }
    const fields = [];
    for (const input of $('#preset-fields').querySelectorAll('input')) {
      const name = input.value.trim();
      if (name && !fields.some((f) => f.toLowerCase() === name.toLowerCase())) fields.push(name);
    }
    resolve({ name: $('#preset-name').value.trim(), fields });
  }, { once: true }));
}

$('#preset-add-field').addEventListener('click', () => {
  $('#preset-fields').insertAdjacentHTML('beforeend', presetFieldRow());
  $('#preset-fields').lastElementChild.querySelector('input').focus();
});
$('#preset-fields').addEventListener('click', (e) => e.target.closest('[data-remove]')?.closest('.field').remove());
// Enter in a field name should not submit the whole form.
$('#preset-fields').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });

$('#preset-types').addEventListener('click', guard(async (e) => {
  const type = e.target.closest('[data-type]')?.dataset.type;
  if (!type) return;
  presetType = type;
  await showPresets();
}));

$('#btn-add-preset').addEventListener('click', guard(async () => {
  const result = await editPreset(null);
  if (!result?.name) return;
  await db.putPreset({ id: db.newId(), type: presetType, order: Date.now(), ...result });
  await showPresets();
}));

$('#preset-list').addEventListener('click', guard(async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const preset = (await db.listPresets()).find((p) => p.id === btn.closest('.card').dataset.id);
  if (!preset) return;
  if (btn.dataset.act === 'edit') {
    const result = await editPreset(preset);
    if (result?.name) await db.putPreset({ ...preset, ...result });
  } else {
    const yes = await dialog({
      title: `Delete preset “${preset.name}”?`,
      body: 'Devices already created from it keep their fields.',
      ok: 'Delete', danger: true,
    });
    if (yes) await db.deletePreset(preset.id);
  }
  await showPresets();
}));

// ---------------------------------------------------------------- routing

function route() {
  const hash = location.hash;
  let m;
  if (hash === '#/presets') return { view: 'presets' };
  if ((m = hash.match(/^#\/p\/([^/]+)\/pins$/))) return { view: 'pins', id: m[1] };
  if ((m = hash.match(/^#\/p\/([^/]+)$/))) return { view: 'project', id: m[1] };
  if ((m = hash.match(/^#\/d\/([^/]+)(?:\/pin\/([^/]+))?$/))) return { view: 'viewer', id: m[1], pin: m[2] || null };
  return { view: 'projects' };
}

function show(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
}

async function navigate() {
  const r = route();
  try {
    if (sheet.dlg.open) sheet.dlg.close();
    if (r.view !== 'viewer') await viewer.close();
    if (r.view === 'projects') {
      await showProjects();
      show('projects');
    } else if (r.view === 'presets') {
      await showPresets();
      show('presets');
    } else if (r.view === 'project') {
      await showProject(r.id);
      if (route().view === 'project') show('project');
    } else if (r.view === 'pins') {
      await showPins(r.id);
      if (route().view === 'pins') show('pins');
    } else if (viewer.doc?.id === r.id) {
      show('viewer');                         // already open: just move to the pin
      if (r.pin) await viewer.focusPin(r.pin);
    } else {
      const doc = await db.getDoc(r.id);
      if (!doc) { location.hash = '#/'; return; }
      $('#btn-back').href = `#/p/${doc.projectId}`;
      show('viewer');
      await viewer.open(r.id, r.pin);
    }
  } catch (err) {
    showError(err);
    if (r.view !== 'projects') location.hash = '#/';
  }
}

window.addEventListener('hashchange', navigate);
navigate();

// ---------------------------------------------------------------- offline plumbing

async function updateStatus() {
  const parts = [];
  if (navigator.serviceWorker?.controller) parts.push('Ready to work offline');
  try {
    const { usage, quota } = await navigator.storage.estimate();
    if (quota) parts.push(`${fmtSize(usage)} used of ${fmtSize(quota)} available`);
    parts.push(await navigator.storage.persisted()
      ? 'Storage is protected'
      : 'Storage is not protected — install the app to the home screen so Android keeps the data');
  } catch { /* storage API unavailable */ }
  $('#status').textContent = parts.join(' · ');
}

if ('serviceWorker' in navigator) {
  let reloadForUpdate = false;
  const updateBanner = $('#update-banner');
  const offerUpdate = (registration) => {
    if (!registration.waiting || !navigator.serviceWorker.controller) return;
    updateBanner.hidden = false;
    $('#update-reload').onclick = () => {
      if (!registration.waiting) return;
      reloadForUpdate = true;
      $('#update-reload').disabled = true;
      registration.waiting.postMessage({ type: 'ACTIVATE_UPDATE' });
    };
    $('#update-later').onclick = () => { updateBanner.hidden = true; };
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadForUpdate) location.reload();
    else updateStatus();
  });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((registration) => {
    offerUpdate(registration); // an update might already be waiting
    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      installing?.addEventListener('statechange', () => {
        if (installing.state === 'installed') offerUpdate(registration);
      });
    });
    // Check on app launch, including when the Android PWA was left installed.
    if (navigator.onLine) registration.update().catch((err) => console.warn('Update check failed', err));
  }).catch((err) => console.warn('Service worker failed', err));
}

// Ask the browser not to evict our data under storage pressure.
navigator.storage?.persist?.().then(updateStatus).catch(() => {});
