// SPDX-License-Identifier: MIT
//
// Capture the README hero from the REAL app.
//
// The point of this being a script rather than a screenshot somebody took once
// is that a committed PNG goes stale silently. The UI changes, the physics
// changes — as it did in ADR-022, which moved every number on that display —
// and the image at the top of the README keeps advertising a build that no
// longer exists. `npm run hero` regenerates it from the same server, the same
// wasm and the same pipeline the end-to-end suite drives, so the picture is a
// measurement of the current build rather than a drawing of a past one.
//
// Everything in the frame is real: the arcs are CFAR detections from a matched
// filter running in wasm, the counters are live state, and the subtitle says
// "Simulating" because it is — the simulator stands in for the microphone, and
// the app says so on its own face rather than in a caption underneath.
import { spawn } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PORT = Number(process.env.PORT ?? 8155);
const OUT = join(root, 'docs/img');

// Enough of a sweep that the room has closed, rather than the 45 pings the e2e
// gate needs to prove the pipeline runs at all.
const PINGS = 220;

async function waitForServer(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`server did not come up at ${url}`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const server = spawn(process.execPath, [join(root, 'packages/batvu-web/scripts/serve.mjs')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  let browser;
  try {
    await waitForServer(`http://127.0.0.1:${PORT}/index.html`);
    // Same escape hatch as the e2e harness, and for the same reason: a sandbox
    // may hold browsers at a build this playwright release does not ask for.
    browser = await chromium.launch({ executablePath: process.env.BATVU_CHROMIUM });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      // 2× is the retina point. 3× doubles the file for detail no README
      // renders at, and a repository is a bad place to put megabytes nobody
      // will ever see.
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();

    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => Boolean(globalThis.batvu), null, { timeout: 30_000 });
    await page.click('#demo');
    await page.waitForFunction((n) => globalThis.batvu.state().pings >= n, PINGS, {
      timeout: 180_000,
    });
    await page.waitForTimeout(600);

    const s = await page.evaluate(() => globalThis.batvu.state());
    console.log(
      `  scan: ${s.pings} pings · ${s.detections} echoes · ` +
        `${(s.coverage * 100).toFixed(1)}% of the sphere · ${s.occupiedVoxels} voxels`,
    );

    // A self-contained unit: name, display, sweep bar, controls, live counters.
    // Cut above "LAST PING" so the A-scope is not sliced in half.
    const box = await (await page.$('#stats')).boundingBox();
    const file = join(OUT, 'batvu-hero.png');
    await page.screenshot({
      path: file,
      clip: { x: 0, y: 0, width: 390, height: Math.ceil(box.y + box.height + 14) },
    });

    if (errors.length) throw new Error(`the app logged errors:\n  ${errors.join('\n  ')}`);
    console.log(`  wrote docs/img/batvu-hero.png (${Math.round(statSync(file).size / 1024)} KB)`);
  } finally {
    browser?.close();
    server.kill();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
