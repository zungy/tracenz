import { SupabaseStore } from "../_shared/supabase-store.js";
import { createSummarizer } from "../_shared/ai.js";
import { createEdgeHandler, createEdgeWorker } from "./handler.js";
import deployment from "./deployment-config.json" with { type: "json" };

function bundledKey(name: string): string | undefined {
  const value = Deno.env.get(name);
  if (!value) return undefined;
  const keys = JSON.parse(value);
  const key = keys.default || Object.values(keys)[0];
  return typeof key === "string" ? key : undefined;
}
const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const openaiKey = Deno.env.get("OPENAI_API_KEY");
const config = {
  supabaseUrl,
  serviceKey:
    Deno.env.get("SUPABASE_SECRET_KEY") ||
    bundledKey("SUPABASE_SECRET_KEYS") ||
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  anonKey:
    Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ||
    bundledKey("SUPABASE_PUBLISHABLE_KEYS") ||
    Deno.env.get("SUPABASE_ANON_KEY"),
  publicOrigin: `${supabaseUrl}/functions/v1/trace`,
  signupUrl: Deno.env.get("TRACE_SIGNUP_URL") || deployment.signupUrl || "",
  authRedirectUrl:
    Deno.env.get("TRACE_AUTH_REDIRECT_URL") || deployment.authRedirectUrl || "",
  workerSecret: Deno.env.get("TRACE_WORKER_SECRET") || "",
  bucket: "trace-viewports",
  ai: Deno.env.get("TRACE_AI") || (openaiKey ? "openai" : "deterministic"),
  openaiKey,
  model: Deno.env.get("OPENAI_MODEL") || "gpt-4.1-mini",
};
if (!config.supabaseUrl || !config.serviceKey || !config.anonKey)
  throw new Error("Trace requires the Supabase runtime credentials.");
if (
  !["openai", "deterministic"].includes(config.ai) ||
  (config.ai === "openai" && !config.openaiKey)
)
  throw new Error("Trace AI configuration is incomplete.");
for (const url of [config.signupUrl, config.authRedirectUrl].filter(Boolean)) {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  )
    throw new Error("Trace account URLs must use HTTPS.");
}
function boundedFetch(signal: AbortSignal) {
  return (url: string | URL | Request, options: RequestInit = {}) =>
    fetch(url, {
      ...options,
      signal: options.signal
        ? AbortSignal.any([signal, options.signal])
        : signal,
    });
}
const processOne = createEdgeWorker({
  storeFactory: (signal: AbortSignal) =>
    new SupabaseStore(config, boundedFetch(signal)),
  summarizerFactory: (signal: AbortSignal) =>
    createSummarizer(config, boundedFetch(signal)),
});
const handler = createEdgeHandler(config, new SupabaseStore(config), {
  processOne,
  waitUntil: (task: Promise<unknown>) => EdgeRuntime.waitUntil(task),
});
Deno.serve(handler);
