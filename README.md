# National Ships Ledger: Belize Customs & Excise Department

A Progressive Web App that replaces the `National_Shipping_Ledger.xlsx` workbook. It keeps the workbook's structure (Vessel Movements, Extension Log, Ship's Report, Dashboard and Overstay Investigation Register) and its rules, adds user accounts with role-based access, and works offline at stations with poor connectivity.

## How it is built

| Piece | Where it runs | What it does |
|---|---|---|
| `public/` | Static hosting (GitHub Pages) | The PWA: HTML, CSS and JavaScript, installable and usable offline |
| `supabase/migrations/` | Supabase Postgres | Tables, the ledger's business rules, and **all permission checks** |
| `supabase/functions/admin-users/` | Supabase Edge Function | Creating sign-ins and resetting passwords (needs the service key, so never runs in the browser) |
| Supabase Auth | Supabase | Email and password sign-in |

**Security model.** Every table has row-level security. Signed-in users can only *read* what their role allows: station officers and supervisors see only their own station. There are **no direct write permissions** at all. Every change goes through a database function that checks the caller's role and applies the ledger's rules, then writes an audit entry. The `anon` key in `public/config.js` is public by design: with it, a person who isn't signed in can read nothing and change nothing.

## Roles

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

Officers and supervisors who are assigned a station see only that station's records. Nobody can approve their own extension request.

## Deploying

1. Create a Supabase project. Put its URL and `anon` key in `public/config.js`.
2. Set two environment variables. **Don't commit them.**
   - `SUPABASE_DB_URL`: from **Connect → Session pooler**, with the database password.
   - `SUPABASE_ACCESS_TOKEN`: a personal access token from https://supabase.com/dashboard/account/tokens.
3. Run:
   ```bash
   ADMIN_EMAIL=you@example.gov.bz tools/deploy.sh
   ```
   This does the following:
   - applies the migrations;
   - deploys the `admin-users` function;
   - turns **off** public sign-ups, so only administrators create accounts;
   - creates the first administrator and prints a one-time temporary password, which must be changed at first sign-in;
   - publishes `public/` to GitHub Pages.

   The script is safe to re-run.
4. Sign in, then add staff under **Users**.

### Importing the existing Excel ledger

```bash
python3 tools/ledger_to_json.py National_Shipping_Ledger.xlsx > import.json   # needs openpyxl
```

Then upload `import.json` under **Lists & settings → Import**. Existing rotation numbers are kept. Officers named in the workbook (for example `J.REYES`) become placeholder entries with no sign-in. **Give sign-in** on the Users page creates an account for them and keeps their history attached.

### Demo data (test projects only)

```bash
DATABASE_URL=$SUPABASE_DB_URL SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=... node tools/demo.mjs
```

This creates seven `@example.com` accounts, one per role, with the password `Demo2026pass`, plus about 40 vessel calls. Never run it against the live ledger.

## Local development

You need Node.js 22 or newer, PostgreSQL 15 or newer, and the [PostgREST](https://github.com/PostgREST/postgrest/releases) binary (version 12).

```bash
npm install
npm run dev:db            # fresh local database that behaves like Supabase (dev/supabase_shim.sql + migrations)
npm run dev:demo          # demo accounts and data
POSTGREST_BIN=/path/to/postgrest npm run dev    # app on http://localhost:8080, API on :54321
```

`dev/stack.mjs` stands in for Supabase locally. It runs PostgREST, which is the same API server Supabase uses, plus a minimal auth server and the real `admin-users` handler. The app runs against it unchanged, using the real supabase-js library.

### Tests

```bash
npm test                  # 14 database tests: rules, RLS and permissions, run as real signed-in users
npm i --no-save playwright && node dev/e2e.mjs /tmp/out   # browser walkthrough of every role, incl. offline sync
```

The database tests need a local Postgres. Set `TEST_DATABASE_URL` if it isn't `postgres://postgres@localhost:5432/postgres`.

## What it does beyond the spreadsheet

- **Rotation numbers are issued inside the database under a lock.** Two stations can't receive the same number. CRG numbers supplied by agents are checked for duplicates. The year comes from the arrival date, so nobody has to change cell B4 at New Year.
- **Vessel registry.** Repeat callers' particulars, last master, agent, crew and cargo fill in automatically.
- **Live data check.** The workbook's "Data Check" column shows as you type. Hard errors block saving: departure before arrival, a future arrival date, or a departed vessel with no clearance officer.
- **Estimated date of departure (EDD).** Every vessel in port has an EDD. Until an extension is approved, the approved stay ends on the EDD; after it the vessel is OVERDUE. Once a call is saved, only a supervisor or administrator can move its EDD: officers request an extension instead.
- **Extension approval workflow.** Officers request an extension and a supervisor decides. The first extension starts from the EDD; later ones carry over the previous extension's expiry.
- **Earlier warnings.** Besides OVERDUE and URGENT (3 or more extensions), the app flags approved stays **ending soon**. Calls recorded before EDDs existed, with no extension, are flagged as **long stays**. The thresholds can be set under Lists & settings.
- **Standard lists of shipping agents and flags.** Calls pick the agent and flag / nationality from a list, so one agent is not spelled five ways. Officers can add a new agent while recording a call (a variant spelling of a listed agent picks the listed one). Administrators correct names under Lists & settings, which updates every call, and merge duplicates by renaming one entry to the other's name. The flag list starts with every country.
- **Investigation cases.** Notes, an assignee, a status and an outcome are attached to the vessel call, not to a spreadsheet row.
- **Verify & lock.** A supervisor signs off a departed call. Unlocking requires a reason.
- **Audit trail.** Sign-ins, every change (with before and after values), approvals, exports and deletions are all recorded.
- **Offline.** Recently opened pages are kept on the device. New calls, departures, extension requests and Ship's Reports are queued and sent when the connection returns. Each queued item has an ID, so sending it twice can't create a duplicate.
- **Conflict protection.** Two people editing the same call can't silently overwrite each other.

### Issues found in the workbook (fixed here)

1. The **Liveaboard Vessel** dropdown entry has a leading space and doesn't match the LISTS sheet, so liveaboards were classed as `OTH`. They now get their own `LVB` class. Imported records keep their original numbers.
2. The **Remarks** column (X) contains a formula that overwrites remarks with the Last Port's month.
3. The dashboard formulas only cover rows 6–505, while the data sheets run to row 1004.
4. Overstay investigation notes are typed beside formula-driven rows, so they become misaligned when the overdue list changes.
5. Ship's Report fields such as Pilot, Health Official and Rummaged are single cells that the next report overwrites.
6. Typing errors in the sample rows (a misspelt port name, and a container vessel with cargo "Liveaboard"). The app suggests ports from earlier entries to reduce these.

## Layout

```
public/                    the PWA (config.js holds the Supabase URL and anon key)
supabase/migrations/       schema, RLS policies and business-rule functions
supabase/functions/        admin-users edge function (handler.js is shared with the local stack)
tools/                     deploy.sh, ledger_to_json.py (Excel → JSON), demo.mjs
dev/                       local Supabase stand-in, database shim, browser walkthrough
test/                      database tests
```
