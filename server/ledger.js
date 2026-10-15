// Business rules carried over from the National Shipping Ledger workbook.
'use strict';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// "Today" in Belize (UTC-6, no daylight saving). LEDGER_TODAY lets tests pin the date.
function today() {
  if (process.env.LEDGER_TODAY) return process.env.LEDGER_TODAY;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Belize' }).format(new Date());
}
const isDate = (s) => typeof s === 'string' && DATE_RE.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

function settingsOf(db) {
  const s = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) s[r.key] = r.value;
  return s;
}

// ---- Rotation numbers -----------------------------------------------------
// Full Rotation No. = YEAR/CLASS/SEQ. The year comes from the arrival date (so no manual
// year roll-over is needed). CRG classes take the number supplied by the agent; every other
// class draws from ONE shared automatic sequence per year (2026/PSV/2, 2026/SUP/3, ...),
// exactly as the workbook's COUNTIFS on "YYYY/*" did.
function allocateRotation(db, { vesselType, arrivalDate, manualSeq }) {
  const vt = db.prepare('SELECT * FROM vessel_types WHERE name = ?').get(vesselType);
  if (!vt) throw httpError(400, `Unknown vessel type "${vesselType}".`);
  const year = Number(arrivalDate.slice(0, 4));
  let seq;
  if (vt.manual_sequence) {
    seq = Number(manualSeq);
    if (!Number.isInteger(seq) || seq < 1) throw httpError(400, `Enter the ${vt.rotation_class} rotation sequence number supplied for this vessel.`, { field: 'rotation_seq' });
    const clash = db.prepare('SELECT rotation_no FROM calls WHERE rotation_year=? AND rotation_class=? AND rotation_seq=?').get(year, vt.rotation_class, seq);
    if (clash) throw httpError(409, `Rotation No. ${clash.rotation_no} is already in use.`, { field: 'rotation_seq' });
  } else {
    const manualClasses = db.prepare('SELECT DISTINCT rotation_class c FROM vessel_types WHERE manual_sequence = 1').all().map((r) => r.c);
    const ph = manualClasses.map(() => '?').join(',') || "''";
    const row = db.prepare(`SELECT COALESCE(MAX(rotation_seq),0) m FROM calls WHERE rotation_year=? AND rotation_class NOT IN (${ph})`).get(year, ...manualClasses);
    seq = row.m + 1;
  }
  return { rotation_year: year, rotation_class: vt.rotation_class, rotation_seq: seq, rotation_no: `${year}/${vt.rotation_class}/${seq}` };
}

// ---- Validation -------------------------------------------------------------
// errors block saving; warnings are the workbook's "Data Check" and block verification.
function checkCall(c) {
  const errors = {}; const warnings = [];
  if (!c.vessel_type) errors.vessel_type = 'Select the vessel type.';
  if (!c.station_code) errors.station_code = 'Select the Customs station.';
  if (!c.vessel_name || !String(c.vessel_name).trim()) errors.vessel_name = 'Enter the vessel name.';
  if (!isDate(c.arrival_date)) errors.arrival_date = 'Enter a valid arrival date.';
  if (c.departure_date && !isDate(c.departure_date)) errors.departure_date = 'Enter a valid departure date.';
  if (isDate(c.arrival_date) && isDate(c.departure_date) && c.departure_date < c.arrival_date) errors.departure_date = 'Departure date cannot be before the arrival date.';
  if (c.departure_date && !c.clearance_officer_id) errors.clearance_officer_id = 'Add the clearance officer for a departed vessel.';
  if (isDate(c.arrival_date) && c.arrival_date > today()) errors.arrival_date = 'Arrival date cannot be in the future.';
  for (const f of ['gross_tonnage', 'net_tonnage', 'crew', 'passengers']) {
    if (c[f] !== null && c[f] !== undefined && c[f] !== '' && (isNaN(Number(c[f])) || Number(c[f]) < 0)) errors[f] = 'Must be a number of 0 or more.';
  }
  const need = { flag: 'Flag / Nationality', crew: 'Crew', master: 'Master', last_port: 'Last Port', boarding_officer_id: 'Boarding Officer', next_port: 'Next Port', cargo: 'Cargo / Operation', agent: 'Shipping Agent' };
  const missing = Object.entries(need).filter(([k]) => c[k] === null || c[k] === undefined || String(c[k]).trim() === '').map(([, v]) => v);
  if (missing.length) warnings.push(`Missing: ${missing.join(', ')}`);
  if (Number(c.net_tonnage) > Number(c.gross_tonnage) && c.gross_tonnage) warnings.push('Net tonnage is greater than gross tonnage.');
  if (!c.imo) warnings.push('No IMO / registration number.');
  return { errors, warnings };
}

// ---- Derived status (VESSEL MOVEMENTS V, W, AC, AD and the overstay register) ---
function deriveStatus(call, approvedExts, settings, todayStr = today()) {
  const soon = Number(settings.expiring_soon_days || 7);
  const longStay = Number(settings.long_stay_days || 30);
  const urgentAt = Number(settings.urgent_extension_count || 3);
  const extCount = approvedExts.length;
  const latest = approvedExts.reduce((a, e) => (!a || e.id > a.id ? e : a), null);
  const latestExpiry = latest ? latest.new_expiry : null;
  const status = call.departure_date ? 'DEPARTED' : 'IN PORT';
  const daysInPort = daysBetween(call.arrival_date, call.departure_date || todayStr);
  let overstay; let daysOverdue = null; let daysToExpiry = null; let priority = null;
  if (call.departure_date) overstay = 'DEPARTED';
  else if (!extCount) overstay = daysInPort > longStay ? 'LONG STAY' : 'NO EXTENSION';
  else {
    daysToExpiry = daysBetween(todayStr, latestExpiry);
    if (daysToExpiry < 0) { overstay = 'OVERDUE'; daysOverdue = -daysToExpiry; }
    else if (daysToExpiry <= soon) overstay = 'EXPIRING SOON';
    else overstay = 'WITHIN EXTENSION';
  }
  if (overstay === 'OVERDUE') priority = extCount >= urgentAt ? `URGENT - ${urgentAt}+ EXTENSIONS` : 'OVERDUE - FOLLOW UP';
  else if (overstay === 'LONG STAY') priority = 'REVIEW - NO EXTENSION ON FILE';
  return { status, extension_count: extCount, latest_expiry: latestExpiry, overstay_status: overstay, days_in_port: daysInPort, days_overdue: daysOverdue, days_to_expiry: daysToExpiry, priority };
}

function httpError(status, message, extra) {
  const e = new Error(message); e.status = status; Object.assign(e, extra || {}); return e;
}

module.exports = { today, isDate, daysBetween, settingsOf, allocateRotation, checkCall, deriveStatus, httpError };
