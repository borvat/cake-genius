/**
 * Render tools/og-image.html to public/img/og-image.png (1200x630) with the
 * Chromium that the local verification lab already has installed. No network,
 * no design tool, no runtime dependency: the PNG is committed.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const require = createRequire('C:/Users/Zulik/verification-lab/package.json');
const { chromium } = require('playwright');

const root = path.resolve(import.meta.dirname, '..');
const source = pathToFileURL(path.join(root, 'tools', 'og-image.html')).href;
const target = path.join(root, 'public', 'img', 'og-image.png');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.goto(source, { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: target, type: 'png' });
await browser.close();
console.log(`wrote ${target}`);
