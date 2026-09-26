# Trace deployment map

Current source release: desktop **v0.7.0**, bundled Fusion add-in **v0.6.0**.

| Component | Location |
| --- | --- |
| Website and account creation | https://tracenz.vercel.app |
| Browser document viewer | https://tracenz.vercel.app/app |
| Windows downloads | https://tracenz.vercel.app/download |
| Source and releases | https://github.com/zungy/tracenz |
| Edge API | https://sbupyqgysoznucelwsij.supabase.co/functions/v1/trace |

The Astro website deploys from the repository root to Vercel. The desktop source is in `trace-app/`; it is built separately. Database and Edge changes are deployed separately to Supabase.

## Data and authentication

The API uses Supabase Auth, owner-scoped `trace_documents` and `trace_events`, upload-token hashes in `trace_tokens`, and the private `trace-viewports` image bucket. User histories are isolated. The background worker processes pending summaries and image cleanup; its credential is generated in Vault and verified through a restricted database function.

The demo accepts email/password registration immediately without email confirmation. Password reset and social login are not implemented. Desktop login sessions stay in main-process memory; per-account upload credentials use Windows encryption. Credentials and local queues must not be committed or distributed.

OpenAI configuration belongs in server-side Edge secrets. The default model in the source is `gpt-4.1-mini`. Client code contains only public service addresses/configuration.

## Maintenance

Run `node scripts/prepare-edge.js` from `trace-app/` after changing shared server modules. Deploy the complete `supabase/functions` dependency tree with `trace/index.ts` as the entrypoint. The generated `_shared` files must remain synchronized with `server/`.

The function uses platform `verify_jwt=false` because the handler supports both authenticated user sessions and upload-only installation tokens. **Keep the handler's authentication enabled.** Upload credentials cannot read account history. The internal worker also requires its separate credential.

The desktop reads signup destinations from `/api/config`; `supabase/functions/trace/deployment-config.json` supplies the default website URLs. A custom deployment also needs its own desktop API URL and scheduled-worker endpoint. See [cloud setup](CLOUD-DEPLOYMENT.md).

Verification commands and limitations are documented in the [desktop README](../README.md). Automated tests do not replace an actual Fusion checkpoint or native PDF save check on the target Windows machine.
