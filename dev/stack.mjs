// Local stand-in for a Supabase project, for development and browser tests only.
//   http://localhost:54321  -> /rest/v1 (PostgREST), /auth/v1 (minimal GoTrue-compatible auth), /functions/v1/admin-users
//   http://localhost:8080   -> the PWA in public/, with config.js pointing at the local stack
// Usage: POSTGREST_BIN=/path/to/postgrest DATABASE_URL=postgres://postgres:postgres@localhost/ledger_dev node dev/stack.mjs
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { handle as adminUsers } from '../supabase/functions/admin-users/handler.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/ledger_dev';
const SECRET = 'local-dev-jwt-secret-with-at-least-32-characters';
const API_PORT = 54321; const APP_PORT = Number(process.env.APP_PORT || 8080); const PGRST_PORT = 3011;
const API = `http://localhost:${API_PORT}`;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (claims) => { const h = b64({ alg: 'HS256', typ: 'JWT' }); const p = b64(claims); return `${h}.${p}.${crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`; };
const verify = (t) => {
  const [h, p, s] = String(t || '').split('.');
  if (!s || crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url') !== s) return null;
  const c = JSON.parse(Buffer.from(p, 'base64url')); return c.exp * 1000 > Date.now() ? c : null;
};
const now = () => Math.floor(Date.now() / 1000);
export const ANON_KEY = sign({ iss: 'supabase-local', role: 'anon', iat: now(), exp: now() + 10 * 365 * 86400 });
const SERVICE_KEY = sign({ iss: 'supabase-local', role: 'service_role', iat: now(), exp: now() + 10 * 365 * 86400 });

const pool = new pg.Pool({ connectionString: DB_URL });
pool.on('error', (e) => console.warn('db pool:', e.message)); // e.g. the dev database was reset
const q = (sql, a) => pool.query(sql, a).then((r) => r.rows);
const userJson = (u) => ({ id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, email_confirmed_at: u.created_at,
  app_metadata: { provider: 'email' }, user_metadata: u.raw_user_meta_data || {}, created_at: u.created_at, updated_at: u.created_at });
const refreshTokens = new Map();
function session(u) {
  const exp = now() + 3600; const refresh = crypto.randomBytes(24).toString('hex'); refreshTokens.set(refresh, u.id);
  return { access_token: sign({ sub: u.id, email: u.email, role: 'authenticated', aud: 'authenticated', iat: now(), exp }),
    token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: refresh, user: userJson(u) };
}

// ---- PostgREST
const conf = path.join(root, 'dev', '.postgrest.conf');
fs.writeFileSync(conf, `db-uri = "${DB_URL.replace(/\/\/[^@]+@/, '//authenticator:authenticator@')}"\ndb-schemas = "public"\ndb-anon-role = "anon"\n` +
  `jwt-secret = "${SECRET}"\nserver-port = ${PGRST_PORT}\nserver-host = "127.0.0.1"\nlog-level = "warn"\n`);
const pgrst = spawn(process.env.POSTGREST_BIN || 'postgrest', [conf], { stdio: 'inherit' });
process.on('exit', () => pgrst.kill());
process.on('SIGINT', () => process.exit(0)); process.on('SIGTERM', () => process.exit(0));

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', 'Access-Control-Expose-Headers': 'Content-Range' };
const readBody = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', ...CORS }); res.end(body === undefined ? '' : JSON.stringify(body)); };
const authErr = (res, status, msg, code = 'invalid_credentials') => send(res, status, { code: status, error_code: code, msg });

async function auth(req, res, url, body) {
  const route = url.pathname.replace('/auth/v1', '');
  const bearer = (req.headers.authorization || '').replace(/^Bearer /i, '');
  const claims = verify(bearer);
  const isService = claims && claims.role === 'service_role';
  if (route === '/token' && url.searchParams.get('grant_type') === 'password') {
    const [u] = await q('select * from auth.users where lower(email)=lower($1) and encrypted_password = extensions.crypt($2, encrypted_password)', [body.email, body.password || '']);
    return u ? send(res, 200, session(u)) : authErr(res, 400, 'Invalid login credentials');
  }
  if (route === '/token' && url.searchParams.get('grant_type') === 'refresh_token') {
    const id = refreshTokens.get(body.refresh_token); refreshTokens.delete(body.refresh_token);
    const [u] = id ? await q('select * from auth.users where id=$1', [id]) : [];
    return u ? send(res, 200, session(u)) : authErr(res, 400, 'Invalid Refresh Token', 'refresh_token_not_found');
  }
  if (route === '/logout') return send(res, 204);
  if (route === '/user') {
    if (!claims || !claims.sub) return authErr(res, 401, 'invalid JWT', 'bad_jwt');
    if (req.method === 'PUT' && body.password) await q("update auth.users set encrypted_password = extensions.crypt($2, extensions.gen_salt('bf')) where id=$1", [claims.sub, body.password]);
    const [u] = await q('select * from auth.users where id=$1', [claims.sub]);
    return u ? send(res, 200, userJson(u)) : authErr(res, 404, 'User not found', 'user_not_found');
  }
  if (route.startsWith('/admin/users')) {
    if (!isService) return authErr(res, 403, 'User not allowed', 'not_admin');
    const id = route.split('/')[3];
    if (req.method === 'POST') {
      if ((await q('select 1 from auth.users where lower(email)=lower($1)', [body.email])).length) return authErr(res, 422, 'A user with this email address has already been registered', 'email_exists');
      const [u] = await q("insert into auth.users(email, encrypted_password, raw_user_meta_data) values (lower($1), extensions.crypt($2, extensions.gen_salt('bf')), $3) returning *",
        [body.email, body.password, body.user_metadata || {}]);
      return send(res, 200, userJson(u));
    }
    if (req.method === 'PUT' && id) {
      if (body.password) await q("update auth.users set encrypted_password = extensions.crypt($2, extensions.gen_salt('bf')) where id=$1", [id, body.password]);
      const [u] = await q('select * from auth.users where id=$1', [id]);
      return send(res, 200, userJson(u));
    }
    if (req.method === 'DELETE' && id) { await q('delete from auth.users where id=$1', [id]); return send(res, 200, {}); }
  }
  return authErr(res, 404, `Not implemented in the local auth stub: ${req.method} ${route}`, 'not_found');
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, API);
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  const raw = await readBody(req);
  try {
    if (url.pathname.startsWith('/auth/v1')) return await auth(req, res, url, raw.length ? JSON.parse(raw) : {});
    if (url.pathname === '/functions/v1/admin-users') {
      const r = await adminUsers(new Request(API + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw }),
        { SUPABASE_URL: API, SUPABASE_ANON_KEY: ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY }, createClient);
      res.writeHead(r.status, Object.fromEntries(r.headers)); return res.end(Buffer.from(await r.arrayBuffer())); // the function sets its own CORS headers
    }
    if (url.pathname.startsWith('/rest/v1')) {
      const headers = { ...req.headers, host: `127.0.0.1:${PGRST_PORT}` };
      if (!headers.authorization && headers.apikey) headers.authorization = `Bearer ${headers.apikey}`;
      const up = http.request({ host: '127.0.0.1', port: PGRST_PORT, method: req.method, path: url.pathname.replace('/rest/v1', '') + url.search, headers }, (r) => {
        const h = Object.fromEntries(Object.entries(r.headers).filter(([k]) => !k.startsWith('access-control-')));
        res.writeHead(r.statusCode, { ...h, ...CORS }); r.pipe(res);
      });
      up.on('error', (e) => send(res, 502, { message: e.message })); up.end(raw); return;
    }
    send(res, 404, { message: 'not found' });
  } catch (e) { console.error(e); send(res, 500, { message: e.message }); }
}).listen(API_PORT, () => console.log(`Local Supabase stand-in: ${API}`));

// ---- static app
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
// APP_BASE=/customs-ship-ledger mimics GitHub Pages, which serves the app from a sub-folder.
const BASE = (process.env.APP_BASE || '').replace(/\/$/, '');
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (BASE) {
    if (p === BASE) { res.writeHead(301, { Location: `${BASE}/` }); return res.end(); }
    if (!p.startsWith(`${BASE}/`)) { res.writeHead(404); return res.end('Not found'); }
    p = p.slice(BASE.length);
  }
  if (p === '/config.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' });
    return res.end(`window.LEDGER_CONFIG = ${JSON.stringify({ supabaseUrl: API, supabaseAnonKey: ANON_KEY })};`);
  }
  let file = path.join(root, 'public', p);
  if (!file.startsWith(path.join(root, 'public')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'public', 'index.html');
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}).listen(APP_PORT, () => console.log(`App: http://localhost:${APP_PORT}${BASE}/`));
