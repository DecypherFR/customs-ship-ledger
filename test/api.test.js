'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
process.env.DB_FILE = path.join(dir, 't.db');
process.env.ADMIN_PASSWORD = 'AdminStart2026';
process.env.LEDGER_TODAY = '2026-10-15';
const { server } = require('../server/server');
let base;

function client() {
  let cookie = '';
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
  return { get: (u) => call('GET', u), post: (u, b = {}) => call('POST', u, b), put: (u, b) => call('PUT', u, b), del: (u, b) => call('DELETE', u, b), raw: call };
}
async function signIn(username, password) {
  const c = client(); const r = await c.post('/api/login', { username, password });
  assert.equal(r.status, 200, JSON.stringify(r.data)); return c;
}
const PW = 'Station2026x';
const arrival = { vessel_name: 'Sea Esprit', imo: '1018822', flag: 'usa', agent: 'agent', gross_tonnage: 48, net_tonnage: 19, crew: 3, passengers: 0,
  master: 'John Carver', last_port: 'Isla Mujeres', next_port: 'Roatan', cargo: 'Ballast / No Cargo' };
let admin; let officer; let officer2; let sup; let sup2; let mgmt; let inv;

before(async () => {
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await signIn('admin', 'AdminStart2026');
  assert.equal((await admin.get('/api/calls')).status, 403, 'must change password first');
  assert.equal((await admin.post('/api/me/password', { current: 'AdminStart2026', password: 'AdminReal2026' })).status, 200);
  const mk = async (username, role, station_code) => {
    const r = await admin.post('/api/users', { username, full_name: `${username} Test`, role, station_code, password: 'Temp123456', national: !station_code });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const c = await signIn(username, 'Temp123456');
    assert.equal((await c.post('/api/me/password', { current: 'Temp123456', password: PW })).status, 200);
    return c;
  };
  officer = await mk('off.bze', 'officer', 'BZE');
  officer2 = await mk('off.spr', 'officer', 'SPR');
  sup = await mk('sup.bze', 'supervisor', 'BZE');
  sup2 = await mk('sup2.bze', 'supervisor', 'BZE');
  mgmt = await mk('mgmt', 'management', null);
  inv = await mk('inv', 'investigator', null);
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('rejects bad credentials and locks after 5 failures', async () => {
  const c = client();
  for (let i = 0; i < 5; i++) assert.equal((await c.post('/api/login', { username: 'mgmt', password: 'wrong' })).status, 401);
  assert.equal((await c.post('/api/login', { username: 'mgmt', password: PW })).status, 429);
});

test('state-changing requests must be JSON (CSRF guard)', async () => {
  const r = await officer.raw('POST', '/api/calls', undefined, { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.equal(r.status, 415);
});

test('rotation numbers: one shared automatic sequence for non-CRG classes, manual unique CRG numbers', async () => {
  const a = await officer.post('/api/calls', { ...arrival, vessel_type: 'Pleasure Vessel / Yacht', arrival_date: '2026-10-01' });
  assert.equal(a.status, 200, JSON.stringify(a.data)); assert.equal(a.data.rotation_no, '2026/PSV/1');
  const b = await officer.post('/api/calls', { ...arrival, vessel_name: 'Gulf Runner', imo: '9201776', vessel_type: 'Supply Vessel', arrival_date: '2026-10-02' });
  assert.equal(b.data.rotation_no, '2026/SUP/2');
  const l = await officer.post('/api/calls', { ...arrival, vessel_name: 'Atomic', imo: '181871', vessel_type: 'Liveaboard Vessel', arrival_date: '2026-10-02' });
  assert.equal(l.data.rotation_no, '2026/LVB/3', 'liveaboard gets its own class (the workbook fell back to OTH)');
  const noSeq = await officer.post('/api/calls', { ...arrival, vessel_name: 'BF Emilia', vessel_type: 'Container Vessel', arrival_date: '2026-10-03' });
  assert.equal(noSeq.status, 400); assert.equal(noSeq.data.field, 'rotation_seq');
  const crg = await officer.post('/api/calls', { ...arrival, vessel_name: 'BF Emilia', imo: '9578569', vessel_type: 'Container Vessel', rotation_seq: 5698, arrival_date: '2026-10-03' });
  assert.equal(crg.data.rotation_no, '2026/CRG/5698');
  const dup = await officer.post('/api/calls', { ...arrival, vessel_name: 'Other Ship', vessel_type: 'General Cargo Vessel', rotation_seq: 5698, arrival_date: '2026-10-04' });
  assert.equal(dup.status, 409);
  const next = await officer.post('/api/calls', { ...arrival, vessel_name: 'Fish', imo: null, vessel_type: 'Fishing Vessel', arrival_date: '2026-10-05' });
  assert.equal(next.data.rotation_no, '2026/FSH/4', 'CRG calls do not consume the shared sequence');
  assert.equal(a.data.station_code, 'BZE'); assert.equal(a.data.vessel_name, 'SEA ESPRIT', 'text is upper-cased like the ledger');
});

test('validation: departure before arrival, future arrival, missing clearance officer', async () => {
  const base2 = { ...arrival, vessel_type: 'Other', arrival_date: '2026-10-10' };
  assert.equal((await officer.post('/api/calls', { ...base2, departure_date: '2026-10-09', clearance_officer_id: 1 })).data.field, 'departure_date');
  assert.equal((await officer.post('/api/calls', { ...base2, arrival_date: '2026-12-01' })).data.field, 'arrival_date');
  assert.equal((await officer.post('/api/calls', { ...base2, departure_date: '2026-10-11' })).data.field, 'clearance_officer_id');
});

test('data check flags incomplete records like the workbook', async () => {
  const r = await officer.post('/api/calls', { vessel_type: 'Other', vessel_name: 'Mystery', arrival_date: '2026-10-12' });
  assert.equal(r.status, 200);
  assert.match(r.data.data_check[0], /Missing: Flag/);
});

test('station scoping: officers only see and write their own station', async () => {
  const spr = await officer2.post('/api/calls', { ...arrival, vessel_name: 'Windsong', imo: '1020456', vessel_type: 'Pleasure Vessel / Yacht', arrival_date: '2026-10-06', station_code: 'BZE' });
  assert.equal(spr.data.station_code, 'SPR', 'station forced to the officer\'s own');
  assert.equal((await officer.get(`/api/calls/${spr.data.id}`)).status, 403);
  const list = await officer.get('/api/calls');
  assert.ok(list.data.every((c) => c.station_code === 'BZE'));
  assert.ok((await mgmt.get('/api/calls')).data.some((c) => c.station_code === 'SPR'), 'management sees all stations');
});

test('read-only roles cannot write', async () => {
  assert.equal((await mgmt.post('/api/calls', { ...arrival, vessel_type: 'Other', arrival_date: '2026-10-10' })).status, 403);
  assert.equal((await inv.post('/api/calls', { ...arrival, vessel_type: 'Other', arrival_date: '2026-10-10' })).status, 403);
  assert.equal((await officer.get('/api/users')).status, 403);
  assert.equal((await officer.get('/api/overstay')).status, 403);
  assert.equal((await officer.get('/api/audit')).status, 403);
  assert.equal((await mgmt.get('/api/audit')).status, 200);
});

test('extensions: officer requests, a different supervisor approves; overstay status follows', async () => {
  const c = (await officer.post('/api/calls', { ...arrival, vessel_name: 'Long Stayer', imo: '7777777', vessel_type: 'Pleasure Vessel / Yacht', arrival_date: '2026-08-01' })).data;
  assert.equal(c.overstay_status, 'LONG STAY', '75 days in port with no extension');
  const req = await officer.post(`/api/calls/${c.id}/extensions`, { original_expiry: '2026-08-15', new_expiry: '2026-09-15', reason: 'Weather' });
  assert.equal(req.status, 200); assert.equal(req.data[0].status, 'PENDING');
  assert.equal((await officer.post(`/api/extensions/${req.data[0].id}/decision`, { decision: 'APPROVED' })).status, 403);
  assert.equal((await sup.post(`/api/extensions/${req.data[0].id}/decision`, { decision: 'REJECTED' })).status, 400, 'rejection needs a note');
  assert.equal((await sup.post(`/api/extensions/${req.data[0].id}/decision`, { decision: 'APPROVED' })).status, 200);
  let d = (await sup.get(`/api/calls/${c.id}`)).data;
  assert.equal(d.extension_count, 1); assert.equal(d.latest_expiry, '2026-09-15'); assert.equal(d.overstay_status, 'OVERDUE'); assert.equal(d.days_overdue, 30);
  assert.equal(d.priority, 'OVERDUE - FOLLOW UP');
  const bad = await sup.post(`/api/calls/${c.id}/extensions`, { new_expiry: '2026-09-01', reason: 'Weather' });
  assert.equal(bad.status, 400, 'new expiry must follow the previous one');
  // supervisor grants directly; original expiry is taken from the previous extension
  for (const to of ['2026-10-01', '2026-10-10']) assert.equal((await sup.post(`/api/calls/${c.id}/extensions`, { new_expiry: to, reason: 'Weather' })).status, 200);
  d = (await sup.get(`/api/calls/${c.id}`)).data;
  assert.equal(d.extensions[2].original_expiry, '2026-10-01');
  assert.equal(d.priority, 'URGENT - 3+ EXTENSIONS');
  const own = await sup.post(`/api/calls/${c.id}/extensions`, { new_expiry: '2026-10-20', reason: 'Weather' });
  assert.equal(own.status, 200);
  d = (await sup.get(`/api/calls/${c.id}`)).data;
  assert.equal(d.overstay_status, 'EXPIRING SOON');
  const reg = (await inv.get('/api/overstay')).data.items;
  assert.ok(reg.some((x) => x.id === c.id));
  // investigator opens a case and adds a note; closing needs an outcome
  assert.equal((await inv.post(`/api/calls/${c.id}/case/notes`, { note: 'Agent contacted.' })).status, 200);
  assert.equal((await inv.post(`/api/calls/${c.id}/case`, { status: 'CLOSED' })).status, 400);
  const k = await inv.post(`/api/calls/${c.id}/case`, { status: 'CLOSED', outcome: 'Departed under escort' });
  assert.equal(k.data.status, 'CLOSED'); assert.equal(k.data.notes.length, 1);
});

test('supervisors grant directly; officer requests go to another supervisor', async () => {
  const c = (await sup.post('/api/calls', { ...arrival, vessel_name: 'Self', imo: '5555555', vessel_type: 'Other', arrival_date: '2026-10-01' })).data;
  const r = await sup.post(`/api/calls/${c.id}/extensions`, { original_expiry: '2026-10-10', new_expiry: '2026-11-10', reason: 'Weather' });
  assert.equal(r.data[0].status, 'APPROVED', 'supervisors grant directly');
  const o = await officer.post(`/api/calls/${c.id}/extensions`, { new_expiry: '2026-12-10', reason: 'Weather' });
  assert.equal(o.data[1].status, 'PENDING');
  assert.equal((await sup2.post(`/api/extensions/${o.data[1].id}/decision`, { decision: 'REJECTED', note: 'Not justified' })).status, 200);
});

test('optimistic locking, departure, verification lock and audit history', async () => {
  const c = (await officer.post('/api/calls', { ...arrival, vessel_name: 'Locker', imo: '6666666', vessel_type: 'Other', arrival_date: '2026-10-01', boarding_officer_id: null })).data;
  const v1 = await officer.put(`/api/calls/${c.id}`, { version: c.version, remarks: 'first' });
  assert.equal(v1.status, 200);
  const stale = await officer.put(`/api/calls/${c.id}`, { version: c.version, remarks: 'stale' });
  assert.equal(stale.status, 409);
  assert.equal((await sup.post(`/api/calls/${c.id}/verify`, {})).status, 400, 'only departed calls can be verified');
  const dep = await officer.put(`/api/calls/${c.id}`, { version: v1.data.version, departure_date: '2026-10-05', clearance_officer_id: v1.data.boarding_officer_id });
  assert.equal(dep.status, 200); assert.equal(dep.data.status, 'DEPARTED');
  assert.equal((await officer.post(`/api/calls/${c.id}/verify`, {})).status, 403);
  assert.equal((await sup.post(`/api/calls/${c.id}/verify`, {})).status, 200);
  assert.equal((await officer.put(`/api/calls/${c.id}`, { remarks: 'after lock' })).status, 423);
  assert.equal((await sup.post(`/api/calls/${c.id}/verify`, { unlock: true })).status, 400, 'unlock needs a reason');
  assert.equal((await sup.post(`/api/calls/${c.id}/verify`, { unlock: true, reason: 'Wrong crew count' })).status, 200);
  const h = (await sup.get(`/api/calls/${c.id}`)).data.history.map((x) => x.action);
  assert.deepEqual(h.slice(0, 5), ['unlock', 'verify', 'update', 'update', 'create']);
  assert.equal((await officer.put(`/api/calls/${c.id}`, { vessel_type: 'Supply Vessel' })).status, 400, 'officers cannot change the rotation class');
});

test('offline replays with the same client_uuid do not duplicate records', async () => {
  const body = { ...arrival, vessel_name: 'Replay', imo: '4444444', vessel_type: 'Other', arrival_date: '2026-10-07', client_uuid: 'a6b0b6e0-1111-4111-8111-000000000001' };
  const a = await officer.post('/api/calls', body); const b = await officer.post('/api/calls', body);
  assert.equal(a.data.id, b.data.id);
});

test('vessel registry remembers particulars for repeat calls', async () => {
  const r = await officer.get('/api/vessels?q=1018822');
  assert.equal(r.data[0].name, 'SEA ESPRIT'); assert.equal(r.data[0].gross_tonnage, 48); assert.equal(r.data[0].last_master, 'JOHN CARVER');
});

test('dashboard and CSV export', async () => {
  const d = (await sup.get('/api/dashboard?month=2026-10')).data;
  assert.equal(d.station, 'BZE'); assert.ok(d.totals.calls >= 5); assert.equal(d.trend.length, 12);
  assert.equal(d.by_station.length, 1, 'station-scoped dashboard');
  const n = (await mgmt.get('/api/dashboard?month=2026-10')).data;
  assert.equal(n.by_station.length, 6);
  const csv = await mgmt.get('/api/export/calls.csv?month=2026-10');
  assert.match(csv.data, /Vessel Type,Rotation Classification,Rotation Sequence No\./);
  assert.match(csv.data, /2026\/CRG\/5698/);
  assert.equal((await officer.get('/api/export/calls.csv')).status, 403);
});

test('admin-only deletion with reason', async () => {
  const c = (await officer.post('/api/calls', { ...arrival, vessel_name: 'Mistake', imo: null, vessel_type: 'Other', arrival_date: '2026-10-08' })).data;
  assert.equal((await sup.del(`/api/calls/${c.id}`, { reason: 'dup' })).status, 403);
  assert.equal((await admin.del(`/api/calls/${c.id}`, {})).status, 400);
  assert.equal((await admin.del(`/api/calls/${c.id}`, { reason: 'Duplicate entry' })).status, 200);
  assert.equal((await admin.get(`/api/calls/${c.id}`)).status, 404);
});
