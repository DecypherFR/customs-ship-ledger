// Supabase Edge Function entry point. The logic lives in handler.js so it can also be tested locally.
import { createClient } from 'npm:@supabase/supabase-js@2.117.2';
import { handle } from './handler.js';

Deno.serve((req: Request) => handle(req, {
  SUPABASE_URL: Deno.env.get('SUPABASE_URL')!,
  SUPABASE_ANON_KEY: Deno.env.get('SUPABASE_ANON_KEY')!,
  SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  ALLOWED_ORIGINS: Deno.env.get('ALLOWED_ORIGINS') ?? '',
}, createClient));
