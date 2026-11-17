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
