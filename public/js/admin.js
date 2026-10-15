// Administration: users & roles, reference lists, settings and Excel ledger import.
import { api } from './api.js';
import { html, raw, icon, $, $$, fmtDateTime, toast, openDialog, options, formData, showFormError } from './ui.js';
import { S, render } from './app.js';

const ROLE_MATRIX = [
  ['View vessel calls', ['officer', 'supervisor', 'investigator', 'management', 'admin']],
  ['Record calls, departures, Ship\'s Reports', ['officer', 'supervisor', 'admin']],
  ['Request extensions', ['officer', 'supervisor', 'admin']],
  ['Approve / reject extensions', ['supervisor', 'admin']],
  ['Verify & lock calls', ['supervisor', 'admin']],
  ['Overstay register & cases', ['supervisor', 'investigator', 'management', 'admin']],
  ['Export CSV', ['supervisor', 'investigator', 'management', 'admin']],
  ['Audit trail', ['management', 'admin']],
  ['Users, lists, settings', ['admin']],
];

export async function usersView(main) {
  const users = await api.get('/api/users');
  const roles = S.lookups.roles;
  const st = (code) => (S.lookups.stations.find((s) => s.code === code) || {}).name || 'All stations';
  main.innerHTML = String(html`
  <div class="page-head"><div><h1>Users &amp; roles</h1><p class="muted">Officers and supervisors only see their own station. Everyone else works nationally.</p></div>
    <button class="btn btn-primary" id="add">${icon('plus')} Add user</button></div>
  <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Name</th><th>Email</th><th>Printed as</th><th>Role</th><th>Station</th><th>Last sign-in</th><th>Status</th><th></th></tr></thead>
  <tbody>${users.map((u) => html`<tr class="${u.active ? '' : 'inactive'}"><td data-l="Name"><b>${u.full_name}</b></td><td data-l="Email">${u.email || html`<span class="muted">No sign-in (imported)</span>`}</td><td data-l="Printed as">${u.initials}</td>
    <td data-l="Role">${roles[u.role].label}</td><td data-l="Station">${st(u.station_code)}</td><td data-l="Last sign-in">${u.last_login_at ? fmtDateTime(u.last_login_at) : 'Never'}</td>
    <td data-l="Status">${u.active ? (u.must_change_password ? html`<span class="tag">Must set password</span>` : 'Active') : html`<span class="tag">Inactive</span>`}</td>
    <td><button class="btn btn-sm" data-edit="${u.id}">Edit</button> ${u.email ? html`<button class="btn btn-sm btn-ghost" data-reset="${u.id}">Reset password</button>` : html`<button class="btn btn-sm btn-ghost" data-signin="${u.id}">Give sign-in</button>`}</td></tr>`)}</tbody></table></div>
  <section class="card section"><h2>What each role can do</h2><div class="tbl-wrap"><table class="tbl tbl-compact matrix"><thead><tr><th>Permission</th>${Object.values(roles).map((r) => html`<th>${r.label}</th>`)}</tr></thead>
    <tbody>${ROLE_MATRIX.map(([p, rs]) => html`<tr><td>${p}</td>${Object.keys(roles).map((k) => html`<td class="c">${rs.includes(k) ? html`${icon('check', 'ok')}<span class="sr">Yes</span>` : html`<span class="muted" aria-label="No">—</span>`}</td>`)}</tr>`)}</tbody></table></div></section>`);

  const form = (u = {}) => html`<div class="fgrid">
    ${u.id ? '' : html`<label>Email<input name="email" type="email" required autocapitalize="none"></label>`}
    <label>Full name<input name="full_name" required value="${u.full_name || ''}"></label>
    <label>Printed as (initials)<input name="initials" value="${u.initials || ''}" class="caps" placeholder="e.g. J.REYES"></label>
    <label>Role<select name="role" required>${options(Object.entries(roles), u.role, { blank: 'Select role…', value: (r) => r[0], label: (r) => r[1].label })}</select></label>
    <label>Station<select name="station_code">${options(S.lookups.stations, u.station_code, { blank: 'All stations (national)', value: (s) => s.code, label: (s) => s.name })}</select></label>
    ${u.id ? html`<label class="chk span2"><input type="checkbox" name="active" ${u.active ? raw('checked') : ''}> Account active</label>`
    : html`<label>Temporary password<input name="password" type="text" required minlength="10"><small class="help">They must change it at first sign-in.</small></label>`}
    <p class="help span2" id="roledesc"></p></div>`;
  const wireDesc = (f) => { const upd = () => { $('#roledesc', f).textContent = roles[f.role.value]?.desc || ''; }; f.role.addEventListener('change', upd); upd(); };

  $('#add', main).addEventListener('click', () => {
    const { form: f } = openDialog('Add user', form(), { submitLabel: 'Create user', onSubmit: async (fm) => {
      await api.send('POST', '/api/users', formData(fm)); toast('User created. Give them the temporary password; they must change it at first sign-in.', 'success'); render(); return true;
    } });
    wireDesc(f);
  });
  $$('[data-edit]', main).forEach((b) => b.addEventListener('click', () => {
    const u = users.find((x) => x.id === b.dataset.edit);
    const { form: f } = openDialog(`Edit ${u.full_name}`, form(u), { onSubmit: async (fm) => {
      await api.send('PUT', `/api/users/${u.id}`, formData(fm)); toast('User updated.', 'success'); render(); return true;
    } });
    wireDesc(f);
  }));
  $$('[data-reset]', main).forEach((b) => b.addEventListener('click', () => {
    const u = users.find((x) => x.id === b.dataset.reset);
    openDialog(`Reset password — ${u.email}`, html`<p>Sets a temporary password for ${u.full_name}. They must choose a new one at their next sign-in.</p>
      <label>Temporary password<input name="password" required minlength="10"></label>`, { submitLabel: 'Reset password', onSubmit: async (fm) => {
      await api.send('POST', `/api/users/${u.id}/reset-password`, { password: fm.password.value }); toast('Password reset.', 'success'); render(); return true;
    } });
  }));
  // Officers imported from the Excel ledger exist without a sign-in; giving them one keeps their history attached.
  $$('[data-signin]', main).forEach((b) => b.addEventListener('click', () => {
    const u = users.find((x) => x.id === b.dataset.signin);
    openDialog(`Give ${u.initials} a sign-in`, html`<p>${u.initials} appears on imported records. Creating a sign-in links those records to the new account.</p>
      <div class="fgrid"><label class="span2">Email<input name="email" type="email" required></label>
      <label>Full name<input name="full_name" required value="${u.full_name === u.initials ? '' : u.full_name}"></label>
      <label>Role<select name="role" required>${options(Object.entries(roles), u.role, { blank: null, value: (r) => r[0], label: (r) => r[1].label })}</select></label>
      <label>Station<select name="station_code">${options(S.lookups.stations, u.station_code, { blank: 'All stations (national)', value: (s) => s.code, label: (s) => s.name })}</select></label>
      <label>Temporary password<input name="password" required minlength="10"></label></div>`, { submitLabel: 'Create sign-in', onSubmit: async (fm) => {
      await api.send('POST', `/api/users/${u.id}/signin`, formData(fm)); toast('Sign-in created.', 'success'); render(); return true;
    } });
  }));
}

export async function settingsView(main) {
  S.lookups = await api.get('/api/lookups');
  const lk = S.lookups; const s = lk.settings;
  const listCard = (key, title, items, cols) => html`<section class="card section" data-list="${key}"><div class="card-head"><h2>${title}</h2>
      <div class="actions"><button class="btn btn-sm" data-addrow>${icon('plus')} Add</button><button class="btn btn-sm btn-primary" data-savelist>Save</button></div></div>
    <div class="tbl-wrap"><table class="tbl tbl-compact tbl-edit"><thead><tr>${cols.map((c) => html`<th>${c[1]}</th>`)}<th>Active</th></tr></thead>
    <tbody>${items.map((it) => row(cols, it))}</tbody></table></div></section>`;
  const row = (cols, it = { active: 1 }) => html`<tr>${cols.map(([k, , type]) => html`<td>${type === 'bool'
    ? html`<input type="checkbox" data-k="${k}" ${it[k] ? raw('checked') : ''} aria-label="${k}">`
    : html`<input data-k="${k}" value="${it[k] ?? ''}" ${type === 'key' && it[k] ? raw('readonly') : ''} aria-label="${k}" class="${type === 'code' || type === 'key' ? 'caps mono' : ''}">`}</td>`)}
    <td><input type="checkbox" data-k="active" ${it.active ? raw('checked') : ''} aria-label="Active"></td></tr>`;
  const LISTS = {
    stations: ['Customs stations', [['code', 'Code', 'key'], ['name', 'Station name']]],
    vessel_types: ['Vessel types &amp; rotation classes', [['name', 'Vessel type', 'key'], ['rotation_class', 'Rotation class', 'code'], ['manual_sequence', 'Agent-supplied sequence (CRG)', 'bool']]],
    cargo_types: ['Cargo / operation', [['name', 'Cargo / operation', 'key']]],
    extension_reasons: ['Extension reasons', [['name', 'Reason', 'key']]],
  };
  main.innerHTML = String(html`
  <div class="page-head"><div><h1>Lists &amp; settings</h1><p class="muted">Changes apply immediately for every user. Deactivate rather than delete so history stays intact.</p></div></div>
  <section class="card section"><h2>Rules</h2><form id="sf" class="fgrid" novalidate>
    <label>Warn when an extension expires within (days)<input name="expiring_soon_days" type="number" min="1" value="${s.expiring_soon_days}"></label>
    <label>Flag in-port vessels with no extension after (days)<input name="long_stay_days" type="number" min="1" value="${s.long_stay_days}"></label>
    <label>Mark overdue vessels URGENT at this many extensions<input name="urgent_extension_count" type="number" min="1" value="${s.urgent_extension_count}"></label>
    <label class="chk"><input type="checkbox" name="require_extension_approval" ${s.require_extension_approval === '1' ? raw('checked') : ''}> Officers' extension requests need supervisor approval</label>
    <label class="span2">Ship's Report footer<input name="office_footer" value="${s.office_footer}"></label>
    <p class="form-error span2" role="alert" hidden></p>
    <div class="span2"><button class="btn btn-primary">Save rules</button></div></form></section>
  ${Object.entries(LISTS).map(([k, [t, cols]]) => listCard(k, raw(t), lk[k], cols))}
  <section class="card section"><h2>Import from the Excel ledger</h2>
    <p>Convert the workbook with <code>python3 tools/ledger_to_json.py National_Shipping_Ledger.xlsx &gt; import.json</code>, then choose the JSON file here.
    Existing rotation numbers are kept; records already in the system are skipped.</p>
    <label class="file">Import file<input type="file" id="imp" accept="application/json,.json"></label><pre id="impout" class="out" hidden></pre></section>`);

  $('#sf', main).addEventListener('submit', async (e) => {
    e.preventDefault(); const d = formData(e.target); d.require_extension_approval = d.require_extension_approval ? '1' : '0';
    try { await api.send('PUT', '/api/settings', d); toast('Rules saved.', 'success'); S.lookups = await api.get('/api/lookups'); } catch (err) { showFormError(e.target, err); }
  });
  $$('[data-list]', main).forEach((card) => {
    const [, cols] = LISTS[card.dataset.list];
    $('[data-addrow]', card).addEventListener('click', () => { $('tbody', card).insertAdjacentHTML('beforeend', String(row(cols))); $('tbody tr:last-child input', card).focus(); });
    $('[data-savelist]', card).addEventListener('click', async () => {
      const items = $$('tbody tr', card).map((tr) => Object.fromEntries($$('[data-k]', tr).map((i) => [i.dataset.k, i.type === 'checkbox' ? i.checked : i.value.trim()]))).filter((it) => it.name || it.code);
      try { S.lookups = await api.send('PUT', `/api/lists/${card.dataset.list}`, { items }); toast('List saved.', 'success'); } catch (err) { toast(err.message, 'error'); }
    });
  });
  $('#imp', main).addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const out = $('#impout', main);
    try {
      const r = await api.send('POST', '/api/import', JSON.parse(await file.text()));
      out.textContent = `Imported ${r.calls} vessel calls and ${r.extensions} extensions.\n${r.officers_created.length ? `Inactive placeholder accounts created for: ${r.officers_created.join(', ')} — activate them under Users.\n` : ''}${r.skipped.length ? `Skipped:\n  ${r.skipped.join('\n  ')}` : ''}`;
      out.hidden = false; toast('Import finished.', 'success');
    } catch (err) { out.textContent = err.message; out.hidden = false; toast(err.message, 'error'); }
  });
}
