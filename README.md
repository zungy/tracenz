# Trace

**Engineering memory for Autodesk Fusion.** Capture design changes, screenshots and the reasons behind them, then turn that evidence into searchable timelines, AI summaries and engineering report PDFs.

[Website](https://tracenz.vercel.app) · [Create account](https://tracenz.vercel.app/signup) · [Windows download](https://tracenz.vercel.app/download) · [User guide](trace-app/docs/USER-GUIDE.md)

## Try it

1. Download and **extract the whole Windows ZIP**, then open `Trace.exe`. Quit any older Trace from its system tray first.
2. Create an account on the website and log in inside Trace.
3. Close Fusion, choose **Fusion → Install / update Fusion add-in** in Trace, then restart Fusion.
4. Finish a modeling command and press **Ctrl + Alt + S** in Fusion to record a checkpoint and rationale. Keep Trace running.
5. View your timeline in desktop or [on the web](https://tracenz.vercel.app/app) with the same account. In desktop, choose **Design report → Generate PDF** for a document's complete saved history.

New accounts start with their own empty history. Captures appear on the website after uploading; the website supports viewing, searching and downloading.

## How it works

```text
Fusion add-in → desktop receiver + durable upload queue
             → Supabase Edge API → OpenAI summaries
             → Supabase database + private image storage
             → desktop timeline / website viewer
```

Checkpoint captures preserve normalized engineering changes, original rationale, document metadata and a PNG viewport. Interrupted uploads retry; account ownership keeps histories separate. OpenAI and privileged database keys stay on the backend.

## Source map

| Location                                                                      | Purpose                                            |
| ----------------------------------------------------------------------------- | -------------------------------------------------- |
| [`src/`](src/)                                                                | Astro website, account pages and signed-in viewer  |
| [`trace-app/desktop/`](trace-app/desktop/) and [`public/`](trace-app/public/) | Electron desktop shell and Paper interface         |
| [`trace-app/fusion/`](trace-app/fusion/)                                      | Fusion add-in and upload transport                 |
| [`trace-app/server/`](trace-app/server/)                                      | Capture validation, queue, API and AI/report logic |
| [`trace-app/supabase/`](trace-app/supabase/)                                  | Cloud Edge function and database migrations        |
| [`test/`](test/) and [`trace-app/test/`](trace-app/test/)                     | Website and desktop/backend regression tests       |

## Run from source

Use **Node.js 24+**. From the repository root:

```sh
npm ci
npm run dev              # Astro website: localhost:4321
# In a second terminal:
cd trace-app
npm ci
npm start                # Electron desktop
```

Both clients use the configured Trace cloud service. For checks, run `npm test` and `npm run check` in each directory; run `npm run build` at the root to build the website. Python 3 is needed for the Fusion transport tests.

See [website setup/deployment](docs/WEBSITE.md), [desktop/backend development](trace-app/README.md) and [account configuration](trace-app/docs/AUTH-SETUP.md). The website stays at the repository root for Vercel; desktop sources are packaged separately.

## Demo status

Windows x64 only; the portable app is unsigned and may show a SmartScreen warning. Updates are downloaded manually. Native PDF saving still needs a check on a Windows PC; automated report tests pass. Email confirmation is disabled for this demo; billing, social login, password reset and team sharing are not implemented.
