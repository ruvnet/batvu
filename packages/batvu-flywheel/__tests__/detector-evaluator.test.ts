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
// modulations written by `makeDwell` a few lines down: a known modulation goes
// in and the OUTCOME MAPPING is checked, never a detection rate against a room.
// Asserting detection performance against a fixture would be asserting that the
// code agrees with the code, which is precisely what ADR-023 §4 exists to
// forbid. Every corpus here is attested `FIXTURE`, so a run over one cannot
// stamp its replay bundle `LIVE`, and there is a test in each direction.
//
// The analyzer is the REAL `analyzeDwell` from `@batvu/micromotion`, reached
// through `MICROMOTION_ANALYZER`, and that is not incidental. An earlier
// version of this file used a hand-written stand-in and claimed that "none of
// these tests depend on the analyzer being any particular analyzer, only on it
// being deterministic". That claim was false and it was load-bearing: the
// stand-in clamped a band to the ordinates it had instead of refusing one above
// Nyquist, and estimated the noise floor from a constant the fixtures were
// generated with. Both defects lived in the code under test and neither could
// be seen from here. The parameters this wheel searches are that analyzer's
// parameters, so the seam is where the two have to actually meet.
//
// `PRF_HZ` is BatVu's shipping 15 pings a second for the same reason: the
// slow-time Nyquist frequency is a property of the capture, the band ladder has
// to fit under it, and a fixture at a rate the instrument does not run at would
// make two rungs of that ladder unexercisable.

import { describe, expect, it } from 'vitest';
import { meetsPromotionRule } from '@metaharness/flywheel';
import { analyzeDwell } from '@batvu/micromotion';
import {
  CONSENT_PRIVACY_CLASS,
  CONSENT_SCOPE,
  LIDAR_FRAME_TYPE,
  encodeCorpus,
  encodeRecord,
  parseCorpus,
} from '@batvu/capture';
import {
  AttestedCorpus,
  DETECTOR_LADDERS,
  DETECTOR_LEVERS,
  DETECTOR_PROMOTION_RULE,
  MICROMOTION_ANALYZER,
  NoEvidenceError,
  aggregateDetectorDetails,
  badRootDetectorPolicy,
  decodeDetectorLever,
  describeDetectorStep,
  detectorLadderStep,
  encodeLever,
  evaluateCapture,
  makeDetectorEvaluator,
  resolveDetectorPolicy,
  runDetectorFlywheel,
  captureFromPairedDwell,
  splitCorpusByRoomAndSubject,
  type CaptureEvaluation,
  type CaptureRecord,
  type ComplexProfileDwell,
  type DetectorPolicy,
  type TeacherLabel,
} from '@batvu/flywheel';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** `c/f` at the centre of the shipping 17.5-20.5 kHz chirp. Arithmetic, which
 *  ADR-023 says is the one thing this problem is entitled to assume. */
const LAMBDA_M = 343 / 19_000;
/** `c/2B` for the same chirp: what one range bin spans. */
const RANGE_STEP_M = 343 / (2 * 3_000);
const START_RANGE_M = 0.5;
/** RMS complex noise per bin per ping. The fixtures are generated with it and
 *  the CAPTURES CARRY IT, exactly as `@batvu/capture` records the floor the
 *  device measured — so the analyzer is told the floor rather than estimating
 *  one from a twelve-bin profile in which most bins hold a return, which is the
 *  case its median-based fallback documents itself as wrong for. */
const NOISE_FLOOR = 0.01;
/** BatVu's shipping ping rate. It sets the slow-time Nyquist frequency at
 *  7.5 Hz, which is what the top rung of the band ladder has to fit under. */
const PRF_HZ = 15;

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
  return { id, roomId, subjectId, consent: { ...CONSENT }, dwell, noiseFloorRms: NOISE_FLOOR, teacher };
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

/** A deterministic clock. Every capture then costs the same, so `costPerWin`
 *  measures the projection rather than the machine the test happens to run on. */
const fakeNow = (): (() => number) => {
  let t = 0;
  return () => (t += 10);
};

const evaluatorOptions = () => ({ analyze: MICROMOTION_ANALYZER, now: fakeNow() });

/** Bins in the fixture dwells, and therefore the number of independent tests
 *  one capture's decision is a maximum over. It is the second argument to the
 *  false-alarm budget and the reason that budget is not `n * alpha`. */
const FIXTURE_BINS = 12;

/** Minimal outcome records, for testing the aggregation arithmetic on its own. */
function outcomes(
  counts: Partial<Record<CaptureEvaluation['outcome'], number>>,
  usableBins = FIXTURE_BINS,
): CaptureEvaluation[] {
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
        noopShare: outcome === 'abstain' ? 1 : 0,
        usableBins,
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
    // corpus does not type-check as one. The runtime check exists because the
    // engine's `Suite.items` is `unknown[]` and the brand does not survive the
    // trip through it — so the bypass has to be demonstrated, not described.
    const notACorpus = { id: 'hollow', provenance: 'DEVICE' as const, records: [] };
    // @ts-expect-error a private member is what stops this being assignable
    const _rejected: AttestedCorpus = notACorpus;
    const smuggled = notACorpus as unknown as AttestedCorpus;

    const evaluate = makeDetectorEvaluator(evaluatorOptions());
    await expect(
      evaluate(makePolicy(), { id: smuggled.id, items: [...smuggled.records] }),
    ).rejects.toThrow(NoEvidenceError);
  });

  it('refuses a record whose consent was removed after the corpus was attested', async () => {
    // `AttestedCorpus` holds its records BY REFERENCE, and the engine's suite
    // erases the brand, so attestation alone leaves three ways to reach a score
    // over a record with no receipt. ADR-023 §6 makes consent the structural
    // refusal, so it is checked where every path has to pass.
    const corpus = fixtureCorpus();
    // Split BEFORE the receipt is removed, so this is the real shape of the
    // attack: everything was checked, and then the object changed underneath.
    const { holdout, anchor } = splitCorpusByRoomAndSubject(corpus);
    const record = holdout.records[0]!;
    const receipt = record.consent;
    try {
      (record as { consent: null }).consent = null;

      // 1. directly.
      expect(() => evaluateCapture(record, makePolicy(), evaluatorOptions())).toThrow(NoEvidenceError);
      expect(() => evaluateCapture(record, makePolicy(), evaluatorOptions())).toThrow(/consent/);

      // 2. through the evaluator the engine calls.
      const evaluate = makeDetectorEvaluator(evaluatorOptions());
      await expect(
        evaluate(makePolicy(), { id: 'suite', items: [...holdout.records] }),
      ).rejects.toThrow(/consent/);

      // 3. through a whole run of the wheel, which is the path that would
      //    otherwise mint a signed bundle over it.
      await expect(
        runDetectorFlywheel({ ...evaluatorOptions(), holdout, anchor, maxGenerations: 1 }),
      ).rejects.toThrow(/consent/);
    } finally {
      (record as { consent: typeof receipt }).consent = receipt;
    }
  }, 60_000);

  it('refuses a dwell whose buffer is not the length its own shape declares', () => {
    // The one invariant that makes a buffer a dwell. Unchecked, the failure
    // surfaces three frames into a run naming the truncated ping count instead
    // of the capture — and an analyzer that indexed past the end instead of
    // throwing would read `undefined`, arithmetic it into NaN, and score the
    // capture as a correct rejection.
    const broken = bodyCapture('a', 'kitchen', 'S1', 1);
    broken.dwell = { ...broken.dwell, data: new Float64Array(10) };
    expect(() =>
      AttestedCorpus.attest({
        id: 'c',
        provenance: 'FIXTURE',
        records: [broken, emptyCapture('b', 'kitchen', 2)],
      }),
    ).toThrow(/carries 10 floats/);
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
    expect(report.caveats.join(' ')).toMatch(/FIXTURE\/FIXTURE/);
  }, 60_000);

  it('stamps a DEVICE corpus LIVE, so the fixture check is not just a hardcoded false', async () => {
    // The other direction. Without it, `evidenceIsReal = false` written as a
    // constant would pass every other test in this file, and the flag that says
    // whether a signed bundle describes a room would be decoration.
    //
    // The records here are the same synthesised phase modulations as everywhere
    // else in this file; `provenance: 'DEVICE'` is a LIE told by the test to
    // exercise the flag. It proves the label follows the declared provenance,
    // and nothing whatever about a room.
    const corpus = AttestedCorpus.attest({
      id: 'claims-to-be-a-device',
      provenance: 'DEVICE',
      records: [...fixtureCorpus().records],
    });
    const { holdout, anchor } = splitCorpusByRoomAndSubject(corpus);
    expect(holdout.provenance).toBe('DEVICE');
    const report = await runDetectorFlywheel({
      ...evaluatorOptions(),
      holdout,
      anchor,
      maxGenerations: 1,
    });
    expect(report.evidenceIsReal).toBe(true);
    expect(report.result.replayBundle.data_source).toBe('LIVE');
    expect(report.caveats.join(' ')).not.toMatch(/provenance/);
  }, 60_000);

  it('says on the report when no generation measured any lift at all', async () => {
    // The failure the module header is built around, and the one an empty-corpus
    // refusal does NOT reach: a NON-empty corpus on which the detector never
    // decided anything produces a flat lift curve, a verified replay chain and a
    // gate fingerprint — byte-indistinguishable from a converged run. Refusing
    // it would be wrong, because a converged search reports the same shape. So
    // the difference is published rather than left to be inferred.
    const { holdout, anchor } = splitCorpusByRoomAndSubject(fixtureCorpus());
    const report = await runDetectorFlywheel({
      ...evaluatorOptions(),
      holdout,
      anchor,
      maxGenerations: 2,
    });
    expect(report.replayVerified).toBe(true);
    expect(report.gateFingerprint).toMatch(/^[a-f0-9]{8,}$/);
    const primaries = report.result.liftCurve.map((p) => p.primary);
    expect(report.bestPrimary).toBe(Math.max(...primaries));

    // This corpus is one of those runs, and it is worth being explicit that it
    // is: every generation scores primary 0, the bundle verifies, and the only
    // thing separating it from a converged search is this line.
    expect(primaries.every((v) => v === 0)).toBe(true);
    expect(report.bestPrimary).toBe(0);
    expect(report.caveats.join(' ')).toMatch(/nothing was detected/);
    expect(report.caveats.join(' ')).toMatch(/not because the search converged/);
  }, 120_000);
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
    // Which refusal, not just that one fired: `attest` has five, and a test
    // that accepts any of them cannot tell "the split was lopsided" from "the
    // corpus was rejected for something else entirely".
    expect(() => splitCorpusByRoomAndSubject(corpus)).toThrow(/hit rate is measurable/);
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
    // The analyzer's own reason, carried through verbatim rather than flattened
    // to a status: it names the dwell, the cycles it held and the cycles asked
    // for, and that is the diagnostic a reader of a rejected generation needs.
    expect(detail.abstainReason).toMatch(/cycles/);
    expect(detail.abstainReason).toMatch(/2\.0 s/);

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

  it('maps a fire in the labelled bin to the outcome `hit`', () => {
    // An OUTCOME-MAPPING assertion, and the phrasing is deliberate. The dwell
    // is a phase modulation `makeDwell` wrote a hundred lines up, so "the
    // detector found the body" is not a claim this test is entitled to make —
    // it would be asserting that the code agrees with the code, which ADR-023
    // §4 forbids. What IS checkable here is the bookkeeping: given a detector
    // that fired in the bin the teacher labelled, the projection calls it a hit
    // rather than a false alarm or an abstention.
    const detail = evaluateCapture(bodyCapture('a', 'kitchen', 'S1', 1), makePolicy(), evaluatorOptions());
    expect(detail.outcome).toBe('hit');
    expect(detail.abstainReason).toBeNull();

    // And a hit lands on the hit COUNT rather than anywhere else. Not quoted as
    // a rate: one fixture capture has no rate to report.
    const score = aggregateDetectorDetails([detail], 0.01);
    expect(score.hits).toBe(1);
    expect(score.falseAlarms).toBe(0);
    expect(score.abstentions).toBe(0);
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
    // Three of twelve bins were refused, and nine were decided. The abstention
    // is charged as the share of the profile left undecided, not as a whole
    // capture — the dwell did commit, just not where the teacher was looking.
    expect(detail.noopShare).toBeCloseTo(3 / 12, 12);
  });

  it('charges a refused range bin to noopRate, so the SNR gate has a visible cost', () => {
    const record = emptyCapture('a', 'kitchen', 7, { deadBins: [0, 1, 2, 3, 4, 5] });
    const detail = evaluateCapture(record, makePolicy(), evaluatorOptions());
    expect(detail.outcome).toBe('correct_rejection');
    expect(aggregateDetectorDetails([detail], 0.01).noopRate).toBeCloseTo(0.5, 12);
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

  it('budgets a CAPTURE\'s false alarms, not a bin\'s, and clears a correctly calibrated detector', () => {
    // `alpha` is the analyzer's PER-BIN rate. A capture's decision is a maximum
    // over its usable bins, so under the null one capture fires with
    // probability 1 - (1 - alpha)^B. Treating alpha as the per-capture rate
    // makes the budget B times too small, and `regressed` is a HARD VETO — the
    // wheel would permanently reject exactly the calibrated classical detector
    // ADR-023 §3 chose over a learned model.
    const alpha = 0.01;
    const bins = 4;
    const perCapture = 1 - Math.pow(1 - alpha, bins);
    expect(perCapture).toBeCloseTo(0.0394, 4);

    // 100 decided empty captures at 4 usable bins each. A detector performing
    // EXACTLY as its null says fires about four times; the naive binomial
    // budget is 1 + 3*sqrt(0.99) = 3.98 and would call that a regression.
    const naiveBudget = 100 * alpha + 3 * Math.sqrt(100 * alpha * (1 - alpha));
    expect(naiveBudget).toBeLessThan(4);

    const calibrated = aggregateDetectorDetails(
      outcomes({ hit: 20, false_alarm: 4, correct_rejection: 96 }, bins),
      alpha,
    );
    expect(calibrated.expectedFalseAlarms).toBeCloseTo(100 * perCapture, 6);
    expect(calibrated.falseAlarmBudget).toBeGreaterThan(4);
    expect(calibrated.regressed).toBe(false);

    // It is still a guard, not a rubber stamp: a detector firing on a quarter
    // of the empty rooms is out by far more than three standard deviations.
    const wild = aggregateDetectorDetails(
      outcomes({ hit: 20, false_alarm: 25, correct_rejection: 75 }, bins),
      alpha,
    );
    expect(wild.regressed).toBe(true);

    // And the budget tracks the bin count, which is the whole correction: the
    // same outcomes over a 64-bin profile are a much weaker claim.
    const wide = aggregateDetectorDetails(
      outcomes({ hit: 20, false_alarm: 4, correct_rejection: 96 }, 64),
      alpha,
    );
    expect(wide.expectedFalseAlarms).toBeGreaterThan(calibrated.expectedFalseAlarms * 10);
  });

  it('scores a worse-than-chance detector below zero, not level with an abstainer', () => {
    // A detector that fires on empty rooms and stays silent on bodies is not
    // equivalent to one that honestly declined, and clamping `primary` at zero
    // would leave the gate no way to tell them apart.
    const perverse = aggregateDetectorDetails(outcomes({ miss: 8, false_alarm: 8 }), 0.5);
    expect(perverse.primary).toBe(-1);
    const abstainer = aggregateDetectorDetails(outcomes({ abstain: 16 }), 0.5);
    expect(abstainer.primary).toBe(0);
    expect(meetsPromotionRule({ baseline: abstainer, candidate: perverse }).reasons).toContain(
      'primary_regressed',
    );
  });

  it('abstains rather than crashing when a policy searches above the capture Nyquist', () => {
    // A band above PRF/2 is not a band this capture can be evaluated under, and
    // `analyzeDwell` refuses one outright. An uncaught throw would end the RUN
    // rather than this capture, so the wheel would die on whichever rung first
    // met a slow capture instead of reporting that the rung decided nothing.
    const slow = bodyCapture('a', 'kitchen', 'S1', 1);
    slow.dwell = { ...slow.dwell, prfHz: 1.0 };
    const policy = makePolicy({ bandLowHz: 0.2, bandHighHz: 7.0 });

    // The refusal is real: the analyzer does throw on it.
    expect(() =>
      analyzeDwell(slow.dwell, { bandHz: [0.2, 7.0], noiseFloor: NOISE_FLOOR }),
    ).toThrow(/PRF/);

    const detail = evaluateCapture(slow, policy, evaluatorOptions());
    expect(detail.outcome).toBe('abstain');
    expect(detail.abstainReason).toBe('band_above_nyquist');
    // Charged as a whole abstention, so a policy that can only be evaluated on
    // part of the corpus pays for it on the axis the frozen gate is strict on.
    expect(detail.noopShare).toBe(1);
  });

  it('keeps every rung of the band ladder under BatVu own Nyquist frequency', () => {
    // Arithmetic, not taste: the instrument pings at 15 Hz, so 7.5 Hz is the
    // highest slow-time rate any dwell it takes can represent. A rung above it
    // is a rung the analyzer refuses on every capture — a search direction with
    // nothing at the end of it.
    for (const rung of DETECTOR_LADDERS.band) {
      const { bandHighHz } = decodeDetectorLever('band', rung);
      expect(Number(bandHighHz)).toBeLessThanOrEqual(PRF_HZ / 2);
    }
    const root = decodeDetectorLever('band', badRootDetectorPolicy().band!);
    expect(Number(root.bandHighHz)).toBeLessThanOrEqual(PRF_HZ / 2);

    // And the root really does run against the real analyzer on a real-rate
    // capture, rather than throwing before the wheel starts.
    const detail = evaluateCapture(
      bodyCapture('a', 'kitchen', 'S1', 1),
      badRootDetectorPolicy(),
      evaluatorOptions(),
    );
    expect(detail.abstainReason).not.toBe('band_above_nyquist');
  });

  it('abstains when the record cannot place the teacher metres in a bin', () => {
    // `no_range_geometry`. The dwell scored its bins, so `noopShare` is NOT 1 —
    // range was decided, just not the range the label is about. The distinction
    // matters because `noopRate` is the axis the frozen gate is strict on.
    const record = bodyCapture('a', 'kitchen', 'S1', 1);
    const { rangeStepM: _dropped, ...withoutGeometry } = record.dwell;
    record.dwell = withoutGeometry;
    const detail = evaluateCapture(record, makePolicy(), evaluatorOptions());
    expect(detail.outcome).toBe('abstain');
    expect(detail.abstainReason).toBe('no_range_geometry');
    expect(detail.noopShare).toBeLessThan(1);
  });

  it('hands the analyzer the floor the capture measured, not one estimated from it', () => {
    // `@batvu/micromotion`'s fallback is a MEDIAN over range bins, and it
    // documents its own assumption: that most bins of a profile hold no target.
    // These dwells are twelve bins with a return in almost all of them, which is
    // the case that assumption is wrong for — so the record carries the floor
    // and the evaluator passes it through.
    const record = bodyCapture('a', 'kitchen', 'S1', 1);
    expect(record.noiseFloorRms).toBe(NOISE_FLOOR);

    const seen: number[] = [];
    const spy = (dwell: ComplexProfileDwell, options: Parameters<typeof analyzeDwell>[1]) => {
      seen.push(options.noiseFloor ?? Number.NaN);
      return analyzeDwell(dwell, options);
    };
    evaluateCapture(record, makePolicy(), { analyze: spy, now: fakeNow() });
    expect(seen).toEqual([NOISE_FLOOR]);

    // Without it the analyzer estimates one, and on this profile the estimate is
    // the median of twelve bins that mostly hold a return — far above the truth,
    // so real bins are refused.
    const { noiseFloorRms: _dropped, ...unmeasured } = record;
    const estimated = evaluateCapture(unmeasured, makePolicy(), evaluatorOptions());
    const measured = evaluateCapture(record, makePolicy(), evaluatorOptions());
    expect(estimated.noopShare).toBeGreaterThan(measured.noopShare);
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

describe('the seam with @batvu/micromotion', () => {
  it('calls the analyzer it says it calls', () => {
    // `MICROMOTION_ANALYZER` is `analyzeDwell` narrowed to the seam's type.
    // Identity, not shape: the point of the seam is that the two packages are
    // the same code, and the previous version of this file proved only that a
    // hand-written stand-in agreed with a hand-written interface.
    expect(MICROMOTION_ANALYZER).toBe(analyzeDwell as unknown);
  });

  it('refuses the options the analyzer refuses, at the same edges', () => {
    // `ResolvedDwellOptions` is derived from that package's `DwellOptions`, so
    // the fields line up by construction. What is checked here is that the
    // POLICY layer does not let a value through that the analyzer would then
    // throw on three frames deeper, where the capture id is gone.
    expect(() => resolveDetectorPolicy(makePolicy({ alpha: 0 }))).toThrow();
    expect(() => analyzeDwell(bodyCapture('a', 'k', 'S', 1).dwell, {
      bandHz: [0.1, 0.7],
      noiseFloor: NOISE_FLOOR,
      alpha: 0,
    })).toThrow(/alpha/);

    expect(() => resolveDetectorPolicy(makePolicy({ minCycles: 0 }))).toThrow();
    expect(() => analyzeDwell(bodyCapture('a', 'k', 'S', 1).dwell, {
      bandHz: [0.1, 0.7],
      noiseFloor: NOISE_FLOOR,
      minCycles: 0,
    })).toThrow(/minCycles/);

    expect(() => resolveDetectorPolicy(makePolicy({ minSnrDb: -1 }))).toThrow();
    expect(() => analyzeDwell(bodyCapture('a', 'k', 'S', 1).dwell, {
      bandHz: [0.1, 0.7],
      noiseFloor: NOISE_FLOOR,
      minSnrDb: -1,
    })).toThrow(/minSnrDb/);
  });
});

describe('the seam with @batvu/capture', () => {
  /** A `.presence.jsonl` record, written and read back through the real
   *  encoder and the real parser — so this exercises the two packages meeting,
   *  not two descriptions of a record shape agreeing with each other. */
  function presenceCorpusText(over: { bodyOnBeam: boolean | null; bodyInScene: boolean }): string {
    const t0 = 1_756_000_000;
    const uptimeNs = 12_345_000_000_000;
    const bins = FIXTURE_BINS;
    const pings = 900; // 60 s at 15 Hz
    const iq = new Float32Array(pings * bins * 2);
    for (let p = 0; p < pings; p++) {
      for (let b = 0; b < bins; b++) {
        // Only the labelled bin moves. A modulation shared by every bin is
        // common-mode by construction and the detector is supposed to remove it.
        const d = b === TARGET_BIN ? 0.002 * Math.sin(2 * Math.PI * TARGET_RATE_HZ * (p / PRF_HZ)) : 0;
        const phase = (4 * Math.PI * d) / LAMBDA_M + b * 0.37;
        iq[(p * bins + b) * 2] = 0.1 * Math.cos(phase);
        iq[(p * bins + b) * 2 + 1] = 0.1 * Math.sin(phase);
      }
    }
    return encodeCorpus([
      encodeRecord({
        deviceId: 'batvu-seam-01',
        sequence: 0,
        source: 'simulated',
        consent: {
          receiptId: 'receipt-seam',
          subjectRef: 'subject-seam',
          scope: CONSENT_SCOPE,
          privacyMax: CONSENT_PRIVACY_CLASS,
          grantedUnixS: t0 - 10,
          expiresUnixS: t0 + 600,
          withdrawalRef: 'batvu://consent/receipt-seam/withdraw',
        },
        clock: {
          ultrasonicUnixS: t0,
          lidarTimestampNs: uptimeNs,
          lidarDomain: 'arkit_uptime',
          offsetS: t0 + 4 - uptimeNs / 1e9,
          skewS: 0.01,
        },
        measurement: {
          beam: [0, 1, 0],
          calibrationId: 'cal-seam',
          prfHz: PRF_HZ,
          lambdaM: LAMBDA_M,
          pings,
          bins,
          startRangeM: START_RANGE_M,
          rangeStepM: RANGE_STEP_M,
          iq,
          noiseFloor: NOISE_FLOOR,
          saturated: false,
        },
        label: {
          frameType: LIDAR_FRAME_TYPE,
          sensor: 'apple-arkit-scene-depth',
          sequence: 4211,
          rangeM: START_RANGE_M + TARGET_BIN * RANGE_STEP_M,
          rangeConfidence: 2,
          sampleCount: 41,
          bodyInScene: over.bodyInScene,
          bodyOnBeam: over.bodyOnBeam,
          pose: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.5, 1.2, -0.3, 1],
          intrinsics: { fx: 1500, fy: 1500, cx: 960, cy: 720, imageWidth: 1920, imageHeight: 1440 },
        },
      }),
    ]);
  }

  it('turns a parsed .presence.jsonl record into a scoreable capture', () => {
    const [record] = parseCorpus(presenceCorpusText({ bodyInScene: true, bodyOnBeam: true }), {
      accept: 'simulated',
    });
    const capture = captureFromPairedDwell(record!, { roomId: 'kitchen' });

    // The dwell goes across untouched, which is the claim `DwellMeasurement`
    // makes about being assignable to `ComplexProfileDwell`.
    expect(capture.dwell).toBe(record!.measurement);
    expect(capture.noiseFloorRms).toBe(NOISE_FLOOR);
    expect(capture.id).toBe('batvu-seam-01#0');
    // The subject identity is the consent receipt's OPAQUE reference. There is
    // no name in the format and none is invented here.
    expect(capture.subjectId).toBe('subject-seam');
    expect(capture.consent).toEqual({ granted: true, receiptId: 'receipt-seam' });
    expect(capture.teacher.bodyInScene).toBe(true);
    // Not exactly the metres that went in: the wire rounds a range to six
    // decimals, which is a micrometre. `TEACHER_BIN_TOLERANCE` is a whole range
    // bin either side of it, so the rounding is seven orders below anything the
    // scoring depends on — but the number is the wire's, not the fixture's.
    expect(capture.teacher.bodyRangeM).toBeCloseTo(START_RANGE_M + TARGET_BIN * RANGE_STEP_M, 5);

    // And the whole thing scores, which is the point of the adapter existing.
    const detail = evaluateCapture(capture, makePolicy(), evaluatorOptions());
    expect(detail.outcome).not.toBe('abstain');
  });

  it('does not turn a body ARKit saw off the beam into a positive', () => {
    // `body_on_beam` is nullable because ADR-023's own "what this does not
    // answer" opens with whether ARKit can say "at this bearing" at all. A body
    // somewhere in the scene gives no range bin to look in, so there is nothing
    // to measure a hit against and the capture is not a positive.
    for (const bodyOnBeam of [null, false]) {
      const [record] = parseCorpus(presenceCorpusText({ bodyInScene: true, bodyOnBeam }), {
        accept: 'simulated',
      });
      const capture = captureFromPairedDwell(record!, { roomId: 'kitchen' });
      expect(capture.teacher.bodyInScene).toBe(true);
      expect(capture.teacher.bodyRangeM).toBeNull();
    }
  });

  it('never lets the teacher range reach a detector', () => {
    // `@batvu/capture` seals the label so a detector cannot read the answers out
    // of the corpus it is being tuned on, and `captureFromPairedDwell` is the
    // one place the seal is opened. What comes out has to stay on the scoring
    // side: nothing the analyzer is handed may carry it.
    const [record] = parseCorpus(presenceCorpusText({ bodyInScene: true, bodyOnBeam: true }), {
      accept: 'simulated',
    });
    const capture = captureFromPairedDwell(record!, { roomId: 'kitchen' });

    let handed: unknown = null;
    evaluateCapture(capture, makePolicy(), {
      analyze: (dwell, options) => {
        handed = { dwell: { ...dwell, data: dwell.data.length }, options };
        return analyzeDwell(dwell, options);
      },
      now: fakeNow(),
    });
    expect(JSON.stringify(handed)).not.toContain('bodyRangeM');
    expect(JSON.stringify(handed)).not.toContain('teacher');
    expect(JSON.stringify(handed)).not.toContain('presence');
    // The sealed handle itself carries nothing readable either.
    expect(JSON.stringify(record!.label)).not.toContain(String(capture.teacher.bodyRangeM));
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
  }, 120_000);

  it('lets the frozen gate refuse a candidate that improves primary but commits no more', () => {
    // Documented, and deliberately not routed around. Once every capture has
    // been decided, `noopRate` is exactly 0 and the gate's strict clause can
    // never be satisfied again — so a candidate that would raise `primary` from
    // 0 to 1 is rejected. The gate is not the thing to change: see the note at
    // the top of `detector-evaluator.ts`. Asserted here on the arithmetic
    // rather than on a particular generation of a particular run, because which
    // generation a corpus reaches that state at is a property of the corpus.
    const baseline = aggregateDetectorDetails(outcomes({ hit: 4, false_alarm: 4 }), 0.5);
    const candidate = aggregateDetectorDetails(outcomes({ hit: 4, correct_rejection: 4 }), 0.05);
    expect(baseline.noopRate).toBe(0);
    expect(candidate.primary).toBeGreaterThan(baseline.primary);

    const decision = meetsPromotionRule({ baseline, candidate });
    expect(decision.promote).toBe(false);
    expect(decision.reasons.join(' ')).toMatch(/noop/);
  });

  it('reproduces exactly across two runs of the same configuration', async () => {
    const run = async () => {
      const { holdout, anchor } = splitCorpusByRoomAndSubject(fixtureCorpus());
      return runDetectorFlywheel({ ...evaluatorOptions(), holdout, anchor, maxGenerations: 2 });
    };
    const a = await run();
    const b = await run();
    expect(b.finalPolicy).toEqual(a.finalPolicy);
    expect(b.promotionNotes).toEqual(a.promotionNotes);

    // Not the lift curve: on this corpus it is [0, 0] and comparing two
    // constant arrays would hold whatever the projection did. The candidate
    // scores the gate actually saw are what vary — noopRate, costPerWin and the
    // outcome counts all differ between rungs — so those are what is compared,
    // together with the verdict each one earned.
    const sealed = (r: typeof a): unknown[] =>
      r.result.replayBundle.all_commits.map((c) => [
        c.id,
        c.verdict,
        c.failureReasons,
        c.baselineScore,
        c.candidateScore,
      ]);
    expect(sealed(b)).toEqual(sealed(a));
    const scores = a.result.replayBundle.all_commits
      .map((c) => c.candidateScore?.noopRate)
      .filter((v): v is number => v !== undefined);
    expect(new Set(scores).size).toBeGreaterThan(1);
  }, 120_000);
});
