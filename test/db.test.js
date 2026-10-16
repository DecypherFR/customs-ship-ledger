// Database tests: run the migration on a scratch Postgres database and exercise every rule
// as real signed-in users (role "authenticated" + JWT claims), so RLS and permissions are tested.
// Needs a local Postgres. Set TEST_DATABASE_URL to an admin connection (default: postgres on localhost).
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5432/postgres';
const DB = `ledger_test_${process.pid}`;
const root = path.join(__dirname, '..');
let db;
const users = {};

before(async () => {
  const admin = new Client({ connectionString: ADMIN_URL }); await admin.connect();
  await admin.query(`create database ${DB}`); await admin.end();
  db = new Client({ connectionString: ADMIN_URL.replace(/\/[^/]*$/, `/${DB}`) }); await db.connect();
  await db.query(fs.readFileSync(path.join(root, 'dev/supabase_shim.sql'), 'utf8'));
  for (const f of fs.readdirSync(path.join(root, 'supabase/migrations')).sort()) await db.query(fs.readFileSync(path.join(root, 'supabase/migrations', f), 'utf8'));
  // Accounts, as the admin-users edge function would create them.
  const mk = async (key, role, station, extra = {}) => {
    const { rows: [u] } = await db.query('insert into auth.users(email) values ($1) returning id', [`${key}@test.bz`]);
    await db.query(`insert into profiles(id,email,full_name,initials,role,station_code,must_change_password,active) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [u.id, `${key}@test.bz`, `${key} Test`, key.toUpperCase(), role, station, extra.must ?? false, extra.active ?? true]);
    users[key] = u.id;
  };
  await mk('admin', 'admin', null); await mk('off', 'officer', 'BZE'); await mk('off2', 'officer', 'SPR');
  await mk('sup', 'supervisor', 'BZE'); await mk('sup2', 'supervisor', 'BZE'); await mk('mgmt', 'management', null);
  await mk('inv', 'investigator', null); await mk('newbie', 'officer', 'BZE', { must: true }); await mk('gone', 'officer', 'BZE', { active: false });
  await db.query("insert into shipping_agents(name) values ('SAN PEDRO YACHT SERVICES')");
});
after(async () => {
  await db.end();
  const admin = new Client({ connectionString: ADMIN_URL }); await admin.connect();
  await admin.query(`drop database if exists ${DB} with (force)`); await admin.end();
});

// Run SQL as a signed-in user, the way PostgREST does. Returns { status, rows, field, message }.
async function as(who, sql, params = []) {
  await db.query('begin');
  try {
    await db.query("select set_config('ledger.today', '2026-10-15', true)");
    await db.query(`set local role ${who ? 'authenticated' : 'anon'}`);
    if (who) await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: users[who], role: 'authenticated' })]);
    const r = await db.query(sql, params);
    await db.query('commit');
    return { status: 200, rows: r.rows };
  } catch (e) {
    await db.query('rollback');
    const status = /^PT\d{3}$/.test(e.code) ? Number(e.code.slice(2)) : e.code === '42501' ? 403 : 500;
    if (status === 500) throw e;
    return { status, field: e.hint || null, message: e.message };
  }
}
const rpc = (who, fn, ...args) => as(who, `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) as r`, args.map((a) => (a && typeof a === 'object' ? JSON.stringify(a) : a)))
  .then((r) => (r.status === 200 ? { ...r, data: r.rows[0].r } : r));
const call = async (who, id) => (await as(who, 'select * from call_overview where id = $1', [id])).rows[0];
// Today is pinned to 2026-10-15. Flag and agent are typed in lower case on purpose: names are stored in capitals.
const arrival = { vessel_name: 'Sea Esprit', imo: '1018822', flag: 'united states of america', agent: 'San Pedro Yacht Services', gross_tonnage: 48,
  net_tonnage: 19, crew: 3, passengers: 0, master: 'John Carver', last_port: 'Isla Mujeres', next_port: 'Roatan', cargo: 'Ballast / No Cargo',
  estimated_departure: '2026-10-30' };
const create = async (who, body) => { const r = await rpc(who, 'create_call', body); return r.status === 200 ? { ...r, data: await call(who, r.data) } : r; };

test('anonymous users see nothing and signed-in users cannot write tables directly', async () => {
  assert.equal((await as(null, 'select * from calls')).status, 403);
  assert.equal((await as(null, 'select public.dashboard()')).status, 403);
  assert.equal((await as('admin', "insert into stations(code,name) values ('XX','x')")).status, 403);
  assert.equal((await as('admin', "update settings set value='1'")).status, 403);
  assert.equal((await as('sup', 'delete from audit')).status, 403);
});

test('inactive users and users who must change their password are blocked', async () => {
  assert.equal((await rpc('gone', 'create_call', { ...arrival, vessel_type: 'Other', arrival_date: '2026-10-01' })).status, 401);
  assert.equal((await as('gone', 'select * from stations')).rows.length, 0);
  const r = await rpc('newbie', 'create_call', { ...arrival, vessel_type: 'Other', arrival_date: '2026-10-01' });
  assert.equal(r.status, 403); assert.equal(r.field, 'must_change_password');
  assert.equal((await rpc('newbie', 'password_changed')).status, 200);
});

test('rotation numbers: one shared automatic sequence for non-CRG classes, manual unique CRG numbers', async () => {
  const a = await create('off', { ...arrival, vessel_type: 'Pleasure Vessel / Yacht', arrival_date: '2026-10-01' });
  assert.equal(a.data.rotation_no, '2026/PSV/1');
  assert.equal((await create('off', { ...arrival, vessel_name: 'Gulf Runner', imo: '9201776', vessel_type: 'Supply Vessel', arrival_date: '2026-10-02' })).data.rotation_no, '2026/SUP/2');
  assert.equal((await create('off', { ...arrival, vessel_name: 'Blue Lagoon', imo: '1000001', vessel_type: 'Liveaboard Vessel', arrival_date: '2026-10-02' })).data.rotation_no, '2026/LVB/3');
  const noSeq = await create('off', { ...arrival, vessel_name: 'Ocean Pioneer', vessel_type: 'Container Vessel', arrival_date: '2026-10-03' });
  assert.equal(noSeq.status, 400); assert.equal(noSeq.field, 'rotation_seq');
  assert.equal((await create('off', { ...arrival, vessel_name: 'Ocean Pioneer', vessel_type: 'Container Vessel', rotation_seq: 'abc', arrival_date: '2026-10-03' })).field, 'rotation_seq');
  const crg = await create('off', { ...arrival, vessel_name: 'Ocean Pioneer', imo: '9500001', vessel_type: 'Container Vessel', rotation_seq: 4321, arrival_date: '2026-10-03' });
  assert.equal(crg.data.rotation_no, '2026/CRG/4321');
  assert.equal((await create('off', { ...arrival, vessel_name: 'Other Ship', vessel_type: 'General Cargo Vessel', rotation_seq: 4321, arrival_date: '2026-10-04' })).status, 409);
  assert.equal((await create('off', { ...arrival, vessel_name: 'Fish', imo: '', vessel_type: 'Fishing Vessel', arrival_date: '2026-10-05' })).data.rotation_no, '2026/FSH/4');
  assert.equal(a.data.station_code, 'BZE'); assert.equal(a.data.vessel_name, 'SEA ESPRIT');
  assert.equal(a.data.boarding_officer, 'OFF', 'boarding officer defaults to the person recording');
});

test('validation: departure before arrival, future arrival, missing clearance officer, bad numbers', async () => {
  const b = { ...arrival, vessel_type: 'Other', arrival_date: '2026-10-10' };
  assert.equal((await rpc('off', 'create_call', { ...b, departure_date: '2026-10-09', clearance_officer_id: users.off })).field, 'departure_date');
  assert.equal((await rpc('off', 'create_call', { ...b, arrival_date: '2026-12-01' })).field, 'arrival_date');
  assert.equal((await rpc('off', 'create_call', { ...b, departure_date: '2026-10-11' })).field, 'clearance_officer_id');
  assert.equal((await rpc('off', 'create_call', { ...b, crew: 'many' })).status, 400);
  assert.equal((await rpc('off', 'create_call', { ...b, cargo: 'Gold' })).field, 'cargo');
  assert.equal((await rpc('off', 'create_call', { ...b, estimated_departure: '' })).field, 'estimated_departure', 'a vessel in port needs an EDD');
  assert.equal((await rpc('off', 'create_call', { ...b, estimated_departure: '2026-10-09' })).field, 'estimated_departure', 'EDD before arrival');
  assert.equal((await rpc('off', 'create_call', { ...b, vessel_name: 'Late Entry', imo: '', estimated_departure: '', departure_date: '2026-10-11', clearance_officer_id: users.off })).status, 200,
    'a call recorded after the vessel left needs no EDD');
});

test('data check flags incomplete records like the workbook', async () => {
  const r = await create('off', { vessel_type: 'Other', vessel_name: 'Mystery', arrival_date: '2026-10-12', estimated_departure: '2026-10-20' });
  assert.equal(r.status, 200);
  assert.match(r.data.data_check[0], /^Missing: Flag/);
});

test('station scoping: officers only see and write their own station', async () => {
  const spr = await create('off2', { ...arrival, vessel_name: 'Windsong', imo: '1020456', vessel_type: 'Pleasure Vessel / Yacht', arrival_date: '2026-10-06', station_code: 'BZE' });
  assert.equal(spr.data.station_code, 'SPR');
  assert.equal(await call('off', spr.data.rotation_no ? spr.data.id : 0), undefined, 'BZE officer cannot read a SPR call');
  assert.equal((await rpc('off', 'update_call', spr.data.id, { remarks: 'x' })).status, 404);
  const mine = (await as('off', 'select distinct station_code from call_overview')).rows.map((r) => r.station_code);
  assert.deepEqual(mine, ['BZE']);
  assert.ok((await as('mgmt', "select 1 from call_overview where station_code='SPR'")).rows.length > 0);
});

test('read-only roles cannot write; audit only for management and admin', async () => {
  assert.equal((await rpc('mgmt', 'create_call', { ...arrival, vessel_type: 'Other', arrival_date: '2026-10-10' })).status, 403);
  assert.equal((await rpc('inv', 'create_call', { ...arrival, vessel_type: 'Other', arrival_date: '2026-10-10' })).status, 403);
  assert.equal((await rpc('off', 'save_settings', { long_stay_days: '5' })).status, 403);
  assert.equal((await as('off', 'select * from audit')).rows.length, 0);
  assert.equal((await as('off', 'select * from cases')).rows.length, 0);
  assert.ok((await as('mgmt', 'select * from audit')).rows.length > 0);
});

test('extensions: request, approval by another supervisor, overstay status and investigation cases', async () => {
  const c = (await create('off', { ...arrival, vessel_name: 'Long Stayer', imo: '7777777', vessel_type: 'Pleasure Vessel / Yacht', arrival_date: '2026-08-01',
    estimated_departure: '2026-08-15' })).data;
  assert.equal(c.overstay_status, 'OVERDUE', 'no extension: the stay ended at the EDD'); assert.equal(c.days_overdue, 61); assert.equal(c.stay_basis, 'EDD');
  assert.equal((await rpc('off', 'add_extension', c.id, { new_expiry: '2026-09-15', reason: 'Weather' })).status, 200);
  const [req] = (await as('off', 'select * from extensions where call_id=$1', [c.id])).rows;
  assert.equal(req.status, 'PENDING'); assert.equal(req.original_expiry.toISOString().slice(0, 10), '2026-08-15', 'first extension starts from the EDD');
  assert.equal((await call('off', c.id)).overstay_status, 'OVERDUE', 'a pending request does not extend the stay');
  assert.equal((await rpc('off', 'decide_extension', req.id, 'APPROVED', null)).status, 403);
  assert.equal((await rpc('sup', 'decide_extension', req.id, 'REJECTED', null)).field, 'note');
  assert.equal((await rpc('sup', 'decide_extension', req.id, 'APPROVED', null)).status, 200);
  assert.equal((await rpc('sup', 'decide_extension', req.id, 'APPROVED', null)).status, 409);
  let d = await call('sup', c.id);
  assert.equal(d.extension_count, 1); assert.equal(d.overstay_status, 'OVERDUE'); assert.equal(d.days_overdue, 30); assert.equal(d.priority, 'OVERDUE - FOLLOW UP');
  assert.equal(d.stay_basis, 'EXTENSION');
  assert.equal((await rpc('sup', 'add_extension', c.id, { new_expiry: '2026-09-01', reason: 'Weather' })).field, 'new_expiry');
  for (const to of ['2026-10-01', '2026-10-10']) assert.equal((await rpc('sup', 'add_extension', c.id, { new_expiry: to, reason: 'Weather' })).status, 200);
  const exts = (await as('sup', 'select * from extensions where call_id=$1 order by id', [c.id])).rows;
  assert.equal(exts[2].original_expiry.toISOString().slice(0, 10), '2026-10-01', 'original expiry carried from previous extension');
  assert.equal((await call('sup', c.id)).priority, 'URGENT - 3+ EXTENSIONS');
  await rpc('sup', 'add_extension', c.id, { new_expiry: '2026-10-20', reason: 'Weather' });
  assert.equal((await call('sup', c.id)).overstay_status, 'EXPIRING SOON');
  assert.equal((await rpc('inv', 'add_case_note', c.id, 'Agent contacted.', null)).status, 200);
  assert.equal((await rpc('inv', 'save_case', c.id, { status: 'CLOSED' })).field, 'outcome');
  assert.equal((await rpc('inv', 'save_case', c.id, { status: 'CLOSED', outcome: 'Departed under escort' })).status, 200);
  const k = (await as('inv', 'select k.status, (select count(*) from case_notes n where n.case_id=k.id)::int n from cases k where call_id=$1', [c.id])).rows[0];
  assert.deepEqual(k, { status: 'CLOSED', n: 1 });
  assert.equal((await as('mgmt', 'select * from cases where call_id=$1', [c.id])).rows.length, 1, 'management can view cases');
  assert.equal((await rpc('mgmt', 'save_case', c.id, { status: 'OPEN' })).status, 403, 'but cannot change them');
});

test('the EDD is the approved stay until an extension replaces it; only supervisors can move it', async () => {
  const mk = (name, edd) => create('off', { ...arrival, vessel_name: name, imo: '', vessel_type: 'Other', arrival_date: '2026-10-01', estimated_departure: edd });
  const within = (await mk('Within', '2026-10-30')).data;
  assert.equal(within.overstay_status, 'WITHIN STAY'); assert.equal(within.latest_expiry.toISOString().slice(0, 10), '2026-10-30'); assert.equal(within.days_to_expiry, 15);
  assert.equal((await mk('Soon', '2026-10-18')).data.overstay_status, 'EXPIRING SOON');
  assert.equal((await mk('Today', '2026-10-15')).data.overstay_status, 'EXPIRING SOON', 'the stay includes the EDD itself');
  const late = (await mk('Late', '2026-10-10')).data;
  assert.equal(late.overstay_status, 'OVERDUE'); assert.equal(late.days_overdue, 5);
  const moved = await rpc('off', 'update_call', late.id, { estimated_departure: '2026-10-25' });
  assert.equal(moved.status, 403); assert.equal(moved.field, 'estimated_departure');
  assert.equal((await rpc('off', 'update_call', late.id, { remarks: 'other fields still editable' })).status, 200);
  assert.equal((await rpc('sup', 'update_call', late.id, { estimated_departure: '2026-10-25' })).status, 200);
  assert.equal((await call('sup', late.id)).overstay_status, 'WITHIN STAY');
  // Calls recorded before EDDs existed keep the old rule.
  await db.query('update calls set estimated_departure = null where id = $1', [within.id]);
  assert.equal((await call('off', within.id)).overstay_status, 'NO EXTENSION');
  await db.query("update calls set arrival_date = '2026-08-01' where id = $1", [within.id]);
  const legacy = await call('off', within.id);
  assert.equal(legacy.overstay_status, 'LONG STAY'); assert.equal(legacy.priority, 'REVIEW - NO EDD OR EXTENSION ON FILE');
  assert.equal((await rpc('off', 'update_call', within.id, { remarks: 'needs an EDD now' })).field, 'estimated_departure');
  assert.equal((await rpc('off', 'update_call', within.id, { estimated_departure: '2026-10-20' })).status, 200, 'an officer may fill in a missing EDD');
});

test('shipping agents and flags come from standard lists', async () => {
  const b = { ...arrival, vessel_type: 'Other', arrival_date: '2026-10-10' };
  assert.equal((await rpc('off', 'create_call', { ...b, flag: 'USA' })).field, 'flag');
  assert.equal((await rpc('off', 'create_call', { ...b, agent: 'Unknown Agency' })).field, 'agent');
  // Officers add agents; a different spelling of a listed agent returns the listed name.
  assert.equal((await rpc('off', 'add_agent', '  Marine   Supply Co. ')).data, 'MARINE SUPPLY CO.');
  assert.equal((await rpc('off', 'add_agent', 'marine supply co')).data, 'MARINE SUPPLY CO.');
  assert.equal((await rpc('off', 'add_agent', 'Bay Shipping & Logistics')).data, 'BAY SHIPPING & LOGISTICS');
  assert.equal((await rpc('off', 'add_agent', 'Bay Shipping and Logistics')).data, 'BAY SHIPPING & LOGISTICS');
  assert.equal((await rpc('mgmt', 'add_agent', 'X')).status, 403);
  assert.equal((await rpc('off', 'save_list', 'flags', [{ name: 'ATLANTIS' }])).status, 403, 'only admins edit the lists');
  const one = (await create('off', { ...b, vessel_name: 'Agent One', imo: '3330001', agent: 'marine supply co.' })).data;
  const two = (await create('off', { ...b, vessel_name: 'Agent Two', imo: '3330002', agent: 'Bay Shipping & Logistics' })).data;
  assert.equal(one.agent, 'MARINE SUPPLY CO.');
  // Renaming corrects every call; renaming to an existing name merges.
  assert.equal((await rpc('admin', 'save_list', 'shipping_agents', [{ old: 'MARINE SUPPLY CO.', name: 'Marine Supply Company', active: true }])).status, 200);
  assert.equal((await call('off', one.id)).agent, 'MARINE SUPPLY COMPANY');
  assert.equal((await rpc('admin', 'save_list', 'shipping_agents', [{ old: 'BAY SHIPPING & LOGISTICS', name: 'MARINE SUPPLY COMPANY', active: true }])).status, 200);
  assert.equal((await call('off', two.id)).agent, 'MARINE SUPPLY COMPANY');
  assert.equal((await as('off', "select * from shipping_agents where name = 'BAY SHIPPING & LOGISTICS'")).rows.length, 0);
  // Flags: merging a variant moves calls and the vessel registry.
  await db.query("insert into flags(name) values ('U.S.A.')");
  const v = (await create('off', { ...b, vessel_name: 'Flag Variant', imo: '3330003', flag: 'U.S.A.' })).data;
  assert.equal((await rpc('admin', 'save_list', 'flags', [{ old: 'U.S.A.', name: 'UNITED STATES OF AMERICA', active: true }])).status, 200);
  assert.equal((await call('off', v.id)).flag, 'UNITED STATES OF AMERICA');
  assert.equal((await as('off', "select flag from vessels where imo = '3330003'")).rows[0].flag, 'UNITED STATES OF AMERICA');
  // Deactivated entries disappear from the pick-list but stay on existing calls.
  assert.equal((await rpc('admin', 'save_list', 'flags', [{ old: 'CANADA', name: 'CANADA', active: false }])).status, 200);
  assert.equal((await as('off', "select active from flags where name = 'CANADA'")).rows[0].active, false);
});

test('nobody approves their own request', async () => {
  const c = (await create('sup', { ...arrival, vessel_name: 'Self', imo: '5555555', vessel_type: 'Other', arrival_date: '2026-10-01' })).data;
  await rpc('admin', 'save_settings', { require_extension_approval: '1' });
  await rpc('off', 'add_extension', c.id, { original_expiry: '2026-10-10', new_expiry: '2026-11-10', reason: 'Weather' });
  const [e] = (await as('sup', 'select * from extensions where call_id=$1', [c.id])).rows;
  // simulate a supervisor-requested pending item: an officer promoted after requesting
  await db.query("update extensions set requested_by=$1 where id=$2", [users.sup2, e.id]);
  assert.equal((await rpc('sup2', 'decide_extension', e.id, 'APPROVED', null)).status, 403);
  assert.equal((await rpc('sup', 'decide_extension', e.id, 'REJECTED', 'Not justified')).status, 200);
});

test('optimistic locking, departure, verification lock and audit history', async () => {
  const c = (await create('off', { ...arrival, vessel_name: 'Locker', imo: '6666666', vessel_type: 'Other', arrival_date: '2026-10-01' })).data;
  assert.equal((await rpc('off', 'update_call', c.id, { version: c.version, remarks: 'first' })).status, 200);
  assert.equal((await rpc('off', 'update_call', c.id, { version: c.version, remarks: 'stale' })).status, 409);
  assert.equal((await rpc('sup', 'verify_call', c.id, false, null)).status, 400);
  assert.equal((await rpc('off', 'update_call', c.id, { departure_date: '2026-10-05', clearance_officer_id: users.off })).status, 200);
  assert.equal((await call('off', c.id)).status, 'DEPARTED');
  assert.equal((await rpc('off', 'verify_call', c.id, false, null)).status, 403);
  assert.equal((await rpc('sup', 'verify_call', c.id, false, null)).status, 200);
  assert.equal((await rpc('off', 'update_call', c.id, { remarks: 'after lock' })).status, 423);
  assert.equal((await rpc('sup', 'verify_call', c.id, true, null)).field, 'reason');
  assert.equal((await rpc('sup', 'verify_call', c.id, true, 'Wrong crew count')).status, 200);
  const h = (await as('mgmt', "select action from audit where entity='call' and entity_id=$1 order by id desc", [c.id])).rows.map((r) => r.action);
  assert.deepEqual(h, ['unlock', 'verify', 'update', 'update', 'create']);
  assert.deepEqual((await as('off', 'select action from call_history($1)', [c.id])).rows.map((r) => r.action), h, 'officers see the history of their own calls');
  assert.equal((await as('off2', 'select * from call_history($1)', [c.id])).status, 404);
  assert.equal((await rpc('off', 'update_call', c.id, { vessel_type: 'Supply Vessel' })).status, 400, 'officers cannot change the rotation class');
  assert.equal((await rpc('admin', 'update_call', c.id, { vessel_type: 'Supply Vessel' })).status, 200);
  assert.match((await call('admin', c.id)).rotation_no, /^2026\/SUP\/\d+$/);
});

test('offline replays with the same client_uuid do not duplicate records', async () => {
  const body = { ...arrival, vessel_name: 'Replay', imo: '4444444', vessel_type: 'Other', arrival_date: '2026-10-07', client_uuid: 'a6b0b6e0-1111-4111-8111-000000000001' };
  assert.equal((await rpc('off', 'create_call', body)).data, (await rpc('off', 'create_call', body)).data);
});

test('vessel registry remembers particulars for repeat calls', async () => {
  const [v] = (await as('off', "select * from search_vessels('1018822')")).rows;
  assert.equal(v.name, 'SEA ESPRIT'); assert.equal(Number(v.gross_tonnage), 48); assert.equal(v.last_master, 'JOHN CARVER');
});

test('dashboard is scoped to the station', async () => {
  const d = (await rpc('sup', 'dashboard', '2026-10', null)).data;
  assert.equal(d.station, 'BZE'); assert.ok(d.totals.calls >= 5); assert.equal(d.trend.length, 12); assert.equal(d.by_station.length, 1);
  assert.equal((await rpc('sup', 'dashboard', '2026-10', 'SPR')).data.station, 'BZE', 'station users cannot pick another station');
  const n = (await rpc('mgmt', 'dashboard', '2026-10', null)).data;
  assert.equal(n.by_station.length, 6); assert.ok(n.attention.overdue >= 0);
});

test('admin: lists, settings, users, import and deletion', async () => {
  assert.equal((await rpc('admin', 'save_settings', { long_stay_days: '0' })).field, 'long_stay_days');
  assert.equal((await rpc('admin', 'save_list', 'stations', [{ code: 'CC', name: 'Corozal', active: true }])).status, 200);
  assert.equal((await as('off', "select name from stations where code='CC'")).rows[0].name, 'Corozal');
  assert.equal((await rpc('admin', 'admin_save_profile', users.admin, { role: 'officer' })).status, 400, 'admins cannot demote themselves');
  assert.equal((await rpc('admin', 'admin_save_profile', users.off2, { station_code: 'PG' })).status, 200);
  const imp = await rpc('admin', 'import_ledger', JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/ledger.json'), 'utf8')));
  assert.equal(imp.data.calls, 1, '2026/CRG/4321 already exists from an earlier test'); assert.match(imp.data.skipped[0], /2026\/CRG\/4321: already imported/);
  assert.equal(imp.data.extensions, 1); assert.deepEqual(imp.data.officers_created, ['J.REYES']);
  const atomic = (await as('admin', "select * from call_overview where rotation_no='2026/OTH/1'")).rows[0];
  assert.equal(atomic.vessel_type, 'Liveaboard Vessel'); assert.equal(atomic.extension_count, 1); assert.equal(atomic.next_port, null);
  assert.equal((await rpc('admin', 'import_ledger', JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/ledger.json'), 'utf8')))).data.calls, 0, 're-import skips');
  assert.equal((await rpc('sup', 'delete_call', atomic.id, 'dup')).status, 403);
  assert.equal((await rpc('admin', 'delete_call', atomic.id, '')).field, 'reason');
  assert.equal((await rpc('admin', 'delete_call', atomic.id, 'Duplicate entry')).status, 200);
  assert.equal(await call('admin', atomic.id), undefined);
});
