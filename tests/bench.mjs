import { performance } from 'node:perf_hooks';
import { makeLinearChirp, simulateEchoes, scan } from '../packages/dsp/sonar.mjs';

const sampleRate = 48000;
const probe = makeLinearChirp({ sampleRate, startHz: 17500, endHz: 20000, durationSec: 0.008 });
const received = simulateEchoes(probe, {
  sampleRate,
  lengthSamples: 4096,
  targets: [{ rangeM: 1.2, amplitude: 0.3 }, { rangeM: 2.7, amplitude: 0.2 }],
});

for (let i = 0; i < 5; i++) scan(received, probe, { sampleRate });
const runs = 50;
const t0 = performance.now();
for (let i = 0; i < runs; i++) scan(received, probe, { sampleRate });
const ms = (performance.now() - t0) / runs;

console.log(JSON.stringify({
  runs,
  samples: received.length,
  probeSamples: probe.length,
  meanMsPerScan: Number(ms.toFixed(3)),
  realtimeBudgetAt20HzMs: 50,
  within20HzBudget: ms < 50,
}, null, 2));
