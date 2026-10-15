-- Belize Customs & Excise - National Ships Ledger
-- Schema, row-level security and business rules for Supabase.
--
-- Security model
--   * Every table has RLS enabled. Signed-in users can only SELECT what their role allows.
--   * There are NO insert/update/delete policies: every write goes through a SECURITY DEFINER
--     function below, which checks the caller's role and applies the ledger's rules.
--   * Officers and supervisors with a station only ever see that station's records.

create extension if not exists pgcrypto with schema extensions;

-- ======================================================================= tables
create table public.settings (key text primary key, value text not null);

create table public.stations (
  code text primary key check (code ~ '^[A-Z]{2,4}$'),
  name text not null unique,
  active boolean not null default true,
  sort int not null default 0
);
create table public.vessel_types (
  name text primary key,
  rotation_class text not null check (rotation_class ~ '^[A-Z]{3}$'),
  manual_sequence boolean not null default false,   -- CRG: number supplied by the agent
  active boolean not null default true,
  sort int not null default 0
);
create table public.cargo_types (name text primary key, active boolean not null default true, sort int not null default 0);
create table public.extension_reasons (name text primary key, active boolean not null default true, sort int not null default 0);

-- One row per person. id = auth.users.id once the person has a sign-in; officers imported
-- from the Excel ledger start as inactive placeholders with no sign-in.
create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  full_name text not null,
  initials text not null,                       -- printed form, e.g. J.REYES
  role text not null check (role in ('officer','supervisor','investigator','management','admin')),
  station_code text references public.stations(code),
  active boolean not null default true,
  must_change_password boolean not null default true,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

create table public.vessels (
  id bigint generated always as identity primary key,
  imo text unique,
  name text not null,
  flag text, vessel_type text, gross_tonnage numeric, net_tonnage numeric,
  updated_at timestamptz not null default now()
);

-- VESSEL MOVEMENTS: one row = one vessel call at one Customs station.
create table public.calls (
  id bigint generated always as identity primary key,
  client_uuid uuid unique,
  rotation_year int not null,
  rotation_class text not null,
  rotation_seq int not null,
  rotation_no text not null unique,
  vessel_id bigint references public.vessels(id),
  vessel_type text not null,
  station_code text not null references public.stations(code),
  voyage_no text,
  vessel_name text not null,
  imo text,
  flag text,
  agent text,
  gross_tonnage numeric check (gross_tonnage >= 0),
  net_tonnage numeric check (net_tonnage >= 0),
  crew int check (crew >= 0),
  passengers int check (passengers >= 0),
  master text,
  last_port text,
  arrival_date date not null,
  boarding_officer_id uuid references public.profiles(id) on update cascade,
  next_port text,
  departure_date date,
  clearance_officer_id uuid references public.profiles(id) on update cascade,
  cargo text,
  remarks text,
  officer_report jsonb not null default '{}',   -- Ship's Report officer section
  verified_by uuid references public.profiles(id) on update cascade,
  verified_at timestamptz,
  version int not null default 1,
  created_by uuid not null references public.profiles(id) on update cascade,
  created_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on update cascade,
  updated_at timestamptz not null default now(),
  unique (rotation_year, rotation_class, rotation_seq)
);
create index calls_station on public.calls(station_code);
create index calls_arrival on public.calls(arrival_date);

-- EXTENSION LOG, with an approval step.
create table public.extensions (
  id bigint generated always as identity primary key,
  client_uuid uuid unique,
  call_id bigint not null references public.calls(id) on delete cascade,
  date_granted date,
  original_expiry date not null,
  new_expiry date not null,
  reason text not null,
  remarks text,
  status text not null default 'PENDING' check (status in ('PENDING','APPROVED','REJECTED')),
  requested_by uuid not null references public.profiles(id) on update cascade,
  requested_at timestamptz not null default now(),
  decided_by uuid references public.profiles(id) on update cascade,
  decided_at timestamptz,
  decision_note text
);
create index ext_call on public.extensions(call_id);

-- OVERSTAY INVESTIGATION cases, attached to the call (not to a spreadsheet row position).
create table public.cases (
  id bigint generated always as identity primary key,
  call_id bigint not null unique references public.calls(id) on delete cascade,
  status text not null default 'OPEN' check (status in ('OPEN','IN PROGRESS','REFERRED','CLOSED')),
  assigned_to uuid references public.profiles(id) on update cascade,
  outcome text,
  opened_by uuid not null references public.profiles(id) on update cascade,
  opened_at timestamptz not null default now(),
  closed_at timestamptz
);
create table public.case_notes (
  id bigint generated always as identity primary key,
  client_uuid uuid unique,
  case_id bigint not null references public.cases(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on update cascade,
  note text not null,
  created_at timestamptz not null default now()
);

create table public.audit (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  user_id uuid references public.profiles(id) on update cascade on delete set null,
  action text not null,
  entity text not null,
  entity_id bigint,
  summary text,
  details jsonb
);
create index audit_entity on public.audit(entity, entity_id);

-- ======================================================================= reference data
insert into public.stations(code, name, sort) values
  ('BZE','Belize City',0), ('BTV','Belize Tourism Village',1), ('BGC','Big Creek',2),
  ('PG','Punta Gorda',3), ('SPR','San Pedro',4), ('OTH','Other Maritime Station',5);
insert into public.vessel_types(name, rotation_class, manual_sequence, sort) values
  ('Container Vessel','CRG',true,0), ('Supply Vessel','SUP',false,1), ('Oil/Fuel Tanker','TKR',false,2),
  ('Pleasure Vessel / Yacht','PSV',false,3), ('Liveaboard Vessel','LVB',false,4), ('Cruise Ship','CRU',false,5),
  ('Military / Government Vessel','GOV',false,6), ('Bulk Carrier','BLK',false,7), ('General Cargo Vessel','CRG',true,8),
  ('Ro-Ro Vessel','ROR',false,9), ('Fishing Vessel','FSH',false,10), ('Research / Survey Vessel','RSV',false,11), ('Other','OTH',false,12);
insert into public.cargo_types(name, sort)
  select n, i - 1 from unnest(array['Containers','General Cargo','Fuel / Petroleum','Wheat','Fertilizer','Vehicles / Ro-Ro',
    'Passengers / Cruise','Supplies / Stores','Marine Products','Bananas / Agricultural Export','Ballast / No Cargo','Liveaboard','Other'])
    with ordinality as t(n, i);
insert into public.extension_reasons(name, sort)
  select n, i - 1 from unnest(array['Temporary Permit','Liveaboard','Force Majeure','Crew Health and Safety Emergency',
    'Awaiting Repairs / Parts','Weather','Other']) with ordinality as t(n, i);
insert into public.settings(key, value) values
  ('expiring_soon_days','7'), ('long_stay_days','30'), ('urgent_extension_count','3'),
  ('office_footer','Office Hours: Monday - Friday 8:00 am - 4:30 pm | Phone No. 223-7092 Ext. 101'),
  ('require_extension_approval','1');

-- ======================================================================= helpers
-- "Today" in Belize (UTC-6, no daylight saving). Tests can pin it with SET ledger.today.
create function public.ledger_today() returns date language sql stable as $$
  select coalesce(nullif(current_setting('ledger.today', true), '')::date, (now() at time zone 'America/Belize')::date)
$$;

create function public.setting(k text) returns text language sql stable security definer set search_path = public as $$
  select value from settings where key = k
$$;

create function public.me() returns public.profiles language sql stable security definer set search_path = public as $$
  select * from profiles where id = auth.uid() and active
$$;

create function public.app_role() returns text language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid() and active
$$;

-- Station filter for station-scoped roles; null = all stations.
create function public.app_station() returns text language sql stable security definer set search_path = public as $$
  select station_code from profiles where id = auth.uid() and active and role in ('officer','supervisor')
$$;

create function public.can(perm text) returns boolean language sql stable as $$
  select case public.app_role()
    when 'admin' then true
    when 'officer' then perm = any(array['calls.read','calls.create','calls.edit','calls.depart','ext.request','report.print','dashboard.view'])
    when 'supervisor' then perm = any(array['calls.read','calls.create','calls.edit','calls.depart','calls.verify','ext.request','ext.approve',
      'report.print','dashboard.view','overstay.view','cases.manage','export'])
    when 'investigator' then perm = any(array['calls.read','report.print','dashboard.view','overstay.view','cases.manage','export'])
    when 'management' then perm = any(array['calls.read','report.print','dashboard.view','overstay.view','export','audit.view'])
    else false end
$$;

-- Raise an error that PostgREST returns with the given HTTP status; the hint carries the form field.
create function public.fail(status int, msg text, field text default null) returns void language plpgsql as $$
begin
  raise exception using errcode = 'PT' || status, message = msg, hint = coalesce(field, '');
end $$;

create function public.need(perm text) returns public.profiles language plpgsql stable security definer set search_path = public as $$
declare u profiles;
begin
  u := me();
  if u.id is null then perform fail(401, 'Please sign in.'); end if;
  if u.must_change_password then perform fail(403, 'Change your password to continue.', 'must_change_password'); end if;
  if perm is not null and not can(perm) then perform fail(403, 'You are not authorised to do this.'); end if;
  return u;
end $$;

create function public.up(v text) returns text language sql immutable as $$ select nullif(upper(trim(v)), '') $$;
create function public.txt(v text) returns text language sql immutable as $$ select nullif(trim(v), '') $$;

create function public.log(u uuid, act text, ent text, ent_id bigint, summ text, det jsonb default null) returns void
language sql security definer set search_path = public as $$
  insert into audit(user_id, action, entity, entity_id, summary, details) values (u, act, ent, ent_id, summ, det)
$$;

-- ======================================================================= rules
-- The workbook's "Data Check" column (warnings; they block verification, not saving).
create function public.call_data_check(c public.calls) returns text[] language plpgsql stable as $$
declare missing text[] := '{}'; w text[] := '{}';
begin
  if txt(c.flag) is null then missing := missing || 'Flag / Nationality'::text; end if;
  if c.crew is null then missing := missing || 'Crew'::text; end if;
  if txt(c.master) is null then missing := missing || 'Master'::text; end if;
  if txt(c.last_port) is null then missing := missing || 'Last Port'::text; end if;
  if c.boarding_officer_id is null then missing := missing || 'Boarding Officer'::text; end if;
  if txt(c.next_port) is null then missing := missing || 'Next Port'::text; end if;
  if txt(c.cargo) is null then missing := missing || 'Cargo / Operation'::text; end if;
  if txt(c.agent) is null then missing := missing || 'Shipping Agent'::text; end if;
  if cardinality(missing) > 0 then w := w || ('Missing: ' || array_to_string(missing, ', ')); end if;
  if c.gross_tonnage > 0 and c.net_tonnage > c.gross_tonnage then w := w || 'Net tonnage is greater than gross tonnage.'::text; end if;
  if txt(c.imo) is null then w := w || 'No IMO / registration number.'::text; end if;
  return case when cardinality(w) = 0 then null else w end;
end $$;

-- Hard errors: these block saving.
create function public.validate_call(c public.calls) returns void language plpgsql stable set search_path = public as $$
begin
  if c.vessel_type is null or not exists (select 1 from vessel_types where name = c.vessel_type) then perform fail(400, 'Select the vessel type.', 'vessel_type'); end if;
  if c.station_code is null or not exists (select 1 from stations where code = c.station_code) then perform fail(400, 'Select the Customs station.', 'station_code'); end if;
  if txt(c.vessel_name) is null then perform fail(400, 'Enter the vessel name.', 'vessel_name'); end if;
  if c.arrival_date is null then perform fail(400, 'Enter a valid arrival date.', 'arrival_date'); end if;
  if c.arrival_date > ledger_today() then perform fail(400, 'Arrival date cannot be in the future.', 'arrival_date'); end if;
  if c.departure_date < c.arrival_date then perform fail(400, 'Departure date cannot be before the arrival date.', 'departure_date'); end if;
  if c.departure_date is not null and c.clearance_officer_id is null then perform fail(400, 'Add the clearance officer for a departed vessel.', 'clearance_officer_id'); end if;
  if c.cargo is not null and not exists (select 1 from cargo_types where name = c.cargo) then perform fail(400, 'Unknown cargo / operation.', 'cargo'); end if;
  if c.boarding_officer_id is not null and not exists (select 1 from profiles where id = c.boarding_officer_id) then perform fail(400, 'Unknown officer.', 'boarding_officer_id'); end if;
  if c.clearance_officer_id is not null and not exists (select 1 from profiles where id = c.clearance_officer_id) then perform fail(400, 'Unknown officer.', 'clearance_officer_id'); end if;
end $$;

-- Full Rotation No. = YEAR/CLASS/SEQ, year from the arrival date. CRG classes take the number
-- supplied by the agent; all other classes share ONE automatic sequence per year
-- (2026/PSV/2, 2026/SUP/3, ...), exactly as the workbook's COUNTIFS on "YYYY/*" did.
create function public.allocate_rotation(p_type text, p_arrival date, p_manual_seq int,
  out rotation_year int, out rotation_class text, out rotation_seq int, out rotation_no text)
language plpgsql volatile security definer set search_path = public as $$
declare vt vessel_types; clash text;
begin
  select * into vt from vessel_types where name = p_type;
  if vt.name is null then perform fail(400, format('Unknown vessel type "%s".', p_type), 'vessel_type'); end if;
  rotation_year := extract(year from p_arrival)::int;
  rotation_class := vt.rotation_class;
  perform pg_advisory_xact_lock(hashtext('ledger-rotation-' || rotation_year));  -- one allocation at a time per year
  if vt.manual_sequence then
    if p_manual_seq is null or p_manual_seq < 1 then
      perform fail(400, format('Enter the %s rotation sequence number supplied for this vessel.', vt.rotation_class), 'rotation_seq');
    end if;
    rotation_seq := p_manual_seq;
    select c.rotation_no into clash from calls c where c.rotation_year = allocate_rotation.rotation_year
      and c.rotation_class = vt.rotation_class and c.rotation_seq = p_manual_seq;
    if clash is not null then perform fail(409, format('Rotation No. %s is already in use.', clash), 'rotation_seq'); end if;
  else
    select coalesce(max(c.rotation_seq), 0) + 1 into rotation_seq from calls c
      where c.rotation_year = allocate_rotation.rotation_year
        and c.rotation_class not in (select v.rotation_class from vessel_types v where v.manual_sequence);
  end if;
  rotation_no := format('%s/%s/%s', rotation_year, rotation_class, rotation_seq);
end $$;

-- Read JSON into a calls row: blank strings become null, text is upper-cased like the ledger.
create function public.call_from_json(base public.calls, p jsonb) returns public.calls language plpgsql stable as $$
declare clean jsonb := '{}'; k text; r public.calls; rep jsonb;
  allowed text[] := array['vessel_type','station_code','voyage_no','vessel_name','imo','flag','agent','gross_tonnage','net_tonnage',
    'crew','passengers','master','last_port','arrival_date','boarding_officer_id','next_port','departure_date','clearance_officer_id','cargo','remarks'];
  report_keys text[] := array['anchorage_time','boarding_time','health_official','pilot_name','fumigated','rummaged','report_remarks'];
begin
  foreach k in array allowed loop
    if p ? k then
      clean := clean || jsonb_build_object(k, case when jsonb_typeof(p->k) = 'string' and trim(p->>k) = '' then null else p->k end);
    end if;
  end loop;
  begin
    r := jsonb_populate_record(base, clean);
  exception when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow or invalid_datetime_format then
    perform fail(400, 'A number or date field has an invalid value.');
  end;
  r.vessel_type := txt(r.vessel_type); r.station_code := txt(r.station_code); r.cargo := txt(r.cargo); r.remarks := txt(r.remarks);
  r.voyage_no := up(r.voyage_no); r.vessel_name := up(r.vessel_name); r.imo := up(r.imo); r.flag := up(r.flag); r.agent := up(r.agent);
  r.master := up(r.master); r.last_port := up(r.last_port); r.next_port := up(r.next_port);
  if p ? 'officer_report' and jsonb_typeof(p->'officer_report') = 'object' then
    rep := coalesce(base.officer_report, '{}');
    foreach k in array report_keys loop
      if (p->'officer_report') ? k then rep := rep || jsonb_build_object(k, trim(p->'officer_report'->>k)); end if;
    end loop;
    r.officer_report := rep;
  end if;
  return r;
end $$;

create function public.upsert_vessel(c public.calls) returns bigint language plpgsql security definer set search_path = public as $$
declare vid bigint;
begin
  if c.imo is null then return null; end if;
  insert into vessels(imo, name, flag, vessel_type, gross_tonnage, net_tonnage)
    values (c.imo, c.vessel_name, c.flag, c.vessel_type, c.gross_tonnage, c.net_tonnage)
  on conflict (imo) do update set name = excluded.name, flag = coalesce(excluded.flag, vessels.flag),
    vessel_type = coalesce(excluded.vessel_type, vessels.vessel_type), gross_tonnage = coalesce(excluded.gross_tonnage, vessels.gross_tonnage),
    net_tonnage = coalesce(excluded.net_tonnage, vessels.net_tonnage), updated_at = now()
  returning id into vid;
  return vid;
end $$;

-- ======================================================================= derived view
-- VESSEL MOVEMENTS columns V, W, AC, AD plus the overstay register's status and priority.
-- security_invoker: callers only see rows their RLS policies allow.
create view public.call_overview with (security_invoker = true) as
select c.*, s.name as station_name, bo.initials as boarding_officer, co.initials as clearance_officer, vu.initials as verified_by_name,
  x.extension_count, x.latest_expiry, x.pending_extensions, k.status as case_status,
  case when c.departure_date is null then 'IN PORT' else 'DEPARTED' end as status,
  (coalesce(c.departure_date, t.today) - c.arrival_date) as days_in_port,
  o.overstay_status,
  case when o.overstay_status = 'OVERDUE' then t.today - x.latest_expiry end as days_overdue,
  case when c.departure_date is null and x.extension_count > 0 then x.latest_expiry - t.today end as days_to_expiry,
  case when o.overstay_status = 'OVERDUE' then
         case when x.extension_count >= t.urgent then format('URGENT - %s+ EXTENSIONS', t.urgent) else 'OVERDUE - FOLLOW UP' end
       when o.overstay_status = 'LONG STAY' then 'REVIEW - NO EXTENSION ON FILE' end as priority,
  public.call_data_check(c) as data_check
from public.calls c
join public.stations s on s.code = c.station_code
left join public.profiles bo on bo.id = c.boarding_officer_id
left join public.profiles co on co.id = c.clearance_officer_id
left join public.profiles vu on vu.id = c.verified_by
left join public.cases k on k.call_id = c.id
cross join lateral (select public.ledger_today() as today,
  coalesce(public.setting('expiring_soon_days')::int, 7) as soon,
  coalesce(public.setting('long_stay_days')::int, 30) as long_stay,
  coalesce(public.setting('urgent_extension_count')::int, 3) as urgent) t
cross join lateral (select
  count(*) filter (where e.status = 'APPROVED')::int as extension_count,
  (select e2.new_expiry from public.extensions e2 where e2.call_id = c.id and e2.status = 'APPROVED' order by e2.id desc limit 1) as latest_expiry,
  count(*) filter (where e.status = 'PENDING')::int as pending_extensions
  from public.extensions e where e.call_id = c.id) x
cross join lateral (select case
  when c.departure_date is not null then 'DEPARTED'
  when x.extension_count = 0 then case when coalesce(c.departure_date, t.today) - c.arrival_date > t.long_stay then 'LONG STAY' else 'NO EXTENSION' end
  when x.latest_expiry < t.today then 'OVERDUE'
  when x.latest_expiry - t.today <= t.soon then 'EXPIRING SOON'
  else 'WITHIN EXTENSION' end as overstay_status) o;

-- ======================================================================= write functions
create function public.create_call(p jsonb) returns bigint language plpgsql security definer set search_path = public as $$
declare u profiles; c calls; rot record; new_id bigint; seq int;
begin
  u := need('calls.create');
  begin
    seq := nullif(trim(p->>'rotation_seq'), '')::int;
  exception when others then perform fail(400, 'The rotation sequence number must be a whole number.', 'rotation_seq');
  end;
  if txt(p->>'client_uuid') is not null then
    select id into new_id from calls where client_uuid = (p->>'client_uuid')::uuid;
    if new_id is not null then return new_id; end if;   -- offline replay: already saved
  end if;
  c := call_from_json(null::calls, p);
  c.officer_report := coalesce(c.officer_report, '{}');
  c.station_code := coalesce(app_station(), c.station_code);
  c.boarding_officer_id := coalesce(c.boarding_officer_id, u.id);
  if c.departure_date is not null and not can('calls.depart') then perform fail(403, 'You are not authorised to record departures.'); end if;
  perform validate_call(c);
  rot := allocate_rotation(c.vessel_type, c.arrival_date, seq);
  insert into calls(client_uuid, rotation_year, rotation_class, rotation_seq, rotation_no, vessel_id, vessel_type, station_code, voyage_no,
    vessel_name, imo, flag, agent, gross_tonnage, net_tonnage, crew, passengers, master, last_port, arrival_date, boarding_officer_id,
    next_port, departure_date, clearance_officer_id, cargo, remarks, officer_report, created_by, updated_by)
  values (txt(p->>'client_uuid')::uuid, rot.rotation_year, rot.rotation_class, rot.rotation_seq, rot.rotation_no, upsert_vessel(c), c.vessel_type,
    c.station_code, c.voyage_no, c.vessel_name, c.imo, c.flag, c.agent, c.gross_tonnage, c.net_tonnage, c.crew, c.passengers, c.master,
    c.last_port, c.arrival_date, c.boarding_officer_id, c.next_port, c.departure_date, c.clearance_officer_id, c.cargo, c.remarks,
    c.officer_report, u.id, u.id)
  returning id into new_id;
  perform log(u.id, 'create', 'call', new_id, format('Recorded %s %s at %s', rot.rotation_no, c.vessel_name, c.station_code));
  return new_id;
end $$;

create function public.update_call(p_id bigint, p jsonb) returns bigint language plpgsql security definer set search_path = public as $$
declare u profiles; cur calls; nxt calls; vt vessel_types; rot record; changes jsonb := '{}'; k text; scope text := app_station();
  year_changed boolean; class_changed boolean; seq_changed boolean; what text;
begin
  u := need('calls.edit');
  select * into cur from calls where id = p_id for update;
  if cur.id is null or (scope is not null and cur.station_code <> scope) then perform fail(404, 'Vessel call not found.'); end if;
  if p ? 'version' and (p->>'version')::int <> cur.version then
    perform fail(409, format('This call was changed by someone else (now version %s). Reload it and re-apply your changes.', cur.version));
  end if;
  if cur.verified_at is not null and u.role <> 'admin' then perform fail(423, 'This call is verified and locked. A supervisor must unlock it first.'); end if;
  nxt := call_from_json(cur, p);
  if scope is not null and nxt.station_code <> scope then perform fail(403, 'You can only record calls for your own station.', 'station_code'); end if;
  if nxt.departure_date is not null and cur.departure_date is null and not can('calls.depart') then perform fail(403, 'You are not authorised to record departures.'); end if;
  perform validate_call(nxt);

  -- The rotation number is printed on documents, so only an administrator may change it.
  select * into vt from vessel_types where name = nxt.vessel_type;
  year_changed := extract(year from nxt.arrival_date)::int <> cur.rotation_year;
  class_changed := vt.rotation_class <> cur.rotation_class;
  seq_changed := vt.manual_sequence and txt(p->>'rotation_seq') is not null and (p->>'rotation_seq')::int <> cur.rotation_seq;
  if year_changed or class_changed or seq_changed then
    if u.role <> 'admin' then
      perform fail(400, 'This change would alter the Rotation No. Ask an administrator to make it.', case when year_changed then 'arrival_date' else 'vessel_type' end);
    end if;
    rot := allocate_rotation(nxt.vessel_type, nxt.arrival_date, coalesce(nullif(trim(p->>'rotation_seq'), '')::int, cur.rotation_seq));
    nxt.rotation_year := rot.rotation_year; nxt.rotation_class := rot.rotation_class; nxt.rotation_seq := rot.rotation_seq; nxt.rotation_no := rot.rotation_no;
    changes := changes || jsonb_build_object('rotation_no', jsonb_build_array(cur.rotation_no, rot.rotation_no));
  end if;

  for k in select jsonb_object_keys(to_jsonb(nxt)) loop
    if k in ('vessel_type','station_code','voyage_no','vessel_name','imo','flag','agent','gross_tonnage','net_tonnage','crew','passengers','master',
             'last_port','arrival_date','boarding_officer_id','next_port','departure_date','clearance_officer_id','cargo','remarks','officer_report')
       and to_jsonb(cur)->k is distinct from to_jsonb(nxt)->k then
      changes := changes || jsonb_build_object(k, jsonb_build_array(to_jsonb(cur)->k, to_jsonb(nxt)->k));
    end if;
  end loop;
  if changes = '{}' then return cur.id; end if;

  update calls set rotation_year = nxt.rotation_year, rotation_class = nxt.rotation_class, rotation_seq = nxt.rotation_seq, rotation_no = nxt.rotation_no,
    vessel_id = coalesce(upsert_vessel(nxt), cur.vessel_id), vessel_type = nxt.vessel_type, station_code = nxt.station_code, voyage_no = nxt.voyage_no,
    vessel_name = nxt.vessel_name, imo = nxt.imo, flag = nxt.flag, agent = nxt.agent, gross_tonnage = nxt.gross_tonnage, net_tonnage = nxt.net_tonnage,
    crew = nxt.crew, passengers = nxt.passengers, master = nxt.master, last_port = nxt.last_port, arrival_date = nxt.arrival_date,
    boarding_officer_id = nxt.boarding_officer_id, next_port = nxt.next_port, departure_date = nxt.departure_date,
    clearance_officer_id = nxt.clearance_officer_id, cargo = nxt.cargo, remarks = nxt.remarks, officer_report = nxt.officer_report,
    version = cur.version + 1, updated_by = u.id, updated_at = now()
  where id = cur.id;
  what := case when changes ? 'departure_date' and cur.departure_date is null then format('Departure recorded %s', nxt.departure_date)
               else 'Updated ' || (select string_agg(x, ', ') from jsonb_object_keys(changes) x) end;
  perform log(u.id, 'update', 'call', cur.id, format('%s: %s', nxt.rotation_no, what), changes);
  return cur.id;
end $$;

create function public.verify_call(p_id bigint, p_unlock boolean default false, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles; c call_overview; scope text := app_station();
begin
  u := need('calls.verify');
  select * into c from call_overview where id = p_id;
  if c.id is null or (scope is not null and c.station_code <> scope) then perform fail(404, 'Vessel call not found.'); end if;
  if p_unlock then
    if c.verified_at is null then return; end if;
    if txt(p_reason) is null then perform fail(400, 'Give a reason for unlocking.', 'reason'); end if;
    update calls set verified_by = null, verified_at = null, version = version + 1 where id = c.id;
    perform log(u.id, 'unlock', 'call', c.id, format('%s: unlocked - %s', c.rotation_no, txt(p_reason)));
  else
    if c.departure_date is null then perform fail(400, 'Only departed calls can be verified.'); end if;
    if c.data_check is not null then perform fail(400, 'Resolve the data check first: ' || array_to_string(c.data_check, '; ')); end if;
    if c.pending_extensions > 0 then perform fail(400, 'There is an extension awaiting a decision.'); end if;
    update calls set verified_by = u.id, verified_at = now(), version = version + 1 where id = c.id;
    perform log(u.id, 'verify', 'call', c.id, format('%s: verified and locked', c.rotation_no));
  end if;
end $$;

create function public.delete_call(p_id bigint, p_reason text) returns void language plpgsql security definer set search_path = public as $$
declare u profiles; c calls;
begin
  u := need(null);
  if u.role <> 'admin' then perform fail(403, 'Only an administrator can delete a vessel call.'); end if;
  select * into c from calls where id = p_id;
  if c.id is null then perform fail(404, 'Vessel call not found.'); end if;
  if txt(p_reason) is null then perform fail(400, 'Give a reason for deleting.', 'reason'); end if;
  delete from calls where id = c.id;   -- extensions, cases and notes cascade
  perform log(u.id, 'delete', 'call', c.id, format('%s %s deleted - %s', c.rotation_no, c.vessel_name, txt(p_reason)), to_jsonb(c));
end $$;

create function public.add_extension(p_call bigint, p jsonb) returns void language plpgsql security definer set search_path = public as $$
declare u profiles; c call_overview; scope text := app_station(); orig date; newx date; auto boolean; eid bigint; reason text := txt(p->>'reason');
begin
  u := need('ext.request');
  if txt(p->>'client_uuid') is not null and exists (select 1 from extensions where client_uuid = (p->>'client_uuid')::uuid) then return; end if;
  select * into c from call_overview where id = p_call;
  if c.id is null or (scope is not null and c.station_code <> scope) then perform fail(404, 'Vessel call not found.'); end if;
  if c.departure_date is not null then perform fail(400, 'This vessel has already departed.'); end if;
  begin
    orig := coalesce(nullif(trim(p->>'original_expiry'), '')::date, c.latest_expiry);
    newx := nullif(trim(p->>'new_expiry'), '')::date;
  exception when others then perform fail(400, 'Enter valid dates.', 'new_expiry');
  end;
  if orig is null then perform fail(400, 'Enter the original expiry date.', 'original_expiry'); end if;
  if newx is null then perform fail(400, 'Enter the new expiry date.', 'new_expiry'); end if;
  if newx <= orig then perform fail(400, 'New expiry must be after the original expiry.', 'new_expiry'); end if;
  if reason is null then perform fail(400, 'Select a reason.', 'reason'); end if;
  auto := can('ext.approve') or setting('require_extension_approval') <> '1';
  insert into extensions(client_uuid, call_id, date_granted, original_expiry, new_expiry, reason, remarks, status, requested_by, decided_by, decided_at)
  values (txt(p->>'client_uuid')::uuid, c.id, case when auto then coalesce(nullif(trim(p->>'date_granted'), '')::date, ledger_today()) end, orig, newx,
    reason, txt(p->>'remarks'), case when auto then 'APPROVED' else 'PENDING' end, u.id, case when auto then u.id end, case when auto then now() end)
  returning id into eid;
  perform log(u.id, case when auto then 'approve' else 'request' end, 'extension', eid,
    format('%s: extension to %s %s (%s)', c.rotation_no, newx, case when auto then 'granted' else 'requested' end, reason));
end $$;

create function public.decide_extension(p_id bigint, p_decision text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles; e extensions; c calls; scope text := app_station();
begin
  u := need('ext.approve');
  select * into e from extensions where id = p_id for update;
  if e.id is null then perform fail(404, 'Extension not found.'); end if;
  select * into c from calls where id = e.call_id;
  if scope is not null and c.station_code <> scope then perform fail(404, 'Extension not found.'); end if;
  if e.status <> 'PENDING' then perform fail(409, format('This extension was already %s.', lower(e.status))); end if;
  if p_decision not in ('APPROVED', 'REJECTED') then perform fail(400, 'Choose approve or reject.'); end if;
  if p_decision = 'REJECTED' and txt(p_note) is null then perform fail(400, 'Give a reason for rejecting.', 'note'); end if;
  if e.requested_by = u.id and u.role <> 'admin' then perform fail(403, 'You cannot approve your own extension request.'); end if;
  update extensions set status = p_decision, decided_by = u.id, decided_at = now(), decision_note = txt(p_note),
    date_granted = case when p_decision = 'APPROVED' then ledger_today() end where id = e.id;
  perform log(u.id, case when p_decision = 'APPROVED' then 'approve' else 'reject' end, 'extension', e.id,
    format('%s: extension to %s %s', c.rotation_no, e.new_expiry, lower(p_decision)));
end $$;

create function public.save_case(p_call bigint, p jsonb) returns void language plpgsql security definer set search_path = public as $$
declare u profiles; c calls; k cases; st text := coalesce(nullif(p->>'status', ''), 'OPEN'); scope text := app_station();
  assignee uuid := nullif(trim(p->>'assigned_to'), '')::uuid;
begin
  u := need('cases.manage');
  select * into c from calls where id = p_call;
  if c.id is null or (scope is not null and c.station_code <> scope) then perform fail(404, 'Vessel call not found.'); end if;
  if st not in ('OPEN','IN PROGRESS','REFERRED','CLOSED') then st := 'OPEN'; end if;
  if st = 'CLOSED' and txt(p->>'outcome') is null then perform fail(400, 'Record the outcome before closing the case.', 'outcome'); end if;
  select * into k from cases where call_id = c.id;
  if k.id is not null then
    update cases set status = st, assigned_to = assignee, outcome = txt(p->>'outcome'),
      closed_at = case when st = 'CLOSED' then coalesce(closed_at, now()) end where id = k.id;
    perform log(u.id, 'update', 'case', k.id, format('%s: case %s', c.rotation_no, lower(st)));
  else
    insert into cases(call_id, status, assigned_to, outcome, opened_by, closed_at)
      values (c.id, st, assignee, txt(p->>'outcome'), u.id, case when st = 'CLOSED' then now() end) returning id into k.id;
    perform log(u.id, 'create', 'case', k.id, format('%s: investigation case opened', c.rotation_no));
  end if;
end $$;

create function public.add_case_note(p_call bigint, p_note text, p_client_uuid uuid default null) returns void
language plpgsql security definer set search_path = public as $$
declare u profiles; kid bigint; rot text;
begin
  u := need('cases.manage');
  if txt(p_note) is null then perform fail(400, 'Write a note first.', 'note'); end if;
  if p_client_uuid is not null and exists (select 1 from case_notes where client_uuid = p_client_uuid) then return; end if;
  select id into kid from cases where call_id = p_call;
  if kid is null then
    perform save_case(p_call, '{"status":"OPEN"}');
    select id into kid from cases where call_id = p_call;
  end if;
  select rotation_no into rot from calls where id = p_call;
  insert into case_notes(client_uuid, case_id, user_id, note) values (p_client_uuid, kid, u.id, txt(p_note));
  perform log(u.id, 'note', 'case', kid, format('%s: follow-up note added', rot));
end $$;

-- ======================================================================= account functions
create function public.signed_in() returns void language plpgsql security definer set search_path = public as $$
declare u profiles := me();
begin
  if u.id is null then return; end if;
  update profiles set last_login_at = now() where id = u.id;
  perform log(u.id, 'login', 'user', null, format('%s signed in', u.email));
end $$;

create function public.password_changed() returns void language plpgsql security definer set search_path = public as $$
declare u profiles := me();
begin
  if u.id is null then perform fail(401, 'Please sign in.'); end if;
  update profiles set must_change_password = false where id = u.id;
  perform log(u.id, 'password', 'user', null, format('%s changed password', u.email));
end $$;

create function public.log_export(p_what text) returns void language plpgsql security definer set search_path = public as $$
declare u profiles;
begin
  u := need('export');
  perform log(u.id, 'export', 'call', null, 'Exported ' || coalesce(txt(p_what), 'data'));
end $$;

-- ======================================================================= read functions (RLS applies)
create function public.dashboard(p_month text default null, p_station text default null) returns jsonb
language plpgsql stable set search_path = public as $$
declare m text := case when p_month ~ '^\d{4}-\d{2}$' then p_month else to_char(ledger_today(), 'YYYY-MM') end;
  scope text := coalesce(app_station(), nullif(p_station, '')); res jsonb; watch_year int := left(m, 4)::int;
begin
  if not can('dashboard.view') then perform fail(403, 'You are not authorised to do this.'); end if;
  with c as (select * from call_overview where scope is null or station_code = scope),
  mo as (select * from c where to_char(arrival_date, 'YYYY-MM') = m),
  ex as (select cc.station_code, count(*) n from extensions e join calls cc on cc.id = e.call_id
         where e.status = 'APPROVED' and to_char(e.date_granted, 'YYYY-MM') = m and (scope is null or cc.station_code = scope) group by 1),
  ip as (select * from c where departure_date is null)
  select jsonb_build_object(
    'month', m, 'station', scope,
    'totals', (select jsonb_build_object('calls', count(*), 'departed', count(departure_date), 'in_port', count(*) - count(departure_date),
       'extensions', (select coalesce(sum(n), 0) from ex), 'crew', coalesce(sum(crew), 0), 'passengers', coalesce(sum(passengers), 0),
       'gross_tonnage', coalesce(sum(gross_tonnage), 0)) from mo),
    'by_station', (select coalesce(jsonb_agg(jsonb_build_object('code', s.code, 'name', s.name,
       'calls', (select count(*) from mo where station_code = s.code), 'departed', (select count(departure_date) from mo where station_code = s.code),
       'in_port', (select count(*) from mo where station_code = s.code and departure_date is null),
       'crew', (select coalesce(sum(crew), 0) from mo where station_code = s.code), 'passengers', (select coalesce(sum(passengers), 0) from mo where station_code = s.code),
       'gross_tonnage', (select coalesce(sum(gross_tonnage), 0) from mo where station_code = s.code),
       'extensions', coalesce((select n from ex where ex.station_code = s.code), 0)) order by s.sort), '[]')
       from stations s where scope is null or s.code = scope),
    'by_type', (select coalesce(jsonb_agg(jsonb_build_object('name', v.name, 'calls', (select count(*) from mo where vessel_type = v.name)) order by v.sort), '[]') from vessel_types v),
    'by_cargo', (select coalesce(jsonb_agg(jsonb_build_object('name', g.name, 'calls', (select count(*) from mo where cargo = g.name)) order by g.sort), '[]') from cargo_types g),
    'trend', (select jsonb_agg(jsonb_build_object('month', to_char(d, 'YYYY-MM'), 'calls', (select count(*) from c where to_char(arrival_date, 'YYYY-MM') = to_char(d, 'YYYY-MM'))) order by d)
       from generate_series((m || '-01')::date - interval '11 months', (m || '-01')::date, interval '1 month') d),
    'attention', jsonb_build_object(
       'in_port', (select count(*) from ip), 'overdue', (select count(*) from ip where overstay_status = 'OVERDUE'),
       'urgent', (select count(*) from ip where priority like 'URGENT%'), 'expiring_soon', (select count(*) from ip where overstay_status = 'EXPIRING SOON'),
       'long_stay', (select count(*) from ip where overstay_status = 'LONG STAY'),
       'pending_extensions', (select count(*) from extensions e join calls cc on cc.id = e.call_id where e.status = 'PENDING' and (scope is null or cc.station_code = scope)),
       'data_check', (select count(*) from c where data_check is not null and verified_at is null),
       'unverified_departed', (select count(*) from c where departure_date is not null and verified_at is null)),
    'watch_year', watch_year,
    'watch', (select coalesce(jsonb_agg(w), '[]') from (select id, rotation_no, vessel_name, station_name, arrival_date, days_in_port, extension_count,
       latest_expiry, overstay_status, priority from ip where rotation_year = watch_year order by days_in_port desc limit 50) w)
  ) into res;
  return res;
end $$;

-- History panel on the call page: audit entries for one call, its extensions and its case.
-- Anyone who can see the call sees its history (the full audit table stays restricted).
create function public.call_history(p_call bigint) returns table (ts timestamptz, action text, summary text, details jsonb, who text)
language plpgsql stable security definer set search_path = public as $$
declare scope text := app_station();
begin
  if not can('calls.read') or not exists (select 1 from calls where id = p_call and (scope is null or station_code = scope)) then
    perform fail(404, 'Vessel call not found.');
  end if;
  return query select a.ts, a.action, a.summary, a.details, p.initials from audit a left join profiles p on p.id = a.user_id
    where (a.entity = 'call' and a.entity_id = p_call)
       or (a.entity = 'extension' and a.entity_id in (select id from extensions where call_id = p_call))
       or (a.entity = 'case' and a.entity_id in (select id from cases where call_id = p_call))
    order by a.id desc;
end $$;

-- Distinct values used for autocomplete (ports, flags, agents).
create function public.lookup_values() returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'ports', (select coalesce(jsonb_agg(p order by p), '[]') from (select last_port p from calls union select next_port from calls) x where p is not null and p <> 'NA'),
    'flags', (select coalesce(jsonb_agg(distinct flag), '[]') from calls where flag is not null),
    'agents', (select coalesce(jsonb_agg(distinct agent), '[]') from calls where agent is not null))
$$;

create function public.search_vessels(q text) returns table (id bigint, imo text, name text, flag text, vessel_type text, gross_tonnage numeric,
  net_tonnage numeric, calls bigint, last_master text, last_agent text, last_crew int, last_cargo text)
language sql stable set search_path = public as $$
  select v.id, v.imo, v.name, v.flag, v.vessel_type, v.gross_tonnage, v.net_tonnage,
    (select count(*) from calls c where c.vessel_id = v.id), l.master, l.agent, l.crew, l.cargo
  from vessels v
  left join lateral (select master, agent, crew, cargo from calls c where c.vessel_id = v.id order by arrival_date desc limit 1) l on true
  where upper(v.name) like '%' || upper(q) || '%' or upper(v.imo) like '%' || upper(q) || '%'
  order by v.updated_at desc limit 10
$$;

-- ======================================================================= administration
create function public.admin_save_profile(p_id uuid, p jsonb) returns void language plpgsql security definer set search_path = public as $$
declare a profiles; t profiles;
begin
  a := need(null);
  if a.role <> 'admin' then perform fail(403, 'You are not authorised to do this.'); end if;
  select * into t from profiles where id = p_id;
  if t.id is null then perform fail(404, 'User not found.'); end if;
  if p ? 'role' and p->>'role' not in ('officer','supervisor','investigator','management','admin') then perform fail(400, 'Unknown role.', 'role'); end if;
  if t.id = a.id and ((p ? 'active' and not (p->>'active')::boolean) or (p ? 'role' and p->>'role' <> 'admin')) then
    perform fail(400, 'You cannot demote or deactivate your own account.');
  end if;
  update profiles set full_name = coalesce(txt(p->>'full_name'), full_name), initials = coalesce(up(p->>'initials'), initials),
    role = coalesce(nullif(p->>'role', ''), role), station_code = case when p ? 'station_code' then nullif(p->>'station_code', '') else station_code end,
    active = coalesce((p->>'active')::boolean, active)
  where id = t.id;
  perform log(a.id, 'update', 'user', null, format('User %s updated', coalesce(t.email, t.initials)), p);
end $$;

create function public.save_list(p_list text, p_items jsonb) returns void language plpgsql security definer set search_path = public as $$
declare a profiles; it jsonb; i int := 0;
begin
  a := need(null);
  if a.role <> 'admin' then perform fail(403, 'You are not authorised to do this.'); end if;
  for it in select * from jsonb_array_elements(p_items) loop
    if p_list = 'stations' then
      if coalesce(it->>'code', '') !~ '^[A-Z]{2,4}$' or txt(it->>'name') is null then perform fail(400, 'Station code must be 2-4 capital letters and name is required.'); end if;
      insert into stations(code, name, active, sort) values (it->>'code', txt(it->>'name'), coalesce((it->>'active')::boolean, true), i)
        on conflict (code) do update set name = excluded.name, active = excluded.active, sort = excluded.sort;
    elsif p_list = 'vessel_types' then
      if txt(it->>'name') is null or coalesce(it->>'rotation_class', '') !~ '^[A-Z]{3}$' then perform fail(400, 'Each vessel type needs a name and a 3-letter rotation class.'); end if;
      insert into vessel_types(name, rotation_class, manual_sequence, active, sort)
        values (txt(it->>'name'), it->>'rotation_class', coalesce((it->>'manual_sequence')::boolean, false), coalesce((it->>'active')::boolean, true), i)
        on conflict (name) do update set rotation_class = excluded.rotation_class, manual_sequence = excluded.manual_sequence, active = excluded.active, sort = excluded.sort;
    elsif p_list in ('cargo_types', 'extension_reasons') then
      if txt(it->>'name') is null then perform fail(400, 'Every item needs a name.'); end if;
      execute format('insert into %I(name, active, sort) values ($1, $2, $3) on conflict (name) do update set active = excluded.active, sort = excluded.sort', p_list)
        using txt(it->>'name'), coalesce((it->>'active')::boolean, true), i;
    else
      perform fail(404, 'Unknown list.');
    end if;
    i := i + 1;
  end loop;
  perform log(a.id, 'update', 'list', null, format('Reference list "%s" updated', p_list));
end $$;

create function public.save_settings(p jsonb) returns void language plpgsql security definer set search_path = public as $$
declare a profiles; k text;
begin
  a := need(null);
  if a.role <> 'admin' then perform fail(403, 'You are not authorised to do this.'); end if;
  foreach k in array array['expiring_soon_days', 'long_stay_days', 'urgent_extension_count'] loop
    if p ? k and coalesce(p->>k, '') !~ '^[1-9][0-9]*$' then perform fail(400, 'Use a whole number greater than 0.', k); end if;
  end loop;
  foreach k in array array['expiring_soon_days', 'long_stay_days', 'urgent_extension_count', 'office_footer', 'require_extension_approval'] loop
    if p ? k then insert into settings(key, value) values (k, p->>k) on conflict (key) do update set value = excluded.value; end if;
  end loop;
  perform log(a.id, 'update', 'settings', null, 'Settings updated', p);
end $$;

-- Import the JSON produced by tools/ledger_to_json.py. Existing rotation numbers are kept.
create function public.import_ledger(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare a profiles; r jsonb; e jsonb; c calls; m text[]; st text; vt text; cid bigint; approver uuid;
  existing uuid[] := array(select id from profiles); report jsonb := jsonb_build_object('calls', 0, 'extensions', 0,
  'skipped', '[]'::jsonb, 'officers_created', '[]'::jsonb);
begin
  a := need(null);
  if a.role <> 'admin' then perform fail(403, 'You are not authorised to do this.'); end if;
  for r in select * from jsonb_array_elements(coalesce(p->'calls', '[]')) loop
    m := regexp_match(coalesce(r->>'rotation_no', ''), '^(\d{4})/([A-Z]{3})/(\d+)$');
    if m is null then report := jsonb_set(report, '{skipped}', report->'skipped' || to_jsonb(format('Row %s: no rotation number', r->>'row'))); continue; end if;
    if exists (select 1 from calls where rotation_no = r->>'rotation_no') then
      report := jsonb_set(report, '{skipped}', report->'skipped' || to_jsonb(format('%s: already imported', r->>'rotation_no'))); continue;
    end if;
    select code into st from stations where name = r->>'station' or code = r->>'station';
    select name into vt from vessel_types where name = trim(r->>'vessel_type');
    if st is null or txt(r->>'arrival_date') is null then
      report := jsonb_set(report, '{skipped}', report->'skipped' || to_jsonb(format('%s: missing station or arrival date', r->>'rotation_no'))); continue;
    end if;
    c := call_from_json(null::calls, r - 'station' - 'boarding_officer' - 'clearance_officer');
    c.station_code := st; c.vessel_type := coalesce(vt, 'Other'); c.officer_report := '{}';
    if c.cargo is not null and not exists (select 1 from cargo_types where name = c.cargo) then c.cargo := 'Other'; end if;
    if c.next_port = 'NA' then c.next_port := null; end if;
    if c.voyage_no = 'NA' then c.voyage_no := null; end if;
    c.boarding_officer_id := import_officer(r->>'boarding_officer');
    c.clearance_officer_id := import_officer(r->>'clearance_officer');
    insert into calls(rotation_year, rotation_class, rotation_seq, rotation_no, vessel_id, vessel_type, station_code, voyage_no, vessel_name, imo, flag,
      agent, gross_tonnage, net_tonnage, crew, passengers, master, last_port, arrival_date, boarding_officer_id, next_port, departure_date,
      clearance_officer_id, cargo, remarks, created_by, updated_by)
    values (m[1]::int, m[2], m[3]::int, r->>'rotation_no', upsert_vessel(c), c.vessel_type, c.station_code, c.voyage_no, c.vessel_name, c.imo, c.flag,
      c.agent, c.gross_tonnage, c.net_tonnage, c.crew, c.passengers, c.master, c.last_port, c.arrival_date, c.boarding_officer_id, c.next_port,
      c.departure_date, c.clearance_officer_id, c.cargo, c.remarks, a.id, a.id) returning id into cid;
    perform log(a.id, 'import', 'call', cid, format('Imported %s from Excel ledger', r->>'rotation_no'));
    report := jsonb_set(report, '{calls}', to_jsonb((report->>'calls')::int + 1));
  end loop;
  for e in select * from jsonb_array_elements(coalesce(p->'extensions', '[]')) loop
    select id into cid from calls where rotation_no = e->>'rotation_no';
    if cid is null or txt(e->>'new_expiry') is null then
      report := jsonb_set(report, '{skipped}', report->'skipped' || to_jsonb(format('Extension for %s: no matching call or expiry', e->>'rotation_no'))); continue;
    end if;
    approver := coalesce(import_officer(e->>'approved_by'), a.id);
    insert into extensions(call_id, date_granted, original_expiry, new_expiry, reason, remarks, status, requested_by, decided_by, decided_at)
    values (cid, txt(e->>'date_granted')::date, coalesce(txt(e->>'original_expiry'), e->>'new_expiry')::date, (e->>'new_expiry')::date,
      coalesce(txt(e->>'reason'), 'Other'), txt(e->>'remarks'), 'APPROVED',
      approver, approver, now());
    report := jsonb_set(report, '{extensions}', to_jsonb((report->>'extensions')::int + 1));
  end loop;
  select jsonb_set(report, '{officers_created}', coalesce(jsonb_agg(initials), '[]')) into report
    from profiles where not (id = any(existing));
  return report;
end $$;

-- Find an officer by printed initials, or create an inactive placeholder so history keeps the name.
create function public.import_officer(ini text) returns uuid language plpgsql security definer set search_path = public as $$
declare pid uuid; v text := up(ini);
begin
  if v is null or v = 'NA' then return null; end if;
  select id into pid from profiles where initials = v order by active desc limit 1;
  if pid is null then
    insert into profiles(full_name, initials, role, active, must_change_password) values (v, v, 'officer', false, true) returning id into pid;
  end if;
  return pid;
end $$;

-- Run once from the SQL editor (or psql) after creating the first user in Authentication > Users.
create function public.bootstrap_admin(p_email text, p_full_name text default 'System Administrator', p_must_change boolean default true) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  select id into uid from auth.users where lower(email) = lower(p_email);
  if uid is null then raise exception 'No auth user with email %', p_email; end if;
  insert into profiles(id, email, full_name, initials, role, active, must_change_password)
    values (uid, lower(p_email), p_full_name, 'ADMIN', 'admin', true, p_must_change)
  on conflict (id) do update set role = 'admin', active = true;
end $$;

-- ======================================================================= row-level security
alter table public.settings enable row level security;
alter table public.stations enable row level security;
alter table public.vessel_types enable row level security;
alter table public.cargo_types enable row level security;
alter table public.extension_reasons enable row level security;
alter table public.profiles enable row level security;
alter table public.vessels enable row level security;
alter table public.calls enable row level security;
alter table public.extensions enable row level security;
alter table public.cases enable row level security;
alter table public.case_notes enable row level security;
alter table public.audit enable row level security;

create policy "signed-in users read settings" on public.settings for select to authenticated using (public.app_role() is not null);
create policy "signed-in users read stations" on public.stations for select to authenticated using (public.app_role() is not null);
create policy "signed-in users read vessel types" on public.vessel_types for select to authenticated using (public.app_role() is not null);
create policy "signed-in users read cargo types" on public.cargo_types for select to authenticated using (public.app_role() is not null);
create policy "signed-in users read reasons" on public.extension_reasons for select to authenticated using (public.app_role() is not null);
create policy "staff directory" on public.profiles for select to authenticated using (id = auth.uid() or public.app_role() is not null);
create policy "vessel registry" on public.vessels for select to authenticated using (public.can('calls.read'));
create policy "calls by role and station" on public.calls for select to authenticated
  using (public.can('calls.read') and (public.app_station() is null or station_code = public.app_station()));
create policy "extensions of visible calls" on public.extensions for select to authenticated
  using (exists (select 1 from public.calls c where c.id = call_id));
create policy "cases for overstay roles" on public.cases for select to authenticated
  using (public.can('overstay.view') and exists (select 1 from public.calls c where c.id = call_id));
create policy "case notes for overstay roles" on public.case_notes for select to authenticated
  using (exists (select 1 from public.cases k where k.id = case_id));
create policy "audit for management and admin" on public.audit for select to authenticated using (public.can('audit.view'));

-- ======================================================================= privileges
revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
grant usage on schema public to anon, authenticated;
grant select on all tables in schema public to authenticated;
grant execute on function
  public.ledger_today(), public.setting(text), public.me(), public.app_role(), public.app_station(), public.can(text), public.fail(int, text, text),
  public.up(text), public.txt(text), public.call_data_check(public.calls),
  public.create_call(jsonb), public.update_call(bigint, jsonb), public.verify_call(bigint, boolean, text), public.delete_call(bigint, text),
  public.add_extension(bigint, jsonb), public.decide_extension(bigint, text, text), public.save_case(bigint, jsonb),
  public.add_case_note(bigint, text, uuid), public.signed_in(), public.password_changed(), public.log_export(text), public.dashboard(text, text),
  public.lookup_values(), public.search_vessels(text), public.call_history(bigint), public.admin_save_profile(uuid, jsonb), public.save_list(text, jsonb),
  public.save_settings(jsonb), public.import_ledger(jsonb)
to authenticated;
-- bootstrap_admin, import_officer, allocate_rotation, upsert_vessel, log, need, validate_call and call_from_json
-- are internal: callable only by the database owner or from inside the functions above.
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
