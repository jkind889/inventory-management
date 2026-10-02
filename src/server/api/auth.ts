import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
let client: SupabaseClient | undefined;
export async function verifyToken(token: string): Promise<string | null> {
  if (!client) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (!url || !key) throw new Error("Supabase Auth is not configured.");
    client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  }
  // Verify with Auth; never trust decoded claims or an unverified client session.
  const { data, error } = await client.auth.getUser(token);
  return error || data.user?.is_anonymous ? null : data.user?.id ?? null;
}
