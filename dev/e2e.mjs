import { chromium } from 'playwright';
import fs from 'node:fs';
// Browser walkthrough of every role against the local stack (npm run dev). Needs Playwright:
//   npm i --no-save playwright && APP_URL=http://localhost:8080 node dev/e2e.mjs /tmp/shots
// Reset the data first (npm run dev:db && npm run dev:demo): the script creates records with fixed numbers.
const S = process.argv[2] || '.'; const B = (process.env.APP_URL || 'http://localhost:8080').replace(/\/$/, '');
fs.mkdirSync(`${S}/shots`, { recursive: true });
const b = await chromium.launch(); const errors = []; const log = (...a) => console.log(...a);
const belizeToday = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Belize' }).format(new Date()) + 'T12:00:00Z');
const inDays = (n) => new Date(belizeToday.getTime() + n * 86400000).toISOString().slice(0, 10);
async function session(user, { vp = { width: 1360, height: 900 }, scheme = 'light', pw = 'Demo2026pass' } = {}) {
  const ctx = await b.newContext({ viewport: vp, colorScheme: scheme, acceptDownloads: true });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${user} pageerror: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error' && !/401|status of 40[0-9]/.test(m.text())) errors.push(`${user} console: ${m.text()}`); });
  await p.goto(B);
  await p.fill('input[name=username]', user.includes('@') ? user : `${user}@example.com`); await p.fill('input[name=password]', pw);
  await p.click('button[type=submit]');
  return { ctx, p };
}
const shot = async (p, name, full = true) => { await p.waitForTimeout(400); await p.screenshot({ path: `${S}/shots/${name}.png`, fullPage: full }); };
const toastText = async (p) => (await p.locator('.toast').allTextContents()).join(' | ');

// --- Supervisor, Belize City
let { ctx, p } = await session('jflowers'); await p.waitForSelector('.attn');
await shot(p, '01-dashboard-supervisor');
log('supervisor dashboard station:', await p.textContent('.hero .eyebrow'));
await p.goto(B + '/#/calls/new'); await p.waitForSelector('#cf');
await p.fill('#vsearch', 'OCEAN P'); await p.waitForSelector('#vresults li[data-i]'); await p.click('#vresults li[data-i]');
await p.fill('[name=rotation_seq]', '5801'); await p.fill('[name=voyage_no]', '5240');
await p.fill('[name=last_port]', 'Puerto Cortes, Honduras'); await p.fill('[name=next_port]', 'Kingston, Jamaica');
await p.fill('[name=estimated_departure]', inDays(5));
// Adding an agent that is already listed under another spelling picks the listed one.
await p.selectOption('[name=agent]', '__new'); await p.waitForSelector('dialog[open]');
await p.fill('dialog [name=name]', 'caribbean  shipping agency.'); await p.click('dialog button[type=submit]'); await p.waitForTimeout(1200);
log('new agent:', await toastText(p), '| selected:', await p.inputValue('[name=agent]'));
await p.click('button[type=submit]'); await p.waitForURL(/#\/calls\/\d+$/); await p.waitForSelector('.kv');
log('created:', await p.textContent('h1'));
await p.click('#depart'); await p.click('dialog button[type=submit]'); await p.waitForTimeout(1200);
await p.click('#verify'); await p.waitForTimeout(1200);
log('chips after verify:', (await p.textContent('.chips')).replace(/\s+/g, ' ').trim());
await p.click('summary:has-text("Record history")');
log('history entries:', await p.locator('.timeline li').count());
await shot(p, '02-call-detail');
const id = p.url().match(/calls\/(\d+)/)[1];
await p.goto(`${B}/#/calls/${id}/report`); await p.waitForSelector('.report'); await shot(p, '03-ship-report');
await p.goto(B + '/#/extensions'); await p.waitForSelector('.card'); log('supervisor pending (BZE only):', await p.locator('.queue li').count());
await ctx.close();

// --- Officer, San Pedro: scoping and approval rules
({ ctx, p } = await session('mcastillo')); await p.waitForSelector('.attn');
await p.goto(B + '/#/calls'); await p.waitForSelector('.tbl-ledger');
log('officer SPR sees stations:', [...new Set(await p.$$eval('td[data-l=Station]', (t) => t.map((x) => x.textContent)))]);
log('officer nav:', await p.$$eval('#nav a span', (s) => s.map((x) => x.textContent)));
await ctx.close();

// --- Supervisor San Pedro approves the officer's pending request
({ ctx, p } = await session('rnunez')); await p.waitForSelector('.attn');
await p.goto(B + '/#/extensions'); await p.waitForSelector('.queue li');
await p.click('[data-act=APPROVED]'); await p.click('dialog button[type=submit]'); await p.waitForTimeout(1200);
log('after approval toast:', await toastText(p));
await ctx.close();

// --- Investigator: overstay + case
({ ctx, p } = await session('kyoung')); await p.waitForSelector('.attn');
await p.goto(B + '/#/overstay'); await p.waitForSelector('.kpis'); await shot(p, '04-overstay');
await p.click('[data-case]'); await p.waitForSelector('dialog[open]');
await p.selectOption('dialog [name=status]', 'IN PROGRESS'); await p.fill('dialog [name=note]', 'Called agent; vessel awaiting parts, departure promised 20 Oct.');
await p.click('dialog button[type=submit]'); await p.waitForTimeout(1500);
log('case column:', (await p.locator('td[data-l=Case]').first().textContent()).replace(/\s+/g, ' ').trim());
await ctx.close();

// --- Comptroller: dark dashboard, audit, CSV export
({ ctx, p } = await session('comptroller', { scheme: 'dark' })); await p.waitForSelector('.attn'); await shot(p, '05-dashboard-dark');
await p.goto(B + '/#/audit'); await p.waitForSelector('.tbl'); log('audit rows:', await p.locator('tbody tr').count());
await p.goto(B + '/#/calls'); await p.waitForSelector('.tbl-ledger');
const [dl] = await Promise.all([p.waitForEvent('download'), p.click('a[href^="/api/export/calls.csv"]')]);
const csv = fs.readFileSync(await dl.path(), 'utf8'); log('csv:', dl.suggestedFilename(), csv.split('\r\n').length - 1, 'rows; header ok:', csv.includes('Vessel Type,Rotation Classification'));
log('comptroller can see New call?', await p.locator('#nav a:has-text("New call")').count());
await ctx.close();

// --- Admin: create a user through the edge function; the new user must change password
({ ctx, p } = await session('admin')); await p.waitForSelector('.attn');
await p.goto(B + '/#/admin/users'); await p.waitForSelector('.matrix');
await p.click('#add'); await p.waitForSelector('dialog[open]');
await p.fill('dialog [name=email]', 'new.officer@example.com'); await p.fill('dialog [name=full_name]', 'Nadia Pech');
await p.selectOption('dialog [name=role]', 'officer'); await p.selectOption('dialog [name=station_code]', 'PG');
await p.fill('dialog [name=password]', 'TempPass2026');
await p.click('dialog button[type=submit]'); await p.waitForTimeout(1500);
log('admin create toast:', await toastText(p));
await shot(p, '06-users');
await p.goto(B + '/#/admin/settings'); await p.waitForSelector('#sf');
await p.fill('[name=long_stay_days]', '45'); await p.click('#sf button'); await p.waitForTimeout(800); log('settings toast:', await toastText(p));
// Correct an agent's spelling everywhere.
const agents = p.locator('[data-ref=shipping_agents]');
await agents.locator('[data-filter]').fill('MARINE SUPPLY');
await agents.locator('tr:not([hidden]) [data-k=name]').fill('MARINE SUPPLY COMPANY'); await agents.locator('[data-savelist]').click();
await p.waitForTimeout(1200); log('agent renamed:', await toastText(p));
await p.goto(B + '/#/calls?q=gulf%20runner'); await p.waitForTimeout(1200);
await p.click('td[data-l="Rotation No."] a'); await p.waitForSelector('.kv'); log('call now shows agent:', await p.locator('dt:has-text("Shipping agent") + dd').textContent());
await ctx.close();
({ ctx, p } = await session('new.officer@example.com', { pw: 'TempPass2026' }));
await p.waitForSelector('#pw'); log('forced password screen shown');
await p.fill('[name=current]', 'TempPass2026'); await p.fill('[name=password]', 'MyOwnPass2026'); await p.fill('[name=repeat]', 'MyOwnPass2026');
await p.click('#pw button'); await p.waitForSelector('.attn'); log('new officer reached dashboard:', await p.textContent('.hero .eyebrow'));
await ctx.close();

// --- Officer Belize City on a phone: offline entry then sync
({ ctx, p } = await session('jreyes', { vp: { width: 390, height: 844 } })); await p.waitForSelector('.attn');
await shot(p, '07-mobile-dashboard', false);
await p.goto(B + '/#/calls/new'); await p.waitForSelector('#cf');
await p.evaluate(() => navigator.serviceWorker.ready); await p.reload(); await p.waitForSelector('#cf');
await ctx.setOffline(true);
await p.selectOption('[name=vessel_type]', 'Fishing Vessel'); await p.fill('[name=vessel_name]', 'Miss Belize'); await p.fill('[name=crew]', '5');
await p.fill('[name=estimated_departure]', inDays(3));
await p.click('button[type=submit]'); await p.waitForURL(/#\/calls$/); await p.waitForSelector('tr.pending');
log('offline:', await p.textContent('#conn')); await shot(p, '08-mobile-offline', false);
await p.reload(); await p.waitForSelector('tr.pending'); log('app restarted offline and still shows the queued call');
await ctx.setOffline(false); await p.evaluate(() => window.dispatchEvent(new Event('online'))); await p.waitForTimeout(2500);
await p.goto(B + '/#/calls?q=miss'); await p.waitForTimeout(1500);
log('after sync:', await p.textContent('#conn'), '| rows:', await p.$$eval('td[data-l="Rotation No."] a', (r) => r.map((x) => x.textContent)));
await ctx.close();

log('ERRORS:', errors.length ? errors : 'none');
await b.close();
