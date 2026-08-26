// SPDX-License-Identifier: MIT
//
// Everything here is synthesised in this file. Nothing imports the simulator,
// and that is deliberate: ADR-023 §4 allows `Target::breathing` to exist as a
// unit-test fixture for ARITHMETIC and bars it from being evidence about
// people. A test asserting detection performance against a simulated breather
// asserts that the code agrees with the code, so what is asserted below is
// only ever that the machinery computes what it says it computes — a known
// phase modulation goes in, the stated rate and the stated displacement come
// back out, and pure noise fires at the rate the derivation predicts.

import { describe, expect, it } from 'vitest';
import {
  analyzeDwell,
  estimateNoiseFloor,
  fisherGPValue,
  fisherGThreshold,
  micromotionFeature,
  phaseNoiseStdRad,
  unwrapInPlace,
  wavelengthM,
  type ComplexProfileDwell,
} from '../index.js';

const SPEED_OF_SOUND = 343;
/** Centre of the shipping 17.5–20.5 kHz chirp. */
const CENTRE_HZ = 19_000;
const LAMBDA = wavelengthM(CENTRE_HZ, SPEED_OF_SOUND);
const PRF = 15;
/** 600 pings at 15 Hz is a 40 s dwell: Δf = 0.025 Hz. */
const PINGS = 600;
const DF = PRF / PINGS;
/** The band these tests search. It exercises the arithmetic; it is NOT a
 *  physiological claim, and the detector takes it as a parameter for exactly
 *  that reason. */
const BAND: readonly [number, number] = [0.1, 0.6];
/** k = 4 … 24 inclusive. */
const BAND_BINS = 21;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

interface SynthSpec {
  pings: number;
  bins: number;
  /** Per-ping SNR in dB of a unit-amplitude scatterer. */
  snrDb: number;
  seed: number;
  /** Reflection amplitude of bin `b`. 0 means nothing is there at all. */
  amplitude?: (bin: number) => number;
  /** Radial displacement of bin `b` at time `t`, metres. */
  displacement?: (bin: number, t: number) => number;
}

/**
 * Complex range profiles with a known phase modulation.
 *
 * `z = A·exp(i(θ_b + 4πd/λ)) + n`. Each bin gets its own arbitrary reflection
 * phase `θ_b`, because a real scatterer has one and nothing in the detector is
 * allowed to depend on it. The sign of the modulation term is a convention of
 * whatever demodulates the profile; the detector only ever reports magnitudes,
 * so nothing here or there depends on which way it runs.
 */
function synthesise(spec: SynthSpec): { dwell: ComplexProfileDwell; noiseFloor: number } {
  const rand = mulberry32(spec.seed);
  const noiseFloor = Math.pow(10, -spec.snrDb / 20);
  const sigma = noiseFloor / Math.SQRT2;
  const theta = new Float64Array(spec.bins);
  for (let b = 0; b < spec.bins; b++) theta[b]! = (rand() * 2 - 1) * Math.PI;

  const data = new Float64Array(spec.pings * spec.bins * 2);
  for (let p = 0; p < spec.pings; p++) {
    const t = p / PRF;
    for (let b = 0; b < spec.bins; b++) {
      const amp = spec.amplitude ? spec.amplitude(b) : 1;
      const d = spec.displacement ? spec.displacement(b, t) : 0;
      const phi = theta[b]! + (4 * Math.PI * d) / LAMBDA;
      const i = (p * spec.bins + b) * 2;
      data[i]! = amp * Math.cos(phi) + sigma * gaussian(rand);
      data[i + 1]! = amp * Math.sin(phi) + sigma * gaussian(rand);
    }
  }
  return {
    dwell: {
      data,
      pings: spec.pings,
      bins: spec.bins,
      prfHz: PRF,
      lambdaM: LAMBDA,
      startRangeM: 0.6,
      rangeStepM: 0.02,
    },
    noiseFloor,
  };
}

describe('the phase relation', () => {
  it('reproduces ADR-023 arithmetic: 1 mm is 42° at 20 kHz', () => {
    const lambda20k = wavelengthM(20_000, SPEED_OF_SOUND);
    expect(lambda20k).toBeCloseTo(0.01715, 5);
    const degrees = ((4 * Math.PI * 0.001) / lambda20k) * (180 / Math.PI);
    expect(degrees).toBeCloseTo(42, 0);
  });

  it('unwraps a ramp that crosses the branch cut many times', () => {
    const n = 200;
    const truth = new Float64Array(n);
    const wrapped = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      truth[i]! = 0.4 * i - 3; // 12.7 full turns, 0.4 rad per step
      wrapped[i]! = Math.atan2(Math.sin(truth[i]!), Math.cos(truth[i]!));
    }
    // The wrapped sequence really does wrap: without unwrapping there is
    // nothing to recover.
    expect(Math.max(...wrapped)).toBeLessThan(Math.PI);
    unwrapInPlace(wrapped);
    const offset = wrapped[0]! - truth[0]!;
    for (let i = 0; i < n; i++) {
      expect(wrapped[i]! - offset).toBeCloseTo(truth[i]!, 9);
    }
  });
});

describe("Fisher's g null distribution", () => {
  it('matches the closed form for k = 2, where the algebra is one line', () => {
    // P(g ≥ x) = 2(1-x) for x ≥ 1/2.
    expect(fisherGPValue(0.7, 2)).toBeCloseTo(0.6, 12);
    expect(fisherGPValue(0.9, 2)).toBeCloseTo(0.2, 12);
    expect(fisherGPValue(1, 2)).toBe(0);
    expect(fisherGPValue(0.5, 2)).toBe(1);
  });

  it('matches Monte Carlo over the exponential ordinates it claims to describe', () => {
    // The derivation says the periodogram ordinates are i.i.d. exponential and
    // g is their max over their sum. This draws exactly that and counts.
    const rand = mulberry32(0xf15e);
    const k = 5;
    const trials = 40_000;
    const xs = [0.4, 0.55, 0.7];
    const hits = [0, 0, 0];
    for (let t = 0; t < trials; t++) {
      let sum = 0;
      let max = 0;
      for (let i = 0; i < k; i++) {
        const e = -Math.log(Math.max(rand(), 1e-12));
        sum += e;
        if (e > max) max = e;
      }
      const g = max / sum;
      for (let xi = 0; xi < xs.length; xi++) if (g >= xs[xi]!) hits[xi]! += 1;
    }
    for (let xi = 0; xi < xs.length; xi++) {
      const empirical = hits[xi]! / trials;
      // 3σ of a binomial at p ≈ 0.5 over 40 k trials is 0.0075.
      expect(Math.abs(empirical - fisherGPValue(xs[xi]!, k))).toBeLessThan(0.01);
    }
  });

  it('inverts to a threshold, and the threshold has the p-value asked for', () => {
    for (const alpha of [0.1, 0.01, 0.001]) {
      const g = fisherGThreshold(alpha, BAND_BINS);
      expect(fisherGPValue(g, BAND_BINS)).toBeCloseTo(alpha, 6);
    }
    // Monotone: a tighter false-alarm rate is a higher bar.
    expect(fisherGThreshold(0.001, BAND_BINS)).toBeGreaterThan(
      fisherGThreshold(0.1, BAND_BINS),
    );
  });
});

describe('recovering a known modulation', () => {
  it('reports the rate and the displacement of a tone on a Fourier bin', () => {
    const rateHz = 10 * DF; // 0.25 Hz, exactly on bin k = 10
    const amplitudeM = 0.0005;
    const target = 12;
    const { dwell, noiseFloor } = synthesise({
      pings: PINGS,
      bins: 48,
      snrDb: 20,
      seed: 0xba71,
      displacement: (b, t) =>
        b === target ? amplitudeM * Math.sin(2 * Math.PI * rateHz * t) : 0,
    });

    const result = analyzeDwell(dwell, { bandHz: BAND, noiseFloor });
    expect(result.status).toBe('ok');
    expect(result.bandBins).toBe(BAND_BINS);
    expect(result.freqResolutionHz).toBeCloseTo(DF, 12);

    const bin = result.bins[target]!;
    expect(bin.status).toBe('ok');
    expect(bin.rangeM).toBeCloseTo(0.6 + target * 0.02, 9);
    expect(bin.rateHz).toBeCloseTo(rateHz, 9);
    // On a Fourier bin the rectangular window is exact: A = 2|X[k]|/N.
    expect(bin.displacementM! / amplitudeM).toBeGreaterThan(0.95);
    expect(bin.displacementM! / amplitudeM).toBeLessThan(1.05);
    expect(bin.micromotionBand).toBeGreaterThan(result.scoreThreshold);
    expect(bin.statistic).toBeGreaterThan(result.statisticThreshold);
    expect(bin.snrDb).toBeGreaterThan(19.5);
    expect(bin.snrDb).toBeLessThan(20.5);
    // The estimator it publishes, on the sample it published it for.
    expect(bin.displacementNoiseM!).toBeCloseTo(
      (phaseNoiseStdRad(bin.snrDb) * LAMBDA) / (4 * Math.PI),
      12,
    );
  });

  it('holds the stated ±Δf/2 tolerance when the tone falls between bins', () => {
    const rateHz = 10.5 * DF; // 0.2625 Hz — the worst case, half a bin off
    const amplitudeM = 0.0005;
    const target = 5;
    const { dwell, noiseFloor } = synthesise({
      pings: PINGS,
      bins: 48,
      snrDb: 20,
      seed: 0x0ffb1,
      displacement: (b, t) =>
        b === target ? amplitudeM * Math.sin(2 * Math.PI * rateHz * t) : 0,
    });

    const bin = analyzeDwell(dwell, { bandHz: BAND, noiseFloor }).bins[target]!;
    expect(Math.abs(bin.rateHz! - rateHz)).toBeLessThanOrEqual(DF / 2 + 1e-12);
    // Scalloping loss at half a bin is 2/π: the reported displacement is a
    // lower bound, and this is how much of one.
    expect(bin.displacementM! / amplitudeM).toBeGreaterThan(0.6);
    expect(bin.displacementM! / amplitudeM).toBeLessThan(1.05);
    expect(bin.micromotionBand).toBeGreaterThan(0.99);
  });

  it('recovers a displacement whose phase wraps several times', () => {
    // 5 mm amplitude is 3.48 rad — a 6.96 rad peak-to-peak swing, so the raw
    // argument crosses the branch cut whatever the scatterer's own phase is,
    // and more than one full turn is in play.
    const amplitudeM = 0.005;
    const rateHz = 8 * DF; // 0.2 Hz
    const target = 30;
    expect((4 * Math.PI * amplitudeM) / LAMBDA).toBeGreaterThan(Math.PI);

    const { dwell, noiseFloor } = synthesise({
      pings: PINGS,
      bins: 48,
      snrDb: 20,
      seed: 0x77a9,
      displacement: (b, t) =>
        b === target ? amplitudeM * Math.sin(2 * Math.PI * rateHz * t) : 0,
    });

    const bin = analyzeDwell(dwell, { bandHz: BAND, noiseFloor }).bins[target]!;
    expect(bin.rateHz).toBeCloseTo(rateHz, 9);
    expect(bin.displacementM! / amplitudeM).toBeGreaterThan(0.95);
    expect(bin.displacementM! / amplitudeM).toBeLessThan(1.05);
    // Beyond λ/4, which is everything a non-unwrapped phase could have said.
    expect(bin.displacementM!).toBeGreaterThan(LAMBDA / 4);
  });
});

describe('refusals', () => {
  it('refuses a dwell too short to hold the periods it is asked about', () => {
    const { dwell, noiseFloor } = synthesise({
      pings: 150, // 10 s: one cycle of the 0.1 Hz band edge
      bins: 16,
      snrDb: 20,
      seed: 0x5407,
      displacement: (_b, t) => 0.0005 * Math.sin(2 * Math.PI * 0.25 * t),
    });

    const result = analyzeDwell(dwell, { bandHz: BAND, noiseFloor });
    expect(result.status).toBe('insufficient_dwell');
    expect(result.reason).toContain('cycles');
    // Not a confident zero: there is nothing to read as a score at all.
    expect(result.bins).toHaveLength(0);
  });

  it('refuses a band too narrow to take a maximum over', () => {
    const { dwell, noiseFloor } = synthesise({ pings: PINGS, bins: 16, snrDb: 20, seed: 0x1 });
    const result = analyzeDwell(dwell, { bandHz: [0.4, 0.41], noiseFloor });
    expect(result.status).toBe('insufficient_dwell');
    expect(result.reason).toContain('Fourier bins');
    expect(result.bins).toHaveLength(0);
  });

  it('refuses a bin with no return, and does not score it', () => {
    const empty = 7;
    const { dwell, noiseFloor } = synthesise({
      pings: PINGS,
      bins: 16,
      snrDb: 20,
      seed: 0xe3f7,
      amplitude: (b) => (b === empty ? 0 : 1),
      // The modulation is applied to the empty bin too. There is no phasor to
      // modulate, so it cannot help it.
      displacement: (_b, t) => 0.0005 * Math.sin(2 * Math.PI * 0.25 * t),
    });

    const result = analyzeDwell(dwell, { bandHz: BAND, noiseFloor });
    const bin = result.bins[empty]!;
    expect(bin.status).toBe('no_return');
    expect(bin.rateHz).toBeNull();
    expect(bin.displacementM).toBeNull();
    expect(bin.micromotionBand).toBe(0);
    // The neighbours, which do have a return, were scored.
    expect(result.bins[empty - 1]!.status).toBe('ok');
  });

  it('refuses an all-zero profile rather than reading its phase', () => {
    const dwell: ComplexProfileDwell = {
      data: new Float64Array(PINGS * 4 * 2),
      pings: PINGS,
      bins: 4,
      prfHz: PRF,
      lambdaM: LAMBDA,
    };
    const result = analyzeDwell(dwell, { bandHz: BAND });
    expect(result.noiseFloor).toBe(0);
    for (const bin of result.bins) {
      expect(bin.status).toBe('no_return');
      expect(bin.micromotionBand).toBe(0);
    }
  });

  it('rejects a malformed dwell loudly', () => {
    const good = synthesise({ pings: 32, bins: 4, snrDb: 20, seed: 0x2 }).dwell;
    expect(() => analyzeDwell({ ...good, bins: 5 }, { bandHz: BAND })).toThrow(/interleaved/);
    expect(() => analyzeDwell(good, { bandHz: [0.5, 0.1] })).toThrow(/band/);
    expect(() => analyzeDwell(good, { bandHz: [0.1, 9] })).toThrow(/PRF/);
  });
});

describe('common-mode rejection', () => {
  /** A sway of 2 mm is 1.39 rad — five times the phase of the 0.4 mm target
   *  below, which is the ADR-023 §3 blocker in miniature: the operator is the
   *  loudest micro-motion source in the room. */
  const swayM = 0.002;
  const swayHz = 12 * DF; // 0.3 Hz, inside the searched band
  const targetM = 0.0004;
  const targetHz = 8 * DF; // 0.2 Hz
  const targetBin = 20;
  const BINS = 64;

  function sceneWithSway(seed: number, withTarget: boolean) {
    return synthesise({
      pings: PINGS,
      bins: BINS,
      snrDb: 20,
      seed,
      // The sway moves the SENSOR, so every bin on the ray sees it identically.
      displacement: (b, t) =>
        swayM * Math.sin(2 * Math.PI * swayHz * t) +
        (withTarget && b === targetBin ? targetM * Math.sin(2 * Math.PI * targetHz * t) : 0),
    });
  }

  it('suppresses a modulation that every bin shares', () => {
    const { dwell, noiseFloor } = sceneWithSway(0xc0de, false);

    const raw = analyzeDwell(dwell, {
      bandHz: BAND,
      noiseFloor,
      commonModeRejection: false,
    });
    const firedRaw = raw.bins.filter((b) => b.micromotionBand > raw.scoreThreshold);
    // Without the step, the phone's own motion is reported as micro-motion in
    // every single bin of the profile.
    expect(firedRaw).toHaveLength(BINS);
    for (const bin of firedRaw) expect(bin.rateHz).toBeCloseTo(swayHz, 9);

    const rejected = analyzeDwell(dwell, { bandHz: BAND, noiseFloor });
    const firedRejected = rejected.bins.filter(
      (b) => b.micromotionBand > rejected.scoreThreshold,
    );
    // What survives is the α = 0.01 false-alarm rate over 64 bins, not the sway.
    expect(firedRejected.length).toBeLessThanOrEqual(3);
    // And the residual displacement is a noise floor, not a millimetre.
    for (const bin of rejected.bins) expect(bin.displacementM!).toBeLessThan(swayM / 20);
  });

  it('measures the sensor motion it removed', () => {
    const { dwell, noiseFloor } = sceneWithSway(0xc0de, false);
    const result = analyzeDwell(dwell, { bandHz: BAND, noiseFloor });
    // The track is referenced to ping 0, where the sway is at a zero crossing,
    // so its peak excursion is the sway amplitude.
    expect(result.commonModePeakM / swayM).toBeGreaterThan(0.95);
    expect(result.commonModePeakM / swayM).toBeLessThan(1.05);
  });

  it('keeps a target that only one bin sees, and drops the sway on top of it', () => {
    const { dwell, noiseFloor } = sceneWithSway(0x1eaf, true);

    const raw = analyzeDwell(dwell, {
      bandHz: BAND,
      noiseFloor,
      commonModeRejection: false,
    }).bins[targetBin]!;
    // Uncompensated, the target bin reports the hand, not the target.
    expect(raw.rateHz).toBeCloseTo(swayHz, 9);

    const bin = analyzeDwell(dwell, { bandHz: BAND, noiseFloor }).bins[targetBin]!;
    expect(bin.rateHz).toBeCloseTo(targetHz, 9);
    expect(bin.micromotionBand).toBeGreaterThan(0.99);
    // The estimator averages over all 64 bins, so it takes 1/64 of the target
    // with it; nothing else should be missing.
    expect(bin.displacementM! / targetM).toBeGreaterThan(0.9);
    expect(bin.displacementM! / targetM).toBeLessThan(1.05);
  });
});

describe('the false-alarm rate', () => {
  it('fires on rigid reflectors at the rate the null distribution predicts', () => {
    // The null is a RIGID REFLECTOR — a constant range at usable SNR, with
    // receiver noise — because that is what the derivation describes and what
    // the detector is asked to reject. An empty bin is a different object: its
    // phase is a random walk, the exponential null is false for it, and it is
    // refused by the SNR gate rather than tested (see the refusals above).
    const dwells = 32;
    const bins = 64;
    const trials = dwells * bins;
    let over95 = 0;
    let over99 = 0;
    let displacementMax = 0;
    for (let d = 0; d < dwells; d++) {
      const { dwell, noiseFloor } = synthesise({
        pings: PINGS,
        bins,
        snrDb: 20,
        seed: 0x5eed + d * 7919,
      });
      const result = analyzeDwell(dwell, { bandHz: BAND, noiseFloor, alpha: 0.01 });
      expect(result.status).toBe('ok');
      for (const bin of result.bins) {
        expect(bin.status).toBe('ok');
        if (bin.pValue <= 0.05) over95 += 1;
        if (bin.pValue <= 0.01) over99 += 1;
        displacementMax = Math.max(displacementMax, bin.displacementM!);
      }
    }

    // 2048 trials. 3σ of a binomial is 30 at α = 0.05 and 13 at α = 0.01, and
    // the p-value is an upper bound by construction, so the count may sit under
    // the nominal figure but must not sit over it.
    expect(over95).toBeGreaterThan(trials * 0.05 - 30);
    expect(over95).toBeLessThan(trials * 0.05 + 30);
    expect(over99).toBeGreaterThan(trials * 0.01 - 13);
    expect(over99).toBeLessThan(trials * 0.01 + 13);

    // Absolute scale, which is where a wrong λ/4π would show up. The per-ping
    // displacement noise at 20 dB is σ_d = σ_φ·λ/4π = 0.102 mm; one DFT bin
    // reports 2σ_d/√N of it; and the largest of the trials·K = 43008 ordinates
    // drawn here sits at about ln(43008) = 10.7 mean powers, i.e.
    // √10.7 · 2σ_d/√N = 6.5 σ_d/√N. The window below is a factor of ~1.5 wide
    // either way, so a λ/2π or a λ/8π would not fit through it.
    const sigmaD = (phaseNoiseStdRad(20) * LAMBDA) / (4 * Math.PI);
    expect(displacementMax / (sigmaD / Math.sqrt(PINGS))).toBeGreaterThan(4);
    expect(displacementMax / (sigmaD / Math.sqrt(PINGS))).toBeLessThan(10);
  });

  it('estimates a noise floor from a profile that is mostly empty', () => {
    const { dwell, noiseFloor } = synthesise({
      pings: PINGS,
      bins: 64,
      snrDb: 20,
      seed: 0x9001,
      amplitude: (b) => (b % 16 === 0 ? 1 : 0),
    });
    expect(estimateNoiseFloor(dwell) / noiseFloor).toBeGreaterThan(0.95);
    expect(estimateNoiseFloor(dwell) / noiseFloor).toBeLessThan(1.05);
  });
});

describe('what the sensor is allowed to say', () => {
  it('emits micromotion_band and no other feature key', () => {
    const { dwell, noiseFloor } = synthesise({
      pings: PINGS,
      bins: 8,
      snrDb: 20,
      seed: 0xfea7,
      displacement: (_b, t) => 0.0005 * Math.sin(2 * Math.PI * 0.25 * t),
    });
    const result = analyzeDwell(dwell, { bandHz: BAND, noiseFloor });
    for (const bin of result.bins) {
      const feature = micromotionFeature(bin);
      expect(Object.keys(feature)).toEqual(['micromotion_band']);
      expect(feature.micromotion_band).toBeGreaterThanOrEqual(0);
      expect(feature.micromotion_band).toBeLessThanOrEqual(1);
    }
    // The refusal is structural, so assert it structurally: nothing this
    // package produces carries a presence claim.
    expect(JSON.stringify(result)).not.toContain('presence');
  });
});
