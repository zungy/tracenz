import type { SupabaseClient, Session } from '@supabase/supabase-js';
import {
  clearStoredSession,
  getSupabaseClient,
  setRememberSession,
  TRACE_API_URL,
} from './supabase.ts';

export interface TraceUser {
  id: string;
  email?: string;
}
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** Injectable SDK/fetch boundary keeps session races testable without live accounts. */
export function createTraceClient(
  client: Pick<SupabaseClient, 'auth'>,
  fetcher: typeof fetch = fetch,
  rememberSession: (remember: boolean) => void = () => {},
  clearSession: () => void = () => {},
) {
  let epoch = 0;
  let authIntent = 0;
  let signedOut = false;
  let userId: string | null | undefined;
  let refresh: Promise<Session> | null = null;
  const listeners = new Set<(user: TraceUser | null) => void>();
  client.auth.onAuthStateChange((_event, session) => {
    const nextId = session?.user.id ?? null;
    if (userId !== undefined && nextId !== userId) epoch++;
    userId = nextId;
    for (const listener of listeners) listener(session?.user ?? null);
  });

  const checkEpoch = (expected: number) => {
    if (expected !== epoch) throw new ApiError('Your session changed. Please sign in again.', 401);
  };

  const authFailure = (error: { status?: number; message: string }) => {
    if (error.status === 400 || error.status === 401 || error.status === 403) {
      return new ApiError('Your session expired. Please log in again.', 401);
    }
    return error;
  };

  async function session(): Promise<Session> {
    if (signedOut) throw new ApiError('Log in to view your traces.', 401);
    const before = epoch;
    const { data, error } = await client.auth.getSession();
    checkEpoch(before);
    if (error) throw authFailure(error);
    if (!data.session) throw new ApiError('Log in to view your traces.', 401);
    return data.session;
  }

  async function refreshed(token: string, expected: number): Promise<Session> {
    checkEpoch(expected);
    const current = await session();
    checkEpoch(expected);
    if (current.access_token !== token) return current;
    if (!refresh) {
      const pending = client.auth.refreshSession().then(({ data, error }) => {
        checkEpoch(expected);
        if (error) throw authFailure(error);
        if (!data.session) throw new ApiError('Your session expired. Please log in again.', 401);
        return data.session;
      });
      refresh = pending;
      void pending
        .finally(() => {
          if (refresh === pending) refresh = null;
        })
        .catch(() => {});
    }
    return refresh;
  }

  async function request(path: string, options: RequestInit = {}, binary = false) {
    // Event content can never direct a bearer token to another origin.
    if (!/^\/api\/[a-z0-9/_-]+(?:\?[^#]*)?$/i.test(path)) {
      throw new ApiError('Invalid Trace API path.', 400);
    }
    if (options.method && options.method.toUpperCase() !== 'GET') {
      throw new ApiError('The web viewer only supports reading and downloading traces.', 405);
    }
    const expected = epoch;
    const initial = await session();
    checkEpoch(expected);
    const send = (token: string) => {
      const headers = new Headers(options.headers);
      headers.set('Authorization', `Bearer ${token}`);
      headers.set('Accept', binary ? 'application/octet-stream' : 'application/json');
      const timeout = AbortSignal.timeout(30000);
      return fetcher(TRACE_API_URL + path, {
        ...options,
        method: 'GET',
        headers,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      });
    };
    let response = await send(initial.access_token);
    checkEpoch(expected);
    if (response.status === 401) {
      const renewed = await refreshed(initial.access_token, expected);
      checkEpoch(expected);
      response = await send(renewed.access_token);
      checkEpoch(expected);
    }
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      checkEpoch(expected);
      throw new ApiError(
        error?.error || `Trace could not complete this request (${response.status}).`,
        response.status,
      );
    }
    const data = await (binary ? response.blob() : response.json());
    checkEpoch(expected);
    return data;
  }

  return {
    api: <T = unknown>(path: string, options?: RequestInit) => request(path, options) as Promise<T>,
    apiBlob: (path: string, options?: RequestInit) => request(path, options, true) as Promise<Blob>,
    async getUser(): Promise<TraceUser | null> {
      try {
        return (await request('/api/auth/me')) as TraceUser;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    async signIn(email: string, password: string, remember = false): Promise<TraceUser> {
      const intent = ++authIntent;
      epoch++;
      rememberSession(remember);
      const { data, error } = await client.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (error) throw error;
      if (intent !== authIntent) {
        throw new ApiError('Sign-in was cancelled. Please try again.', 401);
      }
      if (!data.user) throw new ApiError('Sign-in did not return an account.', 401);
      signedOut = false;
      return data.user;
    },
    async signUp(name: string, email: string, password: string) {
      const { data, error } = await client.auth.signUp({
        email: email.trim(),
        password,
        options: { data: { full_name: name.trim() } },
      });
      if (error) throw error;
      if (data.session) {
        try {
          const { error: logoutError } = await client.auth.signOut({ scope: 'local' });
          if (logoutError) throw logoutError;
        } catch {
          throw new Error('Your account was created. Return to Trace and log in.');
        } finally {
          clearSession();
          signedOut = true;
          epoch++;
          userId = null;
          for (const listener of listeners) listener(null);
        }
      }
      return { confirmationRequired: !data.session };
    },
    async signOut() {
      authIntent++;
      epoch++;
      signedOut = true;
      userId = null;
      for (const listener of listeners) listener(null);
      try {
        const { error } = await client.auth.signOut({ scope: 'local' });
        if (error) throw error;
      } finally {
        clearSession();
      }
    },
    onSessionChange(callback: (user: TraceUser | null) => void) {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
  };
}

let browserApi: ReturnType<typeof createTraceClient> | undefined;
function current() {
  return (browserApi ??= createTraceClient(
    getSupabaseClient(),
    fetch,
    setRememberSession,
    clearStoredSession,
  ));
}
export const api = <T = unknown>(path: string, options?: RequestInit) =>
  current().api<T>(path, options);
export const apiBlob = (path: string, options?: RequestInit) => current().apiBlob(path, options);
export const getUser = () => current().getUser();
export const signIn = (email: string, password: string, remember = false) =>
  current().signIn(email, password, remember);
export const signUp = (name: string, email: string, password: string) =>
  current().signUp(name, email, password);
export const signOut = () => current().signOut();
export const onSessionChange = (callback: (user: TraceUser | null) => void) =>
  current().onSessionChange(callback);
