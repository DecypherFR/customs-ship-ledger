// Small UI toolkit: safe HTML templating, formatting, status chips, toasts and dialogs.

class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(String(s));
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const val = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(val).join('') : v === false || v == null ? '' : esc(v));
// html`...` escapes every interpolation unless it is raw() or another html`` result.
export function html(strings, ...vals) {
  return new Raw(strings.reduce((out, s, i) => out + s + (i < vals.length ? val(vals[i]) : ''), ''));
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// The ledger prints dates as dd-mm-yyyy.
export const fmtDate = (d) => (d ? `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}` : '');
export const fmtDateTime = (s) => { if (!s) return ''; const iso = String(s).replace(' ', 'T'); const d = new Date(/(Z|[+-]\d\d:?\d\d)$/.test(iso) ? iso : `${iso}Z`); return d.toLocaleString('en-GB', { timeZone: 'America/Belize', dateStyle: 'medium', timeStyle: 'short' }); };
export const fmtNum = (n) => (n == null || n === '' ? '' : Number(n).toLocaleString('en-US'));
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const fmtMonth = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
export const fmtMonthLong = (m) => new Date(`${m}-15T12:00:00Z`).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

// ---- icons (inline SVG, stroke = currentColor) ----
const P = {
  dash: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  ship: '<path d="M2 20c2 1 4 1 6 0s4-1 6 0 4 1 6 0"/><path d="M4 17l-1-5h18l-2 5"/><path d="M12 12V4"/><path d="M12 4l5 5h-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert: '<path d="M12 3l9.5 17h-19z"/><path d="M12 10v4M12 17.5v.01"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 010 7M18.5 14.8c1.6.9 2.6 2.6 3 5.2"/>',
  cog: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 018 0v3.5"/>',
  check: '<path d="M4.5 12.5l5 5 10-11"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  print: '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M4 20h16"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  history: '<path d="M3 12a9 9 0 103-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  out: '<path d="M15 4h4a1 1 0 011 1v14a1 1 0 01-1 1h-4M10 17l5-5-5-5M15 12H3"/>',
  cloud: '<path d="M7 18a5 5 0 01-.5-10 6 6 0 0111.5 2 4 4 0 01-1 8z"/>',
  cloudoff: '<path d="M7 18a5 5 0 01-.5-10M10 6.3A6 6 0 0118 10a4 4 0 012.5 6.5M3 3l18 18"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  folder: '<path d="M3 6a1 1 0 011-1h5l2 2h9a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1z"/>',
  anchor: '<circle cx="12" cy="5" r="2"/><path d="M12 7v14M5 12H3a9 9 0 0018 0h-2M8 10h8"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/>',
};
export const icon = (name, cls = '') => raw(`<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`);

// ---- status chips: colour + icon + label, never colour alone ----
const CHIP = {
  'IN PORT': ['info', 'anchor'], DEPARTED: ['muted', 'out'], OVERDUE: ['critical', 'alert'], 'EXPIRING SOON': ['warning', 'clock'],
  'LONG STAY': ['serious', 'clock'], 'WITHIN EXTENSION': ['good', 'check'], 'NO EXTENSION': ['muted', 'anchor'],
  PENDING: ['warning', 'clock'], APPROVED: ['good', 'check'], REJECTED: ['critical', 'x'], VERIFIED: ['good', 'lock'],
  OPEN: ['serious', 'folder'], 'IN PROGRESS': ['warning', 'folder'], REFERRED: ['info', 'folder'], CLOSED: ['muted', 'check'],
  'PENDING SYNC': ['warning', 'cloudoff'],
};
export const chip = (label, title = '') => {
  const [tone, ic] = CHIP[label] || ['muted', 'info'];
  return html`<span class="chip chip-${tone}" title="${title}">${icon(ic)}${label}</span>`;
};

// ---- toasts ----
export function toast(msg, tone = 'info') {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast toast-${tone}`; el.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  el.textContent = msg; box.append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, tone === 'error' ? 6000 : 3500);
}

// ---- dialogs ----
// openDialog(title, bodyHtml, { onSubmit(form) -> truthy closes, submitLabel, danger })
export function openDialog(title, body, { onSubmit, submitLabel = 'Save', danger = false, wide = false } = {}) {
  const d = document.createElement('dialog');
  d.className = `dlg ${wide ? 'dlg-wide' : ''}`;
  d.innerHTML = String(html`<form method="dialog" class="dlg-form" novalidate>
    <header class="dlg-head"><h2>${title}</h2><button type="button" class="icon-btn" data-close aria-label="Close">${icon('x')}</button></header>
    <div class="dlg-body">${body}<p class="form-error" role="alert" hidden></p></div>
    ${onSubmit ? html`<footer class="dlg-foot"><button type="button" class="btn" data-close>Cancel</button>
      <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" type="submit">${submitLabel}</button></footer>` : ''}
  </form>`);
  document.body.append(d);
  const form = d.querySelector('form');
  const close = () => { d.close(); d.remove(); };
  d.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  d.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!onSubmit) return close();
    const btn = form.querySelector('[type=submit]'); btn.disabled = true;
    try { if (await onSubmit(form, d)) close(); }
    catch (err) { showFormError(form, err); }
    finally { btn.disabled = false; }
  });
  d.showModal();
  const first = form.querySelector('input:not([type=hidden]),select,textarea'); if (first) first.focus();
  return { dialog: d, form, close };
}
export function showFormError(form, err) {
  form.querySelectorAll('.invalid').forEach((x) => x.classList.remove('invalid'));
  const box = form.querySelector('.form-error');
  const field = err.data && err.data.field;
  const input = field && form.querySelector(`[name="${field}"]`);
  if (input) { input.classList.add('invalid'); input.setAttribute('aria-invalid', 'true'); input.focus(); }
  if (box) { box.textContent = err.message; box.hidden = false; } else toast(err.message, 'error');
}
export const formData = (form) => {
  const o = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') o[el.name] = el.checked; else o[el.name] = el.value;
  }
  return o;
};
export const options = (items, selected, { blank = '', value = (x) => x, label = (x) => x } = {}) =>
  html`${blank !== null ? html`<option value="">${blank}</option>` : ''}${items.map((x) => html`<option value="${value(x)}" ${String(value(x)) === String(selected ?? '') ? raw('selected') : ''}>${label(x)}</option>`)}`;
