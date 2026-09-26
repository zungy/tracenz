import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const PROJECT_URL = 'https://sbupyqgysoznucelwsij.supabase.co';
const PUBLISHABLE_KEY = 'sb_publishable_1dB-sxxKQ-DxiYgPrlnVzg_ecucKZ-l';
export const TRACE_API_URL = `${PROJECT_URL}/functions/v1/trace`;
const STORAGE_KEY = 'trace-web-auth';
let browserClient: SupabaseClient | undefined;
let browserStorage: ReturnType<typeof createSessionStorage> | undefined;

/** The SDK owns token rotation; this adapter only chooses the user's persistence. */
export function createSessionStorage(session: Storage, local: Storage) {
  let remember = !session.getItem(STORAGE_KEY) && Boolean(local.getItem(STORAGE_KEY));
  return {
    getItem(key: string) {
      return (remember ? local : session).getItem(key);
    },
    setItem(key: string, value: string) {
      (remember ? local : session).setItem(key, value);
    },
    removeItem(key: string) {
      session.removeItem(key);
      local.removeItem(key);
    },
    setRemember(value: boolean) {
      remember = value;
      session.removeItem(STORAGE_KEY);
      local.removeItem(STORAGE_KEY);
    },
  };
}

export function setRememberSession(remember: boolean) {
  getSupabaseClient();
  browserStorage!.setRemember(remember);
}

export function clearStoredSession() {
  browserStorage?.removeItem(STORAGE_KEY);
}

/** A single SDK client coordinates refreshes and sign-out across browser tabs. */
export function getSupabaseClient(): SupabaseClient {
  if (browserClient) return browserClient;
  const url = import.meta.env?.PUBLIC_SUPABASE_URL?.trim() || PROJECT_URL;
  const key = import.meta.env?.PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() || PUBLISHABLE_KEY;
  if (url.replace(/\/$/, '') !== PROJECT_URL) {
    throw new Error('Trace account configuration does not match the desktop workspace.');
  }
  browserStorage = createSessionStorage(window.sessionStorage, window.localStorage);
  browserClient = createClient(url, key, {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: false,
      persistSession: true,
      storageKey: STORAGE_KEY,
      storage: browserStorage,
    },
  });
  return browserClient;
}
