/**
 * Renders the stills the housing model shows without WebGL, and before its
 * first frame: public/renders/housing-light.webp and housing-dark.webp (the
 * hero's cutaway) and cad-light.webp (the CAD window's view). Each is taken
 * from the live render at 1560 x 1125, so re-run this after changing the
 * geometry (src/lib/sander.ts), the cameras or the shader.
 *
 * Needs Playwright (npm install --no-save playwright, then
 * npx playwright install chromium) and the built site being served:
 *
 *   npm run build && npm run preview
 *   node scripts/render-stills.mjs [http://localhost:4321/]
 *
 * Then build again so dist/ picks up the new stills.
 */
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:4321/';
const out = new URL('../public/renders/', import.meta.url);
const jobs = [
  { theme: 'light', view: 'hero', file: 'housing-light.webp' },
  { theme: 'dark', view: 'hero', file: 'housing-dark.webp' },
  { theme: 'light', view: 'cad', file: 'cad-light.webp' },
];

// Software rendering, so every machine produces the same pixels.
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
for (const job of jobs) {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1200 },
    deviceScaleFactor: 2,
    colorScheme: job.theme,
    reducedMotion: 'reduce',
  });
  await page.goto(url, { waitUntil: 'networkidle' });
  const model = `[data-model][data-view="${job.view}"]`;
  // Draw the model 780 CSS px wide, so its 2x canvas is the still's size.
  await page.addStyleTag({
    content: `${model} { width: 780px !important; max-width: none !important; flex: none !important; }`,
  });
  await page.locator(model).first().scrollIntoViewIfNeeded();
  await page.waitForFunction(
    (model) => {
      const root = document.querySelector(model);
      return root?.classList.contains('is-live') && root.querySelector('canvas')?.width === 1560;
    },
    model,
    { timeout: 90_000 },
  );
  await page.waitForTimeout(1000);
  const data = await page.evaluate((model) => {
    const canvas = document.querySelector(`${model} canvas`);
    const still = document.createElement('canvas');
    still.width = 1560;
    still.height = 1125;
    still.getContext('2d').drawImage(canvas, 0, 0, still.width, still.height);
    return still.toDataURL('image/webp', 0.88);
  }, model);
  writeFileSync(new URL(job.file, out), Buffer.from(data.split(',')[1], 'base64'));
  console.log(`public/renders/${job.file}`);
  await page.close();
}
await browser.close();
