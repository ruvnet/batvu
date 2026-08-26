// SPDX-License-Identifier: MIT
//
// The `.presence.jsonl` record: one dwell, and the LiDAR frame that labels it.
//
// ADR-023 §2 is the whole reason this file exists. RuView's iPhone app already
// streams `ruview.lidar.depth.v1` — ARKit scene depth in metres, per-pixel
// confidence, intrinsics, the 4x4 camera transform and a provenance block. Point
// that phone at a room and it is running two instruments on one chassis: a sonar
// that can hear millimetres of motion and cannot see a person, and a depth camera
// that can see a person and cannot hear breathing. The pairing is the
// contribution, and this record is the pairing written down.
//
// ## Why the name is `.presence.jsonl` and why nothing here writes `presence`
//
// The file is named for the QUESTION, not for an answer BatVu is willing to give.
// The label in each record is the LiDAR's report — `body_in_scene` — and it is
// the teacher's observation, not the sonar's claim. ADR-023 §5 is unmoved:
// BatVu populates `range_m` and `micromotion_band`, and `presence` is a fusion
// rule's output key that no code in this package ever writes. `deny_unknown_fields`
// below is what makes that structural rather than a promise: a record that invents
// a `presence` field is a hard parse error, not a field somebody ignored.
//
// ## What is on the wire and what is deliberately not
//
// **Not the depth map.** `RuViewLiDARFrame.Depth` carries `width*height` floats
// and a confidence byte each — a picture of the inside of somebody's home, at
// centimetre resolution, in a file that already contains that person breathing.
// The label needs exactly one scalar out of that map (the range along the beam
// the sonar was pointed down) plus one boolean, so that is what the record
// carries. The geometry that made those two numbers stays on the phone. This is
// the same reasoning `@batvu/field` applies when it coarsens a profile before
// egress: a consumer cannot un-discard what was never written.
//
// **Not a signature.** Same line as `@batvu/field/wire.ts`: BatVu emits the
// measurement, rufield mints the credential. Reproducing serde's byte-exact
// rendering from TypeScript is the one thing in this integration that could pass
// every test and fail on a phone.
//
// **Not an egress format.** ADR-023 §6 first bullet: the corpus never leaves the
// device underived. There is no coarse mode here, because there is no mode of
// this record that is safe to send anywhere — the complex profiles ARE the
// breathing phase. The egress-safe representation and the presence-detecting
// representation are in direct tension by construction, and that tension is the
// safety property.
//
// ## The clock, and why there are two of them
//
// ADR-023 says "one device, one clock". That is true of the chassis and false of
// the software: BatVu timestamps a ping from the browser's `Date.now()` domain
// (Unix epoch, fractional seconds) and `RuViewLiDARFrame` timestamps a frame from
// `ARFrame.timestamp`, which is a system-uptime `TimeInterval` scaled to
// nanoseconds. Those are different origins. A record therefore carries BOTH
// timestamps plus the `offset_s` that maps the LiDAR domain onto the epoch, and
// the residual uncertainty left after applying it. `corpus.ts` refuses a pair
// whose residual is worse than one pulse repetition interval, and refuses a
// teacher frame that lands outside the dwell it claims to label.

/** The record's `type`, and its `provenance.schema`. Both, and they must agree —
 *  `RuViewLiDARFrame` carries the same string in both places and this record
 *  follows it, so a stream demultiplexed on `type` and a store keyed on
 *  `provenance.schema` can never disagree about what they are holding. */
export const SCHEMA_TYPE = 'batvu.presence.pair.v1';

/** The teacher frame this record was derived from. Pinned, because the meaning
 *  of `pose`, `intrinsics` and the depth units all come from that schema — a
 *  record derived from some other depth format is not this record with a
 *  different label on it. */
export const LIDAR_FRAME_TYPE = 'ruview.lidar.depth.v1';

/** The only consent scope this parser accepts.
 *
 *  Consent granted for something else is not consent for this. A receipt minted
 *  for a range-mapping session does not authorise a recording from which chest
 *  motion can be recovered, and the scope string is where that distinction has
 *  to live, because nothing else in the record can tell the two captures apart. */
export const CONSENT_SCOPE = 'batvu.micromotion.corpus.v1';

/** The privacy class a record must declare.
 *
 *  ADR-023 §6 prices this by pointing at RuField's own rule table, where
 *  `breathing` is `privacy_max = "P4"` and `requires_consent = true`, and P4 is
 *  `rufield_core::PrivacyClass`'s "biometric or health inference". This is an
 *  equality check rather than a comparison on purpose: the class scale is a
 *  taxonomy of KIND, not a monotone ordering of restriction — P0 raw frames are
 *  held edge-local while P1 derived features egress — so "at least P4" is not a
 *  sentence that means anything. A record that declares something else has been
 *  mispriced by whatever wrote it, and a mispriced record is the one a policy
 *  downstream lets onto a network. */
export const CONSENT_PRIVACY_CLASS = 'P4';

/** Maximum dwells in one corpus file. At tens of seconds a dwell this is days of
 *  capture; past it, the file is not a session. */
export const MAX_RECORDS = 4096;

/** Maximum slow-time samples (pings) in one dwell.
 *
 *  At BatVu's 15 pings a second this is 273 seconds. ADR-023 §3 asks for "tens
 *  of seconds"; an order of magnitude past the requirement bounds memory without
 *  constraining any dwell anybody has proposed taking. */
export const MAX_DWELL_PINGS = 4096;

/** Maximum range bins in one profile.
 *
 *  A dwell stares down one bearing, so the bins that matter are the ones the
 *  link budget reaches. Both halves of that are numbers this repository already
 *  holds, and neither is a guess:
 *
 *  - the range step is `c/(2*fs)` — `PipelineConfig::range_per_sample` in
 *    `crates/batvu-dsp/src/pipeline.rs` — which at the 48 kHz ADR-003 fixes as
 *    non-negotiable is 343/(2*48000) = 3.6 mm;
 *  - the link budget was MEASURED in ADR-022 at "reliable to about 3.8 m,
 *    ragged to 4.3, nothing beyond", replacing an optimistic 4-5 m that turned
 *    out to be a simulator artefact.
 *
 *  1280 bins is 4.6 m, which is past the ragged edge — so the cap never
 *  truncates a profile the sonar could have heard, and does not pretend to
 *  reach further than ADR-022 says it does. */
export const MAX_PROFILE_BINS = 1280;

/** Maximum `pings * bins` in one dwell.
 *
 *  The product is capped as well as each factor, because the factors multiply
 *  and the line-byte cap is what has to hold. 4096 pings of 1024 bins would be
 *  4.2 M complex samples and a 90 MB line; this is 1/16th of that. A caller who
 *  wants the full dwell length takes 64 bins of it, or takes fewer pings of the
 *  full profile — which is the correct trade to be forced to make explicitly,
 *  since the interesting range bin is known before the dwell starts. */
export const MAX_DWELL_SAMPLES = 262_144;

/** Worst-case UTF-8 bytes one `(re, im)` component costs on the wire, separator
 *  included.
 *
 *  Measured off the encoder rather than estimated. `significant(v, 7)` produces
 *  at most seven significant figures, and `JSON.stringify` switches a number to
 *  exponential notation only below 1e-6 — so the widest form it can emit is a
 *  negative value just above that threshold, written in full:
 *  `-0.000001234567` is 15 characters. One comma makes 16.
 *
 *  The obvious estimate is ~11 characters, and it is wrong for exactly the
 *  numbers this format exists to carry: a faint bin's phasor components ARE
 *  small negative values near 1e-6. See `significant` in `corpus.ts`. */
const WORST_CASE_NUMBER_BYTES = 16;

/** Everything in a line that is not the phasor array, in bytes.
 *
 *  Chosen, not derived, and generous by two orders of magnitude: the whole rest
 *  of the record is six identifiers capped at `MAX_ID_BYTES` each, a 16-value
 *  pose, six intrinsics and about forty short keys, which is a few kilobytes.
 *  The point of the allowance is that {@link MAX_LINE_BYTES} stays a bound on
 *  the array and does not have to be re-derived every time a field is added. */
const METADATA_ALLOWANCE_BYTES = 65_536;

/** Maximum UTF-8 bytes in one line, checked before `JSON.parse` sees it.
 *
 *  Far larger than `@batvu/field`'s 256 KiB because the unit is different: that
 *  format writes one 256-bin magnitude profile per line, this one writes an
 *  entire dwell of complex profiles.
 *
 *  DERIVED, and written as the derivation so it cannot drift from it. A dwell at
 *  `MAX_DWELL_SAMPLES` carries twice that many numbers, each costing at most
 *  `WORST_CASE_NUMBER_BYTES`; the rest of the record fits in the allowance. So a
 *  dwell that satisfies every other cap in this file always encodes, and
 *  `encodeLine` refusing one would be a bug in one of these three numbers rather
 *  than a caller's mistake. There is a test that builds the worst case and
 *  encodes it. */
export const MAX_LINE_BYTES =
  MAX_DWELL_SAMPLES * 2 * WORST_CASE_NUMBER_BYTES + METADATA_ALLOWANCE_BYTES;

/** Maximum UTF-8 bytes in an identifier. Mirrors `@batvu/field`'s `MAX_ID_BYTES`
 *  and `rufield-adapters`' before it. */
export const MAX_ID_BYTES = 256;

/** Largest physically meaningful range, metres. Mirrors `MAX_RANGE_M`. */
export const MAX_RANGE_M = 50;

/** Bounds on the pulse repetition frequency, hertz.
 *
 *  The floor is not a physical claim, it is what makes the clock bound below
 *  finite: at 1 Hz one pulse repetition interval is one second, which is already
 *  the loosest reconciliation ADR-023 §2 describes ("the same phone, in the same
 *  second").
 *
 *  The ceiling is the chirp itself, and the arithmetic is done rather than
 *  gestured at: BatVu's sweep is `durationS = 0.005` s
 *  (`packages/batvu-core/src/config.ts`), a pulse cannot repeat faster than it
 *  lasts, so 200 Hz.
 *
 *  That is the bound a FILE can be held to, and it is far looser than the bound
 *  any real scan is under. The binding one is the second-time-around echo:
 *  `minPriSeconds()` in the same file gives `2*maxRangeM/c + durationS`, which
 *  for the shipping 6 m configuration is 35 ms — a ceiling of 28.6 Hz. A record
 *  does not carry the max range it was configured for, so nothing here can
 *  check it. BatVu ships 15. */
export const MIN_PRF_HZ = 1;
/** See `MIN_PRF_HZ`. */
export const MAX_PRF_HZ = 200;

/** Hard ceiling on the residual clock skew a pair may declare, seconds.
 *
 *  The binding bound is one pulse repetition interval (see `corpus.ts`); this is
 *  the backstop for a dwell taken at the bottom of the PRF range, and it is
 *  ADR-023 §2's own phrasing rather than a measurement: "the label comes from the
 *  same phone, in the same second". A pair that cannot be reconciled to better
 *  than a second is not the thing that section describes. */
export const MAX_CLOCK_SKEW_S = 1;

/** Longest consent window a receipt may declare, seconds.
 *
 *  A policy choice, stated as one. ADR-023 §6: consent is per-capture, "not a
 *  checkbox in an app's settings, not an assumption inherited from the room." A
 *  receipt valid for a year is that checkbox wearing a timestamp. One day is the
 *  loosest reading of "per-capture" that still expires on its own, without
 *  anybody having to remember to expire it. */
export const MAX_CONSENT_WINDOW_S = 86_400;

/** Maximum depth pixels a teacher label may claim to have averaged.
 *
 *  The record does not carry the depth map (see the header), so nothing here
 *  knows its dimensions and this cannot be checked against them. It bounds a
 *  count that would otherwise be unbounded, and no more than that. */
export const MAX_TEACHER_SAMPLES = 4_194_304;

/** Values in a column-major 4x4 pose. Exactly, not at most —
 *  `simd_float4x4.columnMajorArray` writes sixteen. */
export const POSE_VALUES = 16;

/** Highest ARKit `ARConfidenceLevel`. The Swift side ships `confidence: [UInt8]`
 *  over `{low, medium, high}` = `{0, 1, 2}`. */
export const MAX_DEPTH_CONFIDENCE = 2;

/** Where the ultrasonic samples came from. Mirrors `@batvu/field`'s
 *  `UltrasonicSource` and `rufield_adapters::UltrasonicSource` beneath it, and
 *  it is checked against what the caller declared it would accept — in BOTH
 *  directions, so a recording can neither talk its way up a trust tier by
 *  relabelling itself nor be quietly accepted as real by a caller who asked for
 *  simulation. */
export type CorpusSource = 'simulated' | 'device_capture';

// ---------------------------------------------------------------------------
// The wire record. Every key below is the whole permitted vocabulary: `corpus.ts`
// rejects an unknown one the way serde's `deny_unknown_fields` does, so a field
// this format has not agreed to is a parse error rather than something a future
// reader silently drops.
// ---------------------------------------------------------------------------

/** The consent receipt. ADR-023 §6, third bullet, and the reason `corpus.ts`
 *  refuses a whole file over one missing block. */
export interface ConsentReceiptLine {
  /** Identifier for this grant, unique per capture. */
  receipt_id: string;
  /** Opaque handle for the person who granted it.
   *
   *  TODO(ADR-023): nothing in this parser can tell an opaque handle from a
   *  name, and it will not pretend to — a check that rejects strings that "look
   *  like names" would refuse honest handles and pass `subject_ref: "flat 4"`.
   *  The device mints the handle and the device is what has to be audited. */
  subject_ref: string;
  /** Must equal `CONSENT_SCOPE`. */
  scope: string;
  /** Must equal `CONSENT_PRIVACY_CLASS`. */
  privacy_max: string;
  /** Start of validity, seconds since the Unix epoch. */
  granted_unix_s: number;
  /** End of validity, seconds since the Unix epoch. The WHOLE dwell must fall
   *  inside `[granted, expires]` — a receipt that expires mid-dwell did not
   *  cover the second half of it. */
  expires_unix_s: number;
  /** How the subject withdraws this grant. A receipt that cannot be acted on is
   *  a record of a conversation, not consent, so this is required and non-empty
   *  rather than an optional convenience. */
  withdrawal_ref: string;
}

/** Reconciling the two clocks. See the header. */
export interface CorpusClockLine {
  /** Dwell start, SECONDS since the Unix epoch, fractional. BatVu's domain. */
  ultrasonic_unix_s: number;
  /** `RuViewLiDARFrame.Provenance.timestampNs`, verbatim and unconverted. */
  lidar_timestamp_ns: number;
  /** Which origin `lidar_timestamp_ns` is measured from.
   *
   *  One value, and the singleton is deliberate. `arkit_uptime` is what the
   *  shipping Swift produces (`ARFrame.timestamp` is system uptime). A
   *  `unix_epoch` variant was here and has been removed, because this format
   *  cannot carry an honest one: epoch nanoseconds are ~1.76e18 and
   *  `lidar_timestamp_ns` is required to be an exact integer, which stops at
   *  9.01e15. So every record declaring it was refused, and every record that
   *  was ACCEPTED while declaring it was carrying uptime nanoseconds under the
   *  wrong label — a field that could only ever be wrong.
   *
   *  It stays an enum of one rather than disappearing so that the day a capture
   *  path arrives with a different origin, the record has somewhere to say so
   *  and old readers reject it instead of misreading it.
   *  TODO(ADR-023): a second origin needs a representation for its timestamp
   *  first — seconds with a fractional part, the way `ultrasonic_unix_s` does
   *  it. */
  lidar_domain: 'arkit_uptime';
  /** Seconds to ADD to `lidar_timestamp_ns / 1e9` to land on the Unix epoch.
   *
   *  Seconds, not nanoseconds, and that is not a taste decision: epoch
   *  nanoseconds are ~1.76e18, well past the 9.01e15 an IEEE double represents
   *  exactly, so a JSON integer of epoch nanoseconds is silently wrong by
   *  hundreds of nanoseconds before anything has read it.
   *
   *  TODO(ADR-023): this format carries the offset the device measured and has
   *  no way to check it. Verifying it needs a common event visible to both
   *  clocks, which needs hardware. */
  offset_s: number;
  /** Residual uncertainty in that mapping, seconds, non-negative.
   *
   *  NOT the difference between the two timestamps — that is derivable and is
   *  checked separately. This is what is left over after `offset_s` has been
   *  applied: how well the device believes it knows the correspondence. */
  skew_s: number;
}

/** Provenance. Mirrors `RuViewLiDARFrame.Provenance`'s job on the other side of
 *  the pairing. */
export interface CorpusProvenanceLine {
  /** Must equal the record's `type`. */
  schema: string;
  /** Stable sensor identity for the whole file. One corpus is one device: the
   *  calibration, the clock offset and the consent receipt are all properties of
   *  a device in a room, and a file that changes device midway has none of them. */
  device_id: string;
  /** Dwell index within the capture session. */
  sequence: number;
  source: CorpusSource;
  /** Must agree with `source`. Carried anyway, rather than derived at read time,
   *  because it is the flag every downstream trust policy actually keys on and a
   *  record that disagrees with itself about it is one this parser wants to see
   *  and refuse — not one it wants to quietly correct. */
  synthetic: boolean;
}

/** The MEASUREMENT: what the sonar recorded. The student. */
export interface DwellMeasurementLine {
  /** Beam direction in the scan's local ENU frame, unit length. One dwell is one
   *  bearing — ADR-023 §3, these are mutually exclusive modes and a dwell that
   *  swept is not a dwell. */
  beam: [number, number, number];
  /** The calibration receipt every profile in this dwell was measured under. */
  calibration_id: string;
  /** Slow-time sample rate, hertz. */
  prf_hz: number;
  /** Two-way wavelength scale, metres — `c / f` at the centre of the chirp.
   *
   *  On the wire, with no default, for the same reason `@batvu/micromotion`
   *  refuses to default it: picking one would be inventing a centre frequency,
   *  and `d = dphi * lambda / (4 * pi)` turns that invention into every
   *  displacement the corpus reports. */
  lambda_m: number;
  /** Slow-time samples. */
  pings: number;
  /** Range bins per profile. */
  bins: number;
  /** Range of bin 0, metres. */
  start_range_m: number;
  /** Metres per range bin. */
  range_step_m: number;
  /** Interleaved `(re, im)`, ping-major: bin `b` of ping `p` at
   *  `p * bins * 2 + b * 2`. Length is exactly `pings * bins * 2`.
   *
   *  This layout is `@batvu/micromotion`'s `ComplexProfileDwell.data`, field for
   *  field, so a parsed record drops into `analyzeDwell` without a copy. The
   *  packages do not depend on each other — see `index.ts`. */
  iq: number[];
  /** Receiver noise floor in the same amplitude units as `iq`, non-negative. */
  noise_floor: number;
  /** Whether any ping in the dwell clipped. */
  saturated: boolean;
}

/** The LABEL: what the depth camera reported. The teacher.
 *
 *  Everything in here is measured by a different physical principle than the
 *  block above, on the same chassis, at the same moment. That is the entire
 *  claim of ADR-023 §2 and it is also why this block is SEALED once parsed —
 *  see `SealedTeacherLabel`. */
export interface TeacherLabelLine {
  /** Must equal `LIDAR_FRAME_TYPE`. */
  frame_type: string;
  /** `RuViewLiDARFrame.Provenance.sensor`, e.g. `apple-arkit-scene-depth`. */
  sensor: string;
  /** `RuViewLiDARFrame.Provenance.sequence`. */
  sequence: number;
  /** Range to the nearest surface along `beam`, metres, from the depth map.
   *
   *  Must lie inside the profile window the measurement recorded. A label
   *  pointing at a surface the dwell could not have heard is not a label for
   *  that dwell — the same refusal `@batvu/field` applies to a detection outside
   *  its own profile. */
  range_m: number;
  /** Lowest ARKit confidence over the depth pixels that produced `range_m`,
   *  0..=`MAX_DEPTH_CONFIDENCE`. The minimum rather than the mean, because a
   *  footprint straddling a depth discontinuity is exactly the case where an
   *  averaged confidence looks fine and the range is meaningless. */
  range_confidence: number;
  /** Depth pixels in the beam footprint that produced `range_m`. */
  sample_count: number;
  /** Whether ARKit reported a body anchor anywhere in the scene. THE LABEL. */
  body_in_scene: boolean;
  /** Whether a reported body anchor projected onto this beam, or `null` when the
   *  capture did not determine it.
   *
   *  Nullable on purpose. ADR-023's own "what this does not answer" opens with
   *  whether ARKit body anchors are available and accurate enough to say "a
   *  person is in this scene AT THIS BEARING" without a human in the loop —
   *  assumed, not verified. A format that made this a bare boolean would be
   *  forcing every capture to answer a question the ADR says is open, and the
   *  answer it would get is `false`.
   *  TODO(ADR-023): whether this can ever be populated honestly is a hardware
   *  question. */
  body_on_beam: boolean | null;
  /** `RuViewLiDARFrame.Pose.matrix` — the 4x4 camera transform, column-major,
   *  exactly as `simd_float4x4.columnMajorArray` writes it. */
  pose: number[];
  /** `RuViewLiDARFrame.Intrinsics`, minus the depth map they address. */
  intrinsics: {
    fx: number;
    fy: number;
    cx: number;
    cy: number;
    image_width: number;
    image_height: number;
  };
}

/** One `.presence.jsonl` line: one dwell, paired. */
export interface PresencePairLine {
  /** Must equal `SCHEMA_TYPE`. */
  type: string;
  consent: ConsentReceiptLine;
  provenance: CorpusProvenanceLine;
  clock: CorpusClockLine;
  measurement: DwellMeasurementLine;
  teacher: TeacherLabelLine;
}

// ---------------------------------------------------------------------------
// The parsed record, and the seal between measurement and label.
// ---------------------------------------------------------------------------

/** The measurement, parsed.
 *
 *  Field for field assignable to `@batvu/micromotion`'s `ComplexProfileDwell`,
 *  which is the point: `analyzeDwell(record.measurement)` is the intended call
 *  and there is nothing to adapt. */
export interface DwellMeasurement {
  /** Interleaved `(re, im)`, ping-major. */
  data: Float32Array;
  pings: number;
  bins: number;
  prfHz: number;
  lambdaM: number;
  startRangeM: number;
  rangeStepM: number;
  beam: readonly [number, number, number];
  noiseFloor: number;
  saturated: boolean;
  calibrationId: string;
}

/** The teacher's report, once opened. */
export interface TeacherLabel {
  frameType: string;
  sensor: string;
  sequence: number;
  rangeM: number;
  rangeConfidence: number;
  sampleCount: number;
  bodyInScene: boolean;
  bodyOnBeam: boolean | null;
  /** Column-major 4x4. */
  pose: readonly number[];
  intrinsics: {
    fx: number;
    fy: number;
    cx: number;
    cy: number;
    imageWidth: number;
    imageHeight: number;
  };
}

declare const teacherSealBrand: unique symbol;

/**
 * A teacher label that has to be asked for by name.
 *
 * This type has no readable members. `record.label.rangeM` is a compile error,
 * `openTeacherLabel(record.label).rangeM` is not, and that difference is the
 * whole mechanism: the one way into the label is a call that says what it is
 * doing and shows up in a diff and a grep.
 *
 * The reason is narrow and it is the failure this corpus exists to avoid. The
 * measurement and the label live in one object because they describe one moment;
 * a detector search reads that object thousands of times; and the LiDAR range is
 * a number in metres sitting a few characters away from the sonar's own range
 * axis. Leak it into a feature and the detector scores perfectly against a
 * corpus it is reading the answers out of, the flywheel promotes it — ADR-014's
 * gate cannot see the difference, it checks lift on a holdout and the holdout
 * has the answers in it too — and what ships is a model that reports a person
 * whenever the LiDAR would have. That is ADR-022's defect (a measurement error
 * propagated into every published number) at its worst available severity, and
 * ADR-023 §2 names it directly.
 *
 * The seal is enforced at RUNTIME as well as in the type system, because a brand
 * is erased at build time and the paths that would leak a label are exactly the
 * ones that lose their types: a `JSON.stringify` of the record, a spread into a
 * feature bag, a logging helper typed `any`. The payload lives in a module-scope
 * `WeakMap` keyed on the handle, so all of those see an object with nothing in
 * it. `undefined` reaching a detector is a bug that fails loudly on the first
 * run; a correct-looking float reaching a detector is a bug that ships.
 */
export interface SealedTeacherLabel {
  readonly [teacherSealBrand]: 'batvu.presence.teacher.v1';
}

/** The handle's one runtime property. Names what it is for a human reading a
 *  console dump; carries nothing. */
const SEAL_TAG = 'batvu.presence.teacher.v1';

const sealedLabels = new WeakMap<SealedTeacherLabel, TeacherLabel>();

/** Put a label behind the seal. Called by the parser; exported so a synthetic
 *  fixture can be built the same way a parsed record is, rather than through a
 *  cast that would prove nothing. */
export function sealTeacherLabel(label: TeacherLabel): SealedTeacherLabel {
  const handle = Object.freeze({ sealed: SEAL_TAG }) as unknown as SealedTeacherLabel;
  sealedLabels.set(
    handle,
    Object.freeze({
      ...label,
      pose: Object.freeze([...label.pose]),
      intrinsics: Object.freeze({ ...label.intrinsics }),
    }),
  );
  return handle;
}

/**
 * Read a sealed teacher label.
 *
 * Throws on anything that is not a handle this module minted, so a plausible
 * object shaped like a seal — one reconstructed from JSON, say — cannot stand in
 * for the real thing.
 */
export function openTeacherLabel(sealed: SealedTeacherLabel): TeacherLabel {
  const label = sealedLabels.get(sealed);
  if (label === undefined) {
    throw new Error('batvu: not a sealed teacher label minted by @batvu/capture');
  }
  return label;
}

/** The two clocks, reconciled. */
export interface ReconciledClock {
  /** Dwell start on the Unix epoch, seconds. */
  ultrasonicUnixS: number;
  /** Dwell end on the Unix epoch, seconds: `start + pings / prf`. */
  ultrasonicEndUnixS: number;
  /** The teacher's timestamp, mapped onto the Unix epoch. */
  lidarUnixS: number;
  lidarDomain: 'arkit_uptime';
  offsetS: number;
  /** The residual the record declared. */
  skewS: number;
  /** The bound it was checked against: one pulse repetition interval, capped at
   *  `MAX_CLOCK_SKEW_S`. */
  skewBoundS: number;
}

/** The consent receipt, parsed. Readable, unlike the label — it is a permission,
 *  not an answer, and code that has to honour it has to be able to read it. */
export interface ConsentReceipt {
  receiptId: string;
  subjectRef: string;
  scope: string;
  privacyMax: string;
  grantedUnixS: number;
  expiresUnixS: number;
  withdrawalRef: string;
}

/** One parsed record: a dwell, its label, and the terms it was taken under. */
export interface PairedDwell {
  deviceId: string;
  sequence: number;
  source: CorpusSource;
  synthetic: boolean;
  consent: ConsentReceipt;
  clock: ReconciledClock;
  /** The student. Feed this to a detector. */
  measurement: DwellMeasurement;
  /** The teacher. `openTeacherLabel` it, in an evaluator, never in a detector. */
  label: SealedTeacherLabel;
}
