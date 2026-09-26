# Website and desktop integration

The Astro website lives at the repository root and deploys to [tracenz.vercel.app](https://tracenz.vercel.app). The desktop, Fusion add-in and backend live in `trace-app/` and have separate build/deployment steps.

| Website route | Purpose |
| --- | --- |
| `/signup` | Create an email/password account |
| `/login` | Sign in to the browser viewer |
| `/app` | Choose a document, view/search traces and download source archives |
| `/download` | Download the portable Windows release |

The desktop's **Create account** action opens the website. Desktop login opens its timeline directly. Both clients use the same Supabase account and authenticated Trace API; the website is a read-only viewer, while capture, import, deletion and PDF report export are desktop features.

Website authentication is configured in `src/lib/supabase.ts` (project URL, public key, project-match guard and exported API URL), with matching public environment values described in `.env.example`. `src/lib/trace-client.ts` uses that API URL for authenticated history requests. `src/config/site.ts` controls website text and download links. `trace-app/desktop/cloud-config.cjs` contains the desktop API address, while `trace-app/supabase/functions/trace/deployment-config.json` provides default signup/callback URLs returned by the API.

No OpenAI or Supabase server secret belongs in the website or desktop. A newly created account has its own empty history; a shared demonstration account exposes the same history to everyone using its credentials.

For website development, run `npm ci`, `npm run check`, and `npm run build` from the repository root. For desktop development, use the commands in [the desktop README](../README.md). Publish portable app ZIPs as GitHub release assets and update the website download URL when releasing a new version.
