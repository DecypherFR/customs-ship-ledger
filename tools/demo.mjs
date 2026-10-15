// Load demonstration accounts and vessel calls so every role can be tried out.
//
// Local stack:   DATABASE_URL=postgres://postgres:postgres@localhost/ledger_dev node tools/demo.mjs
// Supabase:      DATABASE_URL=$SUPABASE_DB_URL SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node tools/demo.mjs
//                (sign-ins are created through Supabase's Admin API; never run against a live ledger)
//
// All records are created through the same database functions the app uses, as the demo users.
import pg from 'pg';

const PW = process.env.DEMO_PASSWORD || 'Demo2026pass';
const db = new pg.Client({ connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/ledger_dev' });
await db.connect();
if ((await db.query('select count(*)::int n from calls')).rows[0].n) { console.log('The database already has vessel calls; demo data not loaded.'); process.exit(0); }

const USERS = [
  ['admin', 'System Administrator', 'ADMIN', 'admin', null],
  ['jreyes', 'Javier Reyes', 'J.REYES', 'officer', 'BZE'],
  ['mcastillo', 'Maria Castillo', 'M.CASTILLO', 'officer', 'SPR'],
  ['jflowers', 'Jason Flowers', 'J.FLOWERS', 'supervisor', 'BZE'],
  ['rnunez', 'Rosa Nunez', 'R.NUNEZ', 'supervisor', 'SPR'],
  ['kyoung', 'Kevin Young', 'K.YOUNG', 'investigator', null],
  ['comptroller', 'Office of the Comptroller', 'COMPTROLLER', 'management', null],
];
const DOMAIN = process.env.DEMO_EMAIL_DOMAIN || 'example.com';
const id = {};
for (const [u, name, ini, role, st] of USERS) {
  const email = `${u}@${DOMAIN}`;
  let uid;
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users`, { method: 'POST',
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PW, email_confirm: true }) });
    const j = await r.json();
    if (!r.ok) { console.error(`Could not create ${email}: ${j.msg || j.message || r.status}`); process.exit(1); }
    uid = j.id;
  } else {
    uid = (await db.query("insert into auth.users(email, encrypted_password) values ($1, extensions.crypt($2, extensions.gen_salt('bf'))) returning id", [email, PW])).rows[0].id;
  }
  await db.query(`insert into profiles(id,email,full_name,initials,role,station_code,must_change_password) values ($1,$2,$3,$4,$5,$6,false)
    on conflict (id) do update set role = excluded.role, station_code = excluded.station_code`, [uid, email, name, ini, role, st]);
  id[u] = uid;
}

// Run a database function as a demo user, exactly as the app would through Supabase.
async function as(user, sql, params) {
  await db.query('begin');
  try {
    await db.query('set local role authenticated');
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id[user], role: 'authenticated' })]);
    const r = await db.query(sql, params); await db.query('commit'); return r.rows[0];
  } catch (e) { await db.query('rollback'); throw e; }
}
const today = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Belize' }).format(new Date()) + 'T12:00:00Z');
const day = (n) => new Date(today.getTime() - n * 86400000).toISOString().slice(0, 10);

const V = [
  ['Container Vessel', 'OCEAN PIONEER', '9500001', 'ANTIGUA & BARBUDA', 'EXAMPLE SHIPPING AGENCY', 6363, 3998, 14, 'PETER HALE', 'KINGSTON, JAMAICA', 'Containers', 'BZE'],
  ['General Cargo Vessel', 'CARIBE TRADER', '9311245', 'PANAMA', 'CARIBBEAN SHIPPING AGENCY', 2950, 1620, 11, 'LUIS HERRERA', 'PUERTO CORTES, HONDURAS', 'General Cargo', 'BZE'],
  ['Oil/Fuel Tanker', 'PETRO STAR', '9455120', 'LIBERIA', 'PUMA ENERGY BAHAMAS', 11850, 6020, 22, 'ANDREI VOLKOV', 'HOUSTON, UNITED STATES OF AMERICA', 'Fuel / Petroleum', 'BGC'],
  ['Bulk Carrier', 'OCEAN HARVEST', '9602233', 'MARSHALL ISLANDS', 'BANANA GROWERS ASSOCIATION', 19400, 10800, 20, 'CHEN WEI', 'SANTO TOMAS, GUATEMALA', 'Bananas / Agricultural Export', 'BGC'],
  ['Cruise Ship', 'CARIBBEAN DREAM', '9744011', 'BAHAMAS', 'BELIZE TOURISM BOARD', 91000, 58000, 940, 'MARCO ROSSI', 'COZUMEL, MEXICO', 'Passengers / Cruise', 'BTV'],
  ['Pleasure Vessel / Yacht', 'SEA ESPRIT', '1018822', 'UNITED STATES OF AMERICA', 'SAN PEDRO YACHT SERVICES', 48, 19, 3, 'JOHN CARVER', 'ISLA MUJERES, MEXICO', 'Ballast / No Cargo', 'SPR'],
  ['Liveaboard Vessel', 'BLUE LAGOON', '1000001', 'UNITED STATES OF AMERICA', 'BELIZE TOURISM BOARD', 65, 23, 2, 'SAM RIVERS', 'KEY WEST, UNITED STATES OF AMERICA', 'Liveaboard', 'SPR'],
  ['Supply Vessel', 'GULF RUNNER', '9201776', 'BELIZE', 'MARINE SUPPLY CO.', 820, 410, 8, 'DWIGHT USHER', 'PUERTO BARRIOS, GUATEMALA', 'Supplies / Stores', 'PG'],
  ['Fishing Vessel', 'LADY KAREN', 'BZ-4471', 'BELIZE', 'NORTHERN FISHERMEN COOP', 35, 12, 6, 'PEDRO ALVAREZ', 'LIVINGSTON, GUATEMALA', 'Marine Products', 'PG'],
  ['Research / Survey Vessel', 'BLUE HORIZON', '9122003', 'NETHERLANDS', 'WILDLIFE CONSERVATION SOCIETY', 1450, 435, 16, 'ANNA DE VRIES', 'ROATAN, HONDURAS', 'Other', 'BZE'],
  ['Pleasure Vessel / Yacht', 'WINDSONG', '1020456', 'CANADA', 'SAN PEDRO YACHT SERVICES', 22, 9, 2, 'MARK TREMBLAY', 'GUANAJA, HONDURAS', 'Ballast / No Cargo', 'SPR'],
  ['Ro-Ro Vessel', 'AUTO EXPRESS', '9388120', 'MALTA', 'CARIBBEAN SHIPPING AGENCY', 14200, 7300, 19, 'IVAN PETROV', 'MIAMI, UNITED STATES OF AMERICA', 'Vehicles / Ro-Ro', 'BZE'],
];
// Station officer and supervisor for each station (officers record; supervisors verify and approve).
const crew = { BZE: ['jreyes', 'jflowers'], BTV: ['admin', 'admin'], BGC: ['admin', 'admin'], PG: ['admin', 'admin'], SPR: ['mcastillo', 'rnunez'] };
let crg = 5690;
async function call(v, arrivedAgo, stayDays, opts = {}) {
  const [type, name, imo, flag, agent, gt, nt, crewN, master, last, cargo, st] = v;
  const [officer, supervisor] = crew[st];
  const r = await as(officer, 'select create_call($1) as id', [JSON.stringify({ vessel_type: type, rotation_seq: ++crg, station_code: st,
    voyage_no: String(1000 + arrivedAgo), vessel_name: name, imo, flag, agent, gross_tonnage: gt, net_tonnage: nt, crew: crewN,
    passengers: type === 'Cruise Ship' ? 2100 + (arrivedAgo % 7) * 110 : 0, master, last_port: last, next_port: opts.noNext ? null : last,
    arrival_date: day(arrivedAgo), cargo, officer_report: { anchorage_time: '07:30', boarding_time: '08:15', health_official: 'K. BENNETT',
      pilot_name: 'L. MARIN', fumigated: 'NO', rummaged: 'YES', report_remarks: 'ALL CLEAR' } })]);
  if (stayDays != null) {
    await as(officer, 'select update_call($1, $2)', [r.id, JSON.stringify({ departure_date: day(Math.max(arrivedAgo - stayDays, 0)), clearance_officer_id: id[officer] })]);
    if (opts.verify) await as(supervisor, 'select verify_call($1, false, null)', [r.id]);
  }
  return r.id;
}
const grant = (user, callId, from, to, reason) => as(user, 'select add_extension($1, $2)', [callId, JSON.stringify({ original_expiry: from, new_expiry: to, reason })]);

for (let m = 330; m > 20; m -= 9) {
  const v = V[Math.floor(m / 9) % V.length];
  if (v[0] === 'Liveaboard Vessel') continue;
  await call(v, m, v[0] === 'Cruise Ship' ? 0 : 2 + (m % 5), { verify: m > 60 });
}
await call(V[0], 12, 3); await call(V[4], 9, 0); await call(V[1], 6, 2); await call(V[11], 4, null); await call(V[2], 3, null); await call(V[9], 2, null, { noNext: true });
const atomic = await call(V[6], 120, null);                    // liveaboard, 3 extensions, overdue -> URGENT
await grant('rnunez', atomic, day(105), day(75), 'Liveaboard'); await grant('rnunez', atomic, day(75), day(45), 'Liveaboard'); await grant('rnunez', atomic, day(45), day(10), 'Liveaboard');
const esprit = await call(V[5], 40, null);                     // overdue after one extension
await grant('rnunez', esprit, day(26), day(4), 'Awaiting Repairs / Parts');
const runner = await call(V[7], 25, null);                     // expiring soon
await grant('admin', runner, day(15), day(-3), 'Weather');
const windsong = await call(V[10], 48, null);                  // long stay, with a pending request from the officer
await grant('mcastillo', windsong, day(1), day(-30), 'Crew Health and Safety Emergency');
await call(V[8], 52, null);                                    // long stay at Punta Gorda
await db.end();
console.log(`Demo data loaded. Accounts (password ${PW}):`);
for (const [u, , , r, s] of USERS) console.log(`  ${`${u}@${DOMAIN}`.padEnd(32)} ${r.padEnd(13)} ${s || 'all stations'}`);
