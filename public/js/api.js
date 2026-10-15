// API client with an offline outbox.
// Writes made while offline are kept in IndexedDB and replayed in order when the connection returns.
// Each queued create carries a client_uuid so a replay can never create a duplicate record.

const DB_NAME = 'ledger-offline';
let dbp;
function idb() {
  dbp ||= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}
async function store(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('outbox', mode);
    const req = fn(t.objectStore('outbox'));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
  });
}
export const outbox = {
  all: () => store('readonly', (s) => s.getAll()),
  add: (item) => store('readwrite', (s) => s.add(item)),
  put: (item) => store('readwrite', (s) => s.put(item)),
  remove: (id) => store('readwrite', (s) => s.delete(id)),
  clear: () => store('readwrite', (s) => s.clear()),
};

export class ApiError extends Error {
  constructor(status, data) { super(data.error || `Request failed (${status})`); this.status = status; this.data = data; }
}

const listeners = new Set();
export const onSync = (fn) => listeners.add(fn);
const emit = (e) => listeners.forEach((fn) => fn(e));

async function request(method, url, body) {
  const res = await fetch(url, {
    method, credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const fromCache = res.headers.get('x-from-cache') === '1';
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(res.status, typeof data === 'string' ? { error: data } : data);
  if (fromCache && data && typeof data === 'object') Object.defineProperty(data, '__offline', { value: true });
  return data;
}

export const api = {
  get: (url) => request('GET', url),
  // queueable writes: if the network is unreachable the write is stored and replayed later.
  async send(method, url, body, { queueable = false, label = '' } = {}) {
    if (queueable && body && !body.client_uuid && method === 'POST') body.client_uuid = crypto.randomUUID();
    if (queueable && !navigator.onLine) return queue(method, url, body, label);
    try { return await request(method, url, body); }
    catch (e) {
      if (queueable && e instanceof TypeError) return queue(method, url, body, label); // network failure
      throw e;
    }
  },
};

async function queue(method, url, body, label) {
  await outbox.add({ method, url, body, label, queued_at: new Date().toISOString(), error: null });
  emit({ type: 'queued' });
  return { queued: true, client_uuid: body && body.client_uuid };
}

let flushing = false;
export async function flushOutbox() {
  if (flushing || !navigator.onLine) return;
  flushing = true;
  let sent = 0;
  try {
    for (const item of await outbox.all()) {
      if (item.error) continue; // needs user attention
      try {
        await request(item.method, item.url, item.body);
        await outbox.remove(item.id); sent++;
      } catch (e) {
        if (e instanceof TypeError) break; // still offline
        if (e.status === 401) break;       // signed out - retry after sign-in
        item.error = e.message; await outbox.put(item);
      }
    }
  } finally { flushing = false; emit({ type: 'flushed', sent }); }
}
window.addEventListener('online', () => flushOutbox());
