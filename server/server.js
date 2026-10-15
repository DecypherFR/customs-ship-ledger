// Belize Customs & Excise - National Ships Ledger: API + static PWA server.
// Zero npm dependencies: node:http, node:sqlite, node:crypto.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { open, tx } = require('./db');
const A = require('./auth');
const L = require('./ledger');
const { httpError } = L;

const PORT = Number(process.env.PORT || 8080);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'ledger.db');
const PUBLIC = path.join(__dirname, '..', 'public');
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);
const SECURE_COOKIE = process.env.COOKIE_SECURE === '1';
const db = open(DB_FILE);

// ---- helpers -----------------------------------------------------------------
const one = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);
const nz = (v) => (v === undefined || v === '' ? null : v);
const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
const txt = (v) => (v === undefined || v === null ? null : String(v).trim() || null);
const up = (v) => (txt(v) ? txt(v).toUpperCase() : null);

function audit(user, action, entity, id, summary, details) {
  run('INSERT INTO audit(user_id,action,entity,entity_id,summary,details) VALUES (?,?,?,?,?,?)',
    user ? user.id : null, action, entity, id ?? null, summary || null, details ? JSON.stringify(details) : null);
}
function need(user, perm) { if (!A.can(user, perm)) throw httpError(403, 'You are not authorised to do this.'); }
function inScope(user, stationCode) {
  const s = A.stationScope(user);
  if (s && s !== stationCode) throw httpError(403, 'This record belongs to another station.');
}

// ---- call loading / enrichment -------------------------------------------------
const CALL_SELECT = `SELECT c.*, s.name station_name, bo.initials boarding_officer, co.initials clearance_officer,
  vu.initials verified_by_name FROM calls c JOIN stations s ON s.code = c.station_code
  LEFT JOIN users bo ON bo.id = c.boarding_officer_id LEFT JOIN users co ON co.id = c.clearance_officer_id
  LEFT JOIN users vu ON vu.id = c.verified_by`;

function enrich(calls) {
  if (!calls.length) return calls;
  const settings = L.settingsOf(db);
  const ids = calls.map((c) => c.id);
  const exts = all(`SELECT id, call_id, new_expiry, status FROM extensions WHERE call_id IN (${ids.map(() => '?').join(',')})`, ...ids);
  const cases = all(`SELECT call_id, id, status FROM cases WHERE call_id IN (${ids.map(() => '?').join(',')})`, ...ids);
  const byCall = {}; const pending = {}; const caseBy = {};
  for (const e of exts) {
    if (e.status === 'APPROVED') (byCall[e.call_id] ||= []).push(e);
    if (e.status === 'PENDING') pending[e.call_id] = (pending[e.call_id] || 0) + 1;
  }
  for (const k of cases) caseBy[k.call_id] = k;
  const t = L.today();
  return calls.map((c) => {
    c.officer_report = safeJson(c.officer_report);
    const chk = L.checkCall(c);
    return {
      ...c, ...L.deriveStatus(c, byCall[c.id] || [], settings, t),
      pending_extensions: pending[c.id] || 0,
      data_check: chk.warnings.length ? chk.warnings : null,
      case_status: caseBy[c.id] ? caseBy[c.id].status : null,
    };
  });
}
const safeJson = (s) => { try { return typeof s === 'string' ? JSON.parse(s) : s || {}; } catch { return {}; } };

function getCall(user, id) {
  const c = one(`${CALL_SELECT} WHERE c.id = ?`, Number(id));
  if (!c) throw httpError(404, 'Vessel call not found.');
  inScope(user, c.station_code);
  return enrich([c])[0];
}

function scopedCalls(user, where = [], args = []) {
  const s = A.stationScope(user);
  if (s) { where.push('c.station_code = ?'); args.push(s); }
  return enrich(all(`${CALL_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.arrival_date DESC, c.id DESC`, ...args));
}

// ---- call create / update --------------------------------------------------------
const CALL_FIELDS = ['vessel_type', 'station_code', 'voyage_no', 'vessel_name', 'imo', 'flag', 'agent', 'gross_tonnage',
  'net_tonnage', 'crew', 'passengers', 'master', 'last_port', 'arrival_date', 'boarding_officer_id', 'next_port',
  'departure_date', 'clearance_officer_id', 'cargo', 'remarks'];
const REPORT_FIELDS = ['anchorage_time', 'boarding_time', 'health_official', 'pilot_name', 'fumigated', 'rummaged', 'report_remarks'];

function normaliseCall(b) {
  const report = {};
  for (const f of REPORT_FIELDS) if (b.officer_report && b.officer_report[f] != null) report[f] = String(b.officer_report[f]).trim();
  return {
    vessel_type: txt(b.vessel_type), station_code: txt(b.station_code), voyage_no: up(b.voyage_no),
    vessel_name: up(b.vessel_name), imo: up(b.imo), flag: up(b.flag), agent: up(b.agent),
    gross_tonnage: num(b.gross_tonnage), net_tonnage: num(b.net_tonnage), crew: num(b.crew), passengers: num(b.passengers),
    master: up(b.master), last_port: up(b.last_port), arrival_date: nz(b.arrival_date),
    boarding_officer_id: num(b.boarding_officer_id), next_port: up(b.next_port), departure_date: nz(b.departure_date),
    clearance_officer_id: num(b.clearance_officer_id), cargo: txt(b.cargo), remarks: txt(b.remarks), officer_report: report,
  };
}
function validateRefs(c) {
  if (c.station_code && !one('SELECT 1 FROM stations WHERE code=?', c.station_code)) throw httpError(400, 'Unknown station.', { field: 'station_code' });
  if (c.cargo && !one('SELECT 1 FROM cargo_types WHERE name=?', c.cargo)) throw httpError(400, 'Unknown cargo / operation.', { field: 'cargo' });
  for (const f of ['boarding_officer_id', 'clearance_officer_id']) {
    if (c[f] && !one('SELECT 1 FROM users WHERE id=?', c[f])) throw httpError(400, 'Unknown officer.', { field: f });
  }
  const { errors } = L.checkCall(c);
  const keys = Object.keys(errors);
  if (keys.length) throw httpError(400, errors[keys[0]], { field: keys[0], errors });
}
function upsertVessel(c) {
  if (!c.imo) return null;
  const v = one('SELECT id FROM vessels WHERE imo=?', c.imo);
  if (v) {
    run(`UPDATE vessels SET name=?, flag=COALESCE(?,flag), vessel_type=COALESCE(?,vessel_type), gross_tonnage=COALESCE(?,gross_tonnage),
         net_tonnage=COALESCE(?,net_tonnage), updated_at=datetime('now') WHERE id=?`, c.vessel_name, c.flag, c.vessel_type, c.gross_tonnage, c.net_tonnage, v.id);
    return v.id;
  }
  return Number(run('INSERT INTO vessels(imo,name,flag,vessel_type,gross_tonnage,net_tonnage) VALUES (?,?,?,?,?,?)',
    c.imo, c.vessel_name, c.flag, c.vessel_type, c.gross_tonnage, c.net_tonnage).lastInsertRowid);
}

function createCall(user, body) {
  need(user, 'calls.create');
  if (body.client_uuid) {
    const dup = one('SELECT id FROM calls WHERE client_uuid=?', body.client_uuid);
    if (dup) return getCall(user, dup.id); // offline replay: already saved
  }
  const c = normaliseCall(body);
  const scope = A.stationScope(user);
  if (scope) c.station_code = scope;
  if (!c.boarding_officer_id) c.boarding_officer_id = user.id;
  if (c.departure_date) need(user, 'calls.depart');
  validateRefs(c);
  const id = tx(db, () => {
    const rot = L.allocateRotation(db, { vesselType: c.vessel_type, arrivalDate: c.arrival_date, manualSeq: body.rotation_seq });
    const vesselId = upsertVessel(c);
    const cols = [...CALL_FIELDS, 'officer_report', 'rotation_year', 'rotation_class', 'rotation_seq', 'rotation_no', 'vessel_id', 'client_uuid', 'created_by', 'updated_by'];
    const vals = [...CALL_FIELDS.map((f) => c[f]), JSON.stringify(c.officer_report), rot.rotation_year, rot.rotation_class, rot.rotation_seq, rot.rotation_no, vesselId, nz(body.client_uuid), user.id, user.id];
    const r = run(`INSERT INTO calls(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...vals);
    audit(user, 'create', 'call', Number(r.lastInsertRowid), `Recorded ${rot.rotation_no} ${c.vessel_name} at ${c.station_code}`);
    return Number(r.lastInsertRowid);
  });
  return getCall(user, id);
}

function updateCall(user, id, body) {
  need(user, 'calls.edit');
  const cur = getCall(user, id);
  if (body.version != null && Number(body.version) !== cur.version) {
    throw httpError(409, `This call was changed by someone else (now version ${cur.version}). Reload it and re-apply your changes.`, { current: cur });
  }
  if (cur.verified_at && user.role !== 'admin') throw httpError(423, 'This call is verified and locked. A supervisor must unlock it first.');
  const merged = { ...cur, ...normaliseCall({ ...cur, ...body, officer_report: { ...cur.officer_report, ...(body.officer_report || {}) } }) };
  const scope = A.stationScope(user);
  if (scope && merged.station_code !== scope) throw httpError(403, 'You can only record calls for your own station.');
  if (merged.departure_date && !cur.departure_date) need(user, 'calls.depart');
  validateRefs(merged);

  // The rotation number is printed on documents, so only an administrator may change it.
  const newType = one('SELECT * FROM vessel_types WHERE name=?', merged.vessel_type);
  if (!newType) throw httpError(400, 'Unknown vessel type.', { field: 'vessel_type' });
  const yearChanged = Number(merged.arrival_date.slice(0, 4)) !== cur.rotation_year;
  const classChanged = newType.rotation_class !== cur.rotation_class;
  const seqChanged = newType.manual_sequence && body.rotation_seq != null && Number(body.rotation_seq) !== cur.rotation_seq;
  let rot = null;
  if (yearChanged || classChanged || seqChanged) {
    if (user.role !== 'admin') throw httpError(400, 'This change would alter the Rotation No. Ask an administrator to make it.', { field: yearChanged ? 'arrival_date' : 'vessel_type' });
    rot = L.allocateRotation(db, { vesselType: merged.vessel_type, arrivalDate: merged.arrival_date, manualSeq: body.rotation_seq ?? cur.rotation_seq });
  }

  const changes = {};
  for (const f of CALL_FIELDS) if ((cur[f] ?? null) !== (merged[f] ?? null)) changes[f] = [cur[f] ?? null, merged[f] ?? null];
  if (JSON.stringify(cur.officer_report) !== JSON.stringify(merged.officer_report)) changes.officer_report = [cur.officer_report, merged.officer_report];
  if (rot) changes.rotation_no = [cur.rotation_no, rot.rotation_no];
  if (!Object.keys(changes).length) return cur;

  tx(db, () => {
    const vesselId = upsertVessel(merged) ?? cur.vessel_id;
    const sets = [...CALL_FIELDS.map((f) => `${f}=?`), 'officer_report=?', 'vessel_id=?', 'version=version+1', 'updated_by=?', "updated_at=datetime('now')"];
    const vals = [...CALL_FIELDS.map((f) => merged[f]), JSON.stringify(merged.officer_report), vesselId, user.id];
    if (rot) { sets.push('rotation_year=?', 'rotation_class=?', 'rotation_seq=?', 'rotation_no=?'); vals.push(rot.rotation_year, rot.rotation_class, rot.rotation_seq, rot.rotation_no); }
    run(`UPDATE calls SET ${sets.join(',')} WHERE id=?`, ...vals, cur.id);
    const what = changes.departure_date && !cur.departure_date ? `Departure recorded ${merged.departure_date}` : `Updated ${Object.keys(changes).join(', ')}`;
    audit(user, 'update', 'call', cur.id, `${rot ? rot.rotation_no : cur.rotation_no}: ${what}`, changes);
  });
  return getCall(user, cur.id);
}

// ---- extensions -----------------------------------------------------------------
function extensionsFor(callId) {
  return all(`SELECT e.*, r.initials requested_by_name, d.initials decided_by_name FROM extensions e
    JOIN users r ON r.id=e.requested_by LEFT JOIN users d ON d.id=e.decided_by WHERE call_id=? ORDER BY e.id`, callId)
    .map((e, i, arr) => ({ ...e, ext_no: arr.slice(0, i + 1).filter((x) => x.status === 'APPROVED').length }));
}
function addExtension(user, callId, b) {
  need(user, 'ext.request');
  const call = getCall(user, callId);
  if (b.client_uuid) {
    const dup = one('SELECT id FROM extensions WHERE client_uuid=?', b.client_uuid);
    if (dup) return extensionsFor(call.id);
  }
  if (call.departure_date) throw httpError(400, 'This vessel has already departed.');
  const original = nz(b.original_expiry) || call.latest_expiry;
  if (!L.isDate(original)) throw httpError(400, 'Enter the original expiry date.', { field: 'original_expiry' });
  if (!L.isDate(b.new_expiry)) throw httpError(400, 'Enter the new expiry date.', { field: 'new_expiry' });
  if (b.new_expiry <= original) throw httpError(400, 'New expiry must be after the original expiry.', { field: 'new_expiry' });
  if (!txt(b.reason)) throw httpError(400, 'Select a reason.', { field: 'reason' });
  const settings = L.settingsOf(db);
  const autoApprove = A.can(user, 'ext.approve') || settings.require_extension_approval !== '1';
  tx(db, () => {
    const r = run(`INSERT INTO extensions(client_uuid,call_id,date_granted,original_expiry,new_expiry,reason,remarks,status,requested_by,decided_by,decided_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,${autoApprove ? "datetime('now')" : 'NULL'})`,
    nz(b.client_uuid), call.id, autoApprove ? (nz(b.date_granted) || L.today()) : null, original, b.new_expiry, txt(b.reason), txt(b.remarks),
    autoApprove ? 'APPROVED' : 'PENDING', user.id, autoApprove ? user.id : null);
    audit(user, autoApprove ? 'approve' : 'request', 'extension', Number(r.lastInsertRowid),
      `${call.rotation_no}: extension to ${b.new_expiry} ${autoApprove ? 'granted' : 'requested'} (${txt(b.reason)})`);
  });
  return extensionsFor(call.id);
}
function decideExtension(user, extId, b) {
  need(user, 'ext.approve');
  const e = one('SELECT * FROM extensions WHERE id=?', Number(extId));
  if (!e) throw httpError(404, 'Extension not found.');
  const call = getCall(user, e.call_id);
  if (e.status !== 'PENDING') throw httpError(409, `This extension was already ${e.status.toLowerCase()}.`);
  const decision = b.decision === 'APPROVED' ? 'APPROVED' : b.decision === 'REJECTED' ? 'REJECTED' : null;
  if (!decision) throw httpError(400, 'Choose approve or reject.');
  if (decision === 'REJECTED' && !txt(b.note)) throw httpError(400, 'Give a reason for rejecting.', { field: 'note' });
  if (e.requested_by === user.id && user.role !== 'admin') throw httpError(403, 'You cannot approve your own extension request.');
  run(`UPDATE extensions SET status=?, decided_by=?, decided_at=datetime('now'), decision_note=?, date_granted=? WHERE id=?`,
    decision, user.id, txt(b.note), decision === 'APPROVED' ? L.today() : null, e.id);
  audit(user, decision === 'APPROVED' ? 'approve' : 'reject', 'extension', e.id, `${call.rotation_no}: extension to ${e.new_expiry} ${decision.toLowerCase()}`);
  return { ok: true };
}

// ---- dashboard -----------------------------------------------------------------
function dashboard(user, q) {
  need(user, 'dashboard.view');
  const month = /^\d{4}-\d{2}$/.test(q.month || '') ? q.month : L.today().slice(0, 7);
  const scope = A.stationScope(user) || (q.station || null);
  const calls = scopedCalls(user, scope ? ['c.station_code = ?'] : [], scope ? [scope] : []);
  const inMonth = calls.filter((c) => c.arrival_date.slice(0, 7) === month);
  const extArgs = scope ? [month, scope] : [month];
  const extRows = all(`SELECT c.station_code, COUNT(*) n FROM extensions e JOIN calls c ON c.id=e.call_id WHERE e.status='APPROVED'
    AND substr(e.date_granted,1,7)=? ${scope ? 'AND c.station_code=?' : ''} GROUP BY c.station_code`, ...extArgs);
  const extBy = Object.fromEntries(extRows.map((r) => [r.station_code, r.n]));
  const sum = (arr, f) => arr.reduce((a, c) => a + (Number(c[f]) || 0), 0);
  const group = (key, names) => names.map((n) => ({ name: n, calls: inMonth.filter((c) => c[key] === n).length }));
  const stations = all('SELECT code, name FROM stations ORDER BY sort');
  const byStation = stations.filter((s) => !scope || s.code === scope).map((s) => {
    const r = inMonth.filter((c) => c.station_code === s.code);
    return { code: s.code, name: s.name, calls: r.length, departed: r.filter((c) => c.departure_date).length, in_port: r.filter((c) => !c.departure_date).length,
      crew: sum(r, 'crew'), passengers: sum(r, 'passengers'), gross_tonnage: sum(r, 'gross_tonnage'), extensions: extBy[s.code] || 0 };
  });
  // 12-month trend ending at the selected month
  const trend = [];
  let [y, m] = month.split('-').map(Number);
  for (let i = 0; i < 12; i++) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    trend.unshift({ month: key, calls: calls.filter((c) => c.arrival_date.slice(0, 7) === key).length });
    m -= 1; if (!m) { m = 12; y -= 1; }
  }
  const inPort = calls.filter((c) => !c.departure_date);
  const pendingArgs = scope ? [scope] : [];
  const pending = one(`SELECT COUNT(*) n FROM extensions e JOIN calls c ON c.id=e.call_id WHERE e.status='PENDING' ${scope ? 'AND c.station_code=?' : ''}`, ...pendingArgs).n;
  const watchYear = Number(month.slice(0, 4));
  return {
    month, station: scope,
    totals: { calls: inMonth.length, departed: inMonth.filter((c) => c.departure_date).length, in_port: inMonth.filter((c) => !c.departure_date).length,
      extensions: Object.values(extBy).reduce((a, b) => a + b, 0), crew: sum(inMonth, 'crew'), passengers: sum(inMonth, 'passengers'), gross_tonnage: sum(inMonth, 'gross_tonnage') },
    by_station: byStation,
    by_type: group('vessel_type', all('SELECT name FROM vessel_types ORDER BY sort').map((r) => r.name)),
    by_cargo: group('cargo', all('SELECT name FROM cargo_types ORDER BY sort').map((r) => r.name)),
    trend,
    attention: {
      in_port: inPort.length, overdue: inPort.filter((c) => c.overstay_status === 'OVERDUE').length,
      urgent: inPort.filter((c) => c.priority && c.priority.startsWith('URGENT')).length,
      expiring_soon: inPort.filter((c) => c.overstay_status === 'EXPIRING SOON').length,
      long_stay: inPort.filter((c) => c.overstay_status === 'LONG STAY').length,
      pending_extensions: pending, data_check: calls.filter((c) => c.data_check && !c.verified_at).length,
      unverified_departed: calls.filter((c) => c.departure_date && !c.verified_at).length,
    },
    watch_year: watchYear,
    watch: inPort.filter((c) => c.rotation_year === watchYear).sort((a, b) => b.days_in_port - a.days_in_port).slice(0, 50).map(pickWatch),
  };
}
const pickWatch = (c) => ({ id: c.id, rotation_no: c.rotation_no, vessel_name: c.vessel_name, station_name: c.station_name, arrival_date: c.arrival_date,
  days_in_port: c.days_in_port, extension_count: c.extension_count, latest_expiry: c.latest_expiry, overstay_status: c.overstay_status, priority: c.priority });

// ---- overstay register ---------------------------------------------------------
function overstay(user) {
  need(user, 'overstay.view');
  const calls = scopedCalls(user);
  const cases = Object.fromEntries(all(`SELECT k.*, u.initials assigned_name, (SELECT COUNT(*) FROM case_notes n WHERE n.case_id=k.id) notes
    FROM cases k LEFT JOIN users u ON u.id=k.assigned_to`).map((k) => [k.call_id, k]));
  const flagged = calls.filter((c) => ['OVERDUE', 'EXPIRING SOON', 'LONG STAY'].includes(c.overstay_status) || (cases[c.id] && cases[c.id].status !== 'CLOSED'));
  const rank = { OVERDUE: 0, 'LONG STAY': 1, 'EXPIRING SOON': 2 };
  flagged.sort((a, b) => (rank[a.overstay_status] ?? 3) - (rank[b.overstay_status] ?? 3) || (b.days_overdue || 0) - (a.days_overdue || 0) || b.days_in_port - a.days_in_port);
  return { date_checked: L.today(), items: flagged.map((c) => ({ ...c, case: cases[c.id] || null })) };
}
function saveCase(user, callId, b) {
  need(user, 'cases.manage');
  const call = getCall(user, callId);
  const STAT = ['OPEN', 'IN PROGRESS', 'REFERRED', 'CLOSED'];
  const status = STAT.includes(b.status) ? b.status : 'OPEN';
  if (status === 'CLOSED' && !txt(b.outcome)) throw httpError(400, 'Record the outcome before closing the case.', { field: 'outcome' });
  const existing = one('SELECT * FROM cases WHERE call_id=?', call.id);
  if (existing) {
    run(`UPDATE cases SET status=?, assigned_to=?, outcome=?, closed_at=${status === 'CLOSED' ? "COALESCE(closed_at, datetime('now'))" : 'NULL'} WHERE id=?`,
      status, num(b.assigned_to), txt(b.outcome), existing.id);
    audit(user, 'update', 'case', existing.id, `${call.rotation_no}: case ${status.toLowerCase()}`);
  } else {
    const r = run('INSERT INTO cases(call_id,status,assigned_to,outcome,opened_by) VALUES (?,?,?,?,?)', call.id, status, num(b.assigned_to), txt(b.outcome), user.id);
    audit(user, 'create', 'case', Number(r.lastInsertRowid), `${call.rotation_no}: investigation case opened`);
  }
  return caseFor(call.id);
}
function caseFor(callId) {
  const k = one('SELECT k.*, u.initials assigned_name FROM cases k LEFT JOIN users u ON u.id=k.assigned_to WHERE call_id=?', callId);
  if (!k) return null;
  k.notes = all('SELECT n.*, u.initials author FROM case_notes n JOIN users u ON u.id=n.user_id WHERE case_id=? ORDER BY n.id', k.id);
  return k;
}
function addNote(user, callId, b) {
  need(user, 'cases.manage');
  const call = getCall(user, callId);
  if (!txt(b.note)) throw httpError(400, 'Write a note first.', { field: 'note' });
  if (b.client_uuid && one('SELECT 1 FROM case_notes WHERE client_uuid=?', b.client_uuid)) return caseFor(call.id);
  let k = one('SELECT id FROM cases WHERE call_id=?', call.id);
  if (!k) { saveCase(user, call.id, { status: 'OPEN' }); k = one('SELECT id FROM cases WHERE call_id=?', call.id); }
  run('INSERT INTO case_notes(client_uuid,case_id,user_id,note) VALUES (?,?,?,?)', nz(b.client_uuid), k.id, user.id, txt(b.note));
  audit(user, 'note', 'case', k.id, `${call.rotation_no}: follow-up note added`);
  return caseFor(call.id);
}

// ---- export ------------------------------------------------------------------
function csv(rows) {
  const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
}
function exportCalls(user, q) {
  need(user, 'export');
  const where = []; const args = [];
  if (/^\d{4}$/.test(q.year || '')) { where.push('c.rotation_year = ?'); args.push(Number(q.year)); }
  if (/^\d{4}-\d{2}$/.test(q.month || '')) { where.push('substr(c.arrival_date,1,7) = ?'); args.push(q.month); }
  const calls = scopedCalls(user, where, args).reverse();
  const head = ['Vessel Type', 'Rotation Classification', 'Rotation Sequence No.', 'Station', 'Voyage Number', 'Vessel Name', 'IMO / Registration No.',
    'Flag / Nationality', 'Shipping Agent', 'Gross Tonnage', 'Net Tonnage', 'Crew', 'Passengers', 'Master', 'Last Port', 'Arrival Date',
    'Boarding Officer', 'Next Port', 'Departure Date', 'Clearance Officer', 'Cargo / Operation', 'Extension Count', 'Status', 'Remarks',
    'Reporting Month', 'Reporting Year', 'Data Check', 'Full Rotation No.', 'Latest Extension Expiry', 'Overstay Status', 'Verified By'];
  const rows = calls.map((c) => [c.vessel_type, `${c.rotation_year}/${c.rotation_class}/`, c.rotation_seq, c.station_name, c.voyage_no, c.vessel_name, c.imo,
    c.flag, c.agent, c.gross_tonnage, c.net_tonnage, c.crew, c.passengers, c.master, c.last_port, c.arrival_date, c.boarding_officer, c.next_port,
    c.departure_date, c.clearance_officer, c.cargo, c.extension_count, c.status, c.remarks, c.arrival_date.slice(0, 7), c.arrival_date.slice(0, 4),
    c.data_check ? c.data_check.join('; ') : 'OK', c.rotation_no, c.latest_expiry, c.overstay_status, c.verified_by_name]);
  audit(user, 'export', 'call', null, `Exported ${rows.length} vessel calls`);
  return csv([head, ...rows]);
}
function exportExtensions(user) {
  need(user, 'export');
  const s = A.stationScope(user);
  const rows = all(`SELECT c.rotation_no, s.name station, c.vessel_name, e.date_granted, e.original_expiry, e.new_expiry, d.initials approved_by,
    e.reason, e.remarks, e.status FROM extensions e JOIN calls c ON c.id=e.call_id JOIN stations s ON s.code=c.station_code
    LEFT JOIN users d ON d.id=e.decided_by ${s ? 'WHERE c.station_code=?' : ''} ORDER BY e.id`, ...(s ? [s] : []));
  return csv([['Rotation No.', 'Station', 'Vessel Name', 'Date Granted', 'Original Expiry', 'New Expiry', 'Approved By', 'Reason', 'Remarks', 'Status'],
    ...rows.map((r) => Object.values(r))]);
}

// ---- users & admin ---------------------------------------------------------------
const publicUser = (u) => u && ({ id: u.id, username: u.username, full_name: u.full_name, initials: u.initials, role: u.role,
  station_code: u.station_code, active: !!u.active, must_change_password: !!u.must_change_password, last_login_at: u.last_login_at });

function saveUser(admin, id, b) {
  need(admin, 'users.manage');
  if (b.role && !A.ROLES[b.role]) throw httpError(400, 'Unknown role.', { field: 'role' });
  if (b.station_code && !one('SELECT 1 FROM stations WHERE code=?', b.station_code)) throw httpError(400, 'Unknown station.', { field: 'station_code' });
  if (id) {
    const u = one('SELECT * FROM users WHERE id=?', Number(id));
    if (!u) throw httpError(404, 'User not found.');
    if (u.id === admin.id && (b.active === false || (b.role && b.role !== 'admin'))) throw httpError(400, 'You cannot demote or deactivate your own account.');
    run('UPDATE users SET full_name=?, initials=?, role=?, station_code=?, active=? WHERE id=?',
      txt(b.full_name) || u.full_name, up(b.initials) || u.initials, b.role || u.role, b.station_code === undefined ? u.station_code : nz(b.station_code),
      b.active === undefined ? u.active : (b.active ? 1 : 0), u.id);
    if (b.active === false) run('DELETE FROM sessions WHERE user_id=?', u.id);
    audit(admin, 'update', 'user', u.id, `User ${u.username} updated`, b);
    return publicUser(one('SELECT * FROM users WHERE id=?', u.id));
  }
  if (!txt(b.username) || !/^[a-z0-9._-]{3,40}$/i.test(b.username)) throw httpError(400, 'Username: 3-40 letters, numbers, dot, dash or underscore.', { field: 'username' });
  if (!txt(b.full_name)) throw httpError(400, 'Enter the full name.', { field: 'full_name' });
  if (!A.ROLES[b.role]) throw httpError(400, 'Choose a role.', { field: 'role' });
  if (['officer', 'supervisor'].includes(b.role) && !b.station_code && b.national !== true) throw httpError(400, 'Officers and supervisors need a station.', { field: 'station_code' });
  const prob = A.passwordProblem(b.password); if (prob) throw httpError(400, prob, { field: 'password' });
  if (one('SELECT 1 FROM users WHERE username=?', b.username)) throw httpError(409, 'That username is taken.', { field: 'username' });
  const initials = up(b.initials) || deriveInitials(b.full_name);
  const r = run('INSERT INTO users(username,full_name,initials,role,station_code,password_hash) VALUES (?,?,?,?,?,?)',
    b.username.trim(), txt(b.full_name), initials, b.role, nz(b.station_code), A.hashPassword(b.password));
  audit(admin, 'create', 'user', Number(r.lastInsertRowid), `User ${b.username} created as ${b.role}`);
  return publicUser(one('SELECT * FROM users WHERE id=?', r.lastInsertRowid));
}
function deriveInitials(name) {
  const p = String(name).trim().split(/\s+/);
  return (p.length > 1 ? `${p[0][0]}.${p[p.length - 1]}` : p[0]).toUpperCase();
}

const LIST_TABLES = { stations: 'stations', vessel_types: 'vessel_types', cargo_types: 'cargo_types', extension_reasons: 'extension_reasons' };
function saveList(user, list, b) {
  need(user, 'lists.manage');
  const t = LIST_TABLES[list]; if (!t) throw httpError(404, 'Unknown list.');
  const items = Array.isArray(b.items) ? b.items : [];
  tx(db, () => {
    items.forEach((it, i) => {
      if (t === 'stations') {
        if (!/^[A-Z]{2,4}$/.test(it.code || '') || !txt(it.name)) throw httpError(400, 'Station code must be 2-4 capital letters and name is required.');
        run('INSERT INTO stations(code,name,active,sort) VALUES (?,?,?,?) ON CONFLICT(code) DO UPDATE SET name=excluded.name, active=excluded.active, sort=excluded.sort', it.code, txt(it.name), it.active ? 1 : 0, i);
      } else if (t === 'vessel_types') {
        if (!txt(it.name) || !/^[A-Z]{3}$/.test(it.rotation_class || '')) throw httpError(400, 'Each vessel type needs a name and a 3-letter rotation class.');
        run('INSERT INTO vessel_types(name,rotation_class,manual_sequence,active,sort) VALUES (?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET rotation_class=excluded.rotation_class, manual_sequence=excluded.manual_sequence, active=excluded.active, sort=excluded.sort',
          txt(it.name), it.rotation_class, it.manual_sequence ? 1 : 0, it.active ? 1 : 0, i);
      } else {
        if (!txt(it.name)) throw httpError(400, 'Every item needs a name.');
        run(`INSERT INTO ${t}(name,active,sort) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET active=excluded.active, sort=excluded.sort`, txt(it.name), it.active ? 1 : 0, i);
      }
    });
    audit(user, 'update', 'list', null, `Reference list "${list}" updated`);
  });
  return lookups(user);
}

function lookups(user) {
  const active = (t, extra = '') => all(`SELECT * FROM ${t} ${user.role === 'admin' ? '' : 'WHERE active=1'} ${extra} ORDER BY sort`);
  const scope = A.stationScope(user);
  const officers = all(`SELECT id, initials, full_name, role, station_code, active FROM users WHERE role IN ('officer','supervisor','admin')
    ${scope ? 'AND (station_code=? OR station_code IS NULL)' : ''} ORDER BY initials`, ...(scope ? [scope] : []));
  const staff = all(`SELECT id, initials, full_name, role, station_code, active FROM users WHERE active=1 AND role IN ('investigator','supervisor','officer','admin')
    ${scope ? 'AND (station_code=? OR station_code IS NULL)' : ''} ORDER BY role='investigator' DESC, initials`, ...(scope ? [scope] : []));
  const ports = all(`SELECT p FROM (SELECT last_port p FROM calls UNION SELECT next_port FROM calls) WHERE p IS NOT NULL AND p<>'NA' ORDER BY p`).map((r) => r.p);
  const flags = all('SELECT DISTINCT flag FROM calls WHERE flag IS NOT NULL ORDER BY flag').map((r) => r.flag);
  const agents = all('SELECT DISTINCT agent FROM calls WHERE agent IS NOT NULL ORDER BY agent').map((r) => r.agent);
  return {
    stations: active('stations'), vessel_types: active('vessel_types'), cargo_types: active('cargo_types'), extension_reasons: active('extension_reasons'),
    officers, staff, ports, flags, agents, settings: L.settingsOf(db), today: L.today(),
    roles: Object.fromEntries(Object.entries(A.ROLES).map(([k, v]) => [k, { label: v.label, desc: v.desc }])),
  };
}

// ---- import from the Excel ledger (via tools/ledger_to_json.py) --------------------
function importLedger(user, b) {
  need(user, 'users.manage');
  const report = { calls: 0, extensions: 0, skipped: [], officers_created: [] };
  const officerId = (initials) => {
    const ini = up(initials); if (!ini || ini === 'NA') return null;
    const u = one('SELECT id FROM users WHERE initials=?', ini);
    if (u) return u.id;
    // Placeholder (inactive) account so historic records keep their officer; admin can activate it later.
    const uname = ini.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');
    const r = run('INSERT INTO users(username,full_name,initials,role,station_code,password_hash,active) VALUES (?,?,?,?,NULL,?,0)',
      uname, ini, ini, 'officer', A.hashPassword(require('node:crypto').randomBytes(24).toString('hex')));
    report.officers_created.push(ini);
    return Number(r.lastInsertRowid);
  };
  tx(db, () => {
    for (const r of b.calls || []) {
      const m = /^(\d{4})\/([A-Z]{3})\/(\d+)$/.exec(r.rotation_no || '');
      if (!m) { report.skipped.push(`Row ${r.row}: no rotation number`); continue; }
      if (one('SELECT 1 FROM calls WHERE rotation_no=?', r.rotation_no)) { report.skipped.push(`${r.rotation_no}: already imported`); continue; }
      const st = one('SELECT code FROM stations WHERE name=? OR code=?', r.station, r.station);
      const vt = one('SELECT name FROM vessel_types WHERE name=?', (r.vessel_type || '').trim()) || one('SELECT name FROM vessel_types WHERE name=?', 'Other');
      if (!st || !L.isDate(r.arrival_date)) { report.skipped.push(`${r.rotation_no}: missing station or arrival date`); continue; }
      const c = normaliseCall({ ...r, station_code: st.code, vessel_type: vt.name, boarding_officer_id: officerId(r.boarding_officer), clearance_officer_id: officerId(r.clearance_officer) });
      if (c.cargo && !one('SELECT 1 FROM cargo_types WHERE name=?', c.cargo)) c.cargo = 'Other';
      for (const k of ['next_port', 'voyage_no', 'imo']) if (c[k] === 'NA') c[k] = null;
      const vid = upsertVessel(c);
      const cols = [...CALL_FIELDS, 'rotation_year', 'rotation_class', 'rotation_seq', 'rotation_no', 'vessel_id', 'created_by', 'updated_by'];
      const res = run(`INSERT INTO calls(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
        ...CALL_FIELDS.map((f) => c[f]), Number(m[1]), m[2], Number(m[3]), r.rotation_no, vid, user.id, user.id);
      audit(user, 'import', 'call', Number(res.lastInsertRowid), `Imported ${r.rotation_no} from Excel ledger`);
      report.calls++;
    }
    for (const e of b.extensions || []) {
      const call = one('SELECT id FROM calls WHERE rotation_no=?', e.rotation_no);
      if (!call || !L.isDate(e.new_expiry)) { report.skipped.push(`Extension for ${e.rotation_no}: no matching call or expiry`); continue; }
      const approver = officerId(e.approved_by) || user.id;
      run(`INSERT INTO extensions(call_id,date_granted,original_expiry,new_expiry,reason,remarks,status,requested_by,decided_by,decided_at)
        VALUES (?,?,?,?,?,?,'APPROVED',?,?,datetime('now'))`, call.id, nz(e.date_granted), e.original_expiry || e.new_expiry, e.new_expiry,
      txt(e.reason) || 'Other', txt(e.remarks), approver, approver);
      report.extensions++;
    }
  });
  return report;
}

// ---- auth endpoints ----------------------------------------------------------------
function login(req, res, b) {
  const u = one('SELECT * FROM users WHERE username=?', String(b.username || '').trim());
  const fail = () => { throw httpError(401, 'Incorrect username or password.'); };
  if (!u || !u.active) { A.verifyPassword('x', 'scrypt$AAAA$AAAA'); fail(); }
  if (u.locked_until && u.locked_until > new Date().toISOString()) throw httpError(429, 'Too many failed attempts. Try again in 15 minutes or ask an administrator.');
  if (!A.verifyPassword(String(b.password || ''), u.password_hash)) {
    const n = u.failed_logins + 1;
    run('UPDATE users SET failed_logins=?, locked_until=? WHERE id=?', n >= 5 ? 0 : n, n >= 5 ? new Date(Date.now() + 15 * 60000).toISOString() : null, u.id);
    if (n >= 5) audit(u, 'lockout', 'user', u.id, `Account ${u.username} locked after 5 failed sign-ins`);
    fail();
  }
  const token = A.newToken();
  const expires = new Date(Date.now() + SESSION_HOURS * 3600000).toISOString();
  run('INSERT INTO sessions(token_hash,user_id,expires_at,user_agent) VALUES (?,?,?,?)', A.hashToken(token), u.id, expires, String(req.headers['user-agent'] || '').slice(0, 200));
  run("UPDATE users SET failed_logins=0, locked_until=NULL, last_login_at=datetime('now') WHERE id=?", u.id);
  audit(u, 'login', 'user', u.id, `${u.username} signed in`);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}${SECURE_COOKIE ? '; Secure' : ''}`);
  return me(u);
}
function me(u) {
  const perms = A.ROLES[u.role].perms.includes('*') ? ['*'] : A.ROLES[u.role].perms;
  return { user: publicUser(u), perms, role_label: A.ROLES[u.role].label, station_name: u.station_code ? one('SELECT name FROM stations WHERE code=?', u.station_code).name : 'All stations' };
}
function sessionUser(req) {
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const s = one("SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at > ? AND u.active=1",
    A.hashToken(m[1]), new Date().toISOString());
  return s ? { ...s, _token: m[1] } : null;
}

// ---- routing -------------------------------------------------------------------
const routes = [];
const route = (method, pattern, handler, { auth = true } = {}) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler, auth });

route('POST', '/api/login', ({ req, res, body }) => login(req, res, body), { auth: false });
route('POST', '/api/logout', ({ user, res }) => { run('DELETE FROM sessions WHERE token_hash=?', A.hashToken(user._token)); res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0'); return { ok: true }; });
route('GET', '/api/me', ({ user }) => me(user));
route('POST', '/api/me/password', ({ user, body }) => {
  if (!A.verifyPassword(String(body.current || ''), user.password_hash)) throw httpError(400, 'Current password is incorrect.', { field: 'current' });
  const p = A.passwordProblem(body.password); if (p) throw httpError(400, p, { field: 'password' });
  if (body.password === body.current) throw httpError(400, 'Choose a new password different from the current one.', { field: 'password' });
  run('UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?', A.hashPassword(body.password), user.id);
  run('DELETE FROM sessions WHERE user_id=? AND token_hash<>?', user.id, A.hashToken(user._token));
  audit(user, 'password', 'user', user.id, `${user.username} changed password`);
  return { ok: true };
});
route('GET', '/api/lookups', ({ user }) => lookups(user));

route('GET', '/api/calls', ({ user, query }) => {
  need(user, 'calls.read');
  const where = []; const args = [];
  if (query.station && !A.stationScope(user)) { where.push('c.station_code=?'); args.push(query.station); }
  if (/^\d{4}-\d{2}$/.test(query.month || '')) { where.push('substr(c.arrival_date,1,7)=?'); args.push(query.month); }
  if (/^\d{4}$/.test(query.year || '')) { where.push('c.rotation_year=?'); args.push(Number(query.year)); }
  if (query.type) { where.push('c.vessel_type=?'); args.push(query.type); }
  if (query.status === 'IN PORT') where.push('c.departure_date IS NULL');
  if (query.status === 'DEPARTED') where.push('c.departure_date IS NOT NULL');
  if (query.q) {
    const like = `%${String(query.q).toUpperCase()}%`;
    where.push('(UPPER(c.vessel_name) LIKE ? OR UPPER(c.rotation_no) LIKE ? OR UPPER(c.imo) LIKE ? OR UPPER(c.agent) LIKE ? OR UPPER(c.master) LIKE ? OR UPPER(c.voyage_no) LIKE ?)');
    args.push(like, like, like, like, like, like);
  }
  let rows = scopedCalls(user, where, args);
  if (query.flag === 'attention') rows = rows.filter((c) => ['OVERDUE', 'EXPIRING SOON', 'LONG STAY'].includes(c.overstay_status) || c.pending_extensions || (c.data_check && !c.verified_at));
  if (query.flag === 'unverified') rows = rows.filter((c) => c.departure_date && !c.verified_at);
  if (query.flag === 'datacheck') rows = rows.filter((c) => c.data_check && !c.verified_at);
  return rows;
});
route('POST', '/api/calls', ({ user, body }) => createCall(user, body));
route('GET', '/api/calls/:id', ({ user, params }) => {
  need(user, 'calls.read');
  const c = getCall(user, params.id);
  return { ...c, extensions: extensionsFor(c.id), case: A.can(user, 'overstay.view') ? caseFor(c.id) : null,
    history: all(`SELECT a.ts, a.action, a.summary, a.details, u.initials who FROM audit a LEFT JOIN users u ON u.id=a.user_id
      WHERE (a.entity='call' AND a.entity_id=?) OR (a.entity='extension' AND a.entity_id IN (SELECT id FROM extensions WHERE call_id=?))
      OR (a.entity='case' AND a.entity_id IN (SELECT id FROM cases WHERE call_id=?)) ORDER BY a.id DESC`, c.id, c.id, c.id) };
});
route('PUT', '/api/calls/:id', ({ user, params, body }) => updateCall(user, params.id, body));
route('POST', '/api/calls/:id/verify', ({ user, params, body }) => {
  need(user, 'calls.verify');
  const c = getCall(user, params.id);
  if (body.unlock) {
    if (!c.verified_at) return c;
    if (!txt(body.reason)) throw httpError(400, 'Give a reason for unlocking.', { field: 'reason' });
    run('UPDATE calls SET verified_by=NULL, verified_at=NULL, version=version+1 WHERE id=?', c.id);
    audit(user, 'unlock', 'call', c.id, `${c.rotation_no}: unlocked - ${txt(body.reason)}`);
  } else {
    if (!c.departure_date) throw httpError(400, 'Only departed calls can be verified.');
    if (c.data_check) throw httpError(400, `Resolve the data check first: ${c.data_check.join('; ')}`);
    if (c.pending_extensions) throw httpError(400, 'There is an extension awaiting a decision.');
    run("UPDATE calls SET verified_by=?, verified_at=datetime('now'), version=version+1 WHERE id=?", user.id, c.id);
    audit(user, 'verify', 'call', c.id, `${c.rotation_no}: verified and locked`);
  }
  return getCall(user, c.id);
});
route('DELETE', '/api/calls/:id', ({ user, params, body }) => {
  if (user.role !== 'admin') throw httpError(403, 'Only an administrator can delete a vessel call.');
  const c = getCall(user, params.id);
  if (!txt(body.reason)) throw httpError(400, 'Give a reason for deleting.', { field: 'reason' });
  tx(db, () => {
    run('DELETE FROM case_notes WHERE case_id IN (SELECT id FROM cases WHERE call_id=?)', c.id);
    run('DELETE FROM cases WHERE call_id=?', c.id);
    run('DELETE FROM extensions WHERE call_id=?', c.id);
    run('DELETE FROM calls WHERE id=?', c.id);
    audit(user, 'delete', 'call', c.id, `${c.rotation_no} ${c.vessel_name} deleted - ${txt(body.reason)}`, c);
  });
  return { ok: true };
});
route('GET', '/api/vessels', ({ user, query }) => {
  need(user, 'calls.read');
  const q = `%${String(query.q || '').toUpperCase()}%`;
  return all(`SELECT v.*, (SELECT COUNT(*) FROM calls c WHERE c.vessel_id=v.id) calls,
    (SELECT c.master FROM calls c WHERE c.vessel_id=v.id ORDER BY c.arrival_date DESC LIMIT 1) last_master,
    (SELECT c.agent FROM calls c WHERE c.vessel_id=v.id ORDER BY c.arrival_date DESC LIMIT 1) last_agent,
    (SELECT c.crew FROM calls c WHERE c.vessel_id=v.id ORDER BY c.arrival_date DESC LIMIT 1) last_crew,
    (SELECT c.cargo FROM calls c WHERE c.vessel_id=v.id ORDER BY c.arrival_date DESC LIMIT 1) last_cargo
    FROM vessels v WHERE UPPER(v.name) LIKE ? OR UPPER(v.imo) LIKE ? ORDER BY v.updated_at DESC LIMIT 10`, q, q);
});
route('POST', '/api/calls/:id/extensions', ({ user, params, body }) => addExtension(user, params.id, body));
route('POST', '/api/extensions/:id/decision', ({ user, params, body }) => decideExtension(user, params.id, body));
route('GET', '/api/extensions', ({ user, query }) => {
  need(user, 'calls.read');
  const s = A.stationScope(user);
  const where = []; const args = [];
  if (s) { where.push('c.station_code=?'); args.push(s); }
  if (['PENDING', 'APPROVED', 'REJECTED'].includes(query.status)) { where.push('e.status=?'); args.push(query.status); }
  return all(`SELECT e.*, c.rotation_no, c.vessel_name, c.station_code, st.name station_name, r.initials requested_by_name, d.initials decided_by_name
    FROM extensions e JOIN calls c ON c.id=e.call_id JOIN stations st ON st.code=c.station_code JOIN users r ON r.id=e.requested_by
    LEFT JOIN users d ON d.id=e.decided_by ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.id DESC LIMIT 500`, ...args);
});
route('GET', '/api/dashboard', ({ user, query }) => dashboard(user, query));
route('GET', '/api/overstay', ({ user }) => overstay(user));
route('POST', '/api/calls/:id/case', ({ user, params, body }) => saveCase(user, params.id, body));
route('POST', '/api/calls/:id/case/notes', ({ user, params, body }) => addNote(user, params.id, body));
route('GET', '/api/export/calls.csv', ({ user, query }) => ({ __csv: exportCalls(user, query), name: `vessel-movements-${query.month || query.year || 'all'}.csv` }));
route('GET', '/api/export/extensions.csv', ({ user }) => ({ __csv: exportExtensions(user), name: 'extension-log.csv' }));
route('GET', '/api/audit', ({ user, query }) => {
  need(user, 'audit.view');
  return all(`SELECT a.id, a.ts, a.action, a.entity, a.entity_id, a.summary, u.username, u.initials FROM audit a LEFT JOIN users u ON u.id=a.user_id
    ${query.q ? 'WHERE UPPER(a.summary) LIKE ? OR u.username LIKE ?' : ''} ORDER BY a.id DESC LIMIT 300`, ...(query.q ? [`%${String(query.q).toUpperCase()}%`, `%${query.q}%`] : []));
});
route('GET', '/api/users', ({ user }) => { need(user, 'users.manage'); return all('SELECT * FROM users ORDER BY active DESC, username').map(publicUser); });
route('POST', '/api/users', ({ user, body }) => saveUser(user, null, body));
route('PUT', '/api/users/:id', ({ user, params, body }) => saveUser(user, params.id, body));
route('POST', '/api/users/:id/reset-password', ({ user, params, body }) => {
  need(user, 'users.manage');
  const p = A.passwordProblem(body.password); if (p) throw httpError(400, p, { field: 'password' });
  const u = one('SELECT * FROM users WHERE id=?', Number(params.id)); if (!u) throw httpError(404, 'User not found.');
  run('UPDATE users SET password_hash=?, must_change_password=1, failed_logins=0, locked_until=NULL WHERE id=?', A.hashPassword(body.password), u.id);
  run('DELETE FROM sessions WHERE user_id=?', u.id);
  audit(user, 'reset', 'user', u.id, `Password reset for ${u.username}`);
  return { ok: true };
});
route('PUT', '/api/lists/:list', ({ user, params, body }) => saveList(user, params.list, body));
route('PUT', '/api/settings', ({ user, body }) => {
  need(user, 'settings.manage');
  for (const k of ['expiring_soon_days', 'long_stay_days', 'urgent_extension_count']) {
    if (body[k] != null && !(Number.isInteger(Number(body[k])) && Number(body[k]) > 0)) throw httpError(400, 'Use a whole number greater than 0.', { field: k });
  }
  for (const k of ['expiring_soon_days', 'long_stay_days', 'urgent_extension_count', 'office_footer', 'require_extension_approval']) {
    if (body[k] != null) run('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, String(body[k]));
  }
  audit(user, 'update', 'settings', null, 'Settings updated', body);
  return L.settingsOf(db);
});
route('POST', '/api/import', ({ user, body }) => importLedger(user, body));

// ---- HTTP plumbing ----------------------------------------------------------------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const SEC_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
};

function send(res, status, data, headers = {}) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEC_HEADERS, ...headers });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 5e6) { reject(httpError(413, 'Request too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(httpError(400, 'Invalid JSON.')); } });
    req.on('error', reject);
  });
}
function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUBLIC, decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'Forbidden' });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
  const ext = path.extname(file);
  const cache = ['/sw.js', '/index.html', '/'].includes(pathname) || ext === '.html' ? 'no-cache' : 'public, max-age=300';
  res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': cache, ...SEC_HEADERS });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
  try {
    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!r) throw httpError(404, 'Not found.');
    // CSRF defence: state-changing requests must be JSON from our own pages (SameSite=Strict cookie as well).
    if (req.method !== 'GET' && !String(req.headers['content-type'] || '').startsWith('application/json')) throw httpError(415, 'JSON required.');
    const user = sessionUser(req);
    if (r.auth && !user) throw httpError(401, 'Please sign in.');
    if (user && user.must_change_password && !['/api/me', '/api/me/password', '/api/logout', '/api/lookups'].includes(url.pathname)) {
      throw httpError(403, 'Change your password to continue.', { code: 'must_change_password' });
    }
    const body = req.method === 'GET' ? {} : await readBody(req);
    const out = r.handler({ req, res, user, body, params: url.pathname.match(r.re).groups || {}, query: Object.fromEntries(url.searchParams) });
    if (out && out.__csv !== undefined) return send(res, 200, out.__csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${out.name}"` });
    send(res, 200, out ?? { ok: true });
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    send(res, status, { error: status === 500 ? 'Unexpected server error.' : e.message, field: e.field, code: e.code, errors: e.errors, current: e.current });
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`National Ships Ledger running on http://localhost:${PORT}  (db: ${DB_FILE})`));
}
module.exports = { server, db, importLedger };
