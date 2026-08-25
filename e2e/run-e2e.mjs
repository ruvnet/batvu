// SPDX-License-Identifier: MIT
//
// The end-to-end test: drive the REAL app in a real browser and check that a
// room comes out the other end.
//
// What makes this worth having rather than a formality is that nothing is
// stubbed. The page loads the same wasm the phone loads, runs the same matched
// filter, the same CFAR and the same occupancy update, and the only substitution
// is upstream of all of it — `@batvu/sim` stands in for the microphone by
// synthesising the record a real room would have produced. So a pass means the
// browser build genuinely works: the module instantiates, the zero-copy views
// survive the bundler, the canvas draws, and the map forms.
//
// It also catches the class of bug unit tests structurally cannot. A wasm loader
// that works in Node and breaks under a bundler, a `node:fs` import that leaks
// into the web build, a typed-array view detached by memory growth — every one
// of those passes `vitest` and fails here.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PORT = Number(process.env.PORT ?? 8137);
const ARTIFACTS = join(here, 'artifacts');

/**
 * Which Chromium to launch, or `undefined` to let Playwright find its own.
 *
 * Undefined is the right default and the earlier hard-coded path was a bug
 * worth naming: it pointed at the exact versioned directory of the machine this
 * harness was written on, so the test could only ever pass there. CI failed at
 * `browserType.launch: Failed to launch chromium because executable doesn't
 * exist`, and would have failed identically on any contributor's laptop.
 *
 * A test that passes only in the environment that authored it is worse than no
 * test, because it reads as coverage. Playwright's own resolution is what the
 * `playwright` dependency is for; `BATVU_CHROMIUM` remains as an escape hatch
 * for a sandbox that pins a different build.
 */
const EXECUTABLE = process.env.BATVU_CHROMIUM;

/**
 * Launch Chromium, and turn Playwright's "just run npx playwright install"
 * banner into something actionable when that is not the answer.
 *
 * It is not the answer in a pre-provisioned sandbox, where the browsers are
 * already on disk under `PLAYWRIGHT_BROWSERS_PATH` but at a build number this
 * `playwright` release does not ask for. Downloading over them is exactly what
 * such an image is set up to avoid, so the escape hatch is to name the binary.
 */
async function launchChromium() {
  if (EXECUTABLE) {
    console.log(`  browser: ${EXECUTABLE} (BATVU_CHROMIUM)`);
    return chromium.launch({ executablePath: EXECUTABLE });
  }
  try {
    return await chromium.launch();
  } catch (err) {
    const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (root) {
      throw new Error(
        `${err.message}\n\n` +
          `PLAYWRIGHT_BROWSERS_PATH is set to ${root}, so this looks like a sandbox with\n` +
          `pre-provisioned browsers at a different build number than playwright asks for.\n` +
          `Point at one directly rather than downloading over them, e.g.\n\n` +
          `  BATVU_CHROMIUM=${root}/chromium-<build>/chrome-linux/chrome npm run e2e\n`,
      );
    }
    throw err;
  }
}

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitForServer(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`server did not come up at ${url}`);
}

async function main() {
  mkdirSync(ARTIFACTS, { recursive: true });

  const server = spawn(process.execPath, [join(root, 'packages/batvu-web/scripts/serve.mjs')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  let browser;
  try {
    await waitForServer(`http://127.0.0.1:${PORT}/index.html`);

    browser = await launchChromium();
    // A phone-shaped viewport, because the layout is the deliverable too: a
    // desktop-sized run would not catch a control that falls off the screen.
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();

    const consoleErrors = [];
    const pageErrors = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    const missing = [];
    page.on('requestfailed', (r) => missing.push(r.url()));
    page.on('response', (r) => {
      if (r.status() >= 400) missing.push(`${r.status()} ${r.url()}`);
    });
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'load' });

    // ── the app boots ────────────────────────────────────────────────────────
    await page.waitForFunction(() => Boolean(globalThis.batvu), null, { timeout: 30_000 });
    check('the app boots and instantiates the wasm core', true);

    const initial = await page.evaluate(() => globalThis.batvu.state());
    check('starts idle', initial.mode === 'idle' && initial.pings === 0);

    // ── a scan runs ──────────────────────────────────────────────────────────
    await page.click('#demo');
    await page.waitForFunction(() => globalThis.batvu.state().pings >= 45, null, {
      timeout: 60_000,
    });
    const scanned = await page.evaluate(() => globalThis.batvu.state());

    check('pings are processed', scanned.pings >= 45, `${scanned.pings} pings`);
    check(
      'echoes are detected',
      scanned.detections > 0,
      `${scanned.detections} detections over ${scanned.pings} pings`,
    );
    check(
      'the sweep covers ground',
      scanned.coverage > 0.02,
      `${(scanned.coverage * 100).toFixed(1)}% of the sphere`,
    );
    check(
      'the occupancy map forms',
      scanned.occupiedVoxels > 20,
      `${scanned.occupiedVoxels} occupied voxels`,
    );

    // ── the last ping is sane ────────────────────────────────────────────────
    const last = scanned.lastResult;
    check('a ping result is exposed', Boolean(last));
    if (last) {
      check('the direct path is found', last.blastAmplitude > 0);
      check('the record does not clip', last.saturated === false);
      check('no non-finite samples reach the DSP', last.sanitized === 0);
      check(
        'the range window matches the config',
        last.startRangeM > 0.5 && last.startRangeM < 0.8,
        `starts at ${last.startRangeM.toFixed(3)} m`,
      );
      check(
        'ranges land inside the simulated room',
        last.detections.every((d) => d.rangeM > 0.5 && d.rangeM < 6.5),
        JSON.stringify(last.detections.map((d) => +d.rangeM.toFixed(2))),
      );
    }

    // ── the canvases actually drew ───────────────────────────────────────────
    //
    // A blank canvas is the classic silent failure: every number is right, the
    // state object looks perfect, and the user sees black. Sampling the pixels
    // is the only assertion that catches it.
    const drew = await page.evaluate(() => {
      const out = {};
      for (const id of ['ppi', 'ascope', 'coverage']) {
        const c = document.getElementById(id);
        const ctx = c.getContext('2d');
        const { data } = ctx.getImageData(0, 0, c.width, c.height);
        let lit = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] + data[i + 1] + data[i + 2] > 90) lit++;
        }
        out[id] = { lit, total: data.length / 4 };
      }
      return out;
    });
    for (const [id, m] of Object.entries(drew)) {
      check(
        `#${id} renders visible content`,
        m.lit > m.total * 0.001,
        `${((m.lit / m.total) * 100).toFixed(2)}% of pixels lit`,
      );
    }

    // ── it stops cleanly ─────────────────────────────────────────────────────
    await page.click('#stop');
    const stopped = await page.evaluate(() => globalThis.batvu.state());
    check('stops on request', stopped.mode === 'idle');

    const settled = await page.evaluate(() => globalThis.batvu.state().pings);
    await new Promise((r) => setTimeout(r, 600));
    const after = await page.evaluate(() => globalThis.batvu.state().pings);
    check('no pings after stop', after === settled, `${settled} -> ${after}`);

    // ── nothing threw ────────────────────────────────────────────────────────
    check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
    check('no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
    check('every request the page makes succeeds', missing.length === 0, missing.join(' | '));

    await page.screenshot({ path: join(ARTIFACTS, 'batvu-demo-scan.png'), fullPage: true });
    writeFileSync(
      join(ARTIFACTS, 'e2e-report.json'),
      `${JSON.stringify({ checks, state: scanned }, null, 2)}\n`,
    );
  } finally {
    await browser?.close();
    server.kill();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    console.error(`FAILED: ${failed.map((f) => f.name).join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log(`screenshot: ${join(ARTIFACTS, 'batvu-demo-scan.png')}`);
  }
}

await main();
