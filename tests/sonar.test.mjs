import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLinearChirp, simulateEchoes, scan, rangeToSample, sampleToRange } from '../packages/dsp/sonar.mjs';

const sampleRate = 48000;
const probe = makeLinearChirp({ sampleRate, startHz: 17500, endHz: 20000, durationSec: 0.008 });

test('range conversion round trips within one sample', () => {
  for (const r of [0.3, 1, 2.5, 5]) {
    const s = rangeToSample(r, sampleRate);
    assert.ok(Math.abs(sampleToRange(s, sampleRate) - r) <= 343.2 / sampleRate / 2);
  }
});

test('single reflector is recovered within 4 cm', () => {
  const received = simulateEchoes(probe, { sampleRate, lengthSamples: 4096, targets: [{ rangeM: 2.0, amplitude: 0.35 }] });
  const detections = scan(received, probe, { sampleRate, minRangeM: 0.3, maxRangeM: 5, threshold: { guard: 20, training: 64, scale: 4 } });
  assert.ok(detections.find(d => Math.abs(d.rangeM - 2.0) < 0.04), JSON.stringify(detections.slice(0, 10)));
});

test('two separated reflectors are both recovered', () => {
  const targets = [{ rangeM: 1.5, amplitude: 0.42 }, { rangeM: 2.8, amplitude: 0.3 }];
  const received = simulateEchoes(probe, { sampleRate, lengthSamples: 4096, targets });
  const detections = scan(received, probe, { sampleRate, minRangeM: 0.3, maxRangeM: 5, threshold: { guard: 20, training: 64, scale: 3.5 } });
  for (const t of targets) assert.ok(detections.some(d => Math.abs(d.rangeM - t.rangeM) < 0.04), JSON.stringify(detections));
});

test('NaN input never hangs or yields NaN detections', () => {
  const received = simulateEchoes(probe, { sampleRate, lengthSamples: 2048, targets: [{ rangeM: 1.2 }] });
  received[999] = NaN;
  const detections = scan(received, probe, { sampleRate, minRangeM: 0.3, maxRangeM: 4 });
  assert.ok(detections.every(d => Number.isFinite(d.rangeM) && Number.isFinite(d.confidence)));
});
