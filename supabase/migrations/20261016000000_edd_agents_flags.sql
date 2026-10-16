-- Estimated date of departure (EDD), and standard lists of shipping agents and flags / nationalities.
--
--   * Every vessel call in port carries an EDD. Until an extension is approved, the EDD is the end of the
--     approved stay: after it the vessel is OVERDUE. An approved extension's new expiry replaces it.
--     Once saved, only a supervisor or administrator may move the EDD; officers request an extension.
--   * Shipping agents and flags become reference lists. Calls (and the vessel registry) must use a name
--     from the list. Renaming a list entry renames it on every call; renaming it to another entry's
--     name merges the two. Officers can add a new agent while recording a call; flags are admin-only.

-- ======================================================================= estimated departure
alter table public.calls add column estimated_departure date;

-- ======================================================================= reference lists
create table public.shipping_agents (name text primary key check (name = upper(trim(name)) and name <> ''),
  active boolean not null default true, sort int not null default 0);
create table public.flags (name text primary key check (name = upper(trim(name)) and name <> ''),
  active boolean not null default true, sort int not null default 0);

insert into public.flags(name) select unnest(array[
  'AFGHANISTAN','ALBANIA','ALGERIA','ANDORRA','ANGOLA','ANGUILLA','ANTIGUA & BARBUDA','ARGENTINA','ARMENIA','ARUBA','AUSTRALIA','AUSTRIA',
  'AZERBAIJAN','BAHAMAS','BAHRAIN','BANGLADESH','BARBADOS','BELARUS','BELGIUM','BELIZE','BENIN','BERMUDA','BHUTAN','BOLIVIA',
  'BOSNIA & HERZEGOVINA','BOTSWANA','BRAZIL','BRITISH VIRGIN ISLANDS','BRUNEI','BULGARIA','BURKINA FASO','BURUNDI','CABO VERDE','CAMBODIA',
  'CAMEROON','CANADA','CAYMAN ISLANDS','CENTRAL AFRICAN REPUBLIC','CHAD','CHILE','CHINA','COLOMBIA','COMOROS','CONGO','COOK ISLANDS',
  'COSTA RICA','COTE D''IVOIRE','CROATIA','CUBA','CURACAO','CYPRUS','CZECHIA','DEMOCRATIC REPUBLIC OF THE CONGO','DENMARK','DJIBOUTI',
  'DOMINICA','DOMINICAN REPUBLIC','ECUADOR','EGYPT','EL SALVADOR','EQUATORIAL GUINEA','ERITREA','ESTONIA','ESWATINI','ETHIOPIA',
  'FAROE ISLANDS','FIJI','FINLAND','FRANCE','GABON','GAMBIA','GEORGIA','GERMANY','GHANA','GIBRALTAR','GREECE','GRENADA','GUATEMALA',
  'GUINEA','GUINEA-BISSAU','GUYANA','HAITI','HONDURAS','HONG KONG','HUNGARY','ICELAND','INDIA','INDONESIA','IRAN','IRAQ','IRELAND',
  'ISLE OF MAN','ISRAEL','ITALY','JAMAICA','JAPAN','JORDAN','KAZAKHSTAN','KENYA','KIRIBATI','KUWAIT','KYRGYZSTAN','LAOS','LATVIA',
  'LEBANON','LESOTHO','LIBERIA','LIBYA','LIECHTENSTEIN','LITHUANIA','LUXEMBOURG','MACAO','MADAGASCAR','MALAWI','MALAYSIA','MALDIVES',
  'MALI','MALTA','MARSHALL ISLANDS','MAURITANIA','MAURITIUS','MEXICO','MICRONESIA','MOLDOVA','MONACO','MONGOLIA','MONTENEGRO',
  'MONTSERRAT','MOROCCO','MOZAMBIQUE','MYANMAR','NAMIBIA','NAURU','NEPAL','NETHERLANDS','NEW ZEALAND','NICARAGUA','NIGER','NIGERIA',
  'NIUE','NORTH KOREA','NORTH MACEDONIA','NORWAY','OMAN','PAKISTAN','PALAU','PALESTINE','PANAMA','PAPUA NEW GUINEA','PARAGUAY','PERU',
  'PHILIPPINES','POLAND','PORTUGAL','PUERTO RICO','QATAR','ROMANIA','RUSSIA','RWANDA','SAINT KITTS & NEVIS','SAINT LUCIA',
  'SAINT VINCENT & THE GRENADINES','SAMOA','SAN MARINO','SAO TOME & PRINCIPE','SAUDI ARABIA','SENEGAL','SERBIA','SEYCHELLES',
  'SIERRA LEONE','SINGAPORE','SINT MAARTEN','SLOVAKIA','SLOVENIA','SOLOMON ISLANDS','SOMALIA','SOUTH AFRICA','SOUTH KOREA','SOUTH SUDAN',
  'SPAIN','SRI LANKA','SUDAN','SURINAME','SWEDEN','SWITZERLAND','SYRIA','TAIWAN','TAJIKISTAN','TANZANIA','THAILAND','TIMOR-LESTE','TOGO',
  'TONGA','TRINIDAD & TOBAGO','TUNISIA','TURKEY','TURKMENISTAN','TURKS & CAICOS ISLANDS','TUVALU','UGANDA','UKRAINE',
  'UNITED ARAB EMIRATES','UNITED KINGDOM','UNITED STATES OF AMERICA','URUGUAY','US VIRGIN ISLANDS','UZBEKISTAN','VANUATU','VATICAN CITY',
  'VENEZUELA','VIETNAM','YEMEN','ZAMBIA','ZIMBABWE']);
-- Keep every value already on file, so nothing is lost; administrators can then merge variants (e.g. "USA").
insert into public.flags(name) select distinct upper(trim(flag)) from public.calls where nullif(trim(flag), '') is not null on conflict do nothing;
insert into public.flags(name) select distinct upper(trim(flag)) from public.vessels where nullif(trim(flag), '') is not null on conflict do nothing;
insert into public.shipping_agents(name) select distinct upper(trim(agent)) from public.calls where nullif(trim(agent), '') is not null on conflict do nothing;

update public.calls set flag = nullif(upper(trim(flag)), ''), agent = nullif(upper(trim(agent)), '');
update public.vessels set flag = nullif(upper(trim(flag)), '');
alter table public.calls add constraint calls_flag_fkey foreign key (flag) references public.flags(name) on update cascade;
alter table public.calls add constraint calls_agent_fkey foreign key (agent) references public.shipping_agents(name) on update cascade;
alter table public.vessels add constraint vessels_flag_fkey foreign key (flag) references public.flags(name) on update cascade;

-- Two spellings of the same agent ("Marine Supply Co." / "MARINE SUPPLY CO") count as the same name.
create function public.agent_key(v text) returns text language sql immutable as $$
  select regexp_replace(regexp_replace(replace(upper(coalesce(v, '')), '&', ' AND '), '[^A-Z0-9 ]', '', 'g'), '\s+', ' ', 'g')
$$;

-- An officer recording a call can add an agent that is not on the list yet. Returns the name to use:
-- the existing entry when the same agent is already listed under a slightly different spelling.
create function public.add_agent(p_name text) returns text language plpgsql security definer set search_path = public as $$
declare u profiles; v text := upper(regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g')); found text;
begin
  u := need('calls.create');
  if v = '' then perform fail(400, 'Enter the shipping agent''s name.', 'name'); end if;
  if length(v) > 120 then perform fail(400, 'That name is too long.', 'name'); end if;
  select name into found from shipping_agents where agent_key(name) = agent_key(v) order by active desc, name limit 1;
  if found is not null then
    update shipping_agents set active = true where name = found and not active;
    return found;
  end if;
  insert into shipping_agents(name) values (v);
  perform log(u.id, 'create', 'list', null, format('Shipping agent "%s" added', v));
  return v;
end $$;

-- ======================================================================= call rules
create or replace function public.call_from_json(base public.calls, p jsonb) returns public.calls language plpgsql stable as $$
declare clean jsonb := '{}'; k text; r public.calls; rep jsonb;
  allowed text[] := array['vessel_type','station_code','voyage_no','vessel_name','imo','flag','agent','gross_tonnage','net_tonnage',
    'crew','passengers','master','last_port','arrival_date','estimated_departure','boarding_officer_id','next_port','departure_date',
    'clearance_officer_id','cargo','remarks'];
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

create or replace function public.validate_call(c public.calls) returns void language plpgsql stable set search_path = public as $$
begin
  if c.vessel_type is null or not exists (select 1 from vessel_types where name = c.vessel_type) then perform fail(400, 'Select the vessel type.', 'vessel_type'); end if;
  if c.station_code is null or not exists (select 1 from stations where code = c.station_code) then perform fail(400, 'Select the Customs station.', 'station_code'); end if;
  if txt(c.vessel_name) is null then perform fail(400, 'Enter the vessel name.', 'vessel_name'); end if;
  if c.arrival_date is null then perform fail(400, 'Enter a valid arrival date.', 'arrival_date'); end if;
  if c.arrival_date > ledger_today() then perform fail(400, 'Arrival date cannot be in the future.', 'arrival_date'); end if;
  if c.departure_date is null and c.estimated_departure is null then perform fail(400, 'Enter the estimated date of departure.', 'estimated_departure'); end if;
  if c.estimated_departure < c.arrival_date then perform fail(400, 'Estimated departure cannot be before the arrival date.', 'estimated_departure'); end if;
  if c.departure_date < c.arrival_date then perform fail(400, 'Departure date cannot be before the arrival date.', 'departure_date'); end if;
  if c.departure_date is not null and c.clearance_officer_id is null then perform fail(400, 'Add the clearance officer for a departed vessel.', 'clearance_officer_id'); end if;
  if c.flag is not null and not exists (select 1 from flags where name = c.flag) then perform fail(400, 'Choose the flag / nationality from the list.', 'flag'); end if;
  if c.agent is not null and not exists (select 1 from shipping_agents where name = c.agent) then perform fail(400, 'Choose the shipping agent from the list, or add it as a new agent.', 'agent'); end if;
  if c.cargo is not null and not exists (select 1 from cargo_types where name = c.cargo) then perform fail(400, 'Unknown cargo / operation.', 'cargo'); end if;
  if c.boarding_officer_id is not null and not exists (select 1 from profiles where id = c.boarding_officer_id) then perform fail(400, 'Unknown officer.', 'boarding_officer_id'); end if;
  if c.clearance_officer_id is not null and not exists (select 1 from profiles where id = c.clearance_officer_id) then perform fail(400, 'Unknown officer.', 'clearance_officer_id'); end if;
end $$;

create or replace function public.create_call(p jsonb) returns bigint language plpgsql security definer set search_path = public as $$
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
    vessel_name, imo, flag, agent, gross_tonnage, net_tonnage, crew, passengers, master, last_port, arrival_date, estimated_departure,
    boarding_officer_id, next_port, departure_date, clearance_officer_id, cargo, remarks, officer_report, created_by, updated_by)
  values (txt(p->>'client_uuid')::uuid, rot.rotation_year, rot.rotation_class, rot.rotation_seq, rot.rotation_no, upsert_vessel(c), c.vessel_type,
    c.station_code, c.voyage_no, c.vessel_name, c.imo, c.flag, c.agent, c.gross_tonnage, c.net_tonnage, c.crew, c.passengers, c.master,
    c.last_port, c.arrival_date, c.estimated_departure, c.boarding_officer_id, c.next_port, c.departure_date, c.clearance_officer_id, c.cargo,
    c.remarks, c.officer_report, u.id, u.id)
  returning id into new_id;
  perform log(u.id, 'create', 'call', new_id, format('Recorded %s %s at %s', rot.rotation_no, c.vessel_name, c.station_code));
  return new_id;
end $$;

create or replace function public.update_call(p_id bigint, p jsonb) returns bigint language plpgsql security definer set search_path = public as $$
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
  -- The EDD sets the approved stay, so moving it is a supervisor's decision; officers request an extension.
  if cur.estimated_departure is not null and nxt.estimated_departure is distinct from cur.estimated_departure and not can('ext.approve') then
    perform fail(403, 'Only a supervisor can change the estimated departure date. Request an extension instead.', 'estimated_departure');
  end if;
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
             'last_port','arrival_date','estimated_departure','boarding_officer_id','next_port','departure_date','clearance_officer_id','cargo',
             'remarks','officer_report')
       and to_jsonb(cur)->k is distinct from to_jsonb(nxt)->k then
      changes := changes || jsonb_build_object(k, jsonb_build_array(to_jsonb(cur)->k, to_jsonb(nxt)->k));
    end if;
  end loop;
  if changes = '{}' then return cur.id; end if;

  update calls set rotation_year = nxt.rotation_year, rotation_class = nxt.rotation_class, rotation_seq = nxt.rotation_seq, rotation_no = nxt.rotation_no,
    vessel_id = coalesce(upsert_vessel(nxt), cur.vessel_id), vessel_type = nxt.vessel_type, station_code = nxt.station_code, voyage_no = nxt.voyage_no,
    vessel_name = nxt.vessel_name, imo = nxt.imo, flag = nxt.flag, agent = nxt.agent, gross_tonnage = nxt.gross_tonnage, net_tonnage = nxt.net_tonnage,
    crew = nxt.crew, passengers = nxt.passengers, master = nxt.master, last_port = nxt.last_port, arrival_date = nxt.arrival_date,
    estimated_departure = nxt.estimated_departure, boarding_officer_id = nxt.boarding_officer_id, next_port = nxt.next_port,
    departure_date = nxt.departure_date, clearance_officer_id = nxt.clearance_officer_id, cargo = nxt.cargo, remarks = nxt.remarks,
    officer_report = nxt.officer_report, version = cur.version + 1, updated_by = u.id, updated_at = now()
  where id = cur.id;
  what := case when changes ? 'departure_date' and cur.departure_date is null then format('Departure recorded %s', nxt.departure_date)
               else 'Updated ' || (select string_agg(x, ', ') from jsonb_object_keys(changes) x) end;
  perform log(u.id, 'update', 'call', cur.id, format('%s: %s', nxt.rotation_no, what), changes);
  return cur.id;
end $$;

-- ======================================================================= overstay status
-- The approved stay ends at the latest approved extension's new expiry or, with no extension, at the EDD.
-- latest_expiry keeps its name (the app and exports use it) but now means "approved stay until".
-- Calls recorded before EDDs existed, with no extension, keep the old long-stay rule.
drop view public.call_overview;
create view public.call_overview with (security_invoker = true) as
select c.*, s.name as station_name, bo.initials as boarding_officer, co.initials as clearance_officer, vu.initials as verified_by_name,
  x.extension_count, coalesce(x.ext_expiry, c.estimated_departure) as latest_expiry,
  case when x.ext_expiry is not null then 'EXTENSION' when c.estimated_departure is not null then 'EDD' end as stay_basis,
  x.pending_extensions, k.status as case_status,
  case when c.departure_date is null then 'IN PORT' else 'DEPARTED' end as status,
  (coalesce(c.departure_date, t.today) - c.arrival_date) as days_in_port,
  o.overstay_status,
  case when o.overstay_status = 'OVERDUE' then t.today - coalesce(x.ext_expiry, c.estimated_departure) end as days_overdue,
  case when c.departure_date is null then coalesce(x.ext_expiry, c.estimated_departure) - t.today end as days_to_expiry,
  case when o.overstay_status = 'OVERDUE' then
         case when x.extension_count >= t.urgent then format('URGENT - %s+ EXTENSIONS', t.urgent) else 'OVERDUE - FOLLOW UP' end
       when o.overstay_status = 'LONG STAY' then 'REVIEW - NO EDD OR EXTENSION ON FILE' end as priority,
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
  (select e2.new_expiry from public.extensions e2 where e2.call_id = c.id and e2.status = 'APPROVED' order by e2.id desc limit 1) as ext_expiry,
  count(*) filter (where e.status = 'PENDING')::int as pending_extensions
  from public.extensions e where e.call_id = c.id) x
cross join lateral (select coalesce(x.ext_expiry, c.estimated_departure) as until) a
cross join lateral (select case
  when c.departure_date is not null then 'DEPARTED'
  when a.until is null then case when t.today - c.arrival_date > t.long_stay then 'LONG STAY' else 'NO EXTENSION' end
  when a.until < t.today then 'OVERDUE'
  when a.until - t.today <= t.soon then 'EXPIRING SOON'
  when x.extension_count > 0 then 'WITHIN EXTENSION'
  else 'WITHIN STAY' end as overstay_status) o;
grant select on public.call_overview to authenticated;

-- ======================================================================= lists, autocomplete and import
create or replace function public.lookup_values() returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'ports', (select coalesce(jsonb_agg(p order by p), '[]') from (select last_port p from calls union select next_port from calls) x where p is not null and p <> 'NA'))
$$;

create or replace function public.save_list(p_list text, p_items jsonb) returns void language plpgsql security definer set search_path = public as $$
declare a profiles; it jsonb; i int := 0; nm text; old text; n int;
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
    elsif p_list in ('shipping_agents', 'flags') then
      -- Alphabetical lists. "old" is the name before editing: a new name renames the entry on every call,
      -- and a name that already exists merges the two entries.
      nm := upper(regexp_replace(trim(coalesce(it->>'name', '')), '\s+', ' ', 'g')); old := up(it->>'old');
      if nm = '' then perform fail(400, 'Every item needs a name.'); end if;
      if old is null or old = nm then
        execute format('insert into %I(name, active) values ($1, $2) on conflict (name) do update set active = excluded.active', p_list)
          using nm, coalesce((it->>'active')::boolean, true);
      else
        execute format('select count(*) from %I where name = $1', p_list) into n using old;
        if n = 0 then perform fail(404, format('"%s" is no longer on the list. Reload the page.', old)); end if;
        execute format('select count(*) from %I where name = $1', p_list) into n using nm;
        if n = 0 then
          execute format('update %I set name = $1, active = $2 where name = $3', p_list) using nm, coalesce((it->>'active')::boolean, true), old;
          perform log(a.id, 'update', 'list', null, format('%s: "%s" renamed to "%s"', p_list, old, nm));
        else
          if p_list = 'flags' then
            update calls set flag = nm where flag = old; update vessels set flag = nm where flag = old;
          else
            update calls set agent = nm where agent = old;
          end if;
          execute format('delete from %I where name = $1', p_list) using old;
          perform log(a.id, 'update', 'list', null, format('%s: "%s" merged into "%s"', p_list, old, nm));
        end if;
      end if;
    else
      perform fail(404, 'Unknown list.');
    end if;
    i := i + 1;
  end loop;
  perform log(a.id, 'update', 'list', null, format('Reference list "%s" updated', p_list));
end $$;

create or replace function public.import_ledger(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
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
    if c.flag = 'NA' then c.flag := null; end if;
    if c.agent = 'NA' then c.agent := null; end if;
    -- Spellings from the workbook join the lists as they are; administrators merge variants afterwards.
    if c.flag is not null then insert into flags(name) values (c.flag) on conflict do nothing; end if;
    if c.agent is not null then insert into shipping_agents(name) values (c.agent) on conflict do nothing; end if;
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

-- ======================================================================= security
alter table public.shipping_agents enable row level security;
alter table public.flags enable row level security;
create policy "signed-in users read shipping agents" on public.shipping_agents for select to authenticated using (public.app_role() is not null);
create policy "signed-in users read flags" on public.flags for select to authenticated using (public.app_role() is not null);
revoke all on public.shipping_agents, public.flags from anon, authenticated;
grant select on public.shipping_agents, public.flags to authenticated;
revoke all on function public.agent_key(text), public.add_agent(text) from public, anon, authenticated;
grant execute on function public.add_agent(text) to authenticated;
