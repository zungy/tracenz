import { resolve } from "node:path";
export function configFromEnv(env = process.env) {
  env = {
    ...env,
    SUPABASE_SERVICE_ROLE_KEY:
      env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_ANON_KEY: env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY,
  };
  const mode = env.TRACE_MODE || "local";
  if (!["local", "supabase"].includes(mode))
    throw new Error("TRACE_MODE must be local or supabase.");
  const host = env.HOST || "127.0.0.1";
  if (mode === "local" && !["127.0.0.1", "::1", "localhost"].includes(host))
    throw new Error(
      "Local mode must bind to loopback. Use Supabase mode for a hosted backend.",
    );
  const ai = env.TRACE_AI || (mode === "local" ? "deterministic" : "openai");
  if (!["deterministic", "openai"].includes(ai))
    throw new Error("TRACE_AI must be deterministic or openai.");
  const required =
    mode === "supabase"
      ? [
          "SUPABASE_URL",
          "SUPABASE_SERVICE_ROLE_KEY",
          "SUPABASE_ANON_KEY",
          "TRACE_PUBLIC_ORIGIN",
        ]
      : [];
  if (ai === "openai") required.push("OPENAI_API_KEY", "OPENAI_MODEL");
  for (const key of required)
    if (!env[key]) throw new Error(`${key} is required.`);
  if (
    mode === "supabase" &&
    (!env.SUPABASE_URL.startsWith("https://") ||
      !env.TRACE_PUBLIC_ORIGIN.startsWith("https://"))
  )
    throw new Error("Cloud mode requires HTTPS URLs.");
  const signupUrl =
    env.TRACE_SIGNUP_URL ||
    (env.TRACE_PUBLIC_ORIGIN ? env.TRACE_PUBLIC_ORIGIN + "/signup" : undefined);
  if (signupUrl) {
    const u = new URL(signupUrl);
    if (u.protocol !== "https:" || u.username || u.password || u.hash)
      throw new Error("TRACE_SIGNUP_URL must be HTTPS.");
  }
  const authRedirectUrl =
    env.TRACE_AUTH_REDIRECT_URL ||
    (env.TRACE_PUBLIC_ORIGIN
      ? env.TRACE_PUBLIC_ORIGIN + "/auth/confirmed"
      : undefined);
  if (authRedirectUrl) {
    const target = new URL(authRedirectUrl);
    if (
      target.protocol !== "https:" ||
      target.username ||
      target.password ||
      target.hash
    )
      throw new Error("TRACE_AUTH_REDIRECT_URL must be a trusted HTTPS URL.");
  }
  const port = Number(env.PORT || 4318);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Invalid PORT.");
  return {
    mode,
    authRedirectUrl,
    signupUrl,
    host,
    port,
    ai,
    dataDir: resolve(env.TRACE_DATA_DIR || ".data"),
    supabaseUrl: env.SUPABASE_URL?.replace(/\/$/, ""),
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
    anonKey: env.SUPABASE_ANON_KEY,
    publicOrigin: env.TRACE_PUBLIC_ORIGIN,
    openaiKey: env.OPENAI_API_KEY,
    model: env.OPENAI_MODEL,
    bucket: "trace-viewports",
  };
}
