// SPDX-License-Identifier: MIT
import { describe, expect, it, beforeAll } from 'vitest';
import {
  BatVuCore,
  DEFAULT_SONAR_CONFIG,
  recordLenFor,
  minPriSeconds,
  speedOfSound,
  mainlobeHalfWidth,
  recommendedCfarWindows,
  DEFAULT_PING_RATE_HZ,
  type DesignReport,
} from '../src/index.js';

let core: BatVuCore;

beforeAll(async () => {
  core = await BatVuCore.load();
});

describe('the wasm control surface', () => {
  it('loads and reports its ABI version', () => {
    const v = core.eval<{ name: string; version: string; abi: number }>({ op: 'version' });
    expect(v.name).toBe('batvu-dsp');
    expect(v.abi).toBe(1);
    expect(v.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('reports a design that agrees with the textbook formulas', () => {
    const r = core.eval<DesignReport>({
      op: 'design',
      config: DEFAULT_SONAR_CONFIG,
      priS: minPriSeconds(DEFAULT_SONAR_CONFIG),
    });
    expect(r.warning).toBeNull();
    // c = 331.3*sqrt(1+20/273.15) = 343.2 m/s
    expect(r.speedOfSoundMs).toBeCloseTo(343.2, 0);
    expect(r.bandwidthHz).toBeCloseTo(3000, 0);
    // BT = 3000 * 0.005 = 15 -> 10*log10(15) = 11.76 dB
    expect(r.compressionGainDb).toBeCloseTo(11.76, 1);
    // c/(2B) = 5.72 cm nominal, widened 1.67x by the full Hann TRANSMIT taper
    // = 9.55 cm realisable. The nominal figure alone overstates the sensor by
    // two thirds, so it is the widened one that is reported.
    expect(r.rangeResolutionM).toBeCloseTo(0.0955, 3);
    // c/(2*fs) = 3.575 mm per lag sample
    expect(r.rangeStepM).toBeCloseTo(0.003575, 5);
    // The BETTER of the two tapers: the transmit taper alone achieves -31.5 dB
    // nominal (and -45 dB measured on the compressed response).
    expect(r.sidelobeDb).toBeCloseTo(-31.5, 1);
    // Half a 5 ms pulse.
    expect(r.blindRangeM).toBeCloseTo(0.858, 2);
  });

  it('agrees with the TypeScript side on CFAR window sizing', () => {
    // Two implementations of the same arithmetic — one in Rust for the phone,
    // one in TypeScript for the flywheel's policy resolver. If they drift, the
    // flywheel silently evaluates a differently-configured detector from the one
    // it promotes, and every receipt downstream is wrong.
    for (const config of [
      DEFAULT_SONAR_CONFIG,
      { ...DEFAULT_SONAR_CONFIG, f0: 17_000, f1: 23_000, rxTaper: 'hann' as const },
      { ...DEFAULT_SONAR_CONFIG, f0: 19_000, f1: 20_000, txWindow: 'rect' as const },
      { ...DEFAULT_SONAR_CONFIG, rxTaper: 'blackman-harris' as const },
    ]) {
      const r = core.eval<DesignReport>({ op: 'design', config });
      expect(mainlobeHalfWidth(config)).toBeCloseTo(r.mainlobeSamples, 3);
      const ts = recommendedCfarWindows(config);
      expect(ts.guard).toBe(r.recommendedGuard);
      expect(ts.train).toBe(r.recommendedTrain);
      expect(ts.mergeGap).toBe(r.recommendedMergeGap);
    }
  });

  it('ships defaults that match what the core recommends for the waveform', () => {
    const r = core.eval<DesignReport>({ op: 'design', config: DEFAULT_SONAR_CONFIG });
    expect(DEFAULT_SONAR_CONFIG.cfarGuard).toBe(r.recommendedGuard);
    expect(DEFAULT_SONAR_CONFIG.cfarTrain).toBe(r.recommendedTrain);
    expect(DEFAULT_SONAR_CONFIG.cfarMergeGap).toBe(r.recommendedMergeGap);
  });

  it('warns rather than throws when a config would alias', () => {
    const r = core.eval<DesignReport>({
      op: 'design',
      config: { ...DEFAULT_SONAR_CONFIG, f1: 30_000 },
    });
    expect(r.warning).toContain('Nyquist');
  });

  it('refuses to build a plan from an unrealisable config, and says why', () => {
    expect(() => core.createPlan({ ...DEFAULT_SONAR_CONFIG, f1: 30_000 }, 4096)).toThrow(/Nyquist/);
  });

  it('returns the exact transmit waveform', () => {
    const r = core.eval<{ fs: number; len: number; samples: number[] }>({
      op: 'chirp',
      config: DEFAULT_SONAR_CONFIG,
    });
    expect(r.len).toBe(240); // 5 ms at 48 kHz
    expect(r.samples).toHaveLength(240);
    const peak = Math.max(...r.samples.map(Math.abs));
    expect(peak).toBeLessThanOrEqual(DEFAULT_SONAR_CONFIG.amplitude + 1e-4);
    expect(peak).toBeGreaterThan(0.5);
  });

  it('exposes disjoint holdout and anchor scene suites', () => {
    const s = core.eval<{
      holdout: { name: string; targets: unknown[] }[];
      anchor: { name: string; targets: unknown[] }[];
    }>({ op: 'scenes' });
    expect(s.holdout.length).toBeGreaterThanOrEqual(3);
    expect(s.anchor.length).toBeGreaterThanOrEqual(3);
    const holdoutNames = new Set(s.holdout.map((x) => x.name));
    for (const a of s.anchor) expect(holdoutNames.has(a.name)).toBe(false);
  });
});

describe('the plan surface', () => {
  it('ranges a simulated wall to within a centimetre', () => {
    const recordLen = recordLenFor(DEFAULT_SONAR_CONFIG);
    const sim = core.eval<{ samples: number[] }>({
      op: 'simulate',
      config: DEFAULT_SONAR_CONFIG,
      targets: [{ rangeM: 2.4, reflectivity: 0.9, spreading: 1 }],
      scene: { recordLen, noiseRms: 5e-4 },
    });

    const plan = core.createPlan(DEFAULT_SONAR_CONFIG as unknown as Record<string, unknown>, recordLen);
    try {
      const result = plan.processSamples(sim.samples);
      expect(result.saturated).toBe(false);
      expect(result.sanitized).toBe(0);
      const wall = result.detections.find((d) => Math.abs(d.rangeM - 2.4) < 0.05);
      expect(wall, `detections: ${JSON.stringify(result.detections)}`).toBeDefined();
      expect(wall!.rangeM).toBeCloseTo(2.4, 1);
      expect(wall!.snrDb).toBeGreaterThan(10);
    } finally {
      plan.destroy();
    }
  });

  it('gives a zero-copy envelope view into wasm memory', () => {
    const recordLen = 24_000;
    const sim = core.eval<{ samples: number[] }>({
      op: 'simulate',
      config: DEFAULT_SONAR_CONFIG,
      targets: [{ rangeM: 3, reflectivity: 0.9, spreading: 1 }],
      scene: { recordLen, noiseRms: 5e-4 },
    });
    const plan = core.createPlan(DEFAULT_SONAR_CONFIG as unknown as Record<string, unknown>, recordLen);
    try {
      expect(plan.recordLen).toBe(recordLen);
      expect(plan.envLen).toBeGreaterThan(1000);
      // The input view is writable memory inside the module.
      const input = plan.input;
      expect(input).toBeInstanceOf(Float32Array);
      expect(input.length).toBe(recordLen);

      const result = plan.processSamples(sim.samples);
      const env = plan.envelope;
      expect(env.length).toBe(plan.envLen);
      expect(result.envLen).toBeLessThanOrEqual(env.length);

      // The envelope's peak bin should land on the wall's range.
      let peak = 0;
      for (let i = 1; i < result.envLen; i++) if (env[i]! > env[peak]!) peak = i;
      const peakRange = result.startRangeM + peak * result.rangeStepM;
      expect(peakRange).toBeCloseTo(3, 1);
    } finally {
      plan.destroy();
    }
  });

  it('hands back the complex profile only when the plan asked for it', () => {
    // ADR-023 §1: `envelope()` gains a sibling that writes `(re, im)` pairs and
    // the magnitude path is untouched, so nothing downstream changes until
    // something asks for phase. Both halves of that are asserted here, because
    // an export this side does not name is an export a Rust change can delete
    // silently — and phase being deleted is the defect the ADR is about.
    const recordLen = 24_000;
    const sim = core.eval<{ samples: number[] }>({
      op: 'simulate',
      config: DEFAULT_SONAR_CONFIG,
      targets: [{ rangeM: 2.6, reflectivity: 0.9, spreading: 1 }],
      scene: { recordLen, noiseRms: 5e-4 },
    });
    const base = DEFAULT_SONAR_CONFIG as unknown as Record<string, unknown>;

    const plain = core.createPlan(base, recordLen);
    try {
      plain.processSamples(sim.samples);
      expect(plain.iq).toBeNull();
    } finally {
      plain.destroy();
    }

    // Blast cancellation off, so the two buffers describe the same numbers and
    // the agreement is checkable. With it on they diverge at every bin, which
    // is what `blastCancelled` is reported for.
    const plan = core.createPlan(
      { ...base, complexProfile: true, blastCancellation: false },
      recordLen,
    );
    try {
      const result = plan.processSamples(sim.samples);
      expect(result.blastCancelled).toBe(false);
      expect(result.iqLen).toBe(2 * result.envLen);

      const iq = plan.iq;
      expect(iq).not.toBeNull();
      expect(iq!.length).toBe(2 * plan.envLen);
      expect(result.envLen).toBeLessThanOrEqual(plan.envLen);

      const env = plan.envelope;
      let checked = 0;
      let turning = 0;
      for (let i = 0; i < result.envLen; i++) {
        if (env[i] === 0) continue;
        const re = iq![2 * i]!;
        const im = iq![2 * i + 1]!;
        expect(Math.hypot(re, im)).toBeCloseTo(env[i]!, 6);
        checked++;
        if (Math.abs(re) > 1e-6 && Math.abs(im) > 1e-6) turning++;
      }
      expect(checked).toBeGreaterThan(1000);
      // Without this, a complex path that emitted `(|z|, 0)` — phase deleted,
      // the exact defect — would satisfy every assertion above.
      expect(turning).toBeGreaterThan(1000);
    } finally {
      plan.destroy();
    }

    // And the default: cancellation on, so the host is told the buffers do NOT
    // agree rather than left to assume they do.
    const shipped = core.createPlan({ ...base, complexProfile: true }, recordLen);
    try {
      const result = shipped.processSamples(sim.samples);
      expect(result.blastCancelled).toBe(true);
    } finally {
      shipped.destroy();
    }
  });

  it('cancels unknown capture latency via the direct-path blast', () => {
    const recordLen = 36_000;
    const config = DEFAULT_SONAR_CONFIG as unknown as Record<string, unknown>;
    const ranges: number[] = [];
    for (const latencySamples of [0, 137, 2048, 9311]) {
      const sim = core.eval<{ samples: number[] }>({
        op: 'simulate',
        config: DEFAULT_SONAR_CONFIG,
        targets: [{ rangeM: 3, reflectivity: 0.9, spreading: 1 }],
        scene: { recordLen, noiseRms: 5e-4, latencySamples },
      });
      const plan = core.createPlan(config, recordLen);
      try {
        const r = plan.processSamples(sim.samples);
        const wall = r.detections.find((d) => Math.abs(d.rangeM - 3) < 0.1);
        expect(wall, `latency ${latencySamples} lost the wall`).toBeDefined();
        ranges.push(wall!.rangeM);
      } finally {
        plan.destroy();
      }
    }
    const spread = Math.max(...ranges) - Math.min(...ranges);
    expect(spread).toBeLessThan(0.01);
  });

  it('counts non-finite input samples instead of letting them poison the ping', () => {
    const recordLen = recordLenFor(DEFAULT_SONAR_CONFIG);
    const sim = core.eval<{ samples: number[] }>({
      op: 'simulate',
      config: DEFAULT_SONAR_CONFIG,
      targets: [{ rangeM: 2.4, reflectivity: 0.9, spreading: 1 }],
      scene: { recordLen, noiseRms: 5e-4 },
    });
    const dirty = [...sim.samples];
    dirty[100] = NaN;
    dirty[5000] = Infinity;

    const plan = core.createPlan(DEFAULT_SONAR_CONFIG as unknown as Record<string, unknown>, recordLen);
    try {
      const r = plan.processSamples(dirty);
      expect(r.sanitized).toBe(2);
      expect(r.detections.some((d) => Math.abs(d.rangeM - 2.4) < 0.05)).toBe(true);
    } finally {
      plan.destroy();
    }
  });

  it('refuses to be used after destruction', () => {
    const plan = core.createPlan(DEFAULT_SONAR_CONFIG as unknown as Record<string, unknown>, 4096);
    plan.destroy();
    plan.destroy(); // idempotent
    expect(() => plan.process()).toThrow(/destroyed/);
    expect(() => plan.input).toThrow(/destroyed/);
  });
});

describe('config helpers', () => {
  it('computes the speed of sound from temperature', () => {
    expect(speedOfSound(0)).toBeCloseTo(331.3, 1);
    expect(speedOfSound(20)).toBeCloseTo(343.2, 0);
    expect(speedOfSound(30)).toBeGreaterThan(speedOfSound(20));
  });

  it('sizes the record for max range plus latency headroom', () => {
    const n = recordLenFor(DEFAULT_SONAR_CONFIG);
    const c = speedOfSound(DEFAULT_SONAR_CONFIG.temperatureC);
    const rangeSamples =
      ((2 * DEFAULT_SONAR_CONFIG.maxRangeM) / c) * DEFAULT_SONAR_CONFIG.fs;
    expect(n).toBeGreaterThan(rangeSamples);
    // The headroom is not slack: it has to cover the whole direct-path search
    // window, because WebAudio will not say when playback actually started.
    expect(n).toBeGreaterThan(
      rangeSamples + DEFAULT_SONAR_CONFIG.directSearchS * DEFAULT_SONAR_CONFIG.fs,
    );
  });

  it('derives a PRI that keeps max range unambiguous', () => {
    const pri = minPriSeconds(DEFAULT_SONAR_CONFIG);
    // 2*6/343.2 = 35.0 ms, plus the 5 ms pulse.
    expect(pri).toBeCloseTo(0.04, 3);
    // The shipped 15 Hz rate sits comfortably inside that bound. A bat in its
    // terminal buzz reaches 200 Hz; it gets there by giving up range, which is
    // the same trade available here and not one a room scan wants.
    expect(DEFAULT_PING_RATE_HZ).toBeLessThan(1 / pri);
    // 5 ms at 15 Hz is a 7.5% duty cycle — the number that actually governs
    // exposure and battery, and the one a per-ping level limit cannot see.
    expect(DEFAULT_SONAR_CONFIG.durationS * DEFAULT_PING_RATE_HZ).toBeCloseTo(0.075, 3);
  });
});
