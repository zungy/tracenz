# Trace

Trace records changes in Autodesk Fusion and saves engineering decisions, screenshots and AI
summaries to a private design history. This repository is the existing Astro website: marketing
pages, email account access, Windows downloads and the signed-in web viewer.

The site remains a static Astro build. Authentication uses Supabase Auth in the browser; private
history is read from the same Trace Edge API and Supabase project used by the desktop app. No
copy or import into a separate web database is needed.

## Getting started

Use Node 24 or later for the development and test commands below. Install the exact locked
package versions with `npm ci`.

```sh
npm ci
npm run dev       # local server at http://localhost:4321
npm test          # auth/session and history regression tests; no live accounts needed
npm run check     # type and template checks
npm run build     # static site in dist/
npm run preview   # serve the built site
npm run format    # format with Prettier
```

## Pages

| Route              | Source                            | Contents                                                                                            |
| ------------------ | --------------------------------- | --------------------------------------------------------------------------------------------------- |
| `/`                | `src/pages/index.astro`           | Product overview, illustrative model/log/document, plans and Windows download                       |
| `/pricing`         | `src/pages/pricing.astro`         | Existing pricing copy and comparison; billing is not implemented                                    |
| `/login`           | `src/pages/login.astro`           | Email/password login, then a same-origin redirect to `/app`                                         |
| `/signup`          | `src/pages/signup.astro`          | Create the same account used by desktop; return to desktop or log in on the web                     |
| `/app`             | `src/pages/app.astro`             | Documents first, then searchable timelines, checkpoint details, private screenshots and ZIP exports |
| `/download`        | `src/pages/download.astro`        | Windows portable ZIP and setup instructions; no macOS download                                      |
| `/samples/tr-0142` | `src/pages/samples/tr-0142.astro` | Illustrative design document for printing; not private user history                                 |
| 404                | `src/pages/404.astro`             | Not-found page                                                                                      |

## Accounts and shared history

The browser uses the pinned Supabase JavaScript SDK from `src/lib/supabase.ts`. Email/password
login redirects to `/app`; signup creates an account and offers the next step instead of silently
opening the viewer. With the current demo configuration, email confirmation is disabled. Any
session issued during signup is signed out with `scope: 'local'`, which preserves existing desktop
sessions. If email confirmation is enabled later, configure the confirmation flow and email sender
before inviting users.

Login uses session storage by default. **Keep me logged in on this device** opts into local
storage. The SDK manages token renewal; `src/lib/trace-client.ts` coordinates retries, discards
responses after logout/account changes, and sends authenticated reads to the Trace API. Web logout
clears browser credentials and signs out only the browser session.

The viewer is intentionally limited to viewing, searching and downloading. It does not delete or
edit records, install Fusion, change cloud settings or create checkpoints. Screenshots and ZIP
exports require authentication. Users only see histories owned by their account; these are the
same uploaded checkpoints visible in desktop. The desktop must finish uploading a local capture
before it appears on the website. A shared demo login shares one editable desktop history among
all people using that account.

### Public Supabase configuration

Copy `.env.example` to `.env.local` for explicit local configuration, and set these same public
values in the Vercel project's Production and relevant Preview environments:

```dotenv
PUBLIC_SUPABASE_URL=https://sbupyqgysoznucelwsij.supabase.co
PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_1dB-sxxKQ-DxiYgPrlnVzg_ecucKZ-l
```

These are public client values. Never place an OpenAI key, Supabase secret key or service-role key
in a `PUBLIC_` variable, source file or downloadable artifact. The current project values are also
bundled as defaults, so missing environment variables do not break the public release. The client
rejects a different project URL to prevent accidental separation from the desktop database. A
project migration must update both the desktop and this client, including the Trace API URL.

### Trace API and CORS

Private reads use:

```text
https://sbupyqgysoznucelwsij.supabase.co/functions/v1/trace
```

The Edge function is maintained in the desktop repository under
`supabase/functions/trace/`. Its deployment configuration must set the signup URL to
`https://tracenz.vercel.app/signup`; the handler uses that origin to permit the production
website's authenticated browser requests. The desktop signup destination must use the same URL.
An existing `TRACE_SIGNUP_URL` Edge secret overrides the checked-in configuration, so keep it in
sync when deploying.

The production origin must be allowed before deploying the viewer. Localhost and Vercel preview
origins are not automatically permitted by the production API: explicitly configure any trusted
additional testing origins in the backend before using real accounts there. Do not make private
API access anonymous to work around CORS. Unit tests use isolated fixtures and require no live
accounts or cloud data.

## Windows downloads

`site.downloads.windows` in `src/config/site.ts` points to the GitHub release asset. The current
release is `desktop-v0.7.0`, with asset `Trace-desktop-v0.7.0-Windows-x64.zip`. Publish that exact
asset before making its download link live. For later releases, publish the new asset, update the
URL and version shown on `/download`, then deploy the website.

The desktop ZIP is an unsigned portable Windows x64 app. Users must extract the whole ZIP, quit
any old Trace through its system tray, then open `Trace.exe`. The website does not distribute
macOS builds or install desktop updates automatically.

Desktop v0.7.0 adds **Design report**: an engineering PDF for a selected document, with cited
analysis, original rationale, normalized changes and a complete chronological checkpoint appendix.
Available screenshots are included, and missing images are identified. Reports are generated and
saved through the desktop app; the website viewer continues to offer browsing and ZIP exports.

## Remaining marketing content

The Paper design system and illustrative housing remain from the original site. The logo mark matches Trace desktop.
Review sales email (`salesEmail` in `src/config/site.ts`), pricing/FAQ (`src/config/pricing.ts`),
product claims and the footer trademark line before a general release. Google/Microsoft login,
password-reset controls and links to unpublished legal pages are intentionally absent from the
account form; only working email/password controls are presented.

## Design system

Each page is treated as a sheet in a drawing set. On desktop an ISO-style border with zone
numbers runs around the whole page (`SheetFrame.astro`), each section is one of the sheet's rows,
lettered A, B, C down the margins, and the footer is the sheet's title block: it names the sheet,
links the three sheets. Drawings follow drafting
conventions: ISO line weights, centre lines, hatched sections, dimensions, leaders, revision
clouds and revision triangles.

- **Color:** the five palette colors, defined in `src/styles/tokens.css`: Ink `#192C64`,
  Cobalt `#243F8F`, Vellum `#BDC5DD`, Film `#E9EBF3`, Paper `#FFFFFF`. The page is a light film
  tint so paper-white panels sit on it; other tints are alpha versions of the palette. One extra
  color, redline (`#D2401F`), marks what changed in revision B: its revision
  clouds, delta tags, the trace line and the changed part in the render. It is never used for
  text or buttons.
- **Theme:** Paper throughout, including account pages and download panels. Semantic tokens
  (`--bg`, `--text`, `--accent`, ...) keep the design consistent. System dark mode and older
  saved theme preferences do not change the appearance.
- **Type:** Barlow Semi Condensed for headings and Barlow for text, both drawn after DIN 1451,
  the standard lettering of German engineering drawings; IBM Plex Mono, with its dotted zero,
  for values, log entries, part numbers and labels. Fonts are self-hosted through Fontsource.
- **Grid:** on desktop the layout grid is the border's eight zones, edge to edge with no gutter
  (`.grid`); text keeps `--pad` from the zone lines (`.pad`) while rules and cell edges sit on
  them. Blocks with `data-row` are the sheet's rows. Tablet and mobile use 8 and 4 columns.
- **Lines:** a 2px sheet border, 1px ink rules between rows and cells, 1px vellum hairlines.
- **Icons:** [Tabler Icons](https://tabler.io/icons), inlined at build time by
  `src/components/Icon.astro`.
- **Motion:** the hero plays once on load: the section plane sweeps through the housing, the
  log fills, then the trace line draws from the changed part to its log entries and on to the
  document. Pointing at a change re-routes the trace. With reduced motion or without JavaScript,
  every element shows its finished state.

## The housing: one model for the drawings and the render

`src/lib/sander.ts` defines the example part once, as a signed distance field: the housing's
revolved profile, the motor mount wall, the bearing boss and the dust port. Everything that
shows the part is derived from it:

- **Drawings** (`src/components/drawings/`): the half section and detail A in the sample
  document are contours traced from the field and dimensioned with `src/lib/drafting.ts`.
- **Render** (`src/lib/model-shader.ts`, `src/components/ModelView.astro`): a WebGL2 ray marcher
  draws the same field, with a quarter cut away, ink creases and the changed part in redline.
  Surfaces are shaded with a material sphere (a matcap) whose light is graded onto the palette.
  The view follows the pointer by a few degrees.
- **Stills** (`public/renders/`): what the render shows without WebGL and before its first
  frame. They are taken from the live render by `scripts/render-stills.mjs`; re-run it after
  changing the geometry, the cameras or the shader.

## Generated images

The material sphere sampled by the render, `public/textures/matcap-grey.webp`, was made
with an image generation model and graded to the palette. No generated image shows the product.

## Sample document

The home page offers the sample design document as a PDF,
`public/samples/TR-0142-rev-b.pdf`. It is the `/samples/tr-0142` route printed to A4 by
`scripts/print-sample.mjs`; re-run it after changing `src/components/home/DocPage.astro` or the
drawings.

Both scripts need Playwright and the built site being served:

```sh
npm install --no-save playwright && npx playwright install chromium
npm run build && npm run preview       # in one terminal
node scripts/render-stills.mjs         # in another
node scripts/print-sample.mjs
npm run build                          # so dist/ picks up the new files
```

## Deploying

The existing GitHub repository is `zungy/tracenz`. Its `main` branch deploys to the Vercel project
`tracenz`, at `https://tracenz.vercel.app`. Continue using this Astro project; no framework rewrite
or server adapter is needed.

Vercel build settings:

| Setting          | Value                          |
| ---------------- | ------------------------------ |
| Framework Preset | Astro                          |
| Root Directory   | `./`                           |
| Build Command    | `npm run build`                |
| Output Directory | `dist`                         |
| Install Command  | `npm ci` / locked dependencies |
| Node.js          | 24                             |

Before publishing:

1. Run `npm test`, `npm run check` and `npm run build`.
2. Set the public Supabase variables above for the deployment environment.
3. Deploy the compatible Trace Edge backend with the production CORS/signup origin.
4. Publish the Windows ZIP release asset and confirm its configured URL downloads successfully.
5. Push the website changes to the production branch, or review a Vercel preview before merging.

After deployment, check `/signup`, `/login`, `/app` and `/download`. Use a disposable test account
to check signup, web login, documents/timeline access, private screenshots, download and logout.
A signed-out visitor must see login guidance and must not receive another user's private data.
Private records are fetched at runtime and are never rendered into the static build.

`astro.config.mjs` contains the production site URL. Update it when a custom domain is introduced,
and update the desktop signup URL, Supabase URL settings and backend CORS origin together.
