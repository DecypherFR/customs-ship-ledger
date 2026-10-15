// Loads demonstration users and vessel calls so each role can be tried out.
// Usage: DB_FILE=data/demo.db npm run demo    (never run against the live database)
'use strict';
const path = require('node:path');
if (!process.env.DB_FILE) process.env.DB_FILE = path.join(__dirname, '..', 'data', 'demo.db');
const { db } = require('../server/server');
const { hashPassword } = require('../server/auth');
const { allocateRotation } = require('../server/ledger');

if (db.prepare('SELECT COUNT(*) n FROM calls').get().n) { console.log('Database already has vessel calls; demo data not loaded.'); process.exit(0); }
const PW = 'Demo2026pass';
const users = [
  ['gdominguez', 'Gilberto Dominguez', 'G.DOMINGUEZ', 'officer', 'BZE'],
  ['mcastillo', 'Maria Castillo', 'M.CASTILLO', 'officer', 'SPR'],
  ['jflowers', 'Jason Flowers', 'J.FLOWERS', 'supervisor', 'BZE'],
  ['rnunez', 'Rosa Nunez', 'R.NUNEZ', 'supervisor', 'SPR'],
  ['kyoung', 'Kevin Young', 'K.YOUNG', 'investigator', null],
  ['comptroller', 'Office of the Comptroller', 'COMPTROLLER', 'management', null],
];
const id = {};
for (const [u, n, i, r, s] of users) {
  id[u] = Number(db.prepare('INSERT INTO users(username,full_name,initials,role,station_code,password_hash,must_change_password) VALUES (?,?,?,?,?,?,0)')
    .run(u, n, i, r, s, hashPassword(PW)).lastInsertRowid);
}
db.prepare("UPDATE users SET password_hash=?, must_change_password=0 WHERE username='admin'").run(hashPassword(PW));

const T = new Date(process.env.LEDGER_TODAY || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Belize' }).format(new Date()));
const day = (n) => new Date(T.getTime() - n * 86400000).toISOString().slice(0, 10);
const V = [
  ['Container Vessel', 'BF EMILIA', '9578569', 'ANTIGUA & BARBUDA', 'BELIZE ESTATES COMPANY', 6363, 3998, 14, 'OLEG PRIKNA', 'KINGSTON, JAMAICA', 'Containers', 'BZE'],
  ['General Cargo Vessel', 'CARIBE TRADER', '9311245', 'PANAMA', 'CARIBBEAN SHIPPING AGENCY', 2950, 1620, 11, 'LUIS HERRERA', 'PUERTO CORTES, HONDURAS', 'General Cargo', 'BZE'],
  ['Oil/Fuel Tanker', 'PETRO STAR', '9455120', 'LIBERIA', 'PUMA ENERGY BAHAMAS', 11850, 6020, 22, 'ANDREI VOLKOV', 'HOUSTON, UNITED STATES OF AMERICA', 'Fuel / Petroleum', 'BGC'],
  ['Bulk Carrier', 'OCEAN HARVEST', '9602233', 'MARSHALL ISLANDS', 'BANANA GROWERS ASSOCIATION', 19400, 10800, 20, 'CHEN WEI', 'SANTO TOMAS, GUATEMALA', 'Bananas / Agricultural Export', 'BGC'],
  ['Cruise Ship', 'CARIBBEAN DREAM', '9744011', 'BAHAMAS', 'BELIZE TOURISM BOARD', 91000, 58000, 940, 'MARCO ROSSI', 'COZUMEL, MEXICO', 'Passengers / Cruise', 'BTV'],
  ['Pleasure Vessel / Yacht', 'SEA ESPRIT', '1018822', 'UNITED STATES OF AMERICA', 'SAN PEDRO YACHT SERVICES', 48, 19, 3, 'JOHN CARVER', 'ISLA MUJERES, MEXICO', 'Ballast / No Cargo', 'SPR'],
  ['Liveaboard Vessel', 'ATOMIC', '181871', 'UNITED STATES OF AMERICA', 'BELIZE TOURISM BOARD', 65, 23, 2, 'AUSTIN MCBROOM', 'KEYWEST, UNITED STATES OF AMERICA', 'Liveaboard', 'SPR'],
  ['Supply Vessel', 'GULF RUNNER', '9201776', 'BELIZE', 'MARINE SUPPLY CO.', 820, 410, 8, 'DWIGHT USHER', 'PUERTO BARRIOS, GUATEMALA', 'Supplies / Stores', 'PG'],
  ['Fishing Vessel', 'LADY KAREN', 'BZ-4471', 'BELIZE', 'NORTHERN FISHERMEN COOP', 35, 12, 6, 'PEDRO ALVAREZ', 'LIVINGSTON, GUATEMALA', 'Marine Products', 'PG'],
  ['Research / Survey Vessel', 'BLUE HORIZON', '9122003', 'NETHERLANDS', 'WILDLIFE CONSERVATION SOCIETY', 1450, 435, 16, 'ANNA DE VRIES', 'ROATAN, HONDURAS', 'Other', 'BZE'],
  ['Pleasure Vessel / Yacht', 'WINDSONG', '1020456', 'CANADA', 'SAN PEDRO YACHT SERVICES', 22, 9, 2, 'MARK TREMBLAY', 'GUANAJA, HONDURAS', 'Ballast / No Cargo', 'SPR'],
  ['Ro-Ro Vessel', 'AUTO EXPRESS', '9388120', 'MALTA', 'CARIBBEAN SHIPPING AGENCY', 14200, 7300, 19, 'IVAN PETROV', 'MIAMI, UNITED STATES OF AMERICA', 'Vehicles / Ro-Ro', 'BZE'],
];
const officerFor = { BZE: 'gdominguez', BTV: 'gdominguez', BGC: 'jflowers', PG: 'jflowers', SPR: 'mcastillo', OTH: 'gdominguez' };
let crg = 5690;
const ins = db.prepare(`INSERT INTO calls(vessel_type,station_code,voyage_no,vessel_name,imo,flag,agent,gross_tonnage,net_tonnage,crew,passengers,master,last_port,
  arrival_date,boarding_officer_id,next_port,departure_date,clearance_officer_id,cargo,officer_report,rotation_year,rotation_class,rotation_seq,rotation_no,created_by,verified_by,verified_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
function call(v, arrivedAgo, stayDays, opts = {}) {
  const [type, name, imo, flag, agent, gt, nt, crew, master, last, cargo, st] = v;
  const arr = day(arrivedAgo); const dep = stayDays == null ? null : day(Math.max(arrivedAgo - stayDays, 0));
  const rot = allocateRotation(db, { vesselType: type, arrivalDate: arr, manualSeq: ++crg });
  const off = id[officerFor[st]];
  const pax = type === 'Cruise Ship' ? 2100 + (arrivedAgo % 7) * 110 : 0;
  const r = ins.run(type, st, String(1000 + arrivedAgo), name, imo, flag, agent, gt, nt, crew, pax, master, last, arr, off,
    opts.noNext ? null : last, dep, dep ? off : null, cargo,
    JSON.stringify({ anchorage_time: '07:30', boarding_time: '08:15', health_official: 'D. TORRES', pilot_name: 'D. YOUNG', fumigated: 'NO', rummaged: 'YES', report_remarks: 'ALL CLEAR' }),
    rot.rotation_year, rot.rotation_class, rot.rotation_seq, rot.rotation_no, off,
    dep && opts.verify ? id.jflowers : null, dep && opts.verify ? new Date().toISOString() : null);
  db.prepare('INSERT INTO vessels(imo,name,flag,vessel_type,gross_tonnage,net_tonnage) VALUES (?,?,?,?,?,?) ON CONFLICT(imo) DO NOTHING').run(imo, name, flag, type, gt, nt);
  db.prepare('UPDATE calls SET vessel_id=(SELECT id FROM vessels WHERE imo=?) WHERE id=?').run(imo, r.lastInsertRowid);
  db.prepare("INSERT INTO audit(user_id,action,entity,entity_id,summary) VALUES (?,?,?,?,?)").run(off, 'create', 'call', r.lastInsertRowid, `Recorded ${rot.rotation_no} ${name} at ${st}`);
  return Number(r.lastInsertRowid);
}
function ext(callId, from, to, by, status = 'APPROVED', reason = 'Temporary Permit') {
  db.prepare(`INSERT INTO extensions(call_id,date_granted,original_expiry,new_expiry,reason,status,requested_by,decided_by,decided_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(callId, status === 'APPROVED' ? from : null, from, to, reason, status, id[by], status === 'APPROVED' ? id.jflowers : null, status === 'APPROVED' ? new Date().toISOString() : null);
}
// ~11 months of departed traffic
for (let m = 330; m > 20; m -= 9) {
  const v = V[(m / 9 | 0) % V.length];
  if (v[0] === 'Liveaboard Vessel') continue;
  call(v, m, v[0] === 'Cruise Ship' ? 0 : 2 + (m % 5), { verify: m > 60 });
}
// This month: a mix of in-port and departed
call(V[0], 12, 3); call(V[4], 9, 0); call(V[1], 6, 2); call(V[11], 4, null); call(V[2], 3, null); call(V[9], 2, null, { noNext: true });
// Vessels that need attention
const atomic = call(V[6], 120, null);            // liveaboard, 3 extensions, overdue -> URGENT
ext(atomic, day(105), day(75), 'mcastillo', 'APPROVED', 'Liveaboard'); ext(atomic, day(75), day(45), 'mcastillo', 'APPROVED', 'Liveaboard'); ext(atomic, day(45), day(10), 'mcastillo', 'APPROVED', 'Liveaboard');
const esprit = call(V[5], 40, null);             // overdue after one extension
ext(esprit, day(26), day(4), 'mcastillo', 'APPROVED', 'Awaiting Repairs / Parts');
const runner = call(V[7], 25, null);             // expiring soon
ext(runner, day(15), day(-3), 'jflowers', 'APPROVED', 'Weather');
const windsong = call(V[10], 48, null);          // long stay, no extension, pending request
ext(windsong, day(1), day(-30), 'mcastillo', 'PENDING', 'Crew Health and Safety Emergency');
call(V[8], 52, null);                            // long stay at Punta Gorda
console.log(`Demo data loaded into ${process.env.DB_FILE}. Every demo account (and admin) uses the password: ${PW}`);
console.log(users.map(([u, , , r, s]) => `  ${u.padEnd(12)} ${r.padEnd(13)} ${s || 'national'}`).join('\n'));
