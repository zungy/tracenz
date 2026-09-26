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

Build command `npm run build`, output directory `dist`. Netlify, Cloudflare Pages and Vercel all
detect Astro automatically. GitHub Pages also works, but serving a private repository through it
requires a paid GitHub plan.
