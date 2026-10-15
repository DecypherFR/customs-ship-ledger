// Admin-only account management: create sign-ins and reset passwords.
// These need the service-role key, so they run here (an Edge Function) and never in the browser.
// Plain JavaScript with no Deno APIs, so the same code runs in the local dev stack under Node.

const ROLES = ['officer', 'supervisor', 'investigator', 'management', 'admin'];
const cors = (origin) => ({
  'Access-Control-Allow-Origin': origin || '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  Vary: 'Origin',
});
const passwordProblem = (pw) => (typeof pw !== 'string' || pw.length < 10 ? 'Password must be at least 10 characters.'
  : !/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw) ? 'Password must contain letters and numbers.' : null);
const initialsOf = (name) => { const p = String(name).trim().split(/\s+/); return (p.length > 1 ? `${p[0][0]}.${p[p.length - 1]}` : p[0]).toUpperCase(); };

class HttpError extends Error { constructor(status, message, field) { super(message); this.status = status; this.field = field; } }

/**
 * @param {Request} req
 * @param {{SUPABASE_URL:string, SUPABASE_ANON_KEY:string, SUPABASE_SERVICE_ROLE_KEY:string, ALLOWED_ORIGINS?:string}} env
 * @param {Function} createClient  supabase-js createClient
 */
export async function handle(req, env, createClient) {
  const origin = req.headers.get('origin');
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const corsOrigin = !allowed.length || allowed.includes(origin) ? origin : allowed[0];
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors(corsOrigin) } });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(corsOrigin) });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed.' });

  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    // Who is calling? Must be an active administrator.
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: { user } = {}, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !user) throw new HttpError(401, 'Please sign in.');
    const { data: me } = await admin.from('profiles').select('*').eq('id', user.id).maybeSingle();
    if (!me || !me.active || me.role !== 'admin') throw new HttpError(403, 'Only an administrator can manage sign-ins.');
    if (me.must_change_password) throw new HttpError(403, 'Change your password to continue.');

    const b = await req.json().catch(() => ({}));
    const audit = (summary, details) => admin.from('audit').insert({ user_id: me.id, action: b.action === 'create' ? 'create' : 'reset', entity: 'user', summary, details });

    if (b.action === 'create') {
      const email = String(b.email || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address.', 'email');
      const pwErr = passwordProblem(b.password); if (pwErr) throw new HttpError(400, pwErr, 'password');
      let placeholder = null;
      if (b.link_profile_id) {
        const { data } = await admin.from('profiles').select('*').eq('id', b.link_profile_id).maybeSingle();
        if (!data || data.email) throw new HttpError(400, 'That person already has a sign-in.');
        placeholder = data;
      }
      const fullName = String(b.full_name || placeholder?.full_name || '').trim();
      const role = b.role || placeholder?.role;
      if (!fullName) throw new HttpError(400, 'Enter the full name.', 'full_name');
      if (!ROLES.includes(role)) throw new HttpError(400, 'Choose a role.', 'role');
      const station = b.station_code === undefined ? placeholder?.station_code ?? null : b.station_code || null;
      const { data: created, error } = await admin.auth.admin.createUser({ email, password: b.password, email_confirm: true, user_metadata: { full_name: fullName } });
      if (error) throw new HttpError(error.status === 422 || /already/i.test(error.message) ? 409 : 400, /already/i.test(error.message) ? 'That email already has a sign-in.' : error.message, 'email');
      const row = { email, full_name: fullName, initials: String(b.initials || placeholder?.initials || initialsOf(fullName)).trim().toUpperCase(),
        role, station_code: station, active: true, must_change_password: true };
      // Linking keeps every historic record attached: the placeholder's id becomes the new sign-in's id (FKs cascade).
      const { error: pErr } = placeholder
        ? await admin.from('profiles').update({ ...row, id: created.user.id }).eq('id', placeholder.id)
        : await admin.from('profiles').insert({ ...row, id: created.user.id });
      if (pErr) { await admin.auth.admin.deleteUser(created.user.id); throw new HttpError(400, pErr.message); }
      await audit(`Sign-in created for ${email} as ${role}`, { email, role, station_code: station });
      return json(200, { id: created.user.id, email });
    }

    if (b.action === 'reset_password') {
      const pwErr = passwordProblem(b.password); if (pwErr) throw new HttpError(400, pwErr, 'password');
      const { data: target } = await admin.from('profiles').select('*').eq('id', b.user_id).maybeSingle();
      if (!target || !target.email) throw new HttpError(404, 'User not found.');
      const { error } = await admin.auth.admin.updateUserById(target.id, { password: b.password });
      if (error) throw new HttpError(400, error.message);
      await admin.from('profiles').update({ must_change_password: true }).eq('id', target.id);
      await audit(`Password reset for ${target.email}`);
      return json(200, { ok: true });
    }
    throw new HttpError(400, 'Unknown action.');
  } catch (e) {
    return json(e.status || 500, { error: e.status ? e.message : 'Unexpected error.', field: e.field });
  }
}
