// Small helpers shared by every Edge Function: clients, auth, JSON responses.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type Db = SupabaseClient;

export function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

// API keys: the new publishable (sb_publishable_...) and secret (sb_secret_...) keys, not the
// legacy anon / service_role JWTs, which Supabase is retiring by the end of 2026.
// Hosted functions get SUPABASE_PUBLISHABLE_KEYS / SUPABASE_SECRET_KEYS (JSON keyed by key name);
// the local CLI provides single SUPABASE_PUBLISHABLE_KEY / SUPABASE_SECRET_KEY values.
function apiKey(kind: 'PUBLISHABLE' | 'SECRET'): string | undefined {
  const dict = Deno.env.get(`SUPABASE_${kind}_KEYS`);
  if (dict) {
    try {
      const k = (JSON.parse(dict) as Record<string, string>)['default'];
      if (k) return k;
    } catch {
      // fall through to the single-key variable
    }
  }
  return Deno.env.get(`SUPABASE_${kind}_KEY`) || undefined;
}

function requireKey(kind: 'PUBLISHABLE' | 'SECRET'): string {
  const k = apiKey(kind);
  if (!k) throw new Error(`Missing environment variable SUPABASE_${kind}_KEYS (or SUPABASE_${kind}_KEY)`);
  return k;
}

/** Admin client (secret key): bypasses RLS. Use only after checking the caller. */
export function serviceClient(): Db {
  return createClient(env('SUPABASE_URL'), requireKey('SECRET'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Client acting as the caller (publishable key + the caller's JWT, so RLS applies). */
export function userClient(req: Request): Db {
  return createClient(env('SUPABASE_URL'), requireKey('PUBLISHABLE'), {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/**
 * True when the request carries the project's secret key in the `apikey` header (pg_cron /
 * internal calls). Secret keys are not JWTs, so they are never sent as `Authorization: Bearer`.
 * These functions run with verify_jwt = false (config.toml), so this check is the gate.
 */
export function isServiceCall(req: Request): boolean {
  const sent = req.headers.get('apikey');
  const key = apiKey('SECRET');
  return !!sent && !!key && timingSafeEqual(sent, key);
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** The caller's user id, if they are an active owner/member of the project; else throws 403. */
export async function requireProjectStaff(req: Request, projectId: string): Promise<string> {
  const db = userClient(req);
  const { data: u } = await db.auth.getUser();
  if (!u.user) throw new HttpError(401, 'Not signed in');
  const { data } = await db
    .from('project_members')
    .select('role')
    .eq('project_id', projectId)
    .eq('user_id', u.user.id)
    .is('left_at', null)
    .in('role', ['owner', 'member'])
    .maybeSingle();
  if (!data) throw new HttpError(403, 'Not a member of this project');
  return u.user.id;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Wraps a handler: JSON errors, no stack traces to clients. */
export function handle(fn: (req: Request) => Promise<Response>): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
    try {
      return await fn(req);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'Internal error' }, 500);
    }
  };
}
