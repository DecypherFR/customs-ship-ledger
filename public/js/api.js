// Data layer on Supabase, with an offline outbox and read cache.
//
// The views call api.get('/api/...') and api.send(method, '/api/...', body) as before; this module
// maps each route onto Supabase (Auth, PostgREST tables/views and database functions).
// Permissions are enforced in the database (row-level security + security-definer functions);
// nothing here is trusted for security.
//
// Offline: writes made without a connection are stored in IndexedDB and replayed in order when the
// connection returns (each create carries a client_uuid so a replay can never duplicate a record).
// Successful reads are cached so recently opened pages still work offline.

const cfg = window.LEDGER_CONFIG || {};
export const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'ledger-auth' },
});

// ---------------------------------------------------------------- IndexedDB
const DB_NAME = 'ledger-offline';
let dbp;
function idb() {
  dbp ||= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 2);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains('outbox')) r.result.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true });
      if (!r.result.objectStoreNames.contains('cache')) r.result.createObjectStore('cache');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}
async function store(name, mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(name, mode);
    const req = fn(t.objectStore(name));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
  });
}
export const outbox = {
  all: () => store('outbox', 'readonly', (s) => s.getAll()),
  add: (item) => store('outbox', 'readwrite', (s) => s.add(item)),
  put: (item) => store('outbox', 'readwrite', (s) => s.put(item)),
  remove: (id) => store('outbox', 'readwrite', (s) => s.delete(id)),
  clear: () => store('outbox', 'readwrite', (s) => s.clear()),
};
const cache = {
  get: (k) => store('cache', 'readonly', (s) => s.get(k)).catch(() => undefined),
  set: (k, v) => store('cache', 'readwrite', (s) => s.put(v, k)).catch(() => {}),
  clear: () => store('cache', 'readwrite', (s) => s.clear()).catch(() => {}),
};

// ---------------------------------------------------------------- errors
export class ApiError extends Error {
  constructor(status, data) { super(data.error || `Request failed (${status})`); this.status = status; this.data = data; }
}
const offlineError = () => new TypeError('Network unavailable');
// Turn a supabase-js / PostgREST error into ApiError (or a TypeError for network failures, which triggers offline queueing).
function check({ data, error, status }) {
  if (!error) return data;
  if (!status || /Failed to fetch|NetworkError|Load failed|fetch failed/i.test(error.message || '')) throw offlineError();
  const code = error.code || '';
  const http = /^PT\d{3}$/.test(code) ? Number(code.slice(2)) : code === '42501' ? 403 : /^PGRST30/.test(code) ? 401 : status || 400;
  throw new ApiError(http, { error: error.message || 'Request failed.', field: error.hint || undefined, code: error.hint === 'must_change_password' ? 'must_change_password' : code });
}
const rpc = async (fn, args) => check(await sb.rpc(fn, args));

// ---------------------------------------------------------------- roles (labels and UI hints only)
export const ROLES = {
  officer: { label: 'Customs Officer', desc: "Boards and clears vessels at their station; records calls, departures and Ship's Reports; requests extensions.",
    perms: ['calls.read', 'calls.create', 'calls.edit', 'calls.depart', 'ext.request', 'report.print', 'dashboard.view'] },
  supervisor: { label: 'Station Supervisor', desc: 'Everything an officer can do, plus approves extensions, verifies/locks calls and views the overstay register for the station.',
    perms: ['calls.read', 'calls.create', 'calls.edit', 'calls.depart', 'calls.verify', 'ext.request', 'ext.approve', 'report.print', 'dashboard.view', 'overstay.view', 'cases.manage', 'export'] },
  investigator: { label: 'Investigations Officer', desc: 'National read access; runs the overstay register, opens cases, records follow-up notes.',
    perms: ['calls.read', 'report.print', 'dashboard.view', 'overstay.view', 'cases.manage', 'export'] },
  management: { label: 'Comptroller / Management', desc: 'National read-only access to the ledger, dashboard, overstay register, exports and audit trail.',
    perms: ['calls.read', 'report.print', 'dashboard.view', 'overstay.view', 'export', 'audit.view'] },
  admin: { label: 'System Administrator', desc: 'Manages users, reference lists and settings. Full access, including corrections to verified records.', perms: ['*'] },
};
const belizeToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Belize' }).format(new Date());
const publicUser = (p) => p && ({ id: p.id, username: p.email || '(no sign-in)', email: p.email, full_name: p.full_name, initials: p.initials, role: p.role,
  station_code: p.station_code, active: p.active, must_change_password: p.must_change_password, last_login_at: p.last_login_at });

// ---------------------------------------------------------------- reads
let profile = null;
async function me() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new ApiError(401, { error: 'Please sign in.' });
  const p = check(await sb.from('profiles').select('*, station:stations(name)').eq('id', session.user.id).maybeSingle());
  if (!p || !p.active) { await sb.auth.signOut(); throw new ApiError(403, { error: 'Your account is not active. Contact an administrator.' }); }
  profile = p;
  return { user: publicUser(p), perms: ROLES[p.role].perms, role_label: ROLES[p.role].label, station_name: p.station ? p.station.name : 'All stations' };
}
const scope = () => (profile && ['officer', 'supervisor'].includes(profile.role) ? profile.station_code : null);

async function lookups() {
  const admin = profile && profile.role === 'admin';
  const list = async (t) => check(await sb.from(t).select('*').order('sort')).filter((x) => admin || x.active);
  const [stations, vessel_types, cargo_types, extension_reasons, settingsRows, people, values] = await Promise.all([
    list('stations'), list('vessel_types'), list('cargo_types'), list('extension_reasons'),
    sb.from('settings').select('*').then(check), sb.from('profiles').select('id, initials, full_name, role, station_code, active').order('initials').then(check),
    rpc('lookup_values')]);
  const st = scope();
  const inScope = (p) => !st || !p.station_code || p.station_code === st;
  return {
    stations, vessel_types, cargo_types, extension_reasons, ...values,
    officers: people.filter((p) => ['officer', 'supervisor', 'admin'].includes(p.role) && inScope(p)),
    staff: people.filter((p) => p.active && ['investigator', 'supervisor', 'officer', 'admin'].includes(p.role) && inScope(p))
      .sort((a, b) => (b.role === 'investigator') - (a.role === 'investigator')),
    settings: Object.fromEntries(settingsRows.map((r) => [r.key, r.value])), today: belizeToday(),
    roles: Object.fromEntries(Object.entries(ROLES).map(([k, v]) => [k, { label: v.label, desc: v.desc }])),
  };
}

async function listCalls(p) {
  let qb = sb.from('call_overview').select('*').order('arrival_date', { ascending: false }).order('id', { ascending: false });
  if (p.station && !scope()) qb = qb.eq('station_code', p.station);
  if (/^\d{4}-\d{2}$/.test(p.month || '')) { const [y, m] = p.month.split('-').map(Number); qb = qb.gte('arrival_date', `${p.month}-01`).lt('arrival_date', m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`); }
  if (/^\d{4}$/.test(p.year || '')) qb = qb.eq('rotation_year', Number(p.year));
  if (p.type) qb = qb.eq('vessel_type', p.type);
  if (p.status === 'IN PORT') qb = qb.is('departure_date', null);
  if (p.status === 'DEPARTED') qb = qb.not('departure_date', 'is', null);
  if (p.q) {
    const t = String(p.q).replace(/[%,()*]/g, ' ').trim();
    if (t) qb = qb.or(['vessel_name', 'rotation_no', 'imo', 'agent', 'master', 'voyage_no'].map((c) => `${c}.ilike.*${t}*`).join(','));
  }
  let rows = check(await qb.limit(2000));
  if (p.flag === 'attention') rows = rows.filter((c) => ['OVERDUE', 'EXPIRING SOON', 'LONG STAY'].includes(c.overstay_status) || c.pending_extensions || (c.data_check && !c.verified_at));
  if (p.flag === 'unverified') rows = rows.filter((c) => c.departure_date && !c.verified_at);
  if (p.flag === 'datacheck') rows = rows.filter((c) => c.data_check && !c.verified_at);
  return rows;
}

const EXT_SELECT = '*, requester:profiles!extensions_requested_by_fkey(initials), decider:profiles!extensions_decided_by_fkey(initials)';
const flatExt = (e) => ({ ...e, requested_by_name: e.requester?.initials, decided_by_name: e.decider?.initials });

async function caseFor(callId) {
  const k = check(await sb.from('cases').select('*, assignee:profiles!cases_assigned_to_fkey(initials), case_notes(*, author:profiles!case_notes_user_id_fkey(initials))')
    .eq('call_id', callId).maybeSingle());
  if (!k) return null;
  return { ...k, assigned_name: k.assignee?.initials, notes: (k.case_notes || []).sort((a, b) => a.id - b.id).map((n) => ({ ...n, author: n.author?.initials })) };
}

async function callDetail(id) {
  const c = check(await sb.from('call_overview').select('*').eq('id', id).maybeSingle());
  if (!c) throw new ApiError(404, { error: 'Vessel call not found.' });
  const [exts, kase, history] = await Promise.all([
    sb.from('extensions').select(EXT_SELECT).eq('call_id', id).order('id').then(check),
    profile && ROLES[profile.role].perms.some((x) => x === '*' || x === 'overstay.view') ? caseFor(id) : null,
    rpc('call_history', { p_call: id })]);
  let n = 0;
  return { ...c, extensions: exts.map((e) => ({ ...flatExt(e), ext_no: e.status === 'APPROVED' ? ++n : n })), case: kase,
    history: history.map((h) => ({ ...h, details: h.details ? JSON.stringify(h.details) : null })) };
}

async function extensions(p) {
  let qb = sb.from('extensions').select(`${EXT_SELECT}, call:calls!inner(rotation_no, vessel_name, station_code, station:stations(name))`).order('id', { ascending: false }).limit(500);
  if (['PENDING', 'APPROVED', 'REJECTED'].includes(p.status)) qb = qb.eq('status', p.status);
  return check(await qb).map((e) => ({ ...flatExt(e), rotation_no: e.call.rotation_no, vessel_name: e.call.vessel_name, station_code: e.call.station_code, station_name: e.call.station?.name }));
}

async function overstay() {
  const rows = check(await sb.from('call_overview').select('*')
    .or('overstay_status.in.(OVERDUE,"EXPIRING SOON","LONG STAY"),case_status.in.(OPEN,"IN PROGRESS",REFERRED)'));
  const ids = rows.map((r) => r.id);
  const cases = ids.length ? check(await sb.from('cases').select('*, assignee:profiles!cases_assigned_to_fkey(initials), case_notes(count)').in('call_id', ids)) : [];
  const byCall = Object.fromEntries(cases.map((k) => [k.call_id, { ...k, assigned_name: k.assignee?.initials, notes: k.case_notes?.[0]?.count ?? 0 }]));
  const rank = { OVERDUE: 0, 'LONG STAY': 1, 'EXPIRING SOON': 2 };
  rows.sort((a, b) => (rank[a.overstay_status] ?? 3) - (rank[b.overstay_status] ?? 3) || (b.days_overdue || 0) - (a.days_overdue || 0) || b.days_in_port - a.days_in_port);
  return { date_checked: belizeToday(), items: rows.map((c) => ({ ...c, case: byCall[c.id] || null })) };
}

async function audit(p) {
  let qb = sb.from('audit').select('id, ts, action, entity, entity_id, summary, who:profiles!audit_user_id_fkey(email, initials)').order('id', { ascending: false }).limit(300);
  if (p.q) qb = qb.ilike('summary', `%${String(p.q).replace(/[%,]/g, ' ')}%`);
  return check(await qb).map((a) => ({ ...a, username: a.who?.email || a.who?.initials }));
}

// ---------------------------------------------------------------- routes
const routes = [
  ['GET', /^\/api\/me$/, () => me()],
  ['GET', /^\/api\/lookups$/, () => lookups()],
  ['GET', /^\/api\/calls$/, (m, q) => listCalls(q)],
  ['GET', /^\/api\/calls\/(\d+)$/, (m) => callDetail(Number(m[1]))],
  ['GET', /^\/api\/vessels$/, (m, q) => rpc('search_vessels', { q: q.q || '' })],
  ['GET', /^\/api\/extensions$/, (m, q) => extensions(q)],
  ['GET', /^\/api\/dashboard$/, (m, q) => rpc('dashboard', { p_month: q.month || null, p_station: q.station || null })],
  ['GET', /^\/api\/overstay$/, () => overstay()],
  ['GET', /^\/api\/audit$/, (m, q) => audit(q)],
  ['GET', /^\/api\/users$/, async () => check(await sb.from('profiles').select('*').order('active', { ascending: false }).order('email')).map(publicUser)],

  ['POST', /^\/api\/login$/, async (m, q, b) => {
    const r = await sb.auth.signInWithPassword({ email: String(b.username || '').trim(), password: b.password || '' });
    if (r.error) {
      if (!r.error.status) throw offlineError();
      throw new ApiError(r.error.status === 429 ? 429 : 401, { error: r.error.status === 429 ? 'Too many attempts. Wait a few minutes and try again.' : 'Incorrect email or password.' });
    }
    const out = await me(); rpc('signed_in').catch(() => {}); return out;
  }],
  ['POST', /^\/api\/logout$/, async () => { await sb.auth.signOut(); await cache.clear(); profile = null; return { ok: true }; }],
  ['POST', /^\/api\/me\/password$/, async (m, q, b) => {
    const { data: { user } } = await sb.auth.getUser();
    const re = await sb.auth.signInWithPassword({ email: user.email, password: b.current || '' });
    if (re.error) throw new ApiError(400, { error: 'Current password is incorrect.', field: 'current' });
    const pw = b.password || '';
    if (pw.length < 10) throw new ApiError(400, { error: 'Password must be at least 10 characters.', field: 'password' });
    if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) throw new ApiError(400, { error: 'Password must contain letters and numbers.', field: 'password' });
    if (pw === b.current) throw new ApiError(400, { error: 'Choose a new password different from the current one.', field: 'password' });
    const up = await sb.auth.updateUser({ password: pw });
    if (up.error) throw new ApiError(400, { error: up.error.message, field: 'password' });
    await rpc('password_changed');
    return { ok: true };
  }],
  ['POST', /^\/api\/calls$/, async (m, q, b) => callDetail(await rpc('create_call', { p: b }))],
  ['PUT', /^\/api\/calls\/(\d+)$/, async (m, q, b) => { await rpc('update_call', { p_id: Number(m[1]), p: b }); return { ok: true }; }],
  ['POST', /^\/api\/calls\/(\d+)\/verify$/, (m, q, b) => rpc('verify_call', { p_id: Number(m[1]), p_unlock: !!b.unlock, p_reason: b.reason || null })],
  ['DELETE', /^\/api\/calls\/(\d+)$/, (m, q, b) => rpc('delete_call', { p_id: Number(m[1]), p_reason: b.reason || '' })],
  ['POST', /^\/api\/calls\/(\d+)\/extensions$/, (m, q, b) => rpc('add_extension', { p_call: Number(m[1]), p: b })],
  ['POST', /^\/api\/extensions\/(\d+)\/decision$/, (m, q, b) => rpc('decide_extension', { p_id: Number(m[1]), p_decision: b.decision, p_note: b.note || null })],
  ['POST', /^\/api\/calls\/(\d+)\/case$/, async (m, q, b) => { await rpc('save_case', { p_call: Number(m[1]), p: b }); return caseFor(Number(m[1])); }],
  ['POST', /^\/api\/calls\/(\d+)\/case\/notes$/, async (m, q, b) => { await rpc('add_case_note', { p_call: Number(m[1]), p_note: b.note, p_client_uuid: b.client_uuid || null }); return caseFor(Number(m[1])); }],
  ['POST', /^\/api\/users$/, (m, q, b) => adminFn({ action: 'create', ...b, email: b.email || b.username })],
  ['POST', /^\/api\/users\/([\w-]+)\/signin$/, (m, q, b) => adminFn({ action: 'create', ...b, link_profile_id: m[1] })],
  ['PUT', /^\/api\/users\/([\w-]+)$/, (m, q, b) => rpc('admin_save_profile', { p_id: m[1], p: b })],
  ['POST', /^\/api\/users\/([\w-]+)\/reset-password$/, (m, q, b) => adminFn({ action: 'reset_password', user_id: m[1], password: b.password })],
  ['PUT', /^\/api\/lists\/(\w+)$/, async (m, q, b) => { await rpc('save_list', { p_list: m[1], p_items: b.items || [] }); return lookups(); }],
  ['PUT', /^\/api\/settings$/, async (m, q, b) => { await rpc('save_settings', { p: b }); return lookups().then((l) => l.settings); }],
  ['POST', /^\/api\/import$/, (m, q, b) => rpc('import_ledger', { p: b })],
];

async function adminFn(body) {
  const { data: { session } } = await sb.auth.getSession();
  let res;
  try {
    res = await fetch(`${cfg.supabaseUrl}/functions/v1/admin-users`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: cfg.supabaseAnonKey, Authorization: `Bearer ${session?.access_token}` }, body: JSON.stringify(body) });
  } catch { throw offlineError(); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

async function dispatch(method, url, body) {
  const u = new URL(url, location.origin);
  const r = routes.find(([m, re]) => m === method && re.test(u.pathname));
  if (!r) throw new ApiError(404, { error: `Unknown route ${method} ${u.pathname}` });
  return r[2](u.pathname.match(r[1]), Object.fromEntries(u.searchParams), body || {});
}

// ---------------------------------------------------------------- public interface
const listeners = new Set();
export const onSync = (fn) => listeners.add(fn);
const emit = (e) => listeners.forEach((fn) => fn(e));
const cacheKey = (url) => `${profile ? profile.id : 'anon'}:${url}`;

export const api = {
  // Reads: network first; when offline, the last copy saved on this device (flagged __offline).
  async get(url) {
    try {
      // When the device knows it is offline, skip the network (and supabase-js's retry back-off) entirely.
      if (!navigator.onLine) throw offlineError();
      const data = await dispatch('GET', url);
      if (url === '/api/me') await cache.set('last-me', data);
      cache.set(cacheKey(url), data);
      return data;
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;
      if (url === '/api/me' && !profile) {
        const last = await cache.get('last-me');
        const { data: { session } } = await sb.auth.getSession();
        if (last && session && session.user.id === last.user.id) { profile = { ...last.user, station_code: last.user.station_code }; return mark(last); }
      }
      const hit = await cache.get(cacheKey(url));
      if (hit === undefined) throw new ApiError(503, { error: 'You are offline and this page has not been opened on this device before.' });
      return mark(hit);
    }
  },
  // Writes. queueable writes are stored on the device when the network is unreachable.
  async send(method, url, body, { queueable = false, label = '' } = {}) {
    if (queueable && body && !body.client_uuid && method === 'POST') body.client_uuid = crypto.randomUUID();
    if (queueable && !navigator.onLine) return queue(method, url, body, label);
    try { return await dispatch(method, url, body); }
    catch (e) {
      if (queueable && e instanceof TypeError) return queue(method, url, body, label);
      if (e instanceof TypeError) throw new ApiError(503, { error: 'You are offline. Connect to the network and try again.' });
      throw e;
    }
  },
  // CSV exports are built in the browser from data the user is allowed to see.
  async download(url) {
    const u = new URL(url, location.origin);
    const q = Object.fromEntries(u.searchParams);
    if (u.pathname.endsWith('/extensions.csv')) {
      const rows = await extensions({});
      await rpc('log_export', { p_what: `${rows.length} extension log entries` }).catch(() => {});
      return saveCsv('extension-log.csv', [['Rotation No.', 'Station', 'Vessel Name', 'Date Granted', 'Original Expiry', 'New Expiry', 'Approved By', 'Reason', 'Remarks', 'Status'],
        ...rows.slice().reverse().map((e) => [e.rotation_no, e.station_name, e.vessel_name, e.date_granted, e.original_expiry, e.new_expiry, e.decided_by_name, e.reason, e.remarks, e.status])]);
    }
    const calls = (await listCalls(q)).reverse();
    const head = ['Vessel Type', 'Rotation Classification', 'Rotation Sequence No.', 'Station', 'Voyage Number', 'Vessel Name', 'IMO / Registration No.',
      'Flag / Nationality', 'Shipping Agent', 'Gross Tonnage', 'Net Tonnage', 'Crew', 'Passengers', 'Master', 'Last Port', 'Arrival Date',
      'Boarding Officer', 'Next Port', 'Departure Date', 'Clearance Officer', 'Cargo / Operation', 'Extension Count', 'Status', 'Remarks',
      'Reporting Month', 'Reporting Year', 'Data Check', 'Full Rotation No.', 'Latest Extension Expiry', 'Overstay Status', 'Verified By'];
    saveCsv(`vessel-movements-${q.month || q.year || 'all'}.csv`, [head, ...calls.map((c) => [c.vessel_type, `${c.rotation_year}/${c.rotation_class}/`, c.rotation_seq,
      c.station_name, c.voyage_no, c.vessel_name, c.imo, c.flag, c.agent, c.gross_tonnage, c.net_tonnage, c.crew, c.passengers, c.master, c.last_port,
      c.arrival_date, c.boarding_officer, c.next_port, c.departure_date, c.clearance_officer, c.cargo, c.extension_count, c.status, c.remarks,
      c.arrival_date.slice(0, 7), c.arrival_date.slice(0, 4), c.data_check ? c.data_check.join('; ') : 'OK', c.rotation_no, c.latest_expiry,
      c.overstay_status, c.verified_by_name])]);
    await rpc('log_export', { p_what: `${calls.length} vessel calls${q.month ? ` for ${q.month}` : ''}` }).catch(() => {});
  },
};
function mark(d) { if (d && typeof d === 'object') Object.defineProperty(d, '__offline', { value: true }); return d; }

function saveCsv(name, rows) {
  const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const blob = new Blob(['﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

async function queue(method, url, body, label) {
  await outbox.add({ method, url, body, label, queued_at: new Date().toISOString(), error: null });
  emit({ type: 'queued' });
  return { queued: true, client_uuid: body && body.client_uuid };
}

let flushing = false;
export async function flushOutbox() {
  if (flushing || !navigator.onLine) return;
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return;
  flushing = true;
  let sent = 0;
  try {
    for (const item of await outbox.all()) {
      if (item.error) continue; // needs user attention
      try {
        await dispatch(item.method, item.url, item.body);
        await outbox.remove(item.id); sent++;
      } catch (e) {
        if (e instanceof TypeError) break;             // still offline
        if (e.status === 401) break;                   // signed out - retry after sign-in
        item.error = e.message; await outbox.put(item);
      }
    }
  } finally { flushing = false; emit({ type: 'flushed', sent }); }
}
window.addEventListener('online', () => flushOutbox());
