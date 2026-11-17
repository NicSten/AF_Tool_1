// Small shared UI helpers: toast, error reporting, prompt/confirm dialog, busy overlay.

const $ = (sel) => document.querySelector(sel);

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Safe as a file name on Android, Windows and inside a ZIP.
export const safeName = (s) => String(s).trim().replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/\s+/g, ' ') || 'untitled';

let toastTimer;
export function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  // A popover sits in the top layer, so it stays visible above open dialogs.
  try { el.hidePopover(); el.showPopover(); } catch { /* popover API unavailable */ }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
    try { el.hidePopover(); } catch { /* not shown */ }
  }, isError ? 6000 : 3000);
}

export function showError(err, context) {
  console.error(err);
  const quota = err?.name === 'QuotaExceededError';
  const detail = quota ? 'The tablet is out of storage space.' : (err?.message || String(err));
  toast(context ? `${context}: ${detail}` : detail, true);
}

// One <dialog> serves prompts and confirmations. Resolves with the text (or true), or null on cancel.
export function dialog({ title, body = '', value = null, ok = 'OK', danger = false }) {
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

// Blocks the screen with a spinner and a status line while `work(setStatus)` runs.
export async function busy(message, work) {
  const dlg = $('#busy');
  const text = $('#busy-text');
  text.textContent = message;
  const block = (e) => e.preventDefault();
  dlg.addEventListener('cancel', block);
  dlg.showModal();
  try {
    return await work((status) => { text.textContent = status; });
  } finally {
    dlg.removeEventListener('cancel', block);
    dlg.close();
  }
}

// Hands a file to the browser's download manager (lands in Downloads on Android).
export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  // Chrome falls back to the name "download" when it meets characters such as an em dash.
  a.download = name.replace(/[\u2012-\u2015]/g, '-').normalize('NFKD').replace(/[^\x20-\x7e]/g, '');
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Present the prepared archive through a fresh user click. Mobile browsers
// require that navigator.share() and anchor.click() run in that click handler.
// A successful share/download attempt is NOT proof the recipient kept the file.
export function offerFile(blob, name) {
  const file = new File([blob], name, { type: 'application/zip' });
  let canShare = typeof navigator.share === 'function';
  if (canShare && navigator.canShare) {
    try { canShare = navigator.canShare({ files: [file] }); }
    catch { canShare = false; }
  }
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `
    <h2>Save or share archive</h2>
    <p>Choose where to store <strong>${esc(name)}</strong>. For backups, keeping a copy in cloud storage or on another device is recommended.</p>
    <div class="dialog-actions" style="flex-wrap:wrap">
      ${canShare ? '<button type="button" class="btn primary" data-save="share">Share / Save to…</button>' : ''}
      <button type="button" class="btn" data-save="download">Download</button>
      <button type="button" class="btn" data-save="cancel">Cancel</button>
    </div>`;
  document.body.append(dlg);
  return new Promise((resolve) => {
    const finish = (method) => {
      dlg.close();
      dlg.remove();
      resolve(method);
    };
    dlg.querySelector('[data-save="share"]')?.addEventListener('click', async () => {
      try {
        await navigator.share({ files: [file], title: name });
        finish('share');
      } catch (err) {
        if (err?.name !== 'AbortError') showError(err, 'Share failed');
      }
    });
    dlg.querySelector('[data-save="download"]').addEventListener('click', () => {
      download(blob, name);
      finish('download');
    });
    dlg.querySelector('[data-save="cancel"]').addEventListener('click', () => finish(null));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(null); });
    dlg.showModal();
  });
}
