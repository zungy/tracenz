# Trace

Trace logs the changes you make in CAD and uses AI to turn that history into a design document.

This repository holds the marketing website: a landing page, a pricing page and log in / sign up
pages. It's a static site built with [Astro](https://astro.build), so it deploys to any static
host.

## Getting started

Requires Node 22.12 or later.

```sh
npm install
npm run dev       # local server at http://localhost:4321
npm run build     # static site in dist/
npm run preview   # serve the built site
npm run check     # type and template checks
npm run format    # format with Prettier
```

## Pages

| Route              | Source                            | Contents                                                                                    |
| ------------------ | --------------------------------- | ------------------------------------------------------------------------------------------- |
| `/`                | `src/pages/index.astro`           | Hero with the model, log and document joined by a trace line; the document; plans; download |
| `/pricing`         | `src/pages/pricing.astro`         | Plans with a monthly/yearly switch, Enterprise, comparison table, FAQ                       |
| `/login`           | `src/pages/login.astro`           | Log in form beside the housing, cut open                                                    |
| `/signup`          | `src/pages/signup.astro`          | Sign up form; `?plan=pro` or `?plan=team` notes the chosen plan                             |
| `/samples/tr-0142` | `src/pages/samples/tr-0142.astro` | The sample design document at full size, for printing (not indexed)                         |
| 404                | `src/pages/404.astro`             | Not-found page                                                                              |

## Before launch: placeholders to replace

| What                           | Where                                                                                                                                                     |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trace logo                     | `src/components/LogoPlaceholder.astro` and `public/favicon.svg`                                                                                           |
| Google / Microsoft sign-in     | `src/components/auth/AuthForm.astro` (logo slots and links)                                                                                               |
| Download URLs                  | `downloads` in `src/config/site.ts`                                                                                                                       |
| Log in / sign up endpoints     | `auth` in `src/config/site.ts`; forms POST there once set                                                                                                 |
| Sales email                    | `salesEmail` in `src/config/site.ts`                                                                                                                      |
| Plans, prices, FAQ             | `src/config/pricing.ts`                                                                                                                                   |
| Terms, privacy, password reset | Links in `src/components/auth/AuthForm.astro`                                                                                                             |
| Production URL                 | Set `site` in `astro.config.mjs` once the domain is known                                                                                                 |
| Claims to confirm              | "Only the projects you choose are logged" (download band), "Runs beside Autodesk Fusion", Windows and macOS apps (`everyPlan` in `src/config/pricing.ts`) |
| Trademark line                 | Footer (`src/components/Footer.astro`); have it checked                                                                                                   |
| Site drawing number            | `TR-WEB-01` in the footer's title block                                                                                                                   |

Until a download URL or auth endpoint is set, the buttons and forms still work as UI but tell
the visitor that the download or sign-in isn't available yet, instead of linking nowhere.

All copy is a first draft, and the example project (an orbital sander housing, its log and
its design document TR-0142) is illustrative.

## Design system

Each page is treated as a sheet in a drawing set. On desktop an ISO-style border with zone
numbers runs around the whole page (`SheetFrame.astro`), each section is one of the sheet's rows,
lettered A, B, C down the margins, and the footer is the sheet's title block: it names the sheet,
links the three sheets and holds the Paper / Blueprint switch. Drawings follow drafting
conventions: ISO line weights, centre lines, hatched sections, dimensions, leaders, revision
clouds and revision triangles.

- **Color:** the five palette colors, defined in `src/styles/tokens.css`: Ink `#192C64`,
  Cobalt `#243F8F`, Vellum `#BDC5DD`, Film `#E9EBF3`, Paper `#FFFFFF`. The page is a light film
  tint so paper-white panels sit on it; other tints are alpha versions of the palette. One extra
  color, redline (`#D2401F`, `#FF7A59` on dark), marks what changed in revision B: its revision
  clouds, delta tags, the trace line and the changed part in the render. It is never used for
  text or buttons.
- **Themes:** "Paper" (light) and "Blueprint" (dark). They follow the system setting, and
  visitors can override it in the header and the footer's title block. Components use semantic
  tokens (`--bg`, `--text`, `--accent`, ...) so both themes stay in sync. `.scheme-blueprint`
  and `.scheme-paper` pin a section to one theme.
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

Two textures were made with an image generation model and then graded to the palette:
`public/textures/matcap-grey.webp`, the material sphere the render samples, and
`public/textures/cyanotype.webp`, the blueprint paper under the download band and the account
panel (`.cyanotype` in `src/styles/global.css`). No generated image shows the product.

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

The site is fully static: `npm run build` writes it to `dist/`, and any static host can serve
that folder. Netlify and Cloudflare Pages detect Astro automatically. GitHub Pages also works,
but serving a private repository through it requires a paid GitHub plan. For Vercel, follow the
guide below.

### Deploying to Vercel

Vercel detects Astro and serves the static build from its CDN. No adapter is needed: the
`@astrojs/vercel` adapter is only for server rendering or Vercel services such as Web Analytics
and Image Optimization, which this site doesn't use. There are no environment variables to set.

On the free Hobby plan, Vercel deploys public and private repositories from a personal GitHub
account. A private repository owned by a GitHub organization needs a Pro team; the command line
route below also works, as it doesn't use the Git connection.

#### From the dashboard

Connecting the repository deploys every push automatically.

1. Sign in at [vercel.com](https://vercel.com) and choose **Add New… → Project**, or go to
   [vercel.com/new](https://vercel.com/new).
2. Under **Import Git Repository**, pick `Jinomee/trace`. If it isn't listed, follow the link to
   adjust the GitHub app's permissions and give Vercel access to the repository.
3. Check the settings Vercel fills in on the configure screen:

   | Setting          | Value                                                    |
   | ---------------- | -------------------------------------------------------- |
   | Framework Preset | Astro                                                    |
   | Root Directory   | `./`                                                     |
   | Build Command    | `npm run build` (the preset's `astro build` is the same) |
   | Output Directory | `dist`                                                   |
   | Install Command  | The default, which installs from `package-lock.json`     |

4. Choose **Deploy**. The first deployment goes to production, at `<project-name>.vercel.app`.

#### Which branch goes live

Vercel deploys one branch to production and every other branch and pull request as a preview,
each with its own URL. For production it uses `main` if there is one, then `master`, then the
repository's default branch. This repository has a single branch for now,
`claude/amazing-goodall-sb0vfn`, so that is what goes live. Once the work is merged into `main`,
point production at it: in the project, open **Settings → Environments → Production → Branch
Tracking**, enter `main` and save.

#### From the command line

The Vercel CLI deploys from a local checkout:

```sh
npm install --global vercel
vercel login
vercel          # first run: links the folder to a new or existing project and deploys it
vercel          # later runs: a preview deployment with its own URL
vercel --prod   # a production deployment
```

The CLI uploads the project and Vercel builds it with the settings above. The link to the
project is kept in `.vercel/`, which is git-ignored.

#### Node.js version

Astro needs Node.js 22.12 or later. The `engines` field in `package.json` says so, and Vercel
follows it in preference to the **Node.js Version** setting under **Settings → Build and
Deployment**, so there is nothing to set. Because the range is open-ended, the build log may
warn that it will pick up new major versions of Node.js; that is expected.

#### After the first deployment

1. **Domain:** in the project's **Settings → Domains**, add the domain, then create the DNS
   records Vercel shows for it at your DNS provider: an A record for an apex domain such as
   `example.com`, a CNAME for a subdomain such as `www`. Vercel issues the HTTPS certificate once
   DNS resolves.
2. **Site URL:** set `site` in `astro.config.mjs` to the production URL, for example
   `site: 'https://example.com'`. Astro uses it to build absolute URLs, such as canonical links
   or a sitemap if you add them. Push the change and the next deployment picks it up.
3. **Placeholders:** replace everything listed under
   [Before launch](#before-launch-placeholders-to-replace).
4. **Check it:** open `/`, `/pricing`, `/login` and `/signup`; an unknown address, which gets the
   site's own not-found page (Vercel serves `dist/404.html` with a 404 status); and
   `/samples/TR-0142-rev-b.pdf`.
