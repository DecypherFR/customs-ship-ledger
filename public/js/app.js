// App shell: session, navigation, routing, connectivity and sync status.
import { api, ApiError, flushOutbox, onSync, outbox } from './api.js';
import { html, raw, icon, $, $$, toast, formData, showFormError } from './ui.js';
import * as V from './views.js';
import * as F from './forms.js';
import * as Adm from './admin.js';

export const S = { me: null, lookups: null };
export const can = (p) => !!S.me && (S.me.perms.includes('*') || S.me.perms.includes(p));
export const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };

const NAV = [
  { href: '#/', label: 'Dashboard', icon: 'dash', perm: 'dashboard.view' },
  { href: '#/calls', label: 'Vessel calls', icon: 'ship', perm: 'calls.read' },
  { href: '#/calls/new', label: 'New call', icon: 'plus', perm: 'calls.create', primary: true },
  { href: '#/extensions', label: 'Extensions', icon: 'clock', perm: 'calls.read', badge: 'pending_extensions' },
  { href: '#/overstay', label: 'Overstay register', icon: 'alert', perm: 'overstay.view', badge: 'overdue' },
  { href: '#/audit', label: 'Audit trail', icon: 'history', perm: 'audit.view' },
  { href: '#/admin/users', label: 'Users', icon: 'users', perm: 'users.manage' },
  { href: '#/admin/settings', label: 'Lists & settings', icon: 'cog', perm: 'settings.manage' },
];

const ROUTES = [
  [/^#?\/?$/, V.dashboard],
  [/^#\/calls$/, V.callList],
  [/^#\/calls\/new$/, F.callForm],
  [/^#\/calls\/(\d+)$/, V.callDetail],
  [/^#\/calls\/(\d+)\/edit$/, F.callForm],
  [/^#\/calls\/(\d+)\/report$/, V.shipReport],
  [/^#\/extensions$/, V.extensionsView],
  [/^#\/overstay$/, V.overstayView],
  [/^#\/audit$/, V.auditView],
  [/^#\/sync$/, V.syncView],
  [/^#\/account$/, accountView],
  [/^#\/admin\/users$/, Adm.usersView],
  [/^#\/admin\/settings$/, Adm.settingsView],
];

let badges = {};
export async function refreshBadges() {
  if (!can('dashboard.view')) return;
  try { const d = await api.get('/api/dashboard'); badges = d.attention; paintNav(); } catch { /* offline */ }
}

async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  window.addEventListener('online', paintConn); window.addEventListener('offline', paintConn);
  onSync(async (e) => {
    await paintConn();
    if (e.type === 'flushed' && e.sent) { toast(`${e.sent} offline change${e.sent > 1 ? 's' : ''} synced.`, 'success'); render(); }
  });
  try { S.me = await api.get('/api/me'); } catch (e) { S.me = null; }
  if (!S.me || S.me.__offline && !S.me.user) return loginView();
  await start();
}
async function start() {
  if (S.me.user.must_change_password) return forcedPasswordView();
  S.lookups = await api.get('/api/lookups');
  shell();
  window.addEventListener('hashchange', render);
  render();
  flushOutbox();
  refreshBadges();
}

function shell() {
  const u = S.me.user;
  document.body.innerHTML = String(html`
  <a class="skip" href="#main">Skip to content</a>
  <div class="app">
    <aside class="side" id="side">
      <div class="brand">${raw('<img src="/icons/icon.svg" alt="" width="36" height="36">')}<div><strong>National Ships Ledger</strong><span>Customs &amp; Excise · Belize</span></div></div>
      <nav id="nav" aria-label="Main"></nav>
      <div class="side-foot">
        <a href="#/account" class="who"><span class="avatar">${u.initials.replace(/[^A-Z]/g, '').slice(0, 2)}</span>
          <span><strong>${u.full_name}</strong><small>${S.me.role_label} · ${S.me.station_name}</small></span></a>
        <button class="btn btn-ghost btn-sm" id="logout">${icon('out')} Sign out</button>
      </div>
    </aside>
    <div class="main-wrap">
      <header class="topbar">
        <button class="icon-btn menu-btn" id="menu" aria-label="Menu" aria-expanded="false">${icon('menu')}</button>
        <span class="top-title" id="top-title">Ledger</span>
        <a href="#/sync" class="conn" id="conn" aria-live="polite"></a>
      </header>
      <main id="main" tabindex="-1"></main>
    </div>
  </div>
  <div id="toasts" class="toasts"></div>`);
  $('#logout').addEventListener('click', logout);
  $('#menu').addEventListener('click', () => { const o = document.body.classList.toggle('nav-open'); $('#menu').setAttribute('aria-expanded', o); });
  $('#side').addEventListener('click', (e) => { if (e.target.closest('a')) document.body.classList.remove('nav-open'); });
  paintNav(); paintConn();
}
function paintNav() {
  const nav = $('#nav'); if (!nav) return;
  const here = location.hash || '#/';
  nav.innerHTML = String(html`${NAV.filter((n) => can(n.perm)).map((n) => {
    const active = n.href === '#/' ? here === '#/' || here === '' : here === n.href || (here.startsWith(n.href + '/') && n.href !== '#/calls') || (n.href === '#/calls' && /^#\/calls(\?|\/\d|$)/.test(here));
    const b = n.badge && badges[n.badge];
    return html`<a href="${n.href}" class="${active ? 'active' : ''} ${n.primary ? 'nav-primary' : ''}" ${active ? raw('aria-current="page"') : ''}>${icon(n.icon)}<span>${n.label}</span>${b ? html`<b class="badge" title="${b} need attention">${b}</b>` : ''}</a>`;
  })}`);
}
export async function paintConn() {
  const el = $('#conn'); if (!el) return;
  const items = await outbox.all().catch(() => []);
  const waiting = items.length; const failed = items.filter((i) => i.error).length;
  const on = navigator.onLine;
  el.className = `conn ${on ? (failed ? 'conn-warn' : 'conn-on') : 'conn-off'}`;
  el.innerHTML = String(html`${icon(on ? 'cloud' : 'cloudoff')}<span>${on ? (waiting ? (failed ? `${failed} need attention` : `Syncing ${waiting}…`) : 'Online') : `Offline${waiting ? ` · ${waiting} queued` : ''}`}</span>`);
  el.title = on ? 'Connected to the ledger server' : 'Working offline. New records are saved on this device and sent when the connection returns.';
}

export async function render() {
  const main = $('#main'); if (!main) return;
  const hash = location.hash || '#/';
  const [path] = hash.split('?');
  const r = ROUTES.find(([re]) => re.test(path));
  paintNav();
  if (!r) { main.innerHTML = String(html`<div class="empty"><h1>Page not found</h1><a class="btn" href="#/">Go to dashboard</a></div>`); return; }
  const params = Object.fromEntries(new URLSearchParams(hash.split('?')[1] || ''));
  const m = path.match(r[0]);
  main.innerHTML = '<div class="loading" aria-busy="true">Loading…</div>';
  try {
    await r[1](main, { id: m[1], params, edit: /\/edit$/.test(path) });
    const h1 = main.querySelector('h1'); $('#top-title').textContent = h1 ? h1.textContent : 'Ledger';
    document.title = `${h1 ? h1.textContent + ' · ' : ''}National Ships Ledger`;
    main.focus({ preventScroll: true }); window.scrollTo(0, 0);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return loginView();
    main.innerHTML = String(html`<div class="empty"><h1>Couldn't load this page</h1><p>${e.message}</p><a class="btn" href="#/">Go to dashboard</a></div>`);
  }
}

async function logout() {
  const pending = (await outbox.all()).length;
  if (pending && !confirm(`${pending} offline change(s) have not been sent yet. They stay on this device and will send when you next sign in. Sign out anyway?`)) return;
  try { await api.send('POST', '/api/logout', {}); } catch { /* ignore */ }
  navigator.serviceWorker?.controller?.postMessage('clear-api-cache');
  S.me = null; location.hash = ''; loginView();
}

function loginView() {
  document.body.innerHTML = String(html`
  <main class="login">
    <form class="login-card" id="login" novalidate>
      ${raw('<img src="/icons/icon.svg" alt="" width="64" height="64">')}
      <h1>National Ships Ledger</h1>
      <p class="muted">Belize Customs &amp; Excise Department</p>
      <label>Username<input name="username" autocomplete="username" required autocapitalize="none"></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
      <p class="form-error" role="alert" hidden></p>
      <button class="btn btn-primary btn-block" type="submit">Sign in</button>
      <p class="fine">Authorised Customs personnel only. All activity is recorded.</p>
    </form>
  </main><div id="toasts" class="toasts"></div>`);
  const f = $('#login'); f.username.focus();
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = f.querySelector('button'); btn.disabled = true;
    try { S.me = await api.send('POST', '/api/login', formData(f)); await start(); }
    catch (err) { showFormError(f, err.status ? err : new Error(navigator.onLine ? err.message : 'You need a connection to sign in for the first time on this device.')); }
    finally { btn.disabled = false; }
  });
}

function passwordFields() {
  return html`<label>Current password<input name="current" type="password" autocomplete="current-password" required></label>
    <label>New password<input name="password" type="password" autocomplete="new-password" required minlength="10" aria-describedby="pwhelp"></label>
    <small id="pwhelp" class="help">At least 10 characters, with letters and numbers.</small>
    <label>Repeat new password<input name="repeat" type="password" autocomplete="new-password" required></label>`;
}
async function changePassword(f) {
  const d = formData(f);
  if (d.password !== d.repeat) { const e = new Error('The new passwords do not match.'); e.data = { field: 'repeat' }; throw e; }
  await api.send('POST', '/api/me/password', { current: d.current, password: d.password });
}
function forcedPasswordView() {
  document.body.innerHTML = String(html`<main class="login"><form class="login-card" id="pw" novalidate>
    <h1>Set your password</h1><p class="muted">Welcome, ${S.me.user.full_name}. Choose a personal password before continuing.</p>
    ${passwordFields()}<p class="form-error" role="alert" hidden></p>
    <button class="btn btn-primary btn-block">Save and continue</button></form></main><div id="toasts" class="toasts"></div>`);
  const f = $('#pw');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await changePassword(f); S.me = await api.get('/api/me'); await start(); } catch (err) { showFormError(f, err); }
  });
}
async function accountView(main) {
  const u = S.me.user;
  main.innerHTML = String(html`<div class="page-head"><h1>My account</h1></div>
  <div class="grid-2">
    <section class="card"><h2>Profile</h2><dl class="kv">
      <dt>Name</dt><dd>${u.full_name}</dd><dt>Username</dt><dd>${u.username}</dd><dt>Printed as</dt><dd>${u.initials}</dd>
      <dt>Role</dt><dd>${S.me.role_label}</dd><dt>Station</dt><dd>${S.me.station_name}</dd></dl>
      <p class="help">${S.lookups.roles[u.role].desc}</p></section>
    <section class="card"><h2>Change password</h2><form id="pw" class="stack" novalidate>${passwordFields()}
      <p class="form-error" role="alert" hidden></p><button class="btn btn-primary">Change password</button></form></section>
  </div>`);
  const f = $('#pw', main);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await changePassword(f); f.reset(); f.querySelector('.form-error').hidden = true; toast('Password changed. Other devices have been signed out.', 'success'); } catch (err) { showFormError(f, err); }
  });
}

boot();
