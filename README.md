# National Ships Ledger — Belize Customs & Excise Department

A Progressive Web App that replaces the `National_Shipping_Ledger.xlsx` workbook. It keeps the workbook's structure (Vessel Movements, Extension Log, Ship's Report, Dashboard and Overstay Investigation Register) and its rules, adds user accounts with role-based access, and works offline at stations with poor connectivity.

## Quick start

Requires **Node.js 22.5 or newer** and nothing else. There are no npm dependencies; the database is SQLite through Node's built-in `node:sqlite`.

```bash
npm start                      # http://localhost:8080, database in data/ledger.db
```

On first start an `admin` account is created with password `ChangeMe!2026`, or the value of `ADMIN_PASSWORD` if set. The admin must choose a new password at first sign-in.

### Try it with demo data

```bash
DB_FILE=data/demo.db npm run demo
DB_FILE=data/demo.db npm start
```

All demo accounts use the password `Demo2026pass`:

| Username | Role | Station |
|---|---|---|
| `gdominguez` | Customs Officer | Belize City |
| `mcastillo` | Customs Officer | San Pedro |
| `jflowers` | Station Supervisor | Belize City |
| `rnunez` | Station Supervisor | San Pedro |
| `kyoung` | Investigations Officer | national |
| `comptroller` | Comptroller / Management | national |
| `admin` | System Administrator | national |

### Import the existing Excel ledger

```bash
python3 tools/ledger_to_json.py National_Shipping_Ledger.xlsx > import.json   # needs openpyxl
npm run import -- import.json          # or upload the JSON under Lists & settings
```

Existing rotation numbers are kept, so paperwork already issued still matches. Officers named in the workbook (for example `G.DOMINGUEZ`) become inactive placeholder accounts. An administrator can activate them.

### Tests

```bash
npm test
```

There are 14 API tests. They cover rotation numbering, validation, station scoping, permissions, the extension approval workflow, overstay status, optimistic locking, verification locks, offline replay de-duplication and CSV export.

## Roles

Officers and supervisors who are assigned a station see and record **only that station's** vessel calls. Every other role has national scope. All permissions are enforced on the server, not only hidden in the UI.

| Permission | Officer | Supervisor | Investigator | Management | Admin |
|---|:-:|:-:|:-:|:-:|:-:|
| View vessel calls | ✓ | ✓ | ✓ | ✓ | ✓ |
| Record calls, departures, Ship's Reports | ✓ | ✓ | | | ✓ |
| Request extensions | ✓ | ✓ | | | ✓ |
| Approve / reject extensions, verify & lock calls | | ✓ | | | ✓ |
| Overstay register & investigation cases | | ✓ | ✓ | view | ✓ |
| CSV export | | ✓ | ✓ | ✓ | ✓ |
| Audit trail | | | | ✓ | ✓ |
| Users, reference lists, settings, delete records | | | | | ✓ |

## What it does beyond the spreadsheet

- **Rotation numbers are issued by the server inside a transaction.** Two stations can't receive the same number. CRG numbers supplied by agents are checked for duplicates. The year comes from the arrival date, so nobody has to change cell B4 at New Year.
- **Vessel registry.** Type part of a name or IMO number and the vessel's particulars, last master, agent, crew and cargo fill in from its previous call.
- **Live data check.** The workbook's "Data Check" column shows as you type. Hard errors block saving: departure before arrival, a future arrival date, or a departed vessel with no clearance officer.
- **Extension approval workflow.** Officers request an extension and a supervisor approves or rejects it. Nobody can approve their own request. The original expiry is filled in from the previous extension, and a new expiry must come later.
- **Earlier warnings.** Besides OVERDUE and URGENT (3 or more extensions), the app flags **expiring soon** (within 7 days) and **long stay with no extension** (more than 30 days in port). Both thresholds can be changed under Lists & settings.
- **Investigation cases.** Notes, an assignee, a status and an outcome are attached to the vessel call. In the workbook, notes typed beside a formula-driven row could end up next to the wrong vessel when the list changed.
- **Verify & lock.** A supervisor signs off a departed call, after which only an administrator can change it. Unlocking requires a reason.
- **Ship's Report per call.** The officer's report section (times, health official, pilot, fumigated, rummaged) is stored with each call instead of being overwritten. The report prints on one page.
- **Audit trail.** Every sign-in, change (with before and after values), approval, export and deletion is recorded.
- **Offline.** The app installs on phones and tablets. Without a connection, officers can still open recently viewed pages and record new calls, departures, extension requests and Ship's Reports. These are queued on the device and sent when the connection returns. Each queued item has an ID, so sending it twice can't create a duplicate.
- **Conflict protection.** If two people edit the same call, the second person to save is told to reload, so nobody's changes are silently overwritten.
- **Security.** Passwords are hashed with scrypt. Sessions use HttpOnly SameSite=Strict cookies, accounts lock after 5 failed sign-ins, users must change their password at first sign-in, and the app sends a strict Content Security Policy.

### Issues found in the workbook (fixed here)

1. The **Liveaboard Vessel** dropdown entry has a leading space and doesn't match the LISTS sheet, so liveaboards were classed as `OTH`. They now get their own `LVB` class. Imported records keep their original numbers.
2. The **Remarks** column (X) contains a formula (`=TEXT(O6,"yyyy-mm")`) that overwrites remarks with the month of the Last Port.
3. The dashboard formulas only cover rows 6–505, while the movement sheet and the Extension Log run to row 1004. Calls after row 505 are left out of the totals.
4. Overstay investigation notes are typed beside formula-driven rows, so they become misaligned when the overdue list changes.
5. Ship's Report fields such as Pilot, Health Official and Rummaged are single cells that the next report overwrites.
6. Data entry errors in the sample data: `KINGSTON, JAMAIACA`, and a container vessel with cargo "Liveaboard". The app suggests ports from earlier entries to reduce typos like the first one.

## Deployment notes

- Run behind HTTPS, which service workers and installation require. Use a reverse proxy such as nginx or IIS and set `COOKIE_SECURE=1`.
- Environment variables: `PORT` (default 8080), `DB_FILE`, `SESSION_HOURS` (default 12), `ADMIN_PASSWORD` (first run only), `COOKIE_SECURE`.
- Back up the SQLite file in `data/`, for example nightly with `sqlite3 data/ledger.db ".backup backup.db"`.
- "Today" is computed in Belize time (America/Belize).

## Layout

```
server/   server.js (HTTP + API), db.js (schema, seed lists), auth.js (passwords, roles), ledger.js (business rules)
public/   index.html, sw.js, manifest, css/, js/ (app shell, views, forms, admin, offline API client)
tools/    ledger_to_json.py (Excel → JSON), import.js, demo.js
test/     api.test.js
```
