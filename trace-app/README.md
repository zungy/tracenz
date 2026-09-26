# Trace desktop v0.7.0

The Windows desktop app, Autodesk Fusion add-in, and backend source for [Trace](https://tracenz.vercel.app). Trace captures engineering changes, screenshots and rationale, then turns them into a searchable timeline and engineering reports.

## Try it

Download the [Windows app](https://tracenz.vercel.app/download), extract the **whole ZIP**, and open `Trace.exe`. Create an account on the website and log in inside Trace. In **Fusion**, choose **Install / update Fusion add-in** with Autodesk Fusion closed, then restart Fusion.

While working in Fusion, finish the current command and press **Ctrl + Alt + S** to record a checkpoint. Trace connects automatically. The same account can view its history on the [website](https://tracenz.vercel.app/app).

Choose **Documents → Design report → Generate PDF** for an overview, cited analysis, original rationale, engineering changes and screenshots from every saved checkpoint in that design. Search filters do not shorten the report.

## How it works

```text
Fusion add-in → local capture queue → authenticated Edge API
                                         ├─ Supabase Auth, database and private images
                                         └─ OpenAI summaries and report narrative
Desktop app / Astro website ← same account's cloud history
```

The local receiver preserves interrupted uploads. Account credentials stay in Electron's main process; server secrets are never bundled with the app. Each account has its own history.

| Folder | Contents |
| --- | --- |
| `desktop/` | Electron shell, account pairing, add-in installer and PDF export |
| `public/` | Paper-styled desktop interface and licensed fonts |
| `fusion/` | Bundled Fusion add-in v0.6.0 and durable Python uploader |
| `server/` | Validation, persistence, queue forwarding and AI logic |
| `supabase/` | Edge API, generated shared modules and database migrations |
| `test/` | Backend, renderer, export, security and Fusion regression tests |
| `scripts/` | Development preview, validation and packaging tools |

## Develop

Requires Node.js 24+ and Python 3 for Fusion transport tests and release packaging. From this folder:

```sh
npm ci
npm test
npm run check
npm run test:fusion
npm start
```

The desktop uses `desktop/cloud-config.cjs`. To run your own deployment, follow [cloud setup](docs/CLOUD-DEPLOYMENT.md). `npm run server` and `npm run demo:send` are isolated local-backend development tools; they do not switch the released desktop away from its configured cloud.

To build the portable Windows release, run `npm run package:windows`, then `python scripts/package-release.py`. Outputs go to `artifacts/`; never publish `.env`, `.data`, credentials or captured design history.

## Demo limits

- Windows x64, portable and unsigned; no installer or automatic updates. Quit older Trace from its tray before updating.
- Email confirmation is disabled for the demo. Password reset, social login, teams and read-only shared accounts are not implemented.
- PDF reports support up to 2,000 checkpoints / 8 MB text / 96 MB processed screenshots. Larger AI inputs use a clearly labelled evidence template; failures are shown for retry.
- Report saving uses the native Windows print runtime and should be checked on the target PC before a live demonstration.

See the [user guide](docs/USER-GUIDE.md), [account behavior](docs/AUTH-SETUP.md), [Fusion transport](docs/FUSION-AUTO-CONNECTION.md) and [deployment map](docs/LIVE-SETUP.md).
