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

| Route      | Source                    | Contents                                                                        |
| ---------- | ------------------------- | ------------------------------------------------------------------------------- |
| `/`        | `src/pages/index.astro`   | Hero with a model-to-log-to-document demo, the design document, plans, download |
| `/pricing` | `src/pages/pricing.astro` | Plans with a monthly/yearly switch, Enterprise, comparison table, FAQ           |
| `/login`   | `src/pages/login.astro`   | Log in form                                                                     |
| `/signup`  | `src/pages/signup.astro`  | Sign up form; `?plan=pro` or `?plan=team` notes the chosen plan                 |
| 404        | `src/pages/404.astro`     | Not-found page                                                                  |

## Before launch: placeholders to replace

| What                           | Where                                                           |
| ------------------------------ | --------------------------------------------------------------- |
| Trace logo                     | `src/components/LogoPlaceholder.astro` and `public/favicon.svg` |
| Google / Microsoft sign-in     | `src/components/auth/AuthForm.astro` (logo slots and links)     |
| Download URLs                  | `downloads` in `src/config/site.ts`                             |
| Log in / sign up endpoints     | `auth` in `src/config/site.ts`; forms POST there once set       |
| Sales email                    | `salesEmail` in `src/config/site.ts`                            |
| Plans, prices, FAQ             | `src/config/pricing.ts`                                         |
| Terms, privacy, password reset | Links in `src/components/auth/AuthForm.astro`                   |
| Production URL                 | Set `site` in `astro.config.mjs` once the domain is known       |

Until a download URL or auth endpoint is set, the buttons and forms still work as UI but tell
the visitor that the download or sign-in isn't available yet, instead of linking nowhere.

All copy is a first draft, and the example project (an orbital sander housing) is illustrative.

## Design system

Each page is treated as a sheet in a drawing set. On desktop a fixed ISO-style border with zone
numbers and letters frames the page (`SheetFrame.astro`), and the footer is the sheet's title
block: it names the sheet, links the three sheets and holds the Paper / Blueprint switch.
Drawings follow drafting conventions: ISO line weights, centerlines, hatched sections, leaders,
revision clouds and revision triangles.

- **Color:** the five palette colors, defined in `src/styles/tokens.css`: Ink `#192C64`,
  Cobalt `#243F8F`, Vellum `#BDC5DD`, Film `#E9EBF3`, Paper `#FFFFFF`. The page is a light film
  tint so paper-white panels sit on it; other tints are alpha versions of the palette. One extra
  color, redline (`#D2401F`, `#FF7A59` on dark), is reserved for the change being traced: its
  revision cloud, delta tag, new value and trace line. It is never used for text or buttons,
  and every other change mark is drawn in ink.
- **Themes:** "Paper" (light) and "Blueprint" (dark). They follow the system setting, and
  visitors can override it in the footer's title block (and the mobile menu). Components use
  semantic tokens (`--bg`, `--text`, `--accent`, ...) so both themes stay in sync.
  `.scheme-blueprint` and `.scheme-paper` pin a section to one theme.
- **Type:** one family, IBM Plex: Plex Sans for headings and text (headings at weight 500) and
  Plex Mono for values, labels and part numbers, with a dotted zero that keeps 0 and O apart.
  Fonts are self-hosted through Fontsource.
- **Scale and spacing:** type steps by a ratio of 2^(1/4), so every second step is ×√2, the ISO
  paper ratio. Spacing uses an 8px unit in steps of 1, 2, 3, 5, 8 and 13.
- **Grid:** 16 columns on desktop, 8 on tablet and 4 on mobile (`.grid`). On desktop each pair of
  columns fills one of the border's eight zones, with the gutter centered on the zone line.
- **Lines:** a 2px border and table outlines, 1px ink panel outlines and 1px vellum rules.
- **Icons:** [Tabler Icons](https://tabler.io/icons), inlined at build time by
  `src/components/Icon.astro`.
- **Motion:** the hero plays once on load and can be replayed; pointing at a change traces it
  through the drawing, the log and the document. With reduced motion or without JavaScript,
  every element shows its finished state.

## Deploying

Build command `npm run build`, output directory `dist`. Netlify, Cloudflare Pages and Vercel all
detect Astro automatically. GitHub Pages also works, but serving a private repository through it
requires a paid GitHub plan.
