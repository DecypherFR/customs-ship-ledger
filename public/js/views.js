// Read-oriented views: dashboard, ledger, call detail, Ship's Report, extensions, overstay register, audit, sync queue.
import { api, outbox, flushOutbox } from './api.js';
import { html, raw, icon, chip, $, $$, fmtDate, fmtDateTime, fmtNum, fmtMonth, fmtMonthLong, toast, openDialog, options, formData, foldFilters, logo } from './ui.js';
import { S, can, go, render, refreshBadges, paintConn } from './app.js';
import { departureDialog, extensionDialog, decisionDialog, caseDialog } from './forms.js';

const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();
const national = () => !S.me.user.station_code || !['officer', 'supervisor'].includes(S.me.user.role);
const stationName = (code) => (S.lookups.stations.find((s) => s.code === code) || {}).name || code;
const offlineNote = (d) => (d && d.__offline ? html`<div class="note note-warn" role="status">${icon('cloudoff')} You are offline. Showing the last copy saved on this device.</div>` : '');

// ============================================================ DASHBOARD
export async function dashboard(main, { params }) {
  const month = params.month || S.lookups.today.slice(0, 7);
  const station = params.station || '';
  const d = await api.get(`/api/dashboard?${qs({ month, station })}`);
  const a = d.attention; const t = d.totals;
  const scopeLabel = d.station ? stationName(d.station) : 'All stations';
  const attn = [
    ['Overdue, still in port', a.overdue, 'critical', 'alert', '#/overstay', a.urgent ? `${a.urgent} urgent (3+ extensions)` : 'Extension expired', 'overstay.view'],
    ['Approved stay ending soon', a.expiring_soon, 'warning', 'clock', '#/overstay', `Within ${S.lookups.settings.expiring_soon_days} days`, 'overstay.view'],
    ['Long stay, no EDD', a.long_stay, 'serious', 'clock', '#/overstay', `No EDD or extension, in port over ${S.lookups.settings.long_stay_days} days`, 'overstay.view'],
    ['Extensions awaiting decision', a.pending_extensions, 'warning', 'clock', '#/extensions', 'Supervisor approval', 'calls.read'],
    ['Records failing data check', a.data_check, 'serious', 'info', '#/calls?flag=datacheck', 'Missing or inconsistent fields', 'calls.read'],
    ['Departed, not yet verified', a.unverified_departed, 'info', 'lock', '#/calls?flag=unverified', 'Awaiting supervisor sign-off', 'calls.verify'],
  ].filter((x) => can(x[6]));
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: 'America/Belize' }).format(new Date()));
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const name = S.me.user.full_name; const first = /^(system|office)\b/i.test(name) ? '' : name.split(' ')[0];
  main.innerHTML = String(html`
  <section class="hero">
    <div class="hero-text">
      <p class="eyebrow">${fmtMonthLong(d.month)} · ${scopeLabel}</p>
      <h1 data-page-title="Dashboard">${greeting}${first ? `, ${first}` : ''}</h1>
      <p class="hero-sub"><b>${a.in_port}</b> vessel${a.in_port === 1 ? '' : 's'} in port${can('overstay.view') && a.overdue ? html` · <b class="hero-alert">${a.overdue} overdue</b>` : ''}${a.pending_extensions ? html` · ${a.pending_extensions} extension${a.pending_extensions === 1 ? '' : 's'} to decide` : ''}</p>
      <div class="hero-actions">${can('calls.create') ? html`<a class="btn btn-gold" href="#/calls/new">${icon('plus')} New vessel call</a>` : ''}
        ${can('overstay.view') ? html`<a class="btn btn-glass" href="#/overstay">${icon('alert')} Overstay register</a>` : html`<a class="btn btn-glass" href="#/calls">${icon('ship')} Vessel calls</a>`}</div>
    </div>
    <form class="filters hero-filters" id="dfilter">
      <label class="f-inline">Report month<input type="month" name="month" value="${d.month}" max="${S.lookups.today.slice(0, 7)}"></label>
      ${national() ? html`<label class="f-inline">Station<select name="station">${options(S.lookups.stations, station, { blank: 'All stations', value: (s) => s.code, label: (s) => s.name })}</select></label>` : ''}
      ${can('export') ? html`<a class="btn btn-glass" href="/api/export/calls.csv?month=${d.month}" download>${icon('download')} Export month</a>` : ''}
    </form>
  </section>
  ${offlineNote(d)}
  <section aria-labelledby="attn-h" class="section">
    <h2 id="attn-h" class="section-h">Needs attention now <small>across all dates</small></h2>
    <div class="attn-grid">${attn.map(([label, n, tone, ic, href, sub]) => html`
      <a class="attn ${n ? `attn-${tone}` : 'attn-zero'}" href="${href}">
        <span class="attn-ico">${icon(n ? ic : 'check')}</span>
        <span class="attn-n">${n}</span><span class="attn-l">${label}</span><span class="attn-s">${n ? sub : 'All clear'}</span></a>`)}
      <a class="attn attn-plain" href="#/calls?status=IN%20PORT"><span class="attn-ico">${icon('anchor')}</span><span class="attn-n">${a.in_port}</span><span class="attn-l">Vessels currently in port</span><span class="attn-s">All years</span></a>
    </div>
  </section>
  <section class="section" aria-labelledby="month-h">
    <h2 id="month-h" class="section-h">${fmtMonthLong(d.month)} at a glance <small>by arrival date</small></h2>
    <div class="kpis">
      ${kpi('Vessel calls', t.calls, `#/calls?month=${d.month}${station ? '&station=' + station : ''}`)}
      ${kpi('Departed', t.departed)}${kpi('Still in port', t.in_port)}${kpi('Extensions granted', t.extensions)}
      ${kpi('Crew', t.crew)}${kpi('Passengers', t.passengers)}${kpi('Gross tonnage', t.gross_tonnage)}
    </div>
  </section>
  <section class="card section"><h2>By customs station</h2>
      <div class="tbl-wrap"><table class="tbl tbl-compact"><thead><tr><th>Station</th><th class="num">Calls</th><th class="num">Departed</th><th class="num">In port</th><th class="num">Crew</th><th class="num">Pax</th><th class="num">GT</th><th class="num">Ext.</th></tr></thead>
      <tbody>${d.by_station.map((s) => html`<tr><td>${s.name}</td><td class="num"><b>${s.calls}</b></td><td class="num">${s.departed}</td><td class="num">${s.in_port}</td><td class="num">${fmtNum(s.crew)}</td><td class="num">${fmtNum(s.passengers)}</td><td class="num">${fmtNum(s.gross_tonnage)}</td><td class="num">${s.extensions}</td></tr>`)}</tbody></table></div></section>
  <div class="grid-3 section">
    <section class="card"><h2>Vessel calls, last 12 months</h2>${barChart(d.trend)}
      <details class="tbl-toggle"><summary>Show as table</summary><table class="tbl tbl-compact"><thead><tr><th>Month</th><th class="num">Calls</th></tr></thead>
      <tbody>${d.trend.map((r) => html`<tr><td>${fmtMonth(r.month)}</td><td class="num">${r.calls}</td></tr>`)}</tbody></table></details></section>
    <section class="card"><h2>By vessel type</h2>${hbars(d.by_type)}</section>
    <section class="card"><h2>By cargo / operation</h2>${hbars(d.by_cargo)}</section>
  </div>
  <section class="card section"><h2>${d.watch_year} vessels still in port: long-stay watch</h2>
    ${d.watch.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Rotation No.</th><th>Vessel</th><th>Station</th><th>Arrived</th><th class="num">Days in port</th><th class="num">Ext.</th><th>Approved until</th><th>Status</th></tr></thead>
    <tbody>${d.watch.map((w) => html`<tr class="rowlink" data-href="#/calls/${w.id}"><td><a href="#/calls/${w.id}">${w.rotation_no}</a></td><td>${w.vessel_name}</td><td>${w.station_name}</td><td>${fmtDate(w.arrival_date)}</td><td class="num">${w.days_in_port}</td><td class="num">${w.extension_count}</td><td>${fmtDate(w.latest_expiry) || '-'}</td><td>${chip(w.overstay_status)}</td></tr>`)}</tbody></table></div>`
    : html`<p class="muted">No ${d.watch_year} vessels are currently in port.</p>`}
  </section>`);
  const f = $('#dfilter', main);
  f.addEventListener('change', () => go(`#/?${qs(formData(f))}`));
  rowLinks(main); chartHover(main);
}
const kpi = (label, n, href) => html`<${raw(href ? 'a' : 'div')} class="kpi" ${href ? raw(`href="${href}"`) : ''}><span class="kpi-n">${fmtNum(n)}</span><span class="kpi-l">${label}</span></${raw(href ? 'a' : 'div')}>`;

function barChart(rows) {
  const W = 380; const H = 210; const pad = { l: 28, r: 8, t: 12, b: 26 };
  const max = Math.max(4, ...rows.map((r) => r.calls));
  const step = Math.ceil(max / 4); const top = step * 4;
  const bw = (W - pad.l - pad.r) / rows.length; const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / top);
  const grid = [0, 1, 2, 3, 4].map((i) => html`<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(i * step)}" y2="${y(i * step)}" class="grid"/><text x="${pad.l - 6}" y="${y(i * step) + 4}" class="axis" text-anchor="end">${i * step}</text>`);
  const bars = rows.map((r, i) => {
    const x = pad.l + i * bw; const h = H - pad.b - y(r.calls); const w = Math.min(28, bw - 6);
    const bx = x + (bw - w) / 2;
    const path = r.calls ? `M${bx},${H - pad.b} V${y(r.calls) + 4} q0,-4 4,-4 h${w - 8} q4,0 4,4 V${H - pad.b} Z` : '';
    return html`<g class="bar-g" data-tip="${fmtMonth(r.month)}: ${r.calls} call${r.calls === 1 ? '' : 's'}">
      <rect x="${x}" y="${pad.t}" width="${bw}" height="${H - pad.t - pad.b}" class="hit"/>
      ${path ? html`<path d="${path}" class="bar ${i === rows.length - 1 ? 'bar-cur' : ''}"/>` : ''}
      ${h > 0 && i === rows.length - 1 ? html`<text x="${bx + w / 2}" y="${y(r.calls) - 5}" text-anchor="middle" class="lbl">${r.calls}</text>` : ''}
      <text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle" class="axis">${fmtMonth(r.month).slice(0, 3)}</text></g>`;
  });
  return html`<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Vessel calls per month for the last 12 months">${grid}<line x1="${pad.l}" x2="${W - pad.r}" y1="${H - pad.b}" y2="${H - pad.b}" class="base"/>${bars}</svg><div class="tip" hidden></div></div>`;
}
function chartHover(root) {
  $$('.chart', root).forEach((c) => {
    const tip = $('.tip', c);
    c.addEventListener('pointermove', (e) => {
      const g = e.target.closest('.bar-g'); $$('.bar-g', c).forEach((x) => x.classList.toggle('hover', x === g));
      if (!g) { tip.hidden = true; return; }
      const r = c.getBoundingClientRect(); tip.textContent = g.dataset.tip; tip.hidden = false;
      tip.style.left = `${Math.min(e.clientX - r.left + 12, r.width - 140)}px`; tip.style.top = `${e.clientY - r.top - 34}px`;
    });
    c.addEventListener('pointerleave', () => { tip.hidden = true; $$('.bar-g', c).forEach((x) => x.classList.remove('hover')); });
  });
}
function hbars(rows) {
  const used = rows.filter((r) => r.calls).sort((a, b) => b.calls - a.calls);
  if (!used.length) return html`<p class="muted">No calls recorded this month.</p>`;
  const max = Math.max(...used.map((r) => r.calls));
  return html`<ul class="hbars">${used.map((r) => html`<li title="${r.name}: ${r.calls}"><span class="hb-l">${r.name}</span><span class="hb-track"><span class="hb-bar" style="width:${(r.calls / max) * 100}%"></span></span><span class="hb-n">${r.calls}</span></li>`)}</ul>`;
}
function rowLinks(root) {
  $$('.rowlink', root).forEach((tr) => tr.addEventListener('click', (e) => { if (!e.target.closest('a,button')) go(tr.dataset.href); }));
}

// ============================================================ LEDGER (VESSEL MOVEMENTS)
export async function callList(main, { params }) {
  const p = { q: params.q || '', status: params.status || '', station: params.station || '', month: params.month || '', type: params.type || '', flag: params.flag || '' };
  // Offline on a device that never loaded this list: still show calls queued on this device.
  const offlineEmpty = (e) => { if (e.status !== 503) throw e; const r = []; Object.defineProperty(r, '__offline', { value: true }); return r; };
  const [rows, queued] = await Promise.all([api.get(`/api/calls?${qs(p)}`).catch(offlineEmpty), outbox.all()]);
  const pending = queued.filter((i) => i.method === 'POST' && i.url === '/api/calls');
  const flagLabel = { attention: 'needing attention', datacheck: 'failing data check', unverified: 'departed but not verified' }[p.flag];
  main.innerHTML = String(html`
  <div class="page-head"><div><h1>Vessel calls</h1><p class="muted">${rows.length} record${rows.length === 1 ? '' : 's'}${flagLabel ? ` ${flagLabel}` : ''} · one row per vessel call at one Customs station</p></div>
    <div class="actions">${can('export') ? html`<a class="btn" href="/api/export/calls.csv?${qs({ month: p.month })}" download>${icon('download')} Export CSV</a>` : ''}
    ${can('calls.create') ? html`<a class="btn btn-primary" href="#/calls/new">${icon('plus')} New vessel call</a>` : ''}</div></div>
  ${offlineNote(rows)}
  <form class="filters filters-bar" id="cf" role="search">
    <label class="f-search">${icon('search')}<input type="search" name="q" value="${p.q}" placeholder="Vessel, rotation no., IMO, agent, master…" aria-label="Search"></label>
    <select name="status" aria-label="Status">${options(['IN PORT', 'DEPARTED'], p.status, { blank: 'Any status', label: (s) => (s === 'IN PORT' ? 'In port' : 'Departed') })}</select>
    ${national() ? html`<select name="station" aria-label="Station">${options(S.lookups.stations, p.station, { blank: 'All stations', value: (s) => s.code, label: (s) => s.name })}</select>` : ''}
    <select name="type" aria-label="Vessel type">${options(S.lookups.vessel_types.map((v) => v.name), p.type, { blank: 'All vessel types' })}</select>
    <input type="month" name="month" value="${p.month}" aria-label="Arrival month">
    <select name="flag" aria-label="Show">${options([['attention', 'Needs attention'], ['datacheck', 'Failing data check'], ['unverified', 'Not yet verified']], p.flag, { blank: 'All records', value: (x) => x[0], label: (x) => x[1] })}</select>
    ${Object.values(p).some(Boolean) ? html`<a class="btn btn-ghost btn-sm" href="#/calls">Clear</a>` : ''}
  </form>
  ${pending.length ? html`<div class="note note-warn">${icon('cloudoff')} ${pending.length} new call${pending.length > 1 ? 's are' : ' is'} saved on this device and will receive a Rotation No. when synced. <a href="#/sync">View queue</a></div>` : ''}
  ${rows.length || pending.length ? html`<div class="tbl-wrap"><table class="tbl tbl-ledger"><thead><tr>
    <th>Rotation No.</th><th>Vessel</th><th>Type</th><th>Station</th><th>Arrived</th><th>Departed</th><th class="num">Crew</th><th class="num">Ext.</th><th>Status</th><th><span class="sr">Flags</span></th></tr></thead>
    <tbody>${pending.map((q) => html`<tr class="pending"><td data-l="Rotation No.">-</td><td data-l="Vessel"><b>${(q.body.vessel_name || '').toUpperCase()}</b></td><td data-l="Type">${q.body.vessel_type}</td><td data-l="Station">${stationName(q.body.station_code || S.me.user.station_code)}</td><td data-l="Arrived">${fmtDate(q.body.arrival_date)}</td><td data-l="Departed">${fmtDate(q.body.departure_date)}</td><td class="num" data-l="Crew">${q.body.crew}</td><td class="num" data-l="Ext.">0</td><td data-l="Status">${chip('PENDING SYNC')}</td><td></td></tr>`)}
    ${rows.map((c) => html`<tr class="rowlink" data-href="#/calls/${c.id}">
      <td data-l="Rotation No."><a href="#/calls/${c.id}" class="mono">${c.rotation_no}</a></td>
      <td data-l="Vessel"><b>${c.vessel_name}</b><small class="sub">${c.flag || ''}<span class="m-only">${c.flag ? ' · ' : ''}${c.vessel_type}</span></small></td>
      <td data-l="Type">${c.vessel_type}</td><td data-l="Station">${c.station_name}</td>
      <td data-l="Arrived">${fmtDate(c.arrival_date)}</td><td data-l="Departed">${c.departure_date ? fmtDate(c.departure_date) : c.estimated_departure ? html`<span class="muted" title="Estimated departure">Est. <span class="nowrap">${fmtDate(c.estimated_departure)}</span></span>` : '-'}</td>
      <td class="num" data-l="Crew">${c.crew ?? ''}</td><td class="num" data-l="Ext.">${c.extension_count}${c.pending_extensions ? html` <small class="sub">+${c.pending_extensions} pending</small>` : ''}</td>
      <td data-l="Status">${chip(c.status)} ${['OVERDUE', 'EXPIRING SOON', 'LONG STAY'].includes(c.overstay_status) ? chip(c.overstay_status) : ''}</td>
      <td data-l="Flags" class="flags">${c.verified_at ? html`<span title="Verified by ${c.verified_by_name}" class="flag-ok">${icon('lock')}<span class="sr">Verified</span></span>` : ''}${c.data_check ? html`<span title="${c.data_check.join('; ')}" class="flag-warn">${icon('alert')}<span class="sr">Data check: ${c.data_check.join('; ')}</span></span>` : ''}</td>
    </tr>`)}</tbody></table></div>`
    : html`<div class="empty"><p>No vessel calls match these filters.</p>${can('calls.create') ? html`<a class="btn btn-primary" href="#/calls/new">${icon('plus')} Record a vessel call</a>` : ''}</div>`}`);
  const f = $('#cf', main);
  foldFilters(f);
  let timer;
  f.addEventListener('input', (e) => { clearTimeout(timer); timer = setTimeout(() => go(`#/calls?${qs(formData(f))}`), e.target.type === 'search' ? 350 : 0); });
  f.addEventListener('submit', (e) => e.preventDefault());
  rowLinks(main);
  const s = $('[name=q]', f); if (p.q) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
}

// ============================================================ CALL DETAIL
export async function callDetail(main, { id }) {
  const c = await api.get(`/api/calls/${id}`);
  const locked = !!c.verified_at;
  const canEdit = can('calls.edit') && (!locked || S.me.user.role === 'admin');
  const r = c.officer_report || {};
  main.innerHTML = String(html`
  <nav class="crumbs"><a href="#/calls">Vessel calls</a> / <span class="mono">${c.rotation_no}</span></nav>
  ${offlineNote(c)}
  <div class="page-head">
    <div><h1>${c.vessel_name} <span class="mono rot">${c.rotation_no}</span></h1>
      <p class="chips">${chip(c.status)} ${c.overstay_status !== 'DEPARTED' ? chip(c.overstay_status) : ''} ${locked ? chip('VERIFIED', `by ${c.verified_by_name} ${fmtDateTime(c.verified_at)}`) : ''} ${c.case ? chip(c.case.status, 'Investigation case') : ''}</p></div>
    <div class="actions">
      ${canEdit && !c.departure_date && can('calls.depart') ? html`<button class="btn btn-primary" id="depart">${icon('out')} Record departure</button>` : ''}
      ${!c.departure_date && can('ext.request') ? html`<button class="btn" id="ext">${icon('clock')} ${can('ext.approve') ? 'Grant extension' : 'Request extension'}</button>` : ''}
      ${canEdit ? html`<a class="btn" href="#/calls/${c.id}/edit">${icon('edit')} Edit</a>` : ''}
      <a class="btn" href="#/calls/${c.id}/report">${icon('print')} Ship's Report</a>
      ${can('calls.verify') && c.departure_date && !locked ? html`<button class="btn" id="verify">${icon('lock')} Verify &amp; lock</button>` : ''}
      ${can('calls.verify') && locked ? html`<button class="btn" id="unlock">${icon('lock')} Unlock</button>` : ''}
      ${can('overstay.view') && can('cases.manage') && !c.case && !c.departure_date ? html`<button class="btn" id="case">${icon('folder')} Open case</button>` : ''}
      ${S.me.user.role === 'admin' ? html`<button class="btn btn-ghost btn-danger-text" id="del">Delete</button>` : ''}
    </div>
  </div>
  ${c.data_check ? html`<div class="note note-warn" role="status">${icon('alert')} <div><b>Data check:</b> ${c.data_check.join(' · ')}. ${canEdit ? html`<a href="#/calls/${c.id}/edit">Complete the record</a>` : ''}</div></div>` : ''}
  ${c.overstay_status === 'OVERDUE' ? html`<div class="note note-crit" role="alert">${icon('alert')} <div><b>${c.priority}.</b> Approved stay expired ${fmtDate(c.latest_expiry)}, ${c.days_overdue} day${c.days_overdue === 1 ? '' : 's'} overdue and no departure recorded.</div></div>` : ''}
  ${c.overstay_status === 'EXPIRING SOON' ? html`<div class="note note-warn">${icon('clock')} Approved stay ends ${fmtDate(c.latest_expiry)} (${c.days_to_expiry === 0 ? 'today' : `in ${c.days_to_expiry} day${c.days_to_expiry === 1 ? '' : 's'}`}).</div>` : ''}
  ${c.overstay_status === 'LONG STAY' ? html`<div class="note note-warn">${icon('clock')} In port ${c.days_in_port} days with no estimated departure date or extension on file.</div>` : ''}
  <div class="grid-3">
    <section class="card"><h2>Vessel</h2><dl class="kv">
      <dt>Vessel type</dt><dd>${c.vessel_type}</dd><dt>IMO / Reg. No.</dt><dd class="mono">${c.imo || '-'}</dd><dt>Flag</dt><dd>${c.flag || '-'}</dd>
      <dt>Gross / Net tonnage</dt><dd>${fmtNum(c.gross_tonnage) || '-'} / ${fmtNum(c.net_tonnage) || '-'}</dd><dt>Master</dt><dd>${c.master || '-'}</dd>
      <dt>Shipping agent</dt><dd>${c.agent || '-'}</dd></dl></section>
    <section class="card"><h2>Movement</h2><dl class="kv">
      <dt>Station</dt><dd>${c.station_name}</dd><dt>Voyage No.</dt><dd>${c.voyage_no || '-'}</dd>
      <dt>Last port</dt><dd>${c.last_port || '-'}</dd><dt>Arrived</dt><dd>${fmtDate(c.arrival_date)} · ${c.boarding_officer || '-'}</dd>
      <dt>Estimated departure</dt><dd>${fmtDate(c.estimated_departure) || '-'}</dd>
      ${c.departure_date ? '' : html`<dt>Approved stay until</dt><dd>${c.latest_expiry ? html`${fmtDate(c.latest_expiry)} <small class="sub">${c.stay_basis === 'EXTENSION' ? 'from the latest extension' : 'the estimated departure'}</small>` : '-'}</dd>`}
      <dt>Next port</dt><dd>${c.next_port || '-'}</dd><dt>Departed</dt><dd>${c.departure_date ? html`${fmtDate(c.departure_date)} · ${c.clearance_officer || '-'}` : html`<em>In port · day ${c.days_in_port}</em>`}</dd></dl></section>
    <section class="card"><h2>Cargo &amp; people</h2><dl class="kv">
      <dt>Cargo / operation</dt><dd>${c.cargo || '-'}</dd><dt>Crew</dt><dd>${c.crew ?? '-'}</dd><dt>Passengers</dt><dd>${c.passengers ?? '-'}</dd>
      <dt>Remarks</dt><dd>${c.remarks || '-'}</dd><dt>Boarding report</dt><dd>${r.rummaged || r.fumigated ? `Rummaged: ${r.rummaged || '-'} · Fumigated: ${r.fumigated || '-'}` : html`<a href="#/calls/${c.id}/report">Not completed</a>`}</dd></dl></section>
  </div>
  <section class="card section"><div class="card-head"><h2>Clearance extensions <small>${c.extension_count} approved</small></h2></div>
    ${c.extensions.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>No.</th><th>Requested</th><th>Original expiry</th><th>New expiry</th><th>Reason</th><th>Status</th><th>Decided by</th><th></th></tr></thead>
    <tbody>${c.extensions.map((e) => html`<tr><td data-l="No.">${e.status === 'APPROVED' ? e.ext_no : '-'}</td><td data-l="Requested">${fmtDateTime(e.requested_at)} · ${e.requested_by_name}</td>
      <td data-l="Original">${fmtDate(e.original_expiry)}</td><td data-l="New expiry"><b>${fmtDate(e.new_expiry)}</b></td><td data-l="Reason">${e.reason}${e.remarks ? html`<small class="sub">${e.remarks}</small>` : ''}</td>
      <td data-l="Status">${chip(e.status)}${e.decision_note ? html`<small class="sub">${e.decision_note}</small>` : ''}</td><td data-l="Decided">${e.decided_by_name || '-'}</td>
      <td>${e.status === 'PENDING' && can('ext.approve') ? html`<button class="btn btn-sm" data-decide="${e.id}">Decide</button>` : ''}</td></tr>`)}</tbody></table></div>`
    : html`<p class="muted">No extensions recorded.</p>`}</section>
  ${c.case ? html`<section class="card section"><div class="card-head"><h2>Investigation case ${chip(c.case.status)}</h2>${can('cases.manage') ? html`<button class="btn btn-sm" id="case">Update / add note</button>` : ''}</div>
    <dl class="kv kv-inline"><dt>Assigned to</dt><dd>${c.case.assigned_name || 'Unassigned'}</dd><dt>Opened</dt><dd>${fmtDateTime(c.case.opened_at)}</dd>${c.case.outcome ? html`<dt>Outcome</dt><dd>${c.case.outcome}</dd>` : ''}</dl>
    ${c.case.notes.length ? html`<ol class="notes">${c.case.notes.map((n) => html`<li><b>${n.author}</b> <time>${fmtDateTime(n.created_at)}</time><p>${n.note}</p></li>`)}</ol>` : html`<p class="muted">No follow-up notes yet.</p>`}</section>` : ''}
  <details class="card section"><summary><h2>${icon('history')} Record history <small>${c.history.length} entries</small></h2></summary>
    <ol class="timeline">${c.history.map((h) => html`<li><time>${fmtDateTime(h.ts)}</time> <b>${h.who || 'system'}</b>: ${h.summary}${h.details && h.action === 'update' ? html`<small class="sub">${diffText(h.details)}</small>` : ''}</li>`)}</ol></details>`);

  const reload = () => { refreshBadges(); render(); };
  $('#depart', main)?.addEventListener('click', () => departureDialog(c, reload));
  $('#ext', main)?.addEventListener('click', () => extensionDialog(c, reload));
  $('#case', main)?.addEventListener('click', () => caseDialog(c, c.case, reload));
  $$('[data-decide]', main).forEach((b) => b.addEventListener('click', () => decisionDialog(c.extensions.find((e) => e.id === Number(b.dataset.decide)), c, reload)));
  $('#verify', main)?.addEventListener('click', async () => {
    try { await api.send('POST', `/api/calls/${c.id}/verify`, {}); toast(`${c.rotation_no} verified and locked.`, 'success'); reload(); } catch (e) { toast(e.message, 'error'); }
  });
  $('#unlock', main)?.addEventListener('click', () => openDialog('Unlock verified record', html`<p>Unlocking lets officers edit ${c.rotation_no} again. The reason is kept in the audit trail.</p><label>Reason<textarea name="reason" required rows="3"></textarea></label>`, {
    submitLabel: 'Unlock', onSubmit: async (f) => { await api.send('POST', `/api/calls/${c.id}/verify`, { unlock: true, reason: f.reason.value }); reload(); return true; } }));
  $('#del', main)?.addEventListener('click', () => openDialog('Delete vessel call', html`<p>Permanently delete <b>${c.rotation_no} ${c.vessel_name}</b>, its extensions and case notes? The rotation number will not be reused automatically.</p><label>Reason<textarea name="reason" required rows="3"></textarea></label>`, {
    danger: true, submitLabel: 'Delete', onSubmit: async (f) => { await api.send('DELETE', `/api/calls/${c.id}`, { reason: f.reason.value }); toast('Vessel call deleted.'); go('#/calls'); return true; } }));
}
function diffText(json) {
  try {
    const d = JSON.parse(json);
    const who = (v) => (S.lookups.officers.concat(S.lookups.staff).find((o) => o.id === v) || {}).initials || v;
    const show = (k, v) => (v == null ? '-' : k.endsWith('_officer_id') ? who(v) : v);
    return Object.entries(d).filter(([k]) => k !== 'officer_report')
      .map(([k, [a, b]]) => `${k.replace(/_id$/, '').replace(/_/g, ' ')}: ${show(k, a)} → ${show(k, b)}`).join(' · ') || 'Ship\'s Report updated';
  } catch { return ''; }
}

// ============================================================ SHIP'S REPORT
export async function shipReport(main, { id }) {
  const c = await api.get(`/api/calls/${id}`);
  const r = c.officer_report || {};
  const canEdit = can('calls.edit') && (!c.verified_at || S.me.user.role === 'admin');
  const field = (name, label, type = 'text') => (canEdit
    ? html`<label class="rp-edit"><span>${label}</span>${type === 'yn' ? html`<select name="${name}">${options(['YES', 'NO'], r[name], { blank: '-' })}</select>` : html`<input name="${name}" type="${type}" value="${r[name] || ''}">`}</label>`
    : html`<div class="rp-f"><span>${label}</span><b>${r[name] || ''}</b></div>`);
  main.innerHTML = String(html`
  <nav class="crumbs no-print"><a href="#/calls">Vessel calls</a> / <a href="#/calls/${c.id}" class="mono">${c.rotation_no}</a> / Ship's Report</nav>
  <div class="page-head no-print"><h1>Ship's Report</h1><div class="actions">
    ${canEdit ? html`<button class="btn" id="save-rp" form="rp">${icon('check')} Save officer's report</button>` : ''}
    <button class="btn btn-primary" id="print">${icon('print')} Print</button></div></div>
  <form id="rp" class="report" novalidate>
    <header class="rp-head">${logo(64)}<div><p>BELIZE CUSTOMS &amp; EXCISE DEPARTMENT</p><h2>SHIP'S REPORT</h2></div><div class="rp-rot"><span>Rotation No.</span><b class="mono">${c.rotation_no}</b></div></header>
    <h3>Ship particulars</h3>
    <div class="rp-grid">${[['Flag', c.flag], ['Rig', c.vessel_type], ['Vessel Name', c.vessel_name], ['Master', c.master], ['Tonnage GT / NT', `${fmtNum(c.gross_tonnage)} / ${fmtNum(c.net_tonnage)}`], ['Crew No.', c.crew], ['Port of Departure', c.last_port], ['Date of Departure', fmtDate(c.departure_date)], ['IMO / Reg. No.', c.imo], ['Station', c.station_name]].map(([l, v]) => html`<div class="rp-f"><span>${l}</span><b>${v ?? ''}</b></div>`)}</div>
    <h3>Cargo particulars</h3>
    <div class="rp-grid"><div class="rp-f rp-wide"><span>Cargo</span><b>${c.cargo || ''}</b></div></div>
    <h3>Other particulars</h3>
    <div class="rp-grid">${[['Consignee / Shipping Agent', c.agent], ['Passengers', c.passengers], ['Next Port of Arrival', c.next_port], ['Date of Boarding', fmtDate(c.arrival_date)]].map(([l, v]) => html`<div class="rp-f"><span>${l}</span><b>${v ?? ''}</b></div>`)}
      ${field('pilot_name', 'Pilot Name')}</div>
    <div class="rp-sign"><span>Master Signature</span></div>
    <h3>Officer's report</h3>
    <div class="rp-grid">${field('anchorage_time', 'Time of Anchorage / All Fast', 'time')}${field('boarding_time', 'Time of Boarding', 'time')}
      ${field('health_official', 'Name of Health Official')}${field('fumigated', 'Fumigated', 'yn')}${field('rummaged', 'Rummaged', 'yn')}${field('report_remarks', 'Remarks')}
      <div class="rp-f"><span>Voyage No.</span><b>${c.voyage_no || ''}</b></div><div class="rp-f"><span>Boarding Officer</span><b>${c.boarding_officer || ''}</b></div>
      <div class="rp-f"><span>Approved stay until</span><b>${fmtDate(c.latest_expiry)}</b></div><div class="rp-f"><span>Extensions</span><b>${c.extension_count}</b></div></div>
    <div class="rp-sign rp-sign-r"><span>For Comptroller of Customs</span></div>
    <footer class="rp-foot">${S.lookups.settings.office_footer}</footer>
  </form>`);
  $('#print', main).addEventListener('click', () => window.print());
  $('#rp', main).addEventListener('submit', async (e) => {
    e.preventDefault();
    const officer_report = formData(e.target);
    try {
      const res = await api.send('PUT', `/api/calls/${c.id}`, { version: c.version, officer_report }, { queueable: true, label: `Ship's Report ${c.rotation_no}` });
      if (res.queued) { toast('Offline - report saved on this device and will sync later.', 'warn'); paintConn(); } else { toast('Officer\'s report saved.', 'success'); render(); }
    } catch (err) { toast(err.message, 'error'); }
  });
}

// ============================================================ EXTENSIONS
export async function extensionsView(main, { params }) {
  const status = params.status || '';
  const [pending, rows] = await Promise.all([api.get('/api/extensions?status=PENDING'), api.get(`/api/extensions?${qs({ status })}`)]);
  main.innerHTML = String(html`
  <div class="page-head"><div><h1>Clearance extensions</h1><p class="muted">Every extension is a separate line, linked to the vessel call.</p></div>
    ${can('export') ? html`<a class="btn" href="/api/export/extensions.csv" download>${icon('download')} Export log</a>` : ''}</div>
  ${offlineNote(rows)}
  <section class="card section"><h2>Awaiting decision <small>${pending.length}</small></h2>
    ${pending.length ? html`<ul class="queue">${pending.map((e) => html`<li>
      <div><a href="#/calls/${e.call_id}" class="mono">${e.rotation_no}</a> <b>${e.vessel_name}</b> <span class="muted">· ${e.station_name}</span>
        <p>Extend ${fmtDate(e.original_expiry)} → <b>${fmtDate(e.new_expiry)}</b> · ${e.reason}${e.remarks ? ` (${e.remarks})` : ''}</p>
        <small class="muted">Requested by ${e.requested_by_name}, ${fmtDateTime(e.requested_at)}</small></div>
      ${can('ext.approve') ? html`<div class="actions"><button class="btn btn-sm btn-primary" data-act="APPROVED" data-id="${e.id}">${icon('check')} Approve</button><button class="btn btn-sm" data-act="REJECTED" data-id="${e.id}">${icon('x')} Reject</button></div>` : chip('PENDING')}
    </li>`)}</ul>` : html`<p class="muted">Nothing is waiting for a decision.</p>`}
  </section>
  <section class="card section"><div class="card-head"><h2>Extension log</h2>
    <select id="xs" aria-label="Filter by status">${options(['APPROVED', 'PENDING', 'REJECTED'], status, { blank: 'All statuses' })}</select></div>
    ${rows.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Rotation No.</th><th>Vessel</th><th>Station</th><th>Granted</th><th>Original expiry</th><th>New expiry</th><th>Approved by</th><th>Reason</th><th>Status</th></tr></thead>
    <tbody>${rows.map((e) => html`<tr class="rowlink" data-href="#/calls/${e.call_id}"><td data-l="Rotation"><a class="mono" href="#/calls/${e.call_id}">${e.rotation_no}</a></td><td data-l="Vessel">${e.vessel_name}</td><td data-l="Station">${e.station_name}</td><td data-l="Granted">${fmtDate(e.date_granted) || '-'}</td><td data-l="Original">${fmtDate(e.original_expiry)}</td><td data-l="New expiry"><b>${fmtDate(e.new_expiry)}</b></td><td data-l="Approved by">${e.decided_by_name || '-'}</td><td data-l="Reason">${e.reason}</td><td data-l="Status">${chip(e.status)}</td></tr>`)}</tbody></table></div>`
    : html`<p class="muted">No extensions recorded.</p>`}
  </section>`);
  $('#xs', main).addEventListener('change', (e) => go(`#/extensions?${qs({ status: e.target.value })}`));
  rowLinks(main);
  $$('[data-act]', main).forEach((b) => b.addEventListener('click', () => {
    const e = pending.find((x) => x.id === Number(b.dataset.id));
    decisionDialog(e, { rotation_no: e.rotation_no, vessel_name: e.vessel_name }, () => { refreshBadges(); render(); }, b.dataset.act);
  }));
}

// ============================================================ OVERSTAY REGISTER
export async function overstayView(main, { params }) {
  const d = await api.get('/api/overstay');
  const show = params.show || '';
  const items = d.items.filter((c) => !show || c.overstay_status === show || (show === 'CASES' && c.case));
  const count = (s) => d.items.filter((c) => c.overstay_status === s).length;
  const urgent = d.items.filter((c) => c.priority && c.priority.startsWith('URGENT')).length;
  main.innerHTML = String(html`
  <div class="page-head"><div><h1>Overstay investigation register</h1><p class="muted">Vessels that have not departed and whose approved stay has expired, is about to expire, or was never extended. Checked ${fmtDate(d.date_checked)}.</p></div>
    <button class="btn no-print" id="print">${icon('print')} Print register</button></div>
  ${offlineNote(d)}
  <div class="kpis kpis-4">
    <a class="kpi kpi-crit" href="#/overstay?show=OVERDUE"><span class="kpi-n">${count('OVERDUE')}</span><span class="kpi-l">${icon('alert')} Overdue vessels</span></a>
    <a class="kpi kpi-crit" href="#/overstay?show=OVERDUE"><span class="kpi-n">${urgent}</span><span class="kpi-l">${icon('alert')} Urgent: ${S.lookups.settings.urgent_extension_count}+ extensions</span></a>
    <a class="kpi kpi-warn" href="#/overstay?show=EXPIRING%20SOON"><span class="kpi-n">${count('EXPIRING SOON')}</span><span class="kpi-l">${icon('clock')} Expiring within ${S.lookups.settings.expiring_soon_days} days</span></a>
    <a class="kpi kpi-warn" href="#/overstay?show=LONG%20STAY"><span class="kpi-n">${count('LONG STAY')}</span><span class="kpi-l">${icon('clock')} Long stay, no EDD or extension</span></a>
  </div>
  <div class="seg no-print" role="group" aria-label="Show">${[['', 'All'], ['OVERDUE', 'Overdue'], ['EXPIRING SOON', 'Expiring soon'], ['LONG STAY', 'Long stay'], ['CASES', 'With a case']].map(([v, l]) => html`<a href="#/overstay${v ? `?show=${encodeURIComponent(v)}` : ''}" class="${show === v ? 'on' : ''}">${l}</a>`)}</div>
  ${items.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Rotation No.</th><th>Vessel</th><th>Station</th><th>Agent / Master</th><th>Arrived</th><th class="num">Ext.</th><th>Approved until</th><th class="num">Days</th><th>Status / priority</th><th>Case</th><th class="no-print"></th></tr></thead>
  <tbody>${items.map((c) => html`<tr>
    <td data-l="Rotation"><a class="mono" href="#/calls/${c.id}">${c.rotation_no}</a></td><td data-l="Vessel"><b>${c.vessel_name}</b><small class="sub">${c.flag}</small></td><td data-l="Station">${c.station_name}</td>
    <td data-l="Agent / Master">${c.agent}<small class="sub">${c.master}</small></td><td data-l="Arrived">${fmtDate(c.arrival_date)}</td><td class="num" data-l="Ext.">${c.extension_count}</td>
    <td data-l="Approved until">${fmtDate(c.latest_expiry) || '-'}</td>
    <td class="num" data-l="Days">${c.overstay_status === 'OVERDUE' ? html`<b class="t-crit">${c.days_overdue} over</b>` : c.overstay_status === 'EXPIRING SOON' ? `${c.days_to_expiry} left` : `${c.days_in_port} in port`}</td>
    <td data-l="Status">${chip(c.overstay_status)}${c.priority ? html`<small class="sub">${c.priority}</small>` : ''}</td>
    <td data-l="Case">${c.case ? html`${chip(c.case.status)}<small class="sub">${c.case.assigned_name || 'Unassigned'} · ${c.case.notes} note${c.case.notes === 1 ? '' : 's'}</small>` : '-'}</td>
    <td class="no-print">${can('cases.manage') ? html`<button class="btn btn-sm" data-case="${c.id}">${c.case ? 'Follow up' : 'Open case'}</button>` : ''}</td></tr>`)}</tbody></table></div>`
    : html`<div class="empty">${icon('check', 'big-ok')}<p>No vessels need follow-up${show ? ' in this view' : ''}.</p></div>`}`);
  $('#print', main).addEventListener('click', () => window.print());
  $$('[data-case]', main).forEach((b) => b.addEventListener('click', async () => {
    const full = await api.get(`/api/calls/${b.dataset.case}`);
    caseDialog(full, full.case, () => { refreshBadges(); render(); });
  }));
}

// ============================================================ AUDIT
export async function auditView(main, { params }) {
  const rows = await api.get(`/api/audit?${qs({ q: params.q || '' })}`);
  main.innerHTML = String(html`<div class="page-head"><div><h1>Audit trail</h1><p class="muted">Every sign-in, change, approval and export is recorded. Most recent 300 entries.</p></div></div>
  <form class="filters filters-bar" id="af" role="search"><label class="f-search">${icon('search')}<input type="search" name="q" value="${params.q || ''}" placeholder="Search rotation no., vessel, user…" aria-label="Search audit"></label></form>
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>User</th><th>Action</th><th>Details</th></tr></thead>
  <tbody>${rows.map((a) => html`<tr><td data-l="When">${fmtDateTime(a.ts)}</td><td data-l="User">${a.username || 'system'}</td><td data-l="Action"><span class="tag">${a.action}</span></td>
    <td data-l="Details">${a.entity === 'call' && a.entity_id && a.action !== 'delete' ? html`<a href="#/calls/${a.entity_id}">${a.summary}</a>` : a.summary}</td></tr>`)}</tbody></table></div>`);
  let t; $('#af', main).addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => go(`#/audit?${qs({ q: e.target.value })}`), 400); });
  $('#af', main).addEventListener('submit', (e) => e.preventDefault());
}

// ============================================================ SYNC QUEUE
export async function syncView(main) {
  const items = await outbox.all();
  main.innerHTML = String(html`<div class="page-head"><div><h1>Offline queue</h1><p class="muted">${navigator.onLine ? 'Online.' : 'Offline.'} Changes made without a connection are kept on this device until the server accepts them.</p></div>
    ${items.length && navigator.onLine ? html`<button class="btn btn-primary" id="retry">${icon('cloud')} Send now</button>` : ''}</div>
  ${items.length ? html`<ul class="queue">${items.map((i) => html`<li class="${i.error ? 'q-err' : ''}"><div><b>${i.label || `${i.method} ${i.url}`}</b>
    <small class="muted">Saved ${fmtDateTime(i.queued_at)}</small>${i.error ? html`<p class="t-crit">${icon('alert')} Server refused: ${i.error}</p>` : html`<p class="muted">Waiting to send</p>`}</div>
    <div class="actions">${i.error ? html`<button class="btn btn-sm" data-retry="${i.id}">Try again</button>` : ''}<button class="btn btn-sm btn-ghost btn-danger-text" data-drop="${i.id}">Discard</button></div></li>`)}</ul>`
    : html`<div class="empty">${icon('check', 'big-ok')}<p>Everything on this device has been sent to the ledger.</p></div>`}`);
  $('#retry', main)?.addEventListener('click', async () => { await flushOutbox(); render(); });
  $$('[data-retry]', main).forEach((b) => b.addEventListener('click', async () => {
    const it = (await outbox.all()).find((x) => x.id === Number(b.dataset.retry)); it.error = null; await outbox.put(it); await flushOutbox(); render();
  }));
  $$('[data-drop]', main).forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Discard this change? It has not been saved to the ledger.')) return;
    await outbox.remove(Number(b.dataset.drop)); paintConn(); render();
  }));
}
