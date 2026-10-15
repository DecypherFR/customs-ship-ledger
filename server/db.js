// Database schema, reference data and seed users.
// Uses Node's built-in SQLite (node:sqlite) so the server has zero npm dependencies.
'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const { hashPassword } = require('./auth');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS stations (
  code TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS vessel_types (
  name TEXT PRIMARY KEY, rotation_class TEXT NOT NULL, manual_sequence INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cargo_types (
  name TEXT PRIMARY KEY, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS extension_reasons (
  name TEXT PRIMARY KEY, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name TEXT NOT NULL,
  initials TEXT NOT NULL,            -- printed form used on the ledger, e.g. G.DOMINGUEZ
  role TEXT NOT NULL,
  station_code TEXT REFERENCES stations(code),  -- NULL = national scope
  password_hash TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL, user_agent TEXT
);

-- Vessel registry: particulars remembered across calls so officers don't retype them.
CREATE TABLE IF NOT EXISTS vessels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  imo TEXT UNIQUE,
  name TEXT NOT NULL,
  flag TEXT, vessel_type TEXT, gross_tonnage REAL, net_tonnage REAL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row = one vessel call at one Customs station (the VESSEL MOVEMENTS sheet).
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_uuid TEXT UNIQUE,
  rotation_year INTEGER NOT NULL,
  rotation_class TEXT NOT NULL,
  rotation_seq INTEGER NOT NULL,
  rotation_no TEXT NOT NULL UNIQUE,
  vessel_id INTEGER REFERENCES vessels(id),
  vessel_type TEXT NOT NULL,
  station_code TEXT NOT NULL REFERENCES stations(code),
  voyage_no TEXT,
  vessel_name TEXT NOT NULL,
  imo TEXT,
  flag TEXT,
  agent TEXT,
  gross_tonnage REAL,
  net_tonnage REAL,
  crew INTEGER,
  passengers INTEGER,
  master TEXT,
  last_port TEXT,
  arrival_date TEXT NOT NULL,
  boarding_officer_id INTEGER REFERENCES users(id),
  next_port TEXT,
  departure_date TEXT,
  clearance_officer_id INTEGER REFERENCES users(id),
  cargo TEXT,
  remarks TEXT,
  officer_report TEXT NOT NULL DEFAULT '{}',   -- JSON: Ship's Report officer section
  verified_by INTEGER REFERENCES users(id),
  verified_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (rotation_year, rotation_class, rotation_seq)
);
CREATE INDEX IF NOT EXISTS calls_station ON calls(station_code);
CREATE INDEX IF NOT EXISTS calls_arrival ON calls(arrival_date);

-- EXTENSION LOG, with an approval step.
CREATE TABLE IF NOT EXISTS extensions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_uuid TEXT UNIQUE,
  call_id INTEGER NOT NULL REFERENCES calls(id),
  date_granted TEXT,
  original_expiry TEXT NOT NULL,
  new_expiry TEXT NOT NULL,
  reason TEXT NOT NULL,
  remarks TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',   -- PENDING | APPROVED | REJECTED
  requested_by INTEGER NOT NULL REFERENCES users(id),
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  decision_note TEXT
);
CREATE INDEX IF NOT EXISTS ext_call ON extensions(call_id);

-- OVERSTAY INVESTIGATION: notes are attached to the call, not to a spreadsheet row position.
CREATE TABLE IF NOT EXISTS cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id INTEGER NOT NULL UNIQUE REFERENCES calls(id),
  status TEXT NOT NULL DEFAULT 'OPEN',      -- OPEN | IN PROGRESS | REFERRED | CLOSED
  assigned_to INTEGER REFERENCES users(id),
  outcome TEXT,
  opened_by INTEGER NOT NULL REFERENCES users(id),
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT
);
CREATE TABLE IF NOT EXISTS case_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_uuid TEXT UNIQUE,
  case_id INTEGER NOT NULL REFERENCES cases(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  note TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  summary TEXT,
  details TEXT
);
CREATE INDEX IF NOT EXISTS audit_entity ON audit(entity, entity_id);
`;

// Reference lists taken from the LISTS sheet of the National Shipping Ledger.
const STATIONS = [
  ['BZE', 'Belize City'], ['BTV', 'Belize Tourism Village'], ['BGC', 'Big Creek'],
  ['PG', 'Punta Gorda'], ['SPR', 'San Pedro'], ['OTH', 'Other Maritime Station'],
];
// [name, rotation class, manual sequence?]  Container + General Cargo share the CRG class
// and use the number supplied by the agent; every other class shares one automatic annual sequence.
const VESSEL_TYPES = [
  ['Container Vessel', 'CRG', 1], ['Supply Vessel', 'SUP', 0], ['Oil/Fuel Tanker', 'TKR', 0],
  ['Pleasure Vessel / Yacht', 'PSV', 0], ['Liveaboard Vessel', 'LVB', 0], ['Cruise Ship', 'CRU', 0],
  ['Military / Government Vessel', 'GOV', 0], ['Bulk Carrier', 'BLK', 0],
  ['General Cargo Vessel', 'CRG', 1], ['Ro-Ro Vessel', 'ROR', 0], ['Fishing Vessel', 'FSH', 0],
  ['Research / Survey Vessel', 'RSV', 0], ['Other', 'OTH', 0],
];
const CARGO = [
  'Containers', 'General Cargo', 'Fuel / Petroleum', 'Wheat', 'Fertilizer', 'Vehicles / Ro-Ro',
  'Passengers / Cruise', 'Supplies / Stores', 'Marine Products', 'Bananas / Agricultural Export',
  'Ballast / No Cargo', 'Liveaboard', 'Other',
];
const EXT_REASONS = [
  'Temporary Permit', 'Liveaboard', 'Force Majeure', 'Crew Health and Safety Emergency',
  'Awaiting Repairs / Parts', 'Weather', 'Other',
];
const DEFAULT_SETTINGS = {
  expiring_soon_days: '7',       // warn this many days before an extension expires
  long_stay_days: '30',          // flag in-port vessels with no extension after this many days
  urgent_extension_count: '3',   // "URGENT - 3+ EXTENSIONS"
  office_footer: 'Office Hours: Monday - Friday 8:00 am - 4:30 pm | Phone No. 223-7092 Ext. 101',
  require_extension_approval: '1',
};

function open(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  seed(db);
  return db;
}

function seed(db) {
  const has = db.prepare('SELECT COUNT(*) n FROM stations').get().n;
  if (has) return;
  tx(db, () => {
    STATIONS.forEach(([c, n], i) => db.prepare('INSERT INTO stations(code,name,sort) VALUES (?,?,?)').run(c, n, i));
    VESSEL_TYPES.forEach(([n, c, m], i) => db.prepare('INSERT INTO vessel_types(name,rotation_class,manual_sequence,sort) VALUES (?,?,?,?)').run(n, c, m, i));
    CARGO.forEach((n, i) => db.prepare('INSERT INTO cargo_types(name,sort) VALUES (?,?)').run(n, i));
    EXT_REASONS.forEach((n, i) => db.prepare('INSERT INTO extension_reasons(name,sort) VALUES (?,?)').run(n, i));
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run(k, v);
    // Initial administrator. The password must be changed at first sign-in.
    const pw = process.env.ADMIN_PASSWORD || 'ChangeMe!2026';
    db.prepare(`INSERT INTO users(username,full_name,initials,role,station_code,password_hash,must_change_password)
                VALUES ('admin','System Administrator','ADMIN','admin',NULL,?,1)`).run(hashPassword(pw));
  });
}

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { open, tx };
