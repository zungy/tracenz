/**
 * Prints the sample design document (the /samples/tr-0142 route) to
 * public/samples/TR-0142-rev-b.pdf, the PDF offered on the home page. Re-run
 * it after changing src/components/home/DocPage.astro or the drawings.
 *
 * Needs Playwright (npm install --no-save playwright, then
 * npx playwright install chromium) and the built site being served:
 *
 *   npm run build && npm run preview
 *   node scripts/print-sample.mjs [http://localhost:4321/]
 */
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:4321/';
const out = new URL('../public/samples/TR-0142-rev-b.pdf', import.meta.url);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 794, height: 1123 } });
await page.goto(new URL('samples/tr-0142/', base).href, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.pdf({
  path: out.pathname,
  format: 'A4',
  printBackground: true,
  margin: { top: 0, right: 0, bottom: 0, left: 0 },
  preferCSSPageSize: true,
});
console.log('public/samples/TR-0142-rev-b.pdf');
await browser.close();
