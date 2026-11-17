// App shell: routing between the three screens, project and drawing management,
// PDF import, and offline plumbing (service worker, persistent storage).

import * as db from './db.js';
import { closePdf, openPdf, renderThumb } from './pdf.js';
import { Viewer } from './viewer.js';

const $ = (sel) => document.querySelector(sel);
const views = { projects: $('#view-projects'), project: $('#view-project'), viewer: $('#view-viewer') };

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const fmtSize = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB`
  : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`);
const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

// ---------------------------------------------------------------- toast & dialogs

let toastTimer;
function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 3000);
}

function showError(err, context) {
  console.error(err);
  const quota = err?.name === 'QuotaExceededError';
  const detail = quota ? 'The tablet is out of storage space.' : (err?.message || String(err));
  toast(context ? `${context}: ${detail}` : detail, true);
}

// One <dialog> serves prompts and confirmations. Resolves with the text (or true), or null on cancel.
function dialog({ title, body = '', value = null, ok = 'OK', danger = false }) {
  const dlg = $('#dialog');
  const input = $('#dialog-input');
  const okBtn = $('#dialog-ok');
  $('#dialog-title').textContent = title;
  $('#dialog-body').textContent = body;
  okBtn.textContent = ok;
  okBtn.classList.toggle('danger', danger);
  okBtn.classList.toggle('primary', !danger);
  input.hidden = value === null;
  input.required = value !== null;
  input.value = value ?? '';
  dlg.returnValue = 'cancel';
  dlg.showModal();
  if (value !== null) input.select();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => {
      if (dlg.returnValue !== 'ok') resolve(null);
      else resolve(value === null ? true : input.value.trim() || null);
    }, { once: true });
  });
}

// ---------------------------------------------------------------- projects screen

async function showProjects() {
  const projects = await db.listProjects();
  $('#project-list').innerHTML = projects.length ? projects.map((p) => `
    <div class="card" data-id="${esc(p.id)}" data-name="${esc(p.name)}">
      <a class="card-main" href="#/p/${esc(p.id)}">
        <div class="card-text">
          <div class="card-name">${esc(p.name)}</div>
          <div class="card-meta">${plural(p.docCount, 'drawing')} · ${fmtDate(p.updated)}</div>
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

$('#btn-new-project').addEventListener('click', async () => {
  const name = await dialog({ title: 'New project', value: '', ok: 'Create' });
  if (!name) return;
  const project = await db.createProject(name);
  location.hash = `#/p/${project.id}`;
});

$('#project-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const { id, name } = btn.closest('.card').dataset;
  if (btn.dataset.act === 'rename') {
    const next = await dialog({ title: 'Rename project', value: name, ok: 'Save' });
    if (next) await db.renameProject(id, next);
  } else {
    const yes = await dialog({
      title: `Delete “${name}”?`,
      body: 'All drawings and ink in this project will be permanently removed from this tablet.',
      ok: 'Delete', danger: true,
    });
    if (yes) await db.deleteProject(id);
  }
  showProjects();
});

// ---------------------------------------------------------------- project (drawings) screen

let currentProject = null;
let cardThumbUrls = [];

async function showProject(id) {
  const project = await db.getProject(id);
  if (!project) { location.hash = '#/'; return; }
  currentProject = project;
  $('#project-title').textContent = project.name;
  const docs = await db.listDocs(id);
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
    return `
    <div class="card" data-id="${esc(d.id)}" data-name="${esc(d.name)}">
      <a class="card-main" href="#/d/${esc(d.id)}">
        <div class="card-thumb"${style}></div>
        <div class="card-text">
          <div class="card-name">${esc(d.name)}</div>
          <div class="card-meta">${plural(d.pageCount, 'page')} · ${fmtSize(d.size)}</div>
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

$('#doc-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const { id, name } = btn.closest('.card').dataset;
  if (btn.dataset.act === 'rename') {
    const next = await dialog({ title: 'Rename drawing', value: name, ok: 'Save' });
    if (next) await db.updateDoc(id, { name: next });
  } else {
    const yes = await dialog({
      title: `Delete “${name}”?`,
      body: 'The PDF and all ink on it will be permanently removed from this tablet.',
      ok: 'Delete', danger: true,
    });
    if (yes) await db.deleteDoc(id);
  }
  showProject(currentProject.id);
});

// ---------------------------------------------------------------- routing

const viewer = new Viewer(views.viewer, { onError: showError });

function route() {
  const [, kind, id] = location.hash.match(/^#\/(p|d)\/(.+)$/) || [];
  return kind === 'p' ? { view: 'project', id } : kind === 'd' ? { view: 'viewer', id } : { view: 'projects' };
}

function show(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
}

async function navigate() {
  const r = route();
  try {
    if (r.view !== 'viewer') await viewer.close();
    if (r.view === 'projects') {
      await showProjects();
      show('projects');
    } else if (r.view === 'project') {
      await showProject(r.id);
      if (route().view === 'project') show('project');
    } else {
      const doc = await db.getDoc(r.id);
      if (!doc) { location.hash = '#/'; return; }
      $('#btn-back').href = `#/p/${doc.projectId}`;
      show('viewer');
      await viewer.open(r.id);
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
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker failed', err));
  navigator.serviceWorker.addEventListener('controllerchange', updateStatus);
}

// Ask the browser not to evict our data under storage pressure.
navigator.storage?.persist?.().then(updateStatus).catch(() => {});
