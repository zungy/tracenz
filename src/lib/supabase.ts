import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let browserClient: SupabaseClient | undefined;

/** Create one browser Supabase client using Astro's public environment variables. */
export function getSupabaseClient(): SupabaseClient | null {
  const url = import.meta.env.PUBLIC_SUPABASE_URL?.trim();
  const publishableKey = import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();

  if (!url || !publishableKey) return null;

  browserClient ??= createClient(url, publishableKey, {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: true,
      persistSession: true,
    },
  });

  return browserClient;
}
