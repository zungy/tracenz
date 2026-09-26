# Run your own Trace backend

The released demo already uses Supabase Edge Functions. Fusion captures are queued locally, then forwarded to the signed-in account; both the desktop and website read that account's cloud history.

## Supabase Edge deployment

1. Create a Supabase project. Review and apply both SQL files in `supabase/migrations/` in filename order to a fresh project. **Before applying the background-worker migration, change its scheduled HTTP URL to your project's Edge endpoint.** It creates the database, owner policies, private PNG bucket, worker credential and scheduled processing.
2. Set the Edge function's server secrets: `OPENAI_API_KEY` and optionally `OPENAI_MODEL`. Use `TRACE_AI=deterministic` to develop without AI calls. The runtime reads Supabase's injected credentials; explicit `SUPABASE_SECRET_KEY` and `SUPABASE_PUBLISHABLE_KEY` are also supported. Never put secret/service-role keys in client code.
3. Edit `supabase/functions/trace/deployment-config.json` for your website's signup and callback URLs. Configure those URLs in Supabase Auth too. Choose whether email confirmation is required; confirmation and reset emails need working delivery.
4. Run `node scripts/prepare-edge.js`, then deploy `supabase/functions/trace/index.ts` and its local dependencies as the `trace` function. Set platform `verify_jwt=false`: the handler itself validates user sessions, upload-only tokens and worker credentials. Do not remove those checks.
5. Set `desktop/cloud-config.cjs` to `https://YOUR-PROJECT.supabase.co/functions/v1/trace`, then rebuild the desktop. In the website root, update `src/lib/supabase.ts`: its project URL, public key, project-match guard and exported `TRACE_API_URL` must point to the same deployment. `src/lib/trace-client.ts` consumes that API URL. Set matching `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_PUBLISHABLE_KEY` values using `.env.example`; environment values alone do not replace the source project guard/API URL. `src/config/site.ts` controls the download links, not authentication.

Supabase's URL and publishable key are public configuration. OpenAI, service-role/secret keys, worker credentials and user sessions are private.

## Optional Node/Docker backend

The included `Dockerfile` runs a continuously available Node API and AI worker. Use an HTTPS host, one replica initially, health check `/api/health`, and a shutdown grace period of at least 120 seconds. State lives in Supabase. Apply the database schema first; the Edge cron worker is unnecessary when the Node worker handles processing.

Set these in the host's secret/environment settings:

```text
TRACE_MODE=supabase
HOST=0.0.0.0
PORT=8080
TRACE_PUBLIC_ORIGIN=https://YOUR-TRACE-API
TRACE_SIGNUP_URL=https://YOUR-WEBSITE/signup
TRACE_AUTH_REDIRECT_URL=https://YOUR-WEBSITE/login?confirmed=1
SUPABASE_URL=https://YOUR-PROJECT.supabase.co
SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLIC_KEY
SUPABASE_SECRET_KEY=YOUR_SERVER_ONLY_KEY
TRACE_AI=openai
OPENAI_API_KEY=YOUR_SERVER_ONLY_KEY
OPENAI_MODEL=gpt-4.1-mini
```

Legacy `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` aliases are supported. For template-only development, set `TRACE_AI=deterministic` and omit OpenAI variables. Reconfigure the desktop and website to use this hosted Trace API, not the raw Supabase project URL.

## Verify the deployment

- `/api/health` and `/api/config` respond; unauthenticated history requests fail.
- Create an account, log in, install the Fusion add-in and capture a checkpoint. Confirm its rationale, changes, image and summary appear in both clients.
- Capture while disconnected, reconnect and confirm delivery creates one record.
- Use a second account and confirm it cannot see the first account's history.
- Generate and open a PDF report on Windows. Native export requires the desktop app.

The desktop handles receiver discovery and upload-token pairing automatically. Users do not enter ports, API addresses or database keys. Signout pauses uploads; queued jobs retain their original account identity.
