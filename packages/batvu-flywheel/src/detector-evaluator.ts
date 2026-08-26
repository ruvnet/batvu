// SPDX-License-Identifier: MIT
//
// The detector evaluator: the second wheel's projection, and its refusal.
//
// `policy.ts` + `evaluator.ts` evolve the SONAR against simulated rooms. This
// file evolves the MICRO-MOTION DETECTOR against a corpus of real captures.
// `@metaharness/flywheel` is reused unmodified — same engine, same signer, same
// frozen conjunctive gate — and ADR-023 §3 is explicit that the only thing
// changing is what the evaluator reads. So the interesting content here is not
// the loop. It is what counts as evidence, and what happens when there is none.
//
// ## There is no corpus. That is the design constraint, not a caveat
//
// BatVu has measured zero real rooms. Every function below is written for a
// corpus that does not exist yet, and the single most important property of
// this file is that it CANNOT be run against nothing and produce a number.
//
// The failure it is written to prevent is ADR-022's, one step worse. There, a
// near-field error made every published range figure optimistic. Here, the
// available error is a wheel that runs against an empty corpus, scores every
// policy at `primary = 0`, watches the gate refuse everything, and produces a
// signed replay bundle with a flat lift curve — which is BYTE-INDISTINGUISHABLE
// from the bundle a converged run produces. A reader cannot tell "we searched
// and found nothing left to win" from "we searched nothing". So an empty corpus
// throws {@link NoEvidenceError}, and the type system is arranged so that the
// only value the wheel accepts is one that has already been refused the chance
// to be empty: see {@link AttestedCorpus}.
//
// `aggregate` in `evaluator.ts` does the opposite for an empty room suite —
// it returns a maximally bad score. That is right THERE and wrong here. A
// simulator can always produce a room, so an empty room suite is a caller
// mistake; an empty capture corpus is the current state of the world, and a
// maximally bad score is a number a wheel can improve on without measuring
// anything.
//
// ## The simulator is barred
//
// Nothing in this file imports from `@batvu/sim`, and nothing may. ADR-023 §4
// gives `Target::breathing` exactly one job — proving that a known phase
// modulation produces the expected band energy — and states that it must never
// be scored by the flywheel. A detector tuned against a simulated breather is a
// detector tuned to agree with the code that synthesised it, and
// {@link AttestedCorpus} makes a corpus declare its provenance for the same
// reason, so that a run on fixtures cannot mint a bundle stamped `LIVE`.
//
// ## The projection
//
// | axis         | for the micro-motion detector                          | why THIS |
// |--------------|--------------------------------------------------------|----------|
// | `primary`    | hit rate minus false-alarm rate, over DECIDED captures  | both degenerate strategies score exactly zero |
// | `noopRate`   | fraction of captures the detector DECLINED to decide     | abstention, not error — see below |
// | `costPerWin` | milliseconds of analysis per point of `primary`         | a dwell is tens of seconds of one bearing; it has to be worth it |
// | `regressed`  | the measured false-alarm rate exceeds the detector's own claim | a calibrated number that is not calibrated |
//
// **`primary` is Youden's J** — sensitivity + specificity - 1, which for a
// binary detector is exactly `hitRate - falseAlarmRate`. Not accuracy: the
// corpus's class balance is whatever rooms happened to get captured, and
// accuracy rewards a detector for matching that prior. Not F1: it ignores
// correct rejections, and in this problem the empty room is most of the
// evidence and the whole point. J is zero for a detector that never fires and
// zero for one that always fires, so neither degenerate strategy needs a
// separate guard, and it reads directly against ADR-023's "a stated
// false-alarm rate".
//
// **`noopRate` is ABSTENTION, and the distinction is the one that broke the
// gate before.** `run.ts`'s header records it: with `noopRate` defined as the
// miss rate, the single most useful class of change — tightening the detector —
// was structurally unpromotable, because a stricter detector misses more. A
// miss is an ERROR and is already priced into `primary` through the hit rate. A
// no-op is the detector DECLINING TO DECIDE: an `insufficient_dwell`, a bin
// with no usable return, a dwell the operator moved too much. Those are the
// outputs that "end empty", and they are what the strict clause should be
// pushing down.
//
// The root policy is chosen so that clause has somewhere to go: a two-second
// dwell refuses every capture, so the root's `noopRate` is 1 and the only
// direction is down.

import {
  gateFingerprint,
  makeSigner,
  meetsPromotionRule,
  runFlywheelGenerations,
  verifyReplayBundle,
  type FlywheelResult,
  type Score,
} from '@metaharness/flywheel';
import {
  DETECTOR_LEVERS,
  badRootDetectorPolicy,
  describeDetectorStep,
  detectorLadderStep,
  resolveDetectorPolicy,
  type DetectorLever,
  type DetectorPolicy,
  type DwellOptions,
} from './detector-policy.js';

// ---------------------------------------------------------------------------
// Mirrors of packages being written concurrently.
//
// TODO(ADR-023): `@batvu/capture` and `@batvu/micromotion` are not yet
// resolvable from this package — neither appears in its `package.json`, in
// `tsconfig.json`'s project references, or in the repository's vitest alias
// table, and this file owns none of those. Importing them by name today breaks
// `tsc --noEmit` and every test in the repository, so what this file needs from
// each is mirrored structurally below and injected at the seam. The field names
// are the ones those packages declare, so at integration each interface is
// deleted in favour of `import type ... from '@batvu/capture'` /
// `'@batvu/micromotion'` and any disagreement surfaces as a compile error
// rather than as a silently different measurement.
// ---------------------------------------------------------------------------

/** `@batvu/micromotion`'s `ComplexProfileDwell`, mirrored. Interleaved `(re, im)`
 *  pairs, ping-major: bin `b` of ping `p` lives at `p*bins*2 + b*2`. */
export interface ComplexProfileDwell {
  data: Float32Array | Float64Array;
  pings: number;
  bins: number;
  prfHz: number;
  lambdaM: number;
  startRangeM?: number;
  rangeStepM?: number;
}

/** `@batvu/micromotion`'s `MicroMotionBin`, mirrored — only the fields this
 *  projection reads. Note what is absent: there is no `presence` field here,
 *  in that package, or anywhere downstream of it. ADR-023 §5. */
export interface MicroMotionBin {
  bin: number;
  rangeM: number | null;
  status: 'ok' | 'no_return';
  micromotionBand: number;
  pValue: number;
  statistic: number;
  rateHz: number | null;
  snrDb: number;
}

/** `@batvu/micromotion`'s `MicroMotionDwell`, mirrored. */
export interface MicroMotionDwell {
  status: 'ok' | 'insufficient_dwell';
  reason: string | null;
  dwellS: number;
  bandBins: number;
  scoreThreshold: number;
  /** Peak absolute common-mode displacement over the dwell, metres — the
   *  sensor's own motion as this dwell measured it. ADR-023 §3 says this is the
   *  number that can end the enquiry, so the projection reads it. */
  commonModePeakM: number;
  bins: MicroMotionBin[];
}

/** `analyzeDwell` from `@batvu/micromotion`.
 *
 *  Injected rather than imported, and REQUIRED with no default. A default would
 *  be a second way to run this wheel, and every path into it has to pass the
 *  same refusals. */
export type DwellAnalyzer = (
  dwell: ComplexProfileDwell,
  options: DwellOptions,
) => MicroMotionDwell;

/**
 * The label, from the sensor that can see.
 *
 * ADR-023 §2: the teacher rides along. RuView's iPhone capture app streams
 * ARKit scene depth with intrinsics and the camera transform on the same
 * chassis, on the same clock, at the same pose — so for the bearing the sonar
 * was pointed down, LiDAR gives the true range to the nearest surface and ARKit
 * gives whether a body is in the scene. The pairing is what makes a corpus
 * possible at all: LiDAR cannot hear breathing and the sonar cannot see a
 * person.
 *
 * These are the TEACHER's words about the scene. They are not a BatVu feature
 * key and they do not become one — BatVu contributes `range_m` and
 * `micromotion_band`, and deciding that a periodically moving surface is a
 * person happens in a RuField fusion rule with other modalities, a consent flag
 * and a P4 ceiling attached.
 *
 * TODO(ADR-023): whether ARKit body anchors are available and accurate enough
 * to label a bearing without a human in the loop is listed under "what this
 * does not answer". It is assumed here, not verified.
 */
export interface TeacherLabel {
  /** ARKit reported a body anchor in this capture's scene. */
  bodyInScene: boolean;
  /** LiDAR range to that body along the sonar's bearing, metres. `null` when
   *  `bodyInScene` is false. */
  bodyRangeM: number | null;
}

/** ADR-023 §6: consent is per-capture and recorded IN the capture — not a
 *  checkbox in an app's settings and not inherited from the room. A record
 *  without a receipt is refused by {@link AttestedCorpus.attest}, in both directions,
 *  the same way `UltrasonicScan::load` refuses a trust-tier mismatch. */
export interface ConsentReceipt {
  granted: boolean;
  /** Opaque receipt identifier. Never a name, never a location. */
  receiptId: string;
}

/** `@batvu/capture`'s record, mirrored — what this projection reads. */
export interface CaptureRecord {
  id: string;
  /** The room this was captured in. Splits are BY ROOM; see {@link splitCorpusByRoomAndSubject}. */
  roomId: string;
  /** The person in the room, or `null` for a deliberately empty room. */
  subjectId: string | null;
  consent: ConsentReceipt | null;
  /** The complex profiles as recorded. Usually longer than any one candidate
   *  policy looks at — the `dwell` lever decides how much is taken. */
  dwell: ComplexProfileDwell;
  teacher: TeacherLabel;
}

// ---------------------------------------------------------------------------
// The corpus, and the refusal
// ---------------------------------------------------------------------------

/** Thrown when the wheel is asked to score something that is not evidence.
 *
 *  This is not an error condition to be handled and logged. It is the correct
 *  and expected outcome of running BatVu's detector search today, because there
 *  are no captures. Catching it and substituting a score recreates exactly the
 *  defect the class exists to prevent. */
export class NoEvidenceError extends Error {
  override readonly name = 'NoEvidenceError';
  constructor(message: string) {
    super(`batvu/flywheel: ${message}`);
  }
}

export interface AttestCorpusInput {
  id: string;
  /** Where these captures came from. `DEVICE` is a real phone in a real room;
   *  `FIXTURE` is anything synthesised, including by a test in this repository.
   *  It is carried so that a run on fixtures cannot stamp its replay bundle
   *  `LIVE` — the label follows the evidence rather than the intent. */
  provenance: 'DEVICE' | 'FIXTURE';
  records: readonly CaptureRecord[];
}

/**
 * A corpus that has been checked and CANNOT be empty.
 *
 * The private constructor is the mechanism, and it is the reason this is a
 * class in a file of interfaces. {@link AttestedCorpus.attest} is the only way
 * to obtain one, and it throws {@link NoEvidenceError} rather than returning a
 * value the wheel could score. So "run the detector wheel against an empty
 * corpus" is not a mistake that produces a misleadingly flat lift curve — it is
 * a program that does not type-check, and if the types are bypassed, one that
 * throws before it reaches the gate.
 */
export class AttestedCorpus {
  /** Nominal rather than structural. A private member is what stops an object
   *  literal shaped like a corpus from being assignable to this type, so the
   *  only route in really is {@link AttestedCorpus.attest} and its refusals. */
  private readonly attested = true;
  readonly id: string;
  readonly provenance: 'DEVICE' | 'FIXTURE';
  readonly records: readonly CaptureRecord[];
  /** Rooms represented, sorted. */
  readonly rooms: readonly string[];
  /** Subjects represented, sorted. `null` subjects (empty rooms) are excluded. */
  readonly subjects: readonly string[];
  readonly positives: number;
  readonly negatives: number;

  private constructor(input: AttestCorpusInput, rooms: string[], subjects: string[], positives: number) {
    this.id = input.id;
    this.provenance = input.provenance;
    this.records = [...input.records];
    this.rooms = rooms;
    this.subjects = subjects;
    this.positives = positives;
    this.negatives = this.records.length - positives;
  }

  /**
   * Check a set of captures and, if they are evidence, attest them.
   *
   * Five refusals, each of which describes a corpus that cannot support a
   * promotion decision:
   *
   * 1. **Empty.** The one this whole file is built around.
   * 2. **No consent receipt.** ADR-023 §6. Refused at the boundary rather than
   *    filtered out silently, because a corpus that was quietly trimmed is not
   *    the corpus whose scores get signed.
   * 3. **No teacher-positive capture.** Nothing to measure a hit rate on.
   * 4. **No teacher-negative capture.** Nothing to measure a FALSE-ALARM rate
   *    on — and a detector whose false-alarm rate has not been measured has
   *    given up the one thing ADR-023 §3 chose a classical detector for.
   * 5. **A dwell that is not a dwell.** Zero pings, zero bins, or a
   *    non-positive PRF or wavelength: not a measurement, whatever it is.
   */
  static attest(input: AttestCorpusInput): AttestedCorpus {
    const { id, records } = input;
    if (records.length === 0) {
      throw new NoEvidenceError(
        `corpus '${id}' is empty — there is nothing to score. BatVu has measured zero real rooms, ` +
          `and a run against no captures produces a lift curve indistinguishable from a converged one.`,
      );
    }

    const rooms = new Set<string>();
    const subjects = new Set<string>();
    let positives = 0;

    for (const r of records) {
      if (r.consent === null || r.consent.granted !== true) {
        throw new NoEvidenceError(
          `capture '${r.id}' in corpus '${id}' carries no consent receipt (ADR-023 §6)`,
        );
      }
      const d = r.dwell;
      if (d.pings <= 0 || d.bins <= 0 || !(d.prfHz > 0) || !(d.lambdaM > 0)) {
        throw new NoEvidenceError(
          `capture '${r.id}' in corpus '${id}' does not carry a usable dwell`,
        );
      }
      rooms.add(r.roomId);
      if (r.subjectId !== null) subjects.add(r.subjectId);
      if (isTeacherPositive(r)) positives++;
    }

    if (positives === 0) {
      throw new NoEvidenceError(
        `corpus '${id}' has no capture the teacher labelled with a body — no hit rate is measurable`,
      );
    }
    if (positives === records.length) {
      throw new NoEvidenceError(
        `corpus '${id}' has no capture the teacher labelled empty — no false-alarm rate is measurable`,
      );
    }

    return new AttestedCorpus(input, [...rooms].sort(), [...subjects].sort(), positives);
  }
}

/** A capture the teacher put a body in, at a range it could measure. A body
 *  ARKit saw but LiDAR could not range is not usable as a positive — there is
 *  no bin to look in — so it is not counted as one. */
function isTeacherPositive(r: CaptureRecord): boolean {
  return r.teacher.bodyInScene && r.teacher.bodyRangeM !== null && Number.isFinite(r.teacher.bodyRangeM);
}

// ---------------------------------------------------------------------------
// The split
// ---------------------------------------------------------------------------

export interface CorpusSplit {
  holdout: AttestedCorpus;
  anchor: AttestedCorpus;
}

/**
 * Split a corpus into a holdout and a frozen anchor, BY ROOM AND BY SUBJECT.
 *
 * ## Why a random record split leaks
 *
 * Consecutive dwells in one room with one person are not independent samples.
 * They share:
 *
 * - **the room.** Clutter geometry, multipath off soft furnishings, the noise
 *   floor, the reverberation tail — all identical, all in every dwell.
 * - **where the phone was put.** ADR-023 §3 says this is probably a
 *   phone-on-a-table instrument, so the pose is the same for a whole session
 *   and so is the common-mode residual it leaves.
 * - **the person.** One subject's rate, posture, distance and chest-wall
 *   geometry are the same across their captures. A detector's band edges tuned
 *   on half of somebody's session are tuned on the other half too.
 *
 * A record-level split therefore puts dwell 40 in the holdout and dwell 41 in
 * the anchor, and a parameter set that has memorised one room's clutter
 * spectrum shows lift on the holdout AND survives the anchor. The anchor's only
 * job is to be the anti-Goodhart guard; sharing a room with the holdout deletes
 * that job while leaving the receipts looking exactly the same. This is the
 * same class of error as scoring the sonar wheel against a model that agrees
 * with itself, which is what ADR-022 was about.
 *
 * ## Why rooms and subjects have to be split TOGETHER
 *
 * Splitting on rooms alone leaks the subject: one person captured in their
 * kitchen and their living room lands on both sides. Splitting on subjects
 * alone leaks the room: two people captured in the same office land on both
 * sides. Neither is sufficient, and doing both independently is not either,
 * because a room and a subject that share a capture cannot be separated at all
 * — putting the room in the holdout puts that capture in the holdout, which
 * puts the subject there.
 *
 * So rooms and subjects form a bipartite graph whose edges are captures, and
 * its CONNECTED COMPONENTS are the atoms of the split. A component goes to one
 * side entirely or the split is not a split. `subjectId: null` (a deliberately
 * empty room) contributes no edge — otherwise every empty-room capture would
 * fuse every room in the corpus into one component and nothing could be split.
 *
 * ## What it does when it cannot
 *
 * A corpus of one room, or one whose components will not divide into two sides
 * that each carry a positive and a negative, is not splittable, and
 * {@link AttestedCorpus.attest} throws {@link NoEvidenceError} saying so. That is the
 * right answer: a holdout and an anchor drawn from the same room measure
 * nothing about generalisation.
 */
export function splitCorpusByRoomAndSubject(
  corpus: AttestedCorpus,
  options: { holdoutId?: string; anchorId?: string } = {},
): CorpusSplit {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = parent.get(x) ?? x;
    while (root !== (parent.get(root) ?? root)) root = parent.get(root) ?? root;
    let cur = x;
    while (cur !== root) {
      const next = parent.get(cur) ?? cur;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    // Union by the lexically smaller root, so the component ids — and therefore
    // the assignment order below — do not depend on record order.
    if (ra === rb) return;
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  };

  for (const r of corpus.records) {
    const room = `room:${r.roomId}`;
    parent.set(room, parent.get(room) ?? room);
    if (r.subjectId !== null) union(room, `subject:${r.subjectId}`);
  }

  const components = new Map<string, CaptureRecord[]>();
  for (const r of corpus.records) {
    const key = find(`room:${r.roomId}`);
    const bucket = components.get(key);
    if (bucket) bucket.push(r);
    else components.set(key, [r]);
  }

  if (components.size < 2) {
    throw new NoEvidenceError(
      `corpus '${corpus.id}' has one room/subject component — a holdout and an anchor drawn ` +
        `from it would share a room, and the anchor would stop being an independent check`,
    );
  }

  // Largest component first, ties broken by component id: deterministic, and it
  // keeps one dominant room from deciding the balance by arriving last.
  const ordered = [...components.entries()].sort(
    (a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1),
  );
  const holdout: CaptureRecord[] = [];
  const anchor: CaptureRecord[] = [];
  for (const [, group] of ordered) {
    (holdout.length <= anchor.length ? holdout : anchor).push(...group);
  }

  return {
    holdout: AttestedCorpus.attest({
      id: options.holdoutId ?? `${corpus.id}-holdout`,
      provenance: corpus.provenance,
      records: holdout,
    }),
    anchor: AttestedCorpus.attest({
      id: options.anchorId ?? `${corpus.id}-anchor`,
      provenance: corpus.provenance,
      records: anchor,
    }),
  };
}

// ---------------------------------------------------------------------------
// Scoring one capture
// ---------------------------------------------------------------------------

/** What the detector did with one capture. Exactly one of these, per record. */
export type CaptureOutcome =
  /** Teacher put a body at a range; the detector fired in that bin. */
  | 'hit'
  /** Teacher put a body at a range; the detector decided, and said no. ERROR. */
  | 'miss'
  /** Teacher said the room was empty; the detector fired anyway. ERROR. */
  | 'false_alarm'
  /** Teacher said the room was empty; the detector agreed. */
  | 'correct_rejection'
  /** The detector declined to decide. ABSTENTION — never an error. */
  | 'abstain';

export interface CaptureEvaluation {
  capture: string;
  roomId: string;
  outcome: CaptureOutcome;
  /** Why, when the outcome is `abstain`. One of `insufficient_dwell`,
   *  `no_return`, `sensor_motion`, `no_range_geometry`. */
  abstainReason: string | null;
  /** Slow-time seconds actually taken from the record — less than the lever
   *  asked for when the record is shorter than the dwell. */
  dwellS: number;
  /** As the detector measured it, whether or not it was subtracted. */
  commonModePeakM: number;
  /** The strongest `micromotion_band` in any usable bin. Diagnostic. */
  peakScore: number;
  elapsedMs: number;
}

/** Range bins either side of the teacher's range that count as covering it.
 *
 *  The teacher ranges a SURFACE and the sonar bins a range; at 3 kHz of usable
 *  bandwidth a bin is centimetres, and a chest is not a point. Demanding exact
 *  bin agreement would score the discretisation rather than the detector —
 *  which is the argument `evaluator.ts` makes for its one-resolution-cell
 *  tolerance and its one-voxel dilation, applied to the same problem. */
const TEACHER_BIN_TOLERANCE = 1;

export interface DetectorEvaluatorOptions {
  /** `analyzeDwell` from `@batvu/micromotion`. Required — see {@link DwellAnalyzer}. */
  analyze: DwellAnalyzer;
  /** Wall-clock source, injectable so tests are deterministic. */
  now?: () => number;
}

/**
 * Score one capture under one policy.
 *
 * A teacher-POSITIVE capture is judged only in the bins covering the labelled
 * range. A teacher-NEGATIVE capture is judged across the whole profile. The
 * asymmetry is deliberate and it is about what the label licenses: ARKit
 * putting a body at 2.4 m says nothing about whether the curtain at 4 m is
 * moving, so a fire elsewhere in a positive capture is not evidence of a false
 * alarm. Only a capture the teacher says is EMPTY licenses the claim that
 * nothing in it should have fired — and that is the capture the false-alarm
 * rate is measured on.
 */
export function evaluateCapture(
  record: CaptureRecord,
  policy: DetectorPolicy,
  options: DetectorEvaluatorOptions,
): CaptureEvaluation {
  const resolved = resolveDetectorPolicy(policy);
  const now = options.now ?? (() => performance.now());

  const wantPings = Math.max(1, Math.round(resolved.dwellS * record.dwell.prfHz));
  const dwell = takePings(record.dwell, Math.min(wantPings, record.dwell.pings));

  const started = now();
  const analysis = options.analyze(dwell, resolved.dwellOptions);
  const elapsedMs = now() - started;

  const base = {
    capture: record.id,
    roomId: record.roomId,
    dwellS: dwell.pings / dwell.prfHz,
    commonModePeakM: analysis.commonModePeakM,
    elapsedMs,
  };

  // The dwell was too short to see a period of the slowest rate searched. Not
  // evidence of stillness, so not a miss.
  if (analysis.status !== 'ok') {
    return { ...base, outcome: 'abstain', abstainReason: analysis.reason ?? analysis.status, peakScore: 0 };
  }

  // The operator moved more than this policy is prepared to believe through.
  // ADR-023 §3: a few millimetres of hand tremor is hundreds of degrees of
  // phase, and the common-mode estimator only models translation along the
  // boresight. Declining is an abstention; pretending is not an option.
  if (analysis.commonModePeakM > resolved.commonModeMaxPeakM) {
    return { ...base, outcome: 'abstain', abstainReason: 'sensor_motion', peakScore: 0 };
  }

  const usable = analysis.bins.filter((b) => b.status === 'ok');
  const peakScore = usable.reduce((m, b) => Math.max(m, b.micromotionBand), 0);

  if (!isTeacherPositive(record)) {
    if (usable.length === 0) {
      return { ...base, outcome: 'abstain', abstainReason: 'no_return', peakScore: 0 };
    }
    const fired = usable.some((b) => b.micromotionBand >= resolved.scoreThreshold);
    return {
      ...base,
      outcome: fired ? 'false_alarm' : 'correct_rejection',
      abstainReason: null,
      peakScore,
    };
  }

  const target = binsCoveringRange(dwell, record.teacher.bodyRangeM!);
  if (target === null) {
    // The record did not carry the bin geometry, so the teacher's metres cannot
    // be turned into a bin. Nothing was decided about it.
    return { ...base, outcome: 'abstain', abstainReason: 'no_range_geometry', peakScore };
  }
  const atTarget = usable.filter((b) => b.bin >= target.lo && b.bin <= target.hi);
  if (atTarget.length === 0) {
    return { ...base, outcome: 'abstain', abstainReason: 'no_return', peakScore };
  }
  const fired = atTarget.some((b) => b.micromotionBand >= resolved.scoreThreshold);
  return { ...base, outcome: fired ? 'hit' : 'miss', abstainReason: null, peakScore };
}

/** Take the first `pings` profiles. A view, not a copy — the dwell is
 *  ping-major, so a prefix of the buffer is a prefix of the slow time. */
function takePings(dwell: ComplexProfileDwell, pings: number): ComplexProfileDwell {
  const data: Float32Array | Float64Array = dwell.data.subarray(0, pings * dwell.bins * 2);
  return { ...dwell, data, pings };
}

/** Bins covering a range in metres, or `null` when the dwell did not carry the
 *  geometry needed to place one. */
function binsCoveringRange(
  dwell: ComplexProfileDwell,
  rangeM: number,
): { lo: number; hi: number } | null {
  const step = dwell.rangeStepM;
  if (step === undefined || !(step > 0)) return null;
  const centre = Math.round((rangeM - (dwell.startRangeM ?? 0)) / step);
  const lo = centre - TEACHER_BIN_TOLERANCE;
  const hi = centre + TEACHER_BIN_TOLERANCE;
  if (hi < 0 || lo >= dwell.bins) return null;
  return { lo: Math.max(0, lo), hi: Math.min(dwell.bins - 1, hi) };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface DetectorSuiteScore extends Score {
  captures: number;
  hits: number;
  misses: number;
  falseAlarms: number;
  correctRejections: number;
  abstentions: number;
  /** Over DECIDED teacher-positive captures. */
  hitRate: number;
  /** Over DECIDED teacher-negative captures — the number `regressed` tests. */
  falseAlarmRate: number;
  /** The alpha the detector claimed while producing these outcomes. */
  claimedAlpha: number;
  /** The 3-sigma bound on false alarms the claim implies. */
  falseAlarmBudget: number;
  elapsedMs: number;
}

/** How far past its own claimed false-alarm rate a policy may measure before it
 *  counts as a hard regression, in standard deviations of the binomial that
 *  claim implies.
 *
 *  Under the detector's null, false alarms over `n` decided empty captures are
 *  Binomial(n, alpha), so the bound is `n*alpha + 3*sqrt(n*alpha*(1-alpha))`.
 *  That is arithmetic, and it is deliberately a bound rather than a
 *  hand-picked margin. With a small corpus it is wide and the guard is weak;
 *  that is a true statement about having few captures, and tightening it by
 *  hand would replace the honest weakness with a confident wrong answer. */
const CALIBRATION_SIGMAS = 3;

/**
 * Aggregate per-capture outcomes into the one `Score` the gate sees.
 *
 * Throws on an empty list. This is the load-bearing difference from
 * `aggregate` in `evaluator.ts`, which returns a maximally bad score for an
 * empty suite — see the module note on why that is right for rooms and wrong
 * for captures.
 */
export function aggregateDetectorDetails(
  details: readonly CaptureEvaluation[],
  claimedAlpha: number,
): DetectorSuiteScore {
  if (details.length === 0) {
    throw new NoEvidenceError(
      'no capture outcomes to aggregate — a score computed from nothing is not a measurement',
    );
  }

  let hits = 0;
  let misses = 0;
  let falseAlarms = 0;
  let correctRejections = 0;
  let abstentions = 0;
  let elapsedMs = 0;
  for (const d of details) {
    elapsedMs += d.elapsedMs;
    switch (d.outcome) {
      case 'hit':
        hits++;
        break;
      case 'miss':
        misses++;
        break;
      case 'false_alarm':
        falseAlarms++;
        break;
      case 'correct_rejection':
        correctRejections++;
        break;
      default:
        abstentions++;
    }
  }

  const decidedPositives = hits + misses;
  const decidedNegatives = falseAlarms + correctRejections;
  const hitRate = decidedPositives === 0 ? 0 : hits / decidedPositives;
  const falseAlarmRate = decidedNegatives === 0 ? 0 : falseAlarms / decidedNegatives;

  // Youden's J. A detector that never fires and one that always fires both land
  // on exactly zero, and a detector that decided nothing at all lands there too
  // without a special case — its abstention is charged once, on `noopRate`.
  const primary = Math.max(0, hitRate - falseAlarmRate);
  const noopRate = abstentions / details.length;

  // Per POINT of J, not per capture: a policy that doubles the dwell for a
  // rounding-error gain should look expensive, and per-capture cost would hide
  // it. A dwell is tens of seconds of an instrument that cannot sweep while it
  // runs, so this axis is not academic.
  const costPerWin = elapsedMs / Math.max(primary * 100, 0.5);

  const falseAlarmBudget =
    decidedNegatives * claimedAlpha +
    CALIBRATION_SIGMAS * Math.sqrt(decidedNegatives * claimedAlpha * (1 - claimedAlpha));
  // The hard stop, and the analogue of `evaluator.ts`'s false-free carve: the
  // detector's whole justification over a learned model is that it publishes a
  // calibrated false-alarm rate. A policy that fires more often on empty rooms
  // than its own null says it should is not merely worse — every number it
  // reports downstream is wrong by the amount it is out. No measured lift
  // anywhere else may override that.
  const regressed = decidedNegatives > 0 && falseAlarms > falseAlarmBudget;

  return {
    primary,
    noopRate,
    costPerWin,
    regressed,
    captures: details.length,
    hits,
    misses,
    falseAlarms,
    correctRejections,
    abstentions,
    hitRate,
    falseAlarmRate,
    claimedAlpha,
    falseAlarmBudget,
    elapsedMs,
  };
}

/**
 * Build the `Evaluator` the flywheel engine takes.
 *
 * The engine's `Suite.items` is `unknown[]`, so the brand on
 * {@link AttestedCorpus} does not survive the trip through it. The emptiness
 * check is therefore repeated here at runtime — the type stops it being
 * written, and this stops it being smuggled.
 */
export function makeDetectorEvaluator(
  options: DetectorEvaluatorOptions,
): (policy: DetectorPolicy, suite: { id: string; items: unknown[] }) => Promise<Score> {
  return async (policy, suite) => {
    if (suite.items.length === 0) {
      throw new NoEvidenceError(
        `suite '${suite.id}' reached the evaluator with no captures — refusing to return a score`,
      );
    }
    const records = suite.items as CaptureRecord[];
    const { dwellOptions } = resolveDetectorPolicy(policy);
    const details = records.map((r) => evaluateCapture(r, policy, options));
    return aggregateDetectorDetails(details, dwellOptions.alpha);
  };
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/** The gate, unmodified.
 *
 *  Exported by identity rather than re-declared so that a test can assert it is
 *  the same function object `@metaharness/flywheel` ships. ADR-023 §3: the
 *  promotion machinery does not change, `meetsPromotionRule` stays frozen and
 *  conjunctive, and the only thing that changes is what the evaluator reads.
 *  There is no wrapper here, no override, and no escape hatch. If the gate
 *  refuses to promote anything, that is the result of the run and it gets
 *  reported as such — `run.ts`'s header records the two occasions where the
 *  honest fix was the projection and not the gate. */
export const DETECTOR_PROMOTION_RULE = meetsPromotionRule;

export interface DetectorFlywheelOptions extends DetectorEvaluatorOptions {
  holdout: AttestedCorpus;
  anchor: AttestedCorpus;
  rootPolicy?: DetectorPolicy;
  maxGenerations?: number;
  /** Reuse a (policy, suite) score already measured this run. Safe: the
   *  analyzer is deterministic over a fixed corpus, so a repeat measurement
   *  returns the identical number at full cost. */
  cacheEvaluations?: boolean;
}

export interface DetectorFlywheelReport {
  result: FlywheelResult;
  replayVerified: boolean;
  replaySummary: string;
  /** sha256 of the promotion rule's source: proof the gate never moved. */
  gateFingerprint: string;
  rootPolicy: DetectorPolicy;
  finalPolicy: DetectorPolicy;
  /** What each promotion actually changed, in English. Empty when the gate
   *  promoted nothing, which is a legitimate outcome and not a failure. */
  promotionNotes: string[];
  /** True only when BOTH suites are captures from a device. A run on fixtures
   *  says so here and stamps its bundle `SYNTHETIC`. */
  evidenceIsReal: boolean;
  corpus: {
    holdoutCaptures: number;
    anchorCaptures: number;
    holdoutRooms: readonly string[];
    anchorRooms: readonly string[];
  };
}

/**
 * Run the detector wheel.
 *
 * Same engine, same signer, same frozen gate as `runSonarFlywheel`. Three
 * things differ, and all three are about evidence rather than machinery:
 *
 * - the suites are attested corpora of real captures, not simulated rooms;
 * - there is no seed, because there is no synthesis — the analyzer is
 *   deterministic over a fixed corpus and the run reproduces for that reason
 *   rather than by controlling a noise generator;
 * - `dataSource` follows the corpus's provenance, so a run on fixtures cannot
 *   produce a bundle that claims to have been measured in a room.
 */
export async function runDetectorFlywheel(
  options: DetectorFlywheelOptions,
): Promise<DetectorFlywheelReport> {
  const { holdout, anchor } = options;
  // Belt and braces on top of the brand: the engine would otherwise evaluate
  // the root against an empty suite before anything else happened, and the
  // NoEvidenceError would surface from three frames deep with no mention of
  // which suite was empty.
  if (holdout.records.length === 0 || anchor.records.length === 0) {
    throw new NoEvidenceError('a suite reached the wheel with no captures');
  }

  const rootPolicy = options.rootPolicy ?? badRootDetectorPolicy();
  const evidenceIsReal = holdout.provenance === 'DEVICE' && anchor.provenance === 'DEVICE';
  const notes: string[] = [];

  // Attempts per lever, for the same reason `run.ts` keeps them: a stride-1
  // proposer re-offers a rejected rung forever. Deterministic — the counter
  // advances identically in every run of the same configuration — and replay
  // verification re-runs the GATE over sealed scores, never the proposer.
  const attempts = new Map<DetectorLever, number>();
  const result = await runFlywheelGenerations({
    rootPolicy,
    proposer: async (base, target) => {
      const lever = target as DetectorLever;
      const current = base.policy[lever] ?? '';
      const stride = (attempts.get(lever) ?? 0) + 1;
      attempts.set(lever, stride);
      const next = detectorLadderStep(lever, current, stride);
      return { value: next, summary: describeDetectorStep(lever, current, next) };
    },
    evaluator: makeDetectorEvaluator(options),
    promotionRule: DETECTOR_PROMOTION_RULE,
    holdout: { id: holdout.id, items: [...holdout.records] },
    anchor: { id: anchor.id, items: [...anchor.records] },
    mutationTargets: [...DETECTOR_LEVERS],
    maxGenerations: options.maxGenerations ?? 6,
    signer: makeSigner(),
    cacheEvaluations: options.cacheEvaluations ?? true,
    // No wall clock in the lineage: a generation is labelled by its index, so
    // two runs of the same configuration produce byte-identical receipts.
    now: (generation) => `gen-${generation}`,
    dataSource: evidenceIsReal ? 'LIVE' : 'SYNTHETIC',
  });

  for (const commit of result.promotions) {
    if (commit.mutation) notes.push(`gen${commit.generation}: ${commit.mutation.summary}`);
  }

  const verdict = verifyReplayBundle(result.replayBundle);
  return {
    result,
    replayVerified: verdict.pass,
    replaySummary: verdict.chainSummary,
    gateFingerprint: gateFingerprint(DETECTOR_PROMOTION_RULE),
    rootPolicy,
    finalPolicy: result.finalPolicy,
    promotionNotes: notes,
    evidenceIsReal,
    corpus: {
      holdoutCaptures: holdout.records.length,
      anchorCaptures: anchor.records.length,
      holdoutRooms: holdout.rooms,
      anchorRooms: anchor.rooms,
    },
  };
}
