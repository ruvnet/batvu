// SPDX-License-Identifier: MIT
//
// What these tests do and do not claim.
//
// They test the SECOND wheel's bookkeeping: that a corpus with nothing in it is
// refused rather than scored, that the holdout and the anchor cannot share a
// room or a subject, that a miss is charged to `primary` and an abstention to
// `noopRate`, and that the frozen gate is the one `@metaharness/flywheel` ships.
//
// They do NOT claim the detector detects anything. The dwells below are phase
// modulations written by `makeDwell` a few lines down, and the analyzer is
// `stubAnalyzer` — a deliberately crude stand-in for `@batvu/micromotion`,
// which is being written concurrently and is not yet resolvable from this
// package. Asserting detection performance against either would be asserting
// that the code agrees with the code, which is precisely what ADR-023 §4 exists
// to forbid. Every corpus here is attested `FIXTURE`, so a run over one cannot
// stamp its replay bundle `LIVE`, and there is one test that checks that.
//
// TODO(ADR-023): when `@batvu/capture` and `@batvu/micromotion` become
// workspace dependencies, `stubAnalyzer` is deleted and `analyzeDwell` takes
// its place at the same seam. These tests do not change — none of them depend
// on the analyzer being any particular analyzer, only on it being deterministic.

import { describe, expect, it } from 'vitest';
import { meetsPromotionRule } from '@metaharness/flywheel';
import {
  DETECTOR_LADDERS,
  DETECTOR_LEVERS,
  badRootDetectorPolicy,
  decodeDetectorLever,
  describeDetectorStep,
  detectorLadderStep,
  resolveDetectorPolicy,
  type DetectorPolicy,
} from '../detector-policy.js';
import { encodeLever } from '../policy.js';
import {
  AttestedCorpus,
  DETECTOR_PROMOTION_RULE,
  NoEvidenceError,
  aggregateDetectorDetails,
  evaluateCapture,
  makeDetectorEvaluator,
  runDetectorFlywheel,
  splitCorpusByRoomAndSubject,
  type CaptureEvaluation,
  type CaptureRecord,
  type ComplexProfileDwell,
  type MicroMotionBin,
  type MicroMotionDwell,
  type TeacherLabel,
} from '../detector-evaluator.js';
import type { DwellOptions } from '../detector-policy.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** `c/f` at the centre of the shipping 17.5-20.5 kHz chirp. Arithmetic, which
 *  ADR-023 says is the one thing this problem is entitled to assume. */
const LAMBDA_M = 343 / 19_000;
/** `c/2B` for the same chirp: what one range bin spans. */
const RANGE_STEP_M = 343 / (2 * 3_000);
const START_RANGE_M = 0.5;
/** RMS complex noise per bin per ping. `stubAnalyzer` knows this constant; the
 *  real analyzer estimates it. */
const NOISE_FLOOR = 0.01;
/** Deliberately far below the phone's 15 Hz ping rate. Nothing in the policy
 *  sets the PRF — it is a property of the capture — so a slow one costs the
 *  tests nothing but the DFTs below shrink with it. */
const PRF_HZ = 5;

interface TargetSpec {
  bin: number;
  rateHz: number;
  excursionM: number;
  amplitude?: number;
}

interface DwellSpec {
  seconds: number;
  bins?: number;
  binAmplitude?: number;
  /** Bins driven below any usable SNR, so the analyzer refuses them. */
  deadBins?: readonly number[];
  targets?: readonly TargetSpec[];
  /** Motion of the SENSOR: common-mode across every range bin, which is exactly
   *  what makes it separable from a target's. ADR-023 §3. */
  sensorMotion?: { rateHz: number; excursionM: number };
  seed?: number;
}

/** A deterministic complex dwell. Ping-major interleaved `(re, im)`. */
function makeDwell(spec: DwellSpec): ComplexProfileDwell {
  const bins = spec.bins ?? 12;
  const pings = Math.round(spec.seconds * PRF_HZ);
  const amplitude = spec.binAmplitude ?? 0.1;
  const dead = new Set(spec.deadBins ?? []);
  const data = new Float64Array(pings * bins * 2);
  const noise = gaussians(spec.seed ?? 1);

  for (let p = 0; p < pings; p++) {
    const t = p / PRF_HZ;
    const common = spec.sensorMotion
      ? spec.sensorMotion.excursionM * Math.sin(2 * Math.PI * spec.sensorMotion.rateHz * t)
      : 0;
    for (let b = 0; b < bins; b++) {
      const target = spec.targets?.find((x) => x.bin === b);
      const a = dead.has(b) ? 0 : (target?.amplitude ?? amplitude);
      const d =
        common + (target ? target.excursionM * Math.sin(2 * Math.PI * target.rateHz * t) : 0);
      // Two-way phase for a radial displacement: 4*pi*d/lambda, plus a fixed
      // per-bin offset so no bin starts at zero phase by accident.
      const phase = (4 * Math.PI * d) / LAMBDA_M + b * 0.37;
      const i = p * bins * 2 + b * 2;
      data[i] = a * Math.cos(phase) + (NOISE_FLOOR / Math.SQRT2) * noise();
      data[i + 1] = a * Math.sin(phase) + (NOISE_FLOOR / Math.SQRT2) * noise();
    }
  }
  return { data, pings, bins, prfHz: PRF_HZ, lambdaM: LAMBDA_M, startRangeM: START_RANGE_M, rangeStepM: RANGE_STEP_M };
}

/** Box-Muller over a small LCG: same seed, same noise, every run. */
function gaussians(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  const uniform = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s + 1) / 4294967297;
  };
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    const r = Math.sqrt(-2 * Math.log(uniform()));
    const th = 2 * Math.PI * uniform();
    spare = r * Math.sin(th);
    return r * Math.cos(th);
  };
}

const CONSENT = { granted: true, receiptId: 'receipt-fixture' } as const;

function capture(
  id: string,
  roomId: string,
  subjectId: string | null,
  teacher: TeacherLabel,
  dwell: ComplexProfileDwell,
): CaptureRecord {
  return { id, roomId, subjectId, consent: { ...CONSENT }, dwell, teacher };
}

const TARGET_BIN = 5;
const TARGET_RANGE_M = START_RANGE_M + TARGET_BIN * RANGE_STEP_M;
/** On a Fourier bin at 12 s and 20 s of dwell, so scalloping is not part of
 *  what any of these tests is measuring. */
const TARGET_RATE_HZ = 0.25;

/** A capture the teacher put a body in, with a periodic phase in that bin. */
function bodyCapture(id: string, roomId: string, subjectId: string, seed: number, seconds = 60): CaptureRecord {
  return capture(
    id,
    roomId,
    subjectId,
    { bodyInScene: true, bodyRangeM: TARGET_RANGE_M },
    makeDwell({
      seconds,
      seed,
      targets: [{ bin: TARGET_BIN, rateHz: TARGET_RATE_HZ, excursionM: 0.002, amplitude: 0.15 }],
    }),
  );
}

/** A capture the teacher says is empty. `subjectId` is null, which is also what
 *  keeps it from fusing every room into one split component. */
function emptyCapture(id: string, roomId: string, seed: number, spec: Partial<DwellSpec> = {}): CaptureRecord {
  return capture(
    id,
    roomId,
    null,
    { bodyInScene: false, bodyRangeM: null },
    makeDwell({ seconds: 60, seed, ...spec }),
  );
}

/** Two rooms, two subjects, four captures each — the smallest corpus that can
 *  be split into two sides that each carry a positive and a negative. */
function fixtureCorpus(): AttestedCorpus {
  return AttestedCorpus.attest({
    id: 'fixture',
    provenance: 'FIXTURE',
    records: [
      bodyCapture('k1', 'kitchen', 'S1', 11),
      bodyCapture('k2', 'kitchen', 'S1', 12),
      emptyCapture('k3', 'kitchen', 13),
      emptyCapture('k4', 'kitchen', 14),
      bodyCapture('o1', 'office', 'S2', 21),
      bodyCapture('o2', 'office', 'S2', 22),
      emptyCapture('o3', 'office', 23),
      emptyCapture('o4', 'office', 24),
    ],
  });
}

interface PolicyFields {
  dwellS: number;
  minCycles: number;
  bandLowHz: number;
  bandHighHz: number;
  alpha: number;
  minSnrDb: number;
  commonModeRejection: 'on' | 'off';
  commonModeMaxPeakM: number;
}

function makePolicy(over: Partial<PolicyFields> = {}): DetectorPolicy {
  const f: PolicyFields = {
    dwellS: 40,
    minCycles: 3,
    bandLowHz: 0.1,
    bandHighHz: 0.7,
    alpha: 0.01,
    minSnrDb: 8,
    commonModeRejection: 'on',
    commonModeMaxPeakM: 0.02,
    ...over,
  };
  return {
    dwell: encodeLever({ dwellS: f.dwellS, minCycles: f.minCycles }),
    band: encodeLever({ bandLowHz: f.bandLowHz, bandHighHz: f.bandHighHz }),
    periodicity: encodeLever({ alpha: f.alpha, minSnrDb: f.minSnrDb }),
    commonMode: encodeLever({
      commonModeRejection: f.commonModeRejection,
      commonModeMaxPeakM: f.commonModeMaxPeakM,
    }),
  };
}

// ---------------------------------------------------------------------------
// The stand-in analyzer
// ---------------------------------------------------------------------------

/**
 * A crude `analyzeDwell`.
 *
 * Enough of the real thing for the projection to have something to account
 * for: it refuses a dwell too short for `minCycles` of the slowest searched
 * rate, refuses bins under the SNR gate, estimates and optionally removes the
 * across-bin common-mode displacement, and reports Fisher's g over the in-band
 * ordinates. The p-value is the FIRST inclusion-exclusion term only, which
 * `@batvu/micromotion` would not accept and which is fine here — nothing below
 * asserts a false-alarm rate, only that the evaluator counts outcomes
 * correctly.
 */
function stubAnalyzer(dwell: ComplexProfileDwell, options: DwellOptions): MicroMotionDwell {
  const { pings: n, bins, prfHz, lambdaM } = dwell;
  const dwellS = n / prfHz;
  const df = prfHz / n;
  const kLo = Math.max(1, Math.ceil(options.bandHz[0] / df));
  const kHi = Math.min(Math.floor((n - 1) / 2), Math.floor(options.bandHz[1] / df));
  const bandBins = Math.max(0, kHi - kLo + 1);
  const head = { dwellS, bandBins, scoreThreshold: 1 - options.alpha };

  if (dwellS < options.minCycles / options.bandHz[0] || bandBins < 2) {
    return { ...head, status: 'insufficient_dwell', reason: 'insufficient_dwell', commonModePeakM: 0, bins: [] };
  }

  const track: Float64Array[] = [];
  const amp = new Float64Array(bins);
  const snrDb = new Float64Array(bins);
  for (let b = 0; b < bins; b++) {
    const d = new Float64Array(n);
    let power = 0;
    let prev = 0;
    for (let p = 0; p < n; p++) {
      const re = dwell.data[p * bins * 2 + b * 2]!;
      const im = dwell.data[p * bins * 2 + b * 2 + 1]!;
      power += re * re + im * im;
      let ph = Math.atan2(im, re);
      if (p > 0) {
        while (ph - prev > Math.PI) ph -= 2 * Math.PI;
        while (prev - ph > Math.PI) ph += 2 * Math.PI;
      }
      prev = ph;
      d[p] = (ph * lambdaM) / (4 * Math.PI);
    }
    const a2 = Math.max(0, power / n - NOISE_FLOOR * NOISE_FLOOR);
    amp[b] = Math.sqrt(a2);
    snrDb[b] = a2 <= 0 ? -Infinity : 10 * Math.log10(a2 / (NOISE_FLOOR * NOISE_FLOOR));
    track.push(d);
  }

  const usable: number[] = [];
  for (let b = 0; b < bins; b++) if (snrDb[b]! >= options.minSnrDb) usable.push(b);

  const common = new Float64Array(n);
  for (let p = 0; p < n; p++) {
    let w = 0;
    let s = 0;
    for (const b of usable) {
      w += amp[b]!;
      s += amp[b]! * track[b]![p]!;
    }
    common[p] = w > 0 ? s / w : 0;
  }
  const commonMean = mean(common);
  let commonModePeakM = 0;
  for (let p = 0; p < n; p++) {
    commonModePeakM = Math.max(commonModePeakM, Math.abs(common[p]! - commonMean));
  }

  const out: MicroMotionBin[] = [];
  for (let b = 0; b < bins; b++) {
    const rangeM = (dwell.startRangeM ?? 0) + b * (dwell.rangeStepM ?? 0);
    if (snrDb[b]! < options.minSnrDb) {
      out.push({ bin: b, rangeM, status: 'no_return', micromotionBand: 0, pValue: 1, statistic: 0, rateHz: null, snrDb: snrDb[b]! });
      continue;
    }
    const x = Float64Array.from(track[b]!);
    if (options.commonModeRejection) for (let p = 0; p < n; p++) x[p] = x[p]! - common[p]!;
    const m = mean(x);
    for (let p = 0; p < n; p++) x[p] = x[p]! - m;

    let total = 0;
    let best = 0;
    let bestK = kLo;
    for (let k = kLo; k <= kHi; k++) {
      let re = 0;
      let im = 0;
      for (let p = 0; p < n; p++) {
        const w = (-2 * Math.PI * k * p) / n;
        re += x[p]! * Math.cos(w);
        im += x[p]! * Math.sin(w);
      }
      const pw = re * re + im * im;
      total += pw;
      if (pw > best) {
        best = pw;
        bestK = k;
      }
    }
    const g = total > 0 ? best / total : 0;
    const pValue = Math.min(1, bandBins * Math.pow(1 - g, bandBins - 1));
    out.push({ bin: b, rangeM, status: 'ok', micromotionBand: 1 - pValue, pValue, statistic: g, rateHz: bestK * df, snrDb: snrDb[b]! });
  }
  return { ...head, status: 'ok', reason: null, commonModePeakM, bins: out };
}

function mean(xs: Float64Array): number {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i]!;
  return xs.length === 0 ? 0 : s / xs.length;
}

/** A deterministic clock. Every capture then costs the same, so `costPerWin`
 *  measures the projection rather than the machine the test happens to run on. */
const fakeNow = (): (() => number) => {
  let t = 0;
  return () => (t += 10);
};

const evaluatorOptions = () => ({ analyze: stubAnalyzer, now: fakeNow() });

/** Minimal outcome records, for testing the aggregation arithmetic on its own. */
function outcomes(counts: Partial<Record<CaptureEvaluation['outcome'], number>>): CaptureEvaluation[] {
  const out: CaptureEvaluation[] = [];
  for (const [outcome, n] of Object.entries(counts)) {
    for (let i = 0; i < (n ?? 0); i++) {
      out.push({
        capture: `${outcome}-${i}`,
        roomId: 'room',
        outcome: outcome as CaptureEvaluation['outcome'],
        abstainReason: outcome === 'abstain' ? 'insufficient_dwell' : null,
        dwellS: 30,
        commonModePeakM: 0,
        peakScore: 0,
        elapsedMs: 1,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

describe('the corpus refusal', () => {
  it('refuses an empty corpus instead of scoring it zero', () => {
    // The single most important behaviour in this file. A zero score is a
    // number the wheel can be run against; the resulting flat lift curve is
    // indistinguishable from a converged one, and it would be signed.
    expect(() => AttestedCorpus.attest({ id: 'nothing', provenance: 'DEVICE', records: [] })).toThrow(
      NoEvidenceError,
    );
    expect(() => AttestedCorpus.attest({ id: 'nothing', provenance: 'DEVICE', records: [] })).toThrow(
      /is empty/,
    );
  });

  it('refuses a capture that carries no consent receipt', () => {
    const bad = { ...bodyCapture('x', 'kitchen', 'S1', 1), consent: null };
    expect(() =>
      AttestedCorpus.attest({ id: 'c', provenance: 'DEVICE', records: [bad, emptyCapture('y', 'kitchen', 2)] }),
    ).toThrow(/consent receipt/);
    const withheld = {
      ...bodyCapture('x', 'kitchen', 'S1', 1),
      consent: { granted: false, receiptId: 'r' },
    };
    expect(() =>
      AttestedCorpus.attest({ id: 'c', provenance: 'DEVICE', records: [withheld] }),
    ).toThrow(/consent receipt/);
  });

  it('refuses a corpus with no teacher-empty capture, because no false-alarm rate is measurable', () => {
    expect(() =>
      AttestedCorpus.attest({
        id: 'all-bodies',
        provenance: 'FIXTURE',
        records: [bodyCapture('a', 'kitchen', 'S1', 1), bodyCapture('b', 'kitchen', 'S1', 2)],
      }),
    ).toThrow(/false-alarm rate is measurable/);
  });

  it('refuses a corpus with no teacher-labelled body, because no hit rate is measurable', () => {
    expect(() =>
      AttestedCorpus.attest({
        id: 'all-empty',
        provenance: 'FIXTURE',
        records: [emptyCapture('a', 'kitchen', 1), emptyCapture('b', 'kitchen', 2)],
      }),
    ).toThrow(/hit rate is measurable/);
  });

  it('refuses a dwell that is not a dwell', () => {
    const broken = bodyCapture('a', 'kitchen', 'S1', 1);
    broken.dwell = { ...broken.dwell, prfHz: 0 };
    expect(() =>
      AttestedCorpus.attest({ id: 'c', provenance: 'FIXTURE', records: [broken, emptyCapture('b', 'kitchen', 2)] }),
    ).toThrow(/usable dwell/);
  });

  it('refuses an empty suite at the evaluator, even when the brand is bypassed', async () => {
    // `AttestedCorpus` has a private member, so an object literal shaped like a
    // corpus does not type-check as one — this cast is the test forcing its way
    // past that. The runtime check exists because the engine's `Suite.items` is
    // `unknown[]` and the brand does not survive the trip through it.
    const evaluate = makeDetectorEvaluator(evaluatorOptions());
    await expect(evaluate(makePolicy(), { id: 'hollow', items: [] })).rejects.toThrow(NoEvidenceError);
  });

  it('refuses to aggregate an empty list of outcomes', () => {
    // `aggregate` in evaluator.ts returns a maximally bad score here. That is
    // right for rooms and wrong for captures — see the module note.
    expect(() => aggregateDetectorDetails([], 0.01)).toThrow(NoEvidenceError);
  });

  it('refuses to run the wheel against a corpus emptied behind the type system', async () => {
    const corpus = fixtureCorpus();
    const hollow = { ...corpus, records: [] } as unknown as AttestedCorpus;
    await expect(
      runDetectorFlywheel({ ...evaluatorOptions(), holdout: hollow, anchor: corpus }),
    ).rejects.toThrow(NoEvidenceError);
    await expect(
      runDetectorFlywheel({ ...evaluatorOptions(), holdout: corpus, anchor: hollow }),
    ).rejects.toThrow(NoEvidenceError);
  });

  it('never stamps a fixture corpus as LIVE evidence', async () => {
    const { holdout, anchor } = splitCorpusByRoomAndSubject(fixtureCorpus());
    const report = await runDetectorFlywheel({
      ...evaluatorOptions(),
      holdout,
      anchor,
      maxGenerations: 1,
    });
    expect(report.evidenceIsReal).toBe(false);
    expect(report.result.replayBundle.data_source).toBe('SYNTHETIC');
  }, 60_000);
});

describe('the room and subject split', () => {
  it('never puts a room on both sides', () => {
    const { holdout, anchor } = splitCorpusByRoomAndSubject(fixtureCorpus());
    const shared = holdout.rooms.filter((r) => anchor.rooms.includes(r));
    expect(shared).toEqual([]);
    expect(holdout.records.length + anchor.records.length).toBe(8);
  });

  it('never puts a subject on both sides, even when they were captured in two rooms', () => {
    // The leak a room-only split misses: one person in their kitchen and their
    // living room is one person, and a band tuned on their rate in one room is
    // tuned on it in the other.
    const corpus = AttestedCorpus.attest({
      id: 'roaming',
      provenance: 'FIXTURE',
      records: [
        bodyCapture('k1', 'kitchen', 'S1', 11),
        emptyCapture('k2', 'kitchen', 12),
        bodyCapture('l1', 'living-room', 'S1', 13),
        emptyCapture('l2', 'living-room', 14),
        bodyCapture('o1', 'office', 'S2', 21),
        emptyCapture('o2', 'office', 22),
      ],
    });
    const { holdout, anchor } = splitCorpusByRoomAndSubject(corpus);
    expect(holdout.subjects.filter((s) => anchor.subjects.includes(s))).toEqual([]);
    expect(holdout.rooms.filter((r) => anchor.rooms.includes(r))).toEqual([]);
    // S1's two rooms are one atom, so they travel together.
    const side = holdout.rooms.includes('kitchen') ? holdout : anchor;
    expect(side.rooms).toEqual(['kitchen', 'living-room']);
  });

  it('keeps a room and a subject that share a capture together', () => {
    // Two subjects in one office fuse into a single component: putting the room
    // on one side puts every capture in it there, and with it both subjects.
    const corpus = AttestedCorpus.attest({
      id: 'shared-office',
      provenance: 'FIXTURE',
      records: [
        bodyCapture('o1', 'office', 'S1', 11),
        bodyCapture('o2', 'office', 'S2', 12),
        emptyCapture('o3', 'office', 13),
        bodyCapture('k1', 'kitchen', 'S3', 21),
        emptyCapture('k2', 'kitchen', 22),
      ],
    });
    const { holdout, anchor } = splitCorpusByRoomAndSubject(corpus);
    const office = holdout.rooms.includes('office') ? holdout : anchor;
    expect(office.subjects).toEqual(['S1', 'S2']);
    expect(holdout.subjects.filter((s) => anchor.subjects.includes(s))).toEqual([]);
  });

  it('does not let empty-room captures fuse every room into one component', () => {
    // If a null subject contributed an edge, every empty-room capture in the
    // corpus would join every room to the same component and nothing would be
    // splittable at all.
    const corpus = fixtureCorpus();
    expect(corpus.records.filter((r) => r.subjectId === null).length).toBe(4);
    const { holdout, anchor } = splitCorpusByRoomAndSubject(corpus);
    expect(holdout.rooms.length).toBeGreaterThan(0);
    expect(anchor.rooms.length).toBeGreaterThan(0);
  });

  it('refuses to split a corpus that is all one room', () => {
    const corpus = AttestedCorpus.attest({
      id: 'one-room',
      provenance: 'FIXTURE',
      records: [
        bodyCapture('a', 'kitchen', 'S1', 1),
        bodyCapture('b', 'kitchen', 'S1', 2),
        emptyCapture('c', 'kitchen', 3),
        emptyCapture('d', 'kitchen', 4),
      ],
    });
    expect(() => splitCorpusByRoomAndSubject(corpus)).toThrow(NoEvidenceError);
    expect(() => splitCorpusByRoomAndSubject(corpus)).toThrow(/one room\/subject component/);
  });

  it('refuses a split whose sides cannot each measure both rates', () => {
    // Two components, but one of them is nothing but empty rooms: the side it
    // lands on has no hit rate, so there is no evidence there either.
    const corpus = AttestedCorpus.attest({
      id: 'lopsided',
      provenance: 'FIXTURE',
      records: [
        bodyCapture('k1', 'kitchen', 'S1', 11),
        bodyCapture('k2', 'kitchen', 'S1', 12),
        emptyCapture('k3', 'kitchen', 13),
        emptyCapture('o1', 'office', 21),
        emptyCapture('o2', 'office', 22),
      ],
    });
    expect(() => splitCorpusByRoomAndSubject(corpus)).toThrow(NoEvidenceError);
  });

  it('is deterministic under record reordering', () => {
    const a = splitCorpusByRoomAndSubject(fixtureCorpus());
    const shuffled = AttestedCorpus.attest({
      id: 'fixture',
      provenance: 'FIXTURE',
      records: [...fixtureCorpus().records].reverse(),
    });
    const b = splitCorpusByRoomAndSubject(shuffled);
    expect(b.holdout.rooms).toEqual(a.holdout.rooms);
    expect(b.anchor.rooms).toEqual(a.anchor.rooms);
  });
});

describe('the projection', () => {
  it('counts an insufficient dwell as an ABSTENTION, not as a miss', () => {
    // The distinction that broke the gate before (see run.ts's header): a miss
    // is an ERROR and belongs to `primary`; declining to decide is a no-op.
    const record = bodyCapture('a', 'kitchen', 'S1', 1);
    const detail = evaluateCapture(record, badRootDetectorPolicy(), evaluatorOptions());
    expect(detail.outcome).toBe('abstain');
    expect(detail.abstainReason).toBe('insufficient_dwell');

    const score = aggregateDetectorDetails([detail], 0.5);
    expect(score.noopRate).toBe(1);
    expect(score.misses).toBe(0);
    expect(score.primary).toBe(0);
  });

  it('counts a body the detector decided against as a MISS, and charges it to primary', () => {
    // The dwell is long enough and the bin has a return; the searched band just
    // does not contain the rate. That is a decision, and it is wrong.
    const record = bodyCapture('a', 'kitchen', 'S1', 1);
    const detail = evaluateCapture(
      record,
      makePolicy({ bandLowHz: 1.0, bandHighHz: 2.4, minCycles: 2 }),
      evaluatorOptions(),
    );
    expect(detail.outcome).toBe('miss');
    expect(detail.abstainReason).toBeNull();

    const score = aggregateDetectorDetails([detail], 0.01);
    expect(score.noopRate).toBe(0);
    expect(score.hitRate).toBe(0);
    expect(score.primary).toBe(0);
  });

  it('finds the body when the band contains its rate, and calls it a hit', () => {
    const detail = evaluateCapture(bodyCapture('a', 'kitchen', 'S1', 1), makePolicy(), evaluatorOptions());
    expect(detail.outcome).toBe('hit');
    expect(aggregateDetectorDetails([detail], 0.01).hitRate).toBe(1);
  });

  it('counts a fire in a teacher-empty capture as an ERROR, not an abstention', () => {
    // An empty room with an unrejected common-mode motion in it. The teacher
    // says nothing is there, so anything that fires is a false alarm.
    const record = emptyCapture('a', 'kitchen', 7, { sensorMotion: { rateHz: 0.3, excursionM: 0.001 } });
    const detail = evaluateCapture(
      record,
      makePolicy({ commonModeRejection: 'off', commonModeMaxPeakM: 0.05 }),
      evaluatorOptions(),
    );
    expect(detail.outcome).toBe('false_alarm');

    const score = aggregateDetectorDetails([detail], 0.01);
    expect(score.noopRate).toBe(0);
    expect(score.falseAlarmRate).toBe(1);
  });

  it('rejects that same common-mode motion when the lever turns rejection on', () => {
    // The one thing common-mode rejection is for: the sensor's own motion is
    // identical in every range bin and a target's is not. ADR-023 §3.
    const record = emptyCapture('a', 'kitchen', 7, { sensorMotion: { rateHz: 0.3, excursionM: 0.001 } });
    const detail = evaluateCapture(
      record,
      makePolicy({ commonModeRejection: 'on', commonModeMaxPeakM: 0.05 }),
      evaluatorOptions(),
    );
    expect(detail.outcome).toBe('correct_rejection');
  });

  it('abstains on a dwell the operator moved more than the lever tolerates', () => {
    const record = bodyCapture('a', 'kitchen', 'S1', 1);
    record.dwell = makeDwell({
      seconds: 60,
      seed: 1,
      targets: [{ bin: TARGET_BIN, rateHz: TARGET_RATE_HZ, excursionM: 0.002, amplitude: 0.15 }],
      sensorMotion: { rateHz: 0.3, excursionM: 0.008 },
    });
    const detail = evaluateCapture(record, makePolicy({ commonModeMaxPeakM: 0.005 }), evaluatorOptions());
    expect(detail.outcome).toBe('abstain');
    expect(detail.abstainReason).toBe('sensor_motion');
    expect(detail.commonModePeakM).toBeGreaterThan(0.005);

    // Same capture, a lever willing to believe through it: now it decides.
    const believed = evaluateCapture(record, makePolicy({ commonModeMaxPeakM: 0.05 }), evaluatorOptions());
    expect(believed.outcome).not.toBe('abstain');
  });

  it('abstains on a bin with no usable return rather than calling it still', () => {
    const record = bodyCapture('a', 'kitchen', 'S1', 1);
    record.dwell = makeDwell({ seconds: 60, seed: 1, deadBins: [TARGET_BIN - 1, TARGET_BIN, TARGET_BIN + 1] });
    const detail = evaluateCapture(record, makePolicy(), evaluatorOptions());
    expect(detail.outcome).toBe('abstain');
    expect(detail.abstainReason).toBe('no_return');
  });

  it('scores a detector that never fires and one that always fires at exactly zero', () => {
    // Youden's J. Neither degenerate strategy needs its own guard, and neither
    // can buy `primary` from the corpus's class balance.
    const never = aggregateDetectorDetails(outcomes({ miss: 6, correct_rejection: 6 }), 0.01);
    expect(never.primary).toBe(0);
    const always = aggregateDetectorDetails(outcomes({ hit: 6, false_alarm: 6 }), 0.5);
    expect(always.primary).toBe(0);
    const perfect = aggregateDetectorDetails(outcomes({ hit: 6, correct_rejection: 6 }), 0.01);
    expect(perfect.primary).toBe(1);
  });

  it('charges an abstention to noopRate and to nothing else', () => {
    const decided = aggregateDetectorDetails(outcomes({ hit: 3, miss: 1, correct_rejection: 4 }), 0.01);
    const withAbstentions = aggregateDetectorDetails(
      outcomes({ hit: 3, miss: 1, correct_rejection: 4, abstain: 8 }),
      0.01,
    );
    expect(withAbstentions.primary).toBe(decided.primary);
    expect(decided.noopRate).toBe(0);
    expect(withAbstentions.noopRate).toBe(0.5);
  });

  it('flags a false-alarm rate above the detector own claim as REGRESSED', () => {
    // The hard stop: the classical detector's whole justification over a
    // learned model is that it publishes a calibrated number.
    const honest = aggregateDetectorDetails(outcomes({ hit: 10, correct_rejection: 100 }), 0.01);
    expect(honest.regressed).toBe(false);

    const overclaiming = aggregateDetectorDetails(
      outcomes({ hit: 10, false_alarm: 30, correct_rejection: 70 }),
      0.01,
    );
    expect(overclaiming.falseAlarmRate).toBeCloseTo(0.3, 10);
    expect(overclaiming.falseAlarmBudget).toBeLessThan(30);
    expect(overclaiming.regressed).toBe(true);

    // The same 30 false alarms from a policy that CLAIMED a rate of 0.5 is not
    // a calibration failure. It is a bad detector, and `primary` says so.
    const claimingHalf = aggregateDetectorDetails(
      outcomes({ hit: 10, false_alarm: 30, correct_rejection: 70 }),
      0.5,
    );
    expect(claimingHalf.regressed).toBe(false);
  });

  it('does not judge a teacher-empty capture on the labelled bin alone', () => {
    // Asymmetry by design: a body at 2.4 m says nothing about the curtain at
    // 4 m, so only a capture the teacher calls EMPTY licenses "nothing here
    // should have fired" — and it is judged across the whole profile.
    const record = emptyCapture('a', 'kitchen', 7, {
      targets: [{ bin: 9, rateHz: TARGET_RATE_HZ, excursionM: 0.002, amplitude: 0.15 }],
    });
    const detail = evaluateCapture(record, makePolicy(), evaluatorOptions());
    expect(detail.outcome).toBe('false_alarm');
  });
});

describe('the detector policy codec', () => {
  it('round-trips every lever', () => {
    const resolved = resolveDetectorPolicy(makePolicy());
    expect(resolved.dwellS).toBe(40);
    expect(resolved.dwellOptions.bandHz).toEqual([0.1, 0.7]);
    expect(resolved.dwellOptions.alpha).toBe(0.01);
    expect(resolved.dwellOptions.commonModeRejection).toBe(true);
    // One threshold, derived. Two independent copies is how a calibrated number
    // stops being one.
    expect(resolved.scoreThreshold).toBeCloseTo(0.99, 12);
  });

  it('refuses a malformed lever instead of falling back to a default', () => {
    expect(() => decodeDetectorLever('band', 'bandLowHz')).toThrow(/malformed/);
    expect(() => decodeDetectorLever('band', 'bandLowHz=wide')).toThrow(/finite number/);
    expect(() => decodeDetectorLever('band', 'alpha=0.01')).toThrow(/does not belong/);
    expect(() => decodeDetectorLever('dwell', 'commonModeMaxPeakM=0.01')).toThrow(/does not belong/);
  });

  it('refuses a policy that is missing a lever rather than inventing a detector', () => {
    const { band: _band, ...rest } = makePolicy();
    expect(() => resolveDetectorPolicy(rest)).toThrow(/missing lever 'band'/);
  });

  it('refuses a band, a dwell or an alpha that cannot mean anything', () => {
    expect(() => resolveDetectorPolicy(makePolicy({ bandLowHz: 0.9, bandHighHz: 0.4 }))).toThrow(/0 < low < high/);
    expect(() => resolveDetectorPolicy(makePolicy({ dwellS: 0 }))).toThrow(/dwellS must be positive/);
    expect(() => resolveDetectorPolicy(makePolicy({ alpha: 0 }))).toThrow(/strictly in \(0, 1\)/);
    expect(() => resolveDetectorPolicy(makePolicy({ alpha: 1 }))).toThrow(/strictly in \(0, 1\)/);
  });

  it('keeps the levers disjoint so lift is attributable', () => {
    const seen = new Map<string, string>();
    for (const lever of DETECTOR_LEVERS) {
      for (const key of Object.keys(decodeDetectorLever(lever, DETECTOR_LADDERS[lever][0]!))) {
        expect(seen.has(key), `${key} appears in both ${seen.get(key)} and ${lever}`).toBe(false);
        seen.set(key, lever);
      }
    }
  });

  it('produces a runnable policy for EVERY combination of lever rungs', () => {
    for (const dwell of DETECTOR_LADDERS.dwell) {
      for (const band of DETECTOR_LADDERS.band) {
        for (const periodicity of DETECTOR_LADDERS.periodicity) {
          for (const commonMode of DETECTOR_LADDERS.commonMode) {
            expect(() => resolveDetectorPolicy({ dwell, band, periodicity, commonMode })).not.toThrow();
          }
        }
      }
    }
  });

  it('starts from a root that decides nothing at all, so the strict clause has room', () => {
    const corpus = fixtureCorpus();
    const details = corpus.records.map((r) =>
      evaluateCapture(r, badRootDetectorPolicy(), evaluatorOptions()),
    );
    expect(details.every((d) => d.outcome === 'abstain')).toBe(true);
    const score = aggregateDetectorDetails(details, 0.5);
    expect(score.noopRate).toBe(1);
    expect(score.primary).toBe(0);
  });

  it('starts an off-ladder value at the bottom and never runs off the top', () => {
    expect(detectorLadderStep('band', 'nonsense')).toBe(DETECTOR_LADDERS.band[0]);
    const top = DETECTOR_LADDERS.dwell[DETECTOR_LADDERS.dwell.length - 1]!;
    expect(detectorLadderStep('dwell', top)).toBe(top);
    expect(detectorLadderStep('dwell', DETECTOR_LADDERS.dwell[0]!, 2)).toBe(DETECTOR_LADDERS.dwell[2]);
    expect(describeDetectorStep('dwell', DETECTOR_LADDERS.dwell[0]!, DETECTOR_LADDERS.dwell[1]!)).toMatch(
      /dwellS 2 -> 12/,
    );
  });
});

describe('the promotion loop', () => {
  it('calls the frozen gate unmodified, and its verdicts reproduce from the sealed scores', async () => {
    const { holdout, anchor } = splitCorpusByRoomAndSubject(fixtureCorpus());
    const report = await runDetectorFlywheel({
      ...evaluatorOptions(),
      holdout,
      anchor,
      maxGenerations: 3,
    });

    // Not a copy of the gate, not a wrapper around it: the same function object
    // `@metaharness/flywheel` exports.
    expect(DETECTOR_PROMOTION_RULE).toBe(meetsPromotionRule);
    expect(report.gateFingerprint).toMatch(/^[a-f0-9]{8,}$/);
    expect(report.result.replayBundle.gate_fingerprint).toBe(report.gateFingerprint);
    expect(report.replayVerified, report.replaySummary).toBe(true);

    // Re-run the gate over every commit's sealed baseline and candidate. If the
    // run had used anything but `meetsPromotionRule`, the verdicts would not
    // come back the same.
    let checked = 0;
    for (const commit of report.result.replayBundle.all_commits) {
      if (!commit.baselineScore || !commit.candidateScore) continue;
      const decision = meetsPromotionRule({
        baseline: commit.baselineScore,
        candidate: commit.candidateScore,
      });
      if (commit.verdict === 'PROMOTED') {
        expect(decision.promote, commit.id).toBe(true);
      } else if (commit.failureReasons[0] !== 'anchor_regressed') {
        // The one verdict the gate alone does not decide is the anchor guard,
        // which the engine applies after the gate has already said promote.
        expect(decision.promote, commit.id).toBe(false);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
    expect(() => resolveDetectorPolicy(report.finalPolicy)).not.toThrow();
  }, 120_000);

  it('records why the gate refused, when it refuses', async () => {
    const { holdout, anchor } = splitCorpusByRoomAndSubject(fixtureCorpus());
    const report = await runDetectorFlywheel({
      ...evaluatorOptions(),
      holdout,
      anchor,
      maxGenerations: 2,
    });
    // A run that promotes nothing is a legitimate result — the gate is not
    // wrapped and there is no override — but it has to say why.
    const rejected = report.result.replayBundle.all_commits.filter((c) => c.verdict === 'REJECTED');
    for (const commit of rejected) {
      expect(commit.failureReasons.length, commit.id).toBeGreaterThan(0);
    }
    expect(rejected.length + report.promotionNotes.length).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log('DIAG notes', report.promotionNotes, 'lift', JSON.stringify(report.result.liftCurve), 'scores', report.result.replayBundle.all_commits.map((c) => [c.mutation?.summary, c.candidateScore?.primary, c.candidateScore?.noopRate, c.verdict, c.failureReasons.join('|')]));
  }, 120_000);

  it('reproduces exactly across two runs of the same configuration', async () => {
    const run = async () => {
      const { holdout, anchor } = splitCorpusByRoomAndSubject(fixtureCorpus());
      return runDetectorFlywheel({ ...evaluatorOptions(), holdout, anchor, maxGenerations: 2 });
    };
    const a = await run();
    const b = await run();
    expect(b.finalPolicy).toEqual(a.finalPolicy);
    expect(b.promotionNotes).toEqual(a.promotionNotes);
    expect(b.result.liftCurve.map((p) => p.primary)).toEqual(a.result.liftCurve.map((p) => p.primary));
  }, 120_000);
});
