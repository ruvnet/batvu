// SPDX-License-Identifier: MIT
//
// The benchmark that decides whether BatVu is a product or a demo.
//
// The number that matters is not "how fast is the FFT". It is: **can one ping's
// complete work — compress, detect, and fold into the map — finish inside the
// pulse repetition interval, on a phone, while the same phone is also drawing at
// 60 fps and staying cool enough to hold?**
//
// At 15 pings a second the interval is 66.7 ms. A desktop x86 core is roughly
// 3-5x an iPhone's single-core throughput for scalar wasm, so the working target
// here is **under 6 ms per ping** — leaving an order of magnitude of headroom
// for the phone, the renderer, and thermal throttling.
//
// Each stage is timed separately, because a total tells you there is a problem
// and never which one. Results land in `bench/results/latest.json` so a
// regression is a diff rather than a memory.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import {
  BatVuCore,
  DEFAULT_PING_RATE_HZ,
  DEFAULT_SONAR_CONFIG,
  OccupancyGrid,
  coneRays,
  fromSpherical,
  minPriSeconds,
  recordLenFor,
} from '../packages/batvu-core/dist/index.js';
import { livingRoom, sampleBeam } from '../packages/batvu-sim/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(here, 'results');

const PING_BUDGET_MS = 1000 / DEFAULT_PING_RATE_HZ;
/** Desktop budget: a tenth of the interval, leaving 10x for a phone. */
const TARGET_MS = PING_BUDGET_MS / 10;

/**
 * Time `fn` and report the MEDIAN, not the mean.
 *
 * A benchmark's mean is a measurement of the garbage collector. The median says
 * what a typical ping costs; p95 says what the worst frame costs, which is the
 * one a user perceives as a stutter.
 */
function measure(name, fn, { warmup = 20, iterations = 200 } = {}) {
  for (let i = 0; i < warmup; i++) fn(i);
  const samples = new Float64Array(iterations);
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn(i);
    samples[i] = performance.now() - t0;
  }
  const sorted = Array.from(samples).sort((a, b) => a - b);
  return {
    name,
    iterations,
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.floor(sorted.length * 0.95)],
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
  };
}

function row(r, budget) {
  const share = ((r.medianMs / PING_BUDGET_MS) * 100).toFixed(1);
  const flag = budget !== undefined && r.medianMs > budget ? ' ⚠' : '';
  return (
    `  ${r.name.padEnd(34)} ${r.medianMs.toFixed(3).padStart(8)} ms   ` +
    `p95 ${r.p95Ms.toFixed(3).padStart(7)} ms   ${share.padStart(5)}% of a ping${flag}`
  );
}

const core = await BatVuCore.load();
const config = DEFAULT_SONAR_CONFIG;
const recordLen = recordLenFor(config);
const room = livingRoom();

console.log('BatVu benchmarks');
console.log(
  `  ${config.f0 / 1000}-${config.f1 / 1000} kHz · ${config.durationS * 1000} ms · ` +
    `${DEFAULT_PING_RATE_HZ} Hz · record ${recordLen} samples · ` +
    `PRI ${PING_BUDGET_MS.toFixed(1)} ms · desktop target ${TARGET_MS.toFixed(1)} ms\n`,
);

// A realistic sweep's worth of records, pre-rendered so the simulator's cost
// does not contaminate the pipeline measurement.
const beams = Array.from({ length: 32 }, (_, i) =>
  fromSpherical({ azimuth: (i / 32) * 2 * Math.PI - Math.PI, elevation: 0.2 * Math.sin(i) }),
);
const halfAngle = (30 * Math.PI) / 180;
const records = beams.map((beam, i) => {
  const targets = sampleBeam(room, { x: 0, y: 0, z: 0 }, beam, coneRays(beam, halfAngle, 96), {
    halfAngleDeg: 30,
    rays: 96,
    clusterM: 0.08,
    maxRangeM: config.maxRangeM,
  });
  const res = core.eval({
    op: 'simulate',
    config,
    targets,
    scene: { recordLen, noiseRms: 8e-4, seed: (0x5eed + i * 7919) >>> 0 },
  });
  return Float32Array.from(res.samples);
});

const results = [];

// ── stage 1: the DSP ─────────────────────────────────────────────────────────
const plan = core.createPlan(config, recordLen);
results.push(
  measure('dsp: compress + detect (wasm)', (i) => {
    plan.processSamples(records[i % records.length]);
  }),
);

// The copy-in is measured separately because it is the part a native app would
// not pay at all — it exists only because the browser hands us a JS array.
const scratch = records[0];
results.push(
  measure('dsp: process, no copy-in (wasm)', () => {
    plan.input.set(scratch);
    plan.process();
  }),
);

// ── stage 2: the map ─────────────────────────────────────────────────────────
const pingResults = records.map((r) => plan.processSamples(r));
const grid = new OccupancyGrid({ beamHalfAngleDeg: 30 });
results.push(
  measure(
    'map: occupancy integrate (JS)',
    (i) => {
      grid.integrate(pingResults[i % pingResults.length], {
        beam: beams[i % beams.length],
        minRangeM: config.minRangeM,
        maxRangeM: config.maxRangeM,
      });
    },
    { iterations: 120 },
  ),
);

// ── stage 3: what the renderer reads ─────────────────────────────────────────
results.push(
  measure('map: state signature (JS)', () => grid.stateSignature(), { iterations: 60 }),
);
results.push(measure('map: occupied count (JS)', () => grid.occupiedCount(), { iterations: 60 }));
results.push(
  measure('map: occupied points (JS)', () => grid.occupiedPoints(), { iterations: 30 }),
);

// ── stage 4: the whole ping ──────────────────────────────────────────────────
const wholeGrid = new OccupancyGrid({ beamHalfAngleDeg: 30 });
results.push(
  measure(
    'END TO END: one ping, DSP + map',
    (i) => {
      const r = plan.processSamples(records[i % records.length]);
      wholeGrid.integrate(r, {
        beam: beams[i % beams.length],
        minRangeM: config.minRangeM,
        maxRangeM: config.maxRangeM,
      });
    },
    { iterations: 120 },
  ),
);

// ── stage 5: the simulator, which only CI pays for ───────────────────────────
results.push(
  measure(
    'sim: render one record (wasm+JS)',
    (i) => {
      const beam = beams[i % beams.length];
      const targets = sampleBeam(room, { x: 0, y: 0, z: 0 }, beam, coneRays(beam, halfAngle, 96), {
        halfAngleDeg: 30,
        rays: 96,
        clusterM: 0.08,
        maxRangeM: config.maxRangeM,
      });
      core.eval({ op: 'simulate', config, targets, scene: { recordLen, noiseRms: 8e-4, seed: 1 } });
    },
    { iterations: 40 },
  ),
);

plan.destroy();

for (const r of results) console.log(row(r, r.name.startsWith('END TO END') ? TARGET_MS : undefined));

const endToEnd = results.find((r) => r.name.startsWith('END TO END'));
const headroom = PING_BUDGET_MS / endToEnd.medianMs;
console.log(
  `\n  One ping costs ${endToEnd.medianMs.toFixed(2)} ms of a ${PING_BUDGET_MS.toFixed(1)} ms budget ` +
    `— ${headroom.toFixed(0)}x headroom on this machine.`,
);
console.log(
  `  A phone is roughly 3-5x slower for scalar wasm, so expect ${(headroom / 5).toFixed(0)}-${(headroom / 3).toFixed(0)}x there.`,
);

mkdirSync(RESULTS, { recursive: true });
const report = {
  config: {
    band: `${config.f0}-${config.f1} Hz`,
    durationS: config.durationS,
    pingRateHz: DEFAULT_PING_RATE_HZ,
    recordLen,
    priMs: PING_BUDGET_MS,
    minPriMs: minPriSeconds(config) * 1000,
  },
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  results,
};
writeFileSync(join(RESULTS, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`);

if (endToEnd.medianMs > TARGET_MS) {
  console.error(
    `\nFAIL: one ping takes ${endToEnd.medianMs.toFixed(2)} ms, over the ${TARGET_MS.toFixed(1)} ms desktop target.`,
  );
  process.exitCode = 1;
}
