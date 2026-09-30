// Render Play's 1024×500 feature graphic to android/store-listing/.
// Run from the repository root: node frontend/scripts/generate-feature-graphic.mjs
// Needs ImageMagick (magick) and Playwright's Chromium (npx playwright install chromium).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('../..', import.meta.url));
const fonts = `${root}/frontend/node_modules/@fontsource-variable`;
const out = `${root}/android/store-listing/feature-graphic-1024x500.png`;
const tmp = mkdtempSync(join(tmpdir(), 'gp-feature-'));

try {
  // Same crop and mint-artwork alpha mask as generate-icons.sh, but trimmed and
  // left transparent: the icon's opaque square would show against the glow.
  execFileSync('magick', [`${root}/groovepede.xcf`, '-crop', '970x870+130+110', '+repage', `${tmp}/crop.png`]);
  execFileSync('magick', [`${tmp}/crop.png`,
    '(', '+clone', '-alpha', 'off', '-fx', 'g>0.16 && g>r*1.35 && g>b*1.08 ? 1 : 0',
    '-morphology', 'Close', 'Disk:10', '-morphology', 'Dilate', 'Disk:7', '-blur', '0x2', ')',
    '-alpha', 'off', '-compose', 'CopyOpacity', '-composite', '-trim', '+repage', `${tmp}/mark.png`]);

  // Colours and fonts match the app (style.css tokens) and the icon background.
  writeFileSync(`${tmp}/feature.html`, `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Brico;src:url(file://${fonts}/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2);font-weight:200 800}
@font-face{font-family:Hanken;src:url(file://${fonts}/hanken-grotesk/files/hanken-grotesk-latin-wght-normal.woff2);font-weight:100 900}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1024px;height:500px;overflow:hidden}
body{background:#0d1113;display:flex;align-items:center;gap:8px;padding-left:56px;
 background-image:radial-gradient(circle at 256px 250px,rgba(15,210,135,.16),transparent 360px)}
img{width:400px;flex:none;margin-right:36px}
h1{font-family:Brico;font-weight:800;font-size:84px;letter-spacing:-.03em;color:#f5f3ee;line-height:1}
p{font-family:Hanken;font-weight:500;font-size:34px;color:#0FD287;margin-top:14px}
small{display:block;font-family:Hanken;font-weight:400;font-size:24px;color:#9a948c;margin-top:22px}
</style></head><body>
<img src="file://${tmp}/mark.png">
<div><h1>Groovepede</h1><p>Your album listening inbox</p><small>Queue albums from any streaming service.<br>No account. No ads.</small></div>
</body></html>`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1024, height: 500 } });
  await page.goto(`file://${tmp}/feature.html`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: out });
  await browser.close();
  console.log(`Wrote ${out}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
