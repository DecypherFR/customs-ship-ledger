// Data-entry forms and dialogs.
import { api } from './api.js';
import { html, raw, icon, $, $$, fmtDate, toast, openDialog, options, formData, showFormError } from './ui.js';
import { S, can, go, paintConn, refreshBadges } from './app.js';

const today = () => S.lookups.today;
const officers = () => S.lookups.officers.filter((o) => o.active);

// ============================================================ VESSEL CALL FORM
export async function callForm(main, { id }) {
  const editing = !!id;
  const c = editing ? await api.get(`/api/calls/${id}`) : {
    arrival_date: today(), boarding_officer_id: S.me.user.id, station_code: S.me.user.station_code || '', passengers: 0,
  };
  if (editing && c.verified_at && S.me.user.role !== 'admin') { go(`#/calls/${id}`); toast('This call is verified and locked.', 'error'); return; }
  const lk = S.lookups;
  const stationLocked = ['officer', 'supervisor'].includes(S.me.user.role) && S.me.user.station_code;
  const isAdmin = S.me.user.role === 'admin';
  const rotLocked = editing && !isAdmin;
  // Once saved, the EDD sets the approved stay: only supervisors and administrators may move it.
  const eddLocked = editing && c.estimated_departure && !can('ext.approve');
  const dl = (idName, items) => html`<datalist id="${idName}">${items.map((x) => html`<option value="${x}"></option>`)}</datalist>`;

  main.innerHTML = String(html`
  <nav class="crumbs"><a href="#/calls">Vessel calls</a> / ${editing ? html`<a href="#/calls/${c.id}" class="mono">${c.rotation_no}</a> / Edit` : 'New'}</nav>
  <div class="page-head"><div><h1>${editing ? `Edit ${c.vessel_name}` : 'New vessel call'}</h1>
    <p class="muted">One record per vessel call at one Customs station. Fields marked <span class="req">*</span> are needed to save; the rest are needed to pass the data check.</p></div></div>
  <form id="cf" class="form" novalidate autocomplete="off">
    <section class="card form-sec"><h2><span class="step">1</span> Vessel</h2>
      ${!editing ? html`<div class="lookup"><label>Find a vessel that has called before<span class="f-search">${icon('search')}<input id="vsearch" type="search" placeholder="Type vessel name or IMO number" aria-describedby="vhelp" aria-controls="vresults"></span></label>
        <small id="vhelp" class="help">Selecting a vessel fills in its particulars from its last call.</small><ul id="vresults" class="vresults" role="listbox" hidden></ul></div>` : ''}
      <div class="fgrid">
        <label class="span2">Vessel type <span class="req">*</span><select name="vessel_type" required ${rotLocked ? raw('disabled') : ''}>${options(lk.vessel_types.map((v) => v.name), c.vessel_type, { blank: 'Select vessel type…' })}</select></label>
        <label id="seqwrap" hidden>Rotation sequence No. <span class="req">*</span><input name="rotation_seq" inputmode="numeric" pattern="[0-9]*" value="${c.rotation_seq || ''}" ${rotLocked ? raw('disabled') : ''}><small class="help">Number supplied for this CRG call</small></label>
        <div class="rot-preview" aria-live="polite"><span>Rotation No.</span><b class="mono" id="rotprev">-</b></div>
        <label class="span2">Vessel name <span class="req">*</span><input name="vessel_name" required value="${c.vessel_name || ''}" class="caps"></label>
        <label>IMO / Registration No.<input name="imo" value="${c.imo || ''}" class="caps mono"></label>
        <label>Flag / Nationality<select name="flag">${listOptions(lk.flags, c.flag, 'Select flag…')}</select></label>
        <label>Gross tonnage<input name="gross_tonnage" type="number" min="0" step="any" inputmode="decimal" value="${c.gross_tonnage ?? ''}"></label>
        <label>Net tonnage<input name="net_tonnage" type="number" min="0" step="any" inputmode="decimal" value="${c.net_tonnage ?? ''}"></label>
      </div></section>

    <section class="card form-sec"><h2><span class="step">2</span> Arrival &amp; boarding</h2>
      <div class="fgrid">
        <label>Customs station <span class="req">*</span><select name="station_code" required ${stationLocked ? raw('disabled') : ''}>${options(lk.stations, c.station_code, { blank: 'Select station…', value: (s) => s.code, label: (s) => s.name })}</select></label>
        <label>Arrival / boarding date <span class="req">*</span><input name="arrival_date" type="date" required max="${today()}" value="${c.arrival_date || ''}"></label>
        <label>Estimated departure (EDD) <span class="req" id="eddreq">*</span><input name="estimated_departure" type="date" min="${c.arrival_date || ''}" value="${c.estimated_departure || ''}" ${eddLocked ? raw('disabled') : ''} aria-describedby="eddhelp">
          <small class="help" id="eddhelp">${eddLocked ? 'Only a supervisor can change it. Request an extension instead.' : 'The approved stay ends on this date unless an extension is granted.'}</small></label>
        <label>Boarding officer<select name="boarding_officer_id">${options(officers(), c.boarding_officer_id, { blank: 'Select officer…', value: (o) => o.id, label: (o) => o.initials })}</select></label>
        <label>Voyage number<input name="voyage_no" value="${c.voyage_no || ''}" class="caps"></label>
        <label>Last port<input name="last_port" list="dl-ports" value="${c.last_port || ''}" class="caps" placeholder="e.g. KINGSTON, JAMAICA"></label>
        <label>Next port<input name="next_port" list="dl-ports" value="${c.next_port || ''}" class="caps"></label>
        <label>Master<input name="master" value="${c.master || ''}" class="caps"></label>
        <label>Shipping agent<select name="agent">${listOptions(lk.shipping_agents, c.agent, 'Select agent…')}<option value="${NEW}">+ Add a new agent…</option></select></label>
        <label>Crew<input name="crew" type="number" min="0" step="1" inputmode="numeric" value="${c.crew ?? ''}"></label>
        <label>Passengers<input name="passengers" type="number" min="0" step="1" inputmode="numeric" value="${c.passengers ?? ''}"></label>
        <label class="span2">Cargo / operation<select name="cargo">${options(lk.cargo_types.map((x) => x.name), c.cargo, { blank: 'Select cargo / operation…' })}</select></label>
      </div></section>

    ${can('calls.depart') ? html`<section class="card form-sec"><h2><span class="step">3</span> Departure / clearance <small>leave blank while the vessel is in port</small></h2>
      <div class="fgrid">
        <label>Departure date<input name="departure_date" type="date" min="${c.arrival_date || ''}" max="${today()}" value="${c.departure_date || ''}"></label>
        <label>Clearance officer<select name="clearance_officer_id">${options(officers(), c.clearance_officer_id, { blank: 'Select officer…', value: (o) => o.id, label: (o) => o.initials })}</select></label>
      </div></section>` : ''}

    <section class="card form-sec"><h2><span class="step">${can('calls.depart') ? 4 : 3}</span> Remarks</h2>
      <label class="span-all"><span class="sr">Remarks</span><textarea name="remarks" rows="3">${c.remarks || ''}</textarea></label></section>

    <div class="form-foot">
      <div id="dcheck" class="dcheck" aria-live="polite"></div>
      <p class="form-error" role="alert" hidden></p>
      <div class="actions"><a class="btn" href="${editing ? `#/calls/${c.id}` : '#/calls'}">Cancel</a>
        <button class="btn btn-primary" type="submit">${icon('check')} ${editing ? 'Save changes' : 'Record vessel call'}</button></div>
    </div>
  </form>
  ${dl('dl-ports', lk.ports)}`);

  const f = $('#cf', main);
  const typeInfo = () => lk.vessel_types.find((v) => v.name === f.vessel_type.value);
  function refresh() {
    const t = typeInfo();
    const manual = t && t.manual_sequence;
    $('#seqwrap', f).hidden = !manual;
    f.rotation_seq.required = !!manual;
    const year = (f.arrival_date.value || today()).slice(0, 4);
    $('#rotprev', f).textContent = editing && rotLocked ? c.rotation_no
      : !t ? '-' : manual ? `${year}/${t.rotation_class}/${f.rotation_seq.value || '?'}` : editing && t.rotation_class === c.rotation_class && year === String(c.rotation_year) ? c.rotation_no : `${year}/${t.rotation_class}/next`;
    if (f.departure_date) f.departure_date.min = f.arrival_date.value;
    f.estimated_departure.min = f.arrival_date.value;
    // A vessel recorded after it has already left needs no EDD.
    const needEdd = !(f.departure_date && f.departure_date.value);
    f.estimated_departure.required = needEdd; $('#eddreq', f).hidden = !needEdd;
    // Live data check, same rule as the workbook's "Data Check" column
    const d = formData(f);
    const missing = [['flag', 'Flag'], ['crew', 'Crew'], ['master', 'Master'], ['last_port', 'Last port'], ['boarding_officer_id', 'Boarding officer'], ['next_port', 'Next port'], ['cargo', 'Cargo'], ['agent', 'Shipping agent']].filter(([k]) => !String(d[k] ?? '').trim()).map(([, l]) => l);
    const issues = [];
    if (missing.length) issues.push(`Still to complete: ${missing.join(', ')}`);
    if (d.departure_date && !d.clearance_officer_id) issues.push('A departed vessel needs a clearance officer');
    if (d.departure_date && d.arrival_date && d.departure_date < d.arrival_date) issues.push('Departure is before arrival');
    if (d.estimated_departure && d.arrival_date && d.estimated_departure < d.arrival_date) issues.push('Estimated departure is before arrival');
    if (Number(d.net_tonnage) > Number(d.gross_tonnage) && d.gross_tonnage) issues.push('Net tonnage is greater than gross tonnage');
    $('#dcheck', f).innerHTML = String(issues.length ? html`<span class="dc-warn">${icon('alert')} Data check: ${issues.join(' · ')}</span>` : html`<span class="dc-ok">${icon('check')} Data check OK</span>`);
  }
  f.addEventListener('input', refresh); f.addEventListener('change', refresh); refresh();
  let lastAgent = f.agent.value;
  f.agent.addEventListener('change', () => {
    if (f.agent.value !== NEW) { lastAgent = f.agent.value; return; }
    f.agent.value = lastAgent;
    newAgentDialog((name) => { setOption(f.agent, name, NEW); lastAgent = name; refresh(); });
  });

  // Vessel registry lookup
  const vs = $('#vsearch', f); const vr = $('#vresults', f);
  if (vs) {
    let timer; let found = [];
    vs.addEventListener('input', () => {
      clearTimeout(timer);
      if (vs.value.trim().length < 2) { vr.hidden = true; return; }
      timer = setTimeout(async () => {
        try { found = await api.get(`/api/vessels?q=${encodeURIComponent(vs.value.trim())}`); } catch { found = []; }
        vr.innerHTML = String(found.length ? html`${found.map((v, i) => html`<li role="option" tabindex="-1" data-i="${i}"><b>${v.name}</b> <span class="mono">${v.imo || ''}</span><small>${v.flag || ''} · ${v.vessel_type || ''} · ${v.calls} previous call${v.calls === 1 ? '' : 's'}</small></li>`)}`
          : html`<li class="muted">No previous calls found. Enter the particulars below.</li>`);
        vr.hidden = false;
      }, 250);
    });
    const pick = (li) => {
      const v = found[Number(li.dataset.i)]; if (!v) return;
      const set = (n, val) => { if (val != null && val !== '' && f[n]) { if (f[n].tagName === 'SELECT') setOption(f[n], val, NEW); else f[n].value = val; } };
      set('vessel_type', v.vessel_type); set('vessel_name', v.name); set('imo', v.imo); set('flag', v.flag);
      set('gross_tonnage', v.gross_tonnage); set('net_tonnage', v.net_tonnage); set('master', v.last_master); set('agent', v.last_agent); set('crew', v.last_crew); set('cargo', v.last_cargo);
      vr.hidden = true; vs.value = ''; refresh(); toast(`Filled in from ${v.name}'s last call. Check that the master and crew are still correct.`);
      f.voyage_no.focus();
    };
    vr.addEventListener('click', (e) => { const li = e.target.closest('li[data-i]'); if (li) pick(li); });
    vs.addEventListener('keydown', (e) => {
      const lis = $$('li[data-i]', vr); if (!lis.length) return;
      const cur = lis.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); lis[Math.min(cur + 1, lis.length - 1)].focus(); }
    });
    vr.addEventListener('keydown', (e) => {
      const lis = $$('li[data-i]', vr); const cur = lis.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); lis[Math.min(cur + 1, lis.length - 1)].focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); (cur <= 0 ? vs : lis[cur - 1]).focus(); }
      if (e.key === 'Enter') { e.preventDefault(); pick(document.activeElement); }
      if (e.key === 'Escape') { vr.hidden = true; vs.focus(); }
    });
  }

  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = f.querySelector('[type=submit]'); btn.disabled = true;
    const body = formData(f);
    if (stationLocked) body.station_code = S.me.user.station_code;
    try {
      if (editing) {
        body.version = c.version;
        const res = await api.send('PUT', `/api/calls/${c.id}`, body, { queueable: true, label: `Edit ${c.rotation_no} ${c.vessel_name}` });
        if (res.queued) { toast('Offline: changes saved on this device and will sync later.', 'warn'); paintConn(); go(`#/calls/${c.id}`); return; }
        toast('Changes saved.', 'success'); refreshBadges(); go(`#/calls/${c.id}`);
      } else {
        const res = await api.send('POST', '/api/calls', body, { queueable: true, label: `New call: ${String(body.vessel_name).toUpperCase()} (${body.arrival_date})` });
        if (res.queued) { toast('Offline: the call is saved on this device and will get its Rotation No. when it syncs.', 'warn'); paintConn(); go('#/calls'); return; }
        toast(`Recorded as ${res.rotation_no}.`, 'success'); refreshBadges(); go(`#/calls/${res.id}`);
      }
    } catch (err) {
      if (err.status === 409 && err.data.current) {
        showFormError(f, new Error(`${err.message}`));
        const box = f.querySelector('.form-error'); box.append(' '); const a = document.createElement('a'); a.href = `#/calls/${c.id}`; a.textContent = 'Open the latest version'; box.append(a);
      } else showFormError(f, err);
    } finally { btn.disabled = false; }
  });
}

// Flags and agents come from admin-managed lists. A value that has since been deactivated stays selectable
// on the record that already uses it.
const NEW = '__new';
const listOptions = (items, cur, blank) => {
  const names = items.filter((x) => x.active || x.name === cur).map((x) => x.name);
  if (cur && !names.includes(cur)) names.push(cur);
  return options(names, cur, { blank });
};
function setOption(sel, value, before) {
  if (![...sel.options].some((o) => o.value === value)) {
    const o = new Option(value, value); const ref = before && [...sel.options].find((x) => x.value === before);
    sel.insertBefore(o, ref || null);
  }
  sel.value = value;
}
function newAgentDialog(done) {
  openDialog('Add a shipping agent', html`
    <label>Agent's name<input name="name" required class="caps" autocomplete="off" placeholder="e.g. CARIBBEAN SHIPPING AGENCY"></label>
    <p class="help">Check the list first: if the agent is already there under a slightly different spelling, that entry is used instead.
      Administrators can correct or merge names under Lists &amp; settings.</p>`, {
    submitLabel: 'Add agent',
    onSubmit: async (f) => {
      const name = await api.send('POST', '/api/agents', { name: f.name.value });
      S.lookups = await api.get('/api/lookups');
      toast(name === f.name.value.trim().toUpperCase().replace(/\s+/g, ' ') ? `${name} added to the list.` : `Already on the list as ${name}.`, 'success');
      done(name); return true;
    },
  });
}

// ============================================================ DIALOGS
export function departureDialog(c, done) {
  openDialog(`Record departure: ${c.vessel_name}`, html`
    <p class="muted">${c.rotation_no} · arrived ${fmtDate(c.arrival_date)} · ${c.station_name}</p>
    <div class="fgrid">
      <label>Departure date<input name="departure_date" type="date" required min="${c.arrival_date}" max="${today()}" value="${today()}"></label>
      <label>Clearance officer<select name="clearance_officer_id" required>${options(officers(), S.me.user.id, { blank: 'Select officer…', value: (o) => o.id, label: (o) => o.initials })}</select></label>
      <label class="span2">Next port<input name="next_port" value="${c.next_port || ''}" class="caps" list="dl-ports2"></label>
    </div><datalist id="dl-ports2">${S.lookups.ports.map((p) => html`<option value="${p}"></option>`)}</datalist>`, {
    submitLabel: 'Record departure',
    onSubmit: async (f) => {
      const res = await api.send('PUT', `/api/calls/${c.id}`, { ...formData(f), version: c.version }, { queueable: true, label: `Departure ${c.rotation_no} ${c.vessel_name}` });
      if (res.queued) { toast('Offline: departure saved on this device and will sync later.', 'warn'); paintConn(); } else toast(`${c.vessel_name} marked as departed.`, 'success');
      done(); return true;
    },
  });
}

export function extensionDialog(c, done) {
  const approver = can('ext.approve') || S.lookups.settings.require_extension_approval !== '1';
  openDialog(`${approver ? 'Grant' : 'Request'} clearance extension`, html`
    <p class="muted">${c.rotation_no} · ${c.vessel_name} · ${c.extension_count} extension${c.extension_count === 1 ? '' : 's'} so far</p>
    <div class="fgrid">
      <label>Original expiry<input name="original_expiry" type="date" required value="${c.latest_expiry || ''}" ${c.latest_expiry ? raw('readonly') : ''}>
        <small class="help">${c.stay_basis === 'EXTENSION' ? 'Taken from the previous extension' : c.stay_basis === 'EDD' ? 'The estimated departure date' : 'Expiry of the initial clearance'}</small></label>
      <label>New expiry<input name="new_expiry" type="date" required min="${c.latest_expiry || c.arrival_date}"></label>
      <label class="span2">Reason<select name="reason" required>${options(S.lookups.extension_reasons.map((r) => r.name), '', { blank: 'Select reason…' })}</select></label>
      <label class="span2">Remarks<textarea name="remarks" rows="2"></textarea></label>
    </div>
    ${approver ? '' : html`<p class="note note-info">${icon('info')} This request will go to your station supervisor for approval. It does not count until approved.</p>`}`, {
    submitLabel: approver ? 'Grant extension' : 'Send request',
    onSubmit: async (f) => {
      const res = await api.send('POST', `/api/calls/${c.id}/extensions`, formData(f), { queueable: true, label: `Extension for ${c.rotation_no}` });
      if (res.queued) { toast('Offline: saved on this device and will sync later.', 'warn'); paintConn(); } else toast(approver ? 'Extension granted.' : 'Extension request sent for approval.', 'success');
      done(); return true;
    },
  });
}

export function decisionDialog(e, c, done, preset) {
  openDialog('Extension decision', html`
    <p><span class="mono">${c.rotation_no}</span> <b>${c.vessel_name}</b></p>
    <p>Extend from ${fmtDate(e.original_expiry)} to <b>${fmtDate(e.new_expiry)}</b>. Reason: ${e.reason}${e.remarks ? ` (${e.remarks})` : ''}. Requested by ${e.requested_by_name}.</p>
    <fieldset class="radios"><legend>Decision</legend>
      <label><input type="radio" name="decision" value="APPROVED" ${preset !== 'REJECTED' ? raw('checked') : ''}> Approve</label>
      <label><input type="radio" name="decision" value="REJECTED" ${preset === 'REJECTED' ? raw('checked') : ''}> Reject</label></fieldset>
    <label>Note <small class="help">required when rejecting</small><textarea name="note" rows="2"></textarea></label>`, {
    submitLabel: 'Save decision',
    onSubmit: async (f) => {
      await api.send('POST', `/api/extensions/${e.id}/decision`, { decision: f.decision.value, note: f.note.value });
      toast(`Extension ${f.decision.value.toLowerCase()}.`, 'success'); done(); return true;
    },
  });
}

export function caseDialog(c, k, done) {
  const people = S.lookups.staff;
  openDialog(`Investigation: ${c.vessel_name}`, html`
    <p class="muted">${c.rotation_no} · ${c.station_name} · ${c.overstay_status}${c.days_overdue ? ` · ${c.days_overdue} days overdue` : ''}</p>
    <div class="fgrid">
      <label>Case status<select name="status">${options(['OPEN', 'IN PROGRESS', 'REFERRED', 'CLOSED'], k ? k.status : 'OPEN', { blank: null })}</select></label>
      <label>Assigned to<select name="assigned_to">${options(people, k && k.assigned_to, { blank: 'Unassigned', value: (o) => o.id, label: (o) => o.initials })}</select></label>
      <label class="span2">Outcome <small class="help">required to close</small><input name="outcome" value="${(k && k.outcome) || ''}"></label>
      <label class="span2">Add follow-up note<textarea name="note" rows="3" placeholder="e.g. Agent contacted; vessel to depart Friday."></textarea></label>
    </div>
    ${k && k.notes && k.notes.length ? html`<h3 class="h-sm">Previous notes</h3><ol class="notes">${k.notes.map((n) => html`<li><b>${n.author}</b> <time>${n.created_at}</time><p>${n.note}</p></li>`)}</ol>` : ''}`, {
    submitLabel: k ? 'Save' : 'Open case', wide: true,
    onSubmit: async (f) => {
      const d = formData(f);
      await api.send('POST', `/api/calls/${c.id}/case`, { status: d.status, assigned_to: d.assigned_to, outcome: d.outcome });
      if (d.note.trim()) await api.send('POST', `/api/calls/${c.id}/case/notes`, { note: d.note }, { queueable: true, label: `Case note ${c.rotation_no}` });
      toast('Case updated.', 'success'); done(); return true;
    },
  });
}
