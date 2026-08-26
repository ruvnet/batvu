// SPDX-License-Identifier: MIT
//
// Reading and writing `.presence.jsonl`, hostilely.
//
// ## Why a refusal and not a warning
//
// ADR-023 §6 makes consent structural: "a frame without a consent receipt is
// refused by the parser, in both directions, the same way `UltrasonicScan::load`
// refuses a trust-tier mismatch." That reference is load-bearing and this file
// copies its reasoning rather than its wording.
//
// `UltrasonicReplayAdapter::from_jsonl_with` validates everything before it
// produces a single event, and says why: "a stream that half-replays and then
// dies mid-way is the worst outcome for a fusion consumer: it has already
// ingested and acted on the good prefix." The same sentence with the nouns
// changed is the argument here, and it is stronger. A corpus that half-loads is
// a corpus whose unconsented records were dropped somewhere in the middle of a
// file, by a loop, without anybody deciding to drop them. The detector search
// that reads it does not know it is looking at a subset; the flywheel scores the
// subset; the holdout split is over the subset. Nothing downstream can tell that
// from a corpus that was always that size, and the one record that mattered — the
// one whose subject withdrew — is the one that left no trace of leaving.
//
// So there is no partial success. `parseCorpus` returns every record or it
// throws, and a caller holding a `PairedDwell[]` knows every dwell in it was
// consented to, clock-reconciled and inside its own bounds. That is a property
// worth having exactly once, at the boundary, rather than re-derived by every
// consumer that got a warning and had to decide what to do about it.
//
// ## Bounds before parsing
//
// Every cap in `schema.ts` is checked at the earliest point this language allows.
// The byte cap runs on the raw line before `JSON.parse` sees it, which is the one
// that matters and the one `rufield-adapters` singles out: "a cap applied after
// parsing has already allowed the allocation it was meant to prevent." The array
// caps are checked on the declared `pings`, `bins` and `iq.length` before any
// element is touched — JavaScript offers no streaming parser here and pretending
// otherwise would be theatre, so the honest statement is that `JSON.parse` has
// already allocated the array and everything after it is bounded.
//
// ## The direction of the trust check
//
// `accept` has no default. A caller declares which capture source it will take
// and gets refused in both directions — asking for `device_capture` and being
// handed simulator output is the obvious failure, and asking for `simulated` and
// being handed a real person's home is the one that matters more. Neither is a
// silent reinterpretation. There is no default because the choice is the whole
// point of the check, and a default is a choice nobody made.

import {
  CONSENT_PRIVACY_CLASS,
  CONSENT_SCOPE,
  LIDAR_FRAME_TYPE,
  MAX_CLOCK_SKEW_S,
  MAX_CONSENT_WINDOW_S,
  MAX_DEPTH_CONFIDENCE,
  MAX_DWELL_PINGS,
  MAX_DWELL_SAMPLES,
  MAX_ID_BYTES,
  MAX_LINE_BYTES,
  MAX_PRF_HZ,
  MAX_PROFILE_BINS,
  MAX_RANGE_M,
  MAX_RECORDS,
  MAX_TEACHER_SAMPLES,
  MIN_PRF_HZ,
  POSE_VALUES,
  SCHEMA_TYPE,
  sealTeacherLabel,
  type ConsentReceipt,
  type CorpusSource,
  type DwellMeasurement,
  type PairedDwell,
  type PresencePairLine,
  type ReconciledClock,
  type TeacherLabel,
} from './schema.js';

/** Why a record, and therefore its file, was refused. */
export type CorpusErrorCode =
  /** A line exceeded `MAX_LINE_BYTES`, measured before `JSON.parse`. */
  | 'line_too_long'
  /** The file exceeded `MAX_RECORDS`. */
  | 'too_many_records'
  /** The file held no records. */
  | 'empty'
  /** A line was not JSON. */
  | 'parse'
  /** A key this format has not agreed to, or a required key absent. */
  | 'unknown_field'
  /** `type`, `provenance.schema` or `teacher.frame_type` named something else. */
  | 'schema_mismatch'
  /** No consent receipt, or one missing the fields that make it one. */
  | 'consent_missing'
  /** A receipt that is present and does not authorise this capture. */
  | 'consent_invalid'
  /** The record declared a capture source the caller does not accept. */
  | 'source_mismatch'
  /** `provenance.synthetic` disagreed with `provenance.source`. */
  | 'synthetic_mismatch'
  /** The file changed device midway. One corpus is one device. */
  | 'device_mismatch'
  /** Dwells did not advance, or overlapped in time. */
  | 'non_monotonic'
  /** The two clocks could not be reconciled to within one pulse repetition
   *  interval. */
  | 'clock_skew'
  /** The teacher frame fell outside the dwell it claims to label. */
  | 'teacher_outside_dwell'
  /** A field failed a physical or structural bound. */
  | 'invalid';

/** A refusal. Carries the 1-based line it happened on, so a rejected corpus can
 *  be diagnosed while the room and the phone are still there. */
export class CorpusError extends Error {
  readonly code: CorpusErrorCode;
  /** 1-based line number, or 0 for a whole-file condition. */
  readonly line: number;

  constructor(code: CorpusErrorCode, message: string, line = 0) {
    super(line > 0 ? `batvu: line ${line}: ${message}` : `batvu: ${message}`);
    this.name = 'CorpusError';
    this.code = code;
    this.line = line;
  }
}

export interface ParseOptions {
  /** Which capture source this caller will take. Required, and refused in both
   *  directions. */
  accept: CorpusSource;
}

/** Seconds since the epoch at the start of the year 2100.
 *
 *  Copied from `@batvu/field`'s `validateLine` and for the same reason: the
 *  consumer converts seconds to a `u64` nanosecond clock, and a timestamp past
 *  this saturates the cast. Duplicated on purpose — an emitter that can only
 *  produce files its own consumer accepts is worth more than one that finds out
 *  at ingest. */
const YEAR_2100_S = 4_102_444_800;

const RECORD_KEYS = ['type', 'consent', 'provenance', 'clock', 'measurement', 'teacher'] as const;
const CONSENT_KEYS = [
  'receipt_id',
  'subject_ref',
  'scope',
  'privacy_max',
  'granted_unix_s',
  'expires_unix_s',
  'withdrawal_ref',
] as const;
const PROVENANCE_KEYS = ['schema', 'device_id', 'sequence', 'source', 'synthetic'] as const;
const CLOCK_KEYS = [
  'ultrasonic_unix_s',
  'lidar_timestamp_ns',
  'lidar_domain',
  'offset_s',
  'skew_s',
] as const;
const MEASUREMENT_KEYS = [
  'beam',
  'calibration_id',
  'prf_hz',
  'lambda_m',
  'pings',
  'bins',
  'start_range_m',
  'range_step_m',
  'iq',
  'noise_floor',
  'saturated',
] as const;
const TEACHER_KEYS = [
  'frame_type',
  'sensor',
  'sequence',
  'range_m',
  'range_confidence',
  'sample_count',
  'body_in_scene',
  'body_on_beam',
  'pose',
  'intrinsics',
] as const;
const INTRINSICS_KEYS = ['fx', 'fy', 'cx', 'cy', 'image_width', 'image_height'] as const;

/**
 * Parse a whole `.presence.jsonl` corpus.
 *
 * Returns every record or throws. See the header for why there is no third
 * outcome.
 */
export function parseCorpus(text: string, options: ParseOptions): PairedDwell[] {
  if (options.accept !== 'simulated' && options.accept !== 'device_capture') {
    throw new CorpusError('invalid', `accept ${String(options.accept)} is not a capture source`);
  }

  const encoder = new TextEncoder();
  const records: PairedDwell[] = [];
  let deviceId: string | null = null;
  let previousEndS = Number.NEGATIVE_INFINITY;

  const raw = text.split('\n');
  for (let index = 0; index < raw.length; index++) {
    const lineNo = index + 1;
    const source = raw[index]!;
    // Before `JSON.parse`, and on bytes rather than UTF-16 units, because those
    // differ by up to 3x and the cap is a memory bound.
    const bytes = encoder.encode(source).length;
    if (bytes > MAX_LINE_BYTES) {
      throw new CorpusError(
        'line_too_long',
        `${bytes} bytes; maximum is ${MAX_LINE_BYTES}`,
        lineNo,
      );
    }
    const trimmed = source.trim();
    if (trimmed.length === 0) continue;
    if (records.length >= MAX_RECORDS) {
      throw new CorpusError('too_many_records', `corpus exceeds ${MAX_RECORDS} dwells`, lineNo);
    }

    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch (error) {
      throw new CorpusError('parse', (error as Error).message, lineNo);
    }

    const line = shapeRecord(value, lineNo);
    validateLine(line, lineNo);

    // The trust check runs after the shape is known and before anything is built
    // from the record, so a refused source never becomes a `PairedDwell` that
    // somebody could have kept a reference to.
    if (line.provenance.source !== options.accept) {
      throw new CorpusError(
        'source_mismatch',
        `record declares source ${line.provenance.source} but this caller accepts ${options.accept}`,
        lineNo,
      );
    }

    const id = line.provenance.device_id.trim();
    if (deviceId === null) deviceId = id;
    else if (deviceId !== id) {
      throw new CorpusError(
        'device_mismatch',
        'record changes device_id; one corpus is one device',
        lineNo,
      );
    }

    // Dwells share one transducer, so they cannot overlap in time. Requiring the
    // next dwell to start after the previous one ENDED — rather than merely after
    // it started — is what makes that a structural check instead of a tidiness
    // one, and it is the same watermark discipline `@batvu/field`'s recorder
    // keeps for pings.
    const startS = line.clock.ultrasonic_unix_s;
    if (!(startS > previousEndS)) {
      throw new CorpusError(
        'non_monotonic',
        `dwell starts at ${startS} s, which does not follow the previous dwell ending at ${previousEndS} s`,
        lineNo,
      );
    }
    previousEndS = startS + line.measurement.pings / line.measurement.prf_hz;

    records.push(buildRecord(line));
  }

  if (records.length === 0) {
    throw new CorpusError('empty', 'corpus contained no dwells');
  }
  return records;
}

/**
 * Structural pass: shape, vocabulary, and the one absence that is its own error.
 *
 * Every key in this format is required as well as permitted, so the check is set
 * equality rather than a subset test. That is `deny_unknown_fields` and serde's
 * missing-field error in one pass, and it is what makes ADR-023 §5 structural:
 * a record that invents a `presence` field is a hard parse error here, not a key
 * a future reader quietly drops.
 */
function shapeRecord(value: unknown, line: number): PresencePairLine {
  const record = asObject(value, 'record', line);

  // Consent first, and with its own error code, because §6 is the one refusal
  // this format exists to make unmissable. A caller catching `CorpusError`
  // should be able to tell "you sent me a corrupt file" from "you sent me a
  // recording of a person who did not agree to it" without reading a string.
  const consent = record['consent'];
  if (consent === undefined || consent === null || typeof consent !== 'object') {
    throw new CorpusError('consent_missing', 'record carries no consent receipt', line);
  }
  for (const key of CONSENT_KEYS) {
    if ((consent as Record<string, unknown>)[key] === undefined) {
      throw new CorpusError(
        'consent_missing',
        `consent receipt is missing ${key}; an incomplete receipt is not a receipt`,
        line,
      );
    }
  }

  exactKeys(record, RECORD_KEYS, 'record', line);
  exactKeys(asObject(record['consent'], 'consent', line), CONSENT_KEYS, 'consent', line);
  exactKeys(
    asObject(record['provenance'], 'provenance', line),
    PROVENANCE_KEYS,
    'provenance',
    line,
  );
  exactKeys(asObject(record['clock'], 'clock', line), CLOCK_KEYS, 'clock', line);
  const measurement = asObject(record['measurement'], 'measurement', line);
  exactKeys(measurement, MEASUREMENT_KEYS, 'measurement', line);
  const teacher = asObject(record['teacher'], 'teacher', line);
  exactKeys(teacher, TEACHER_KEYS, 'teacher', line);
  exactKeys(
    asObject(teacher['intrinsics'], 'teacher.intrinsics', line),
    INTRINSICS_KEYS,
    'teacher.intrinsics',
    line,
  );

  return record as unknown as PresencePairLine;
}

/**
 * Every physical and structural bound, checked on a shaped record.
 *
 * Shared by the parser and by `encodeLine`, so an emitter cannot write a file its
 * own reader refuses.
 */
export function validateLine(line: PresencePairLine, lineNo = 0): void {
  const bad = (code: CorpusErrorCode, message: string): never => {
    throw new CorpusError(code, message, lineNo);
  };

  if (line.type !== SCHEMA_TYPE) {
    bad('schema_mismatch', `type ${String(line.type)} is not ${SCHEMA_TYPE}`);
  }

  const p = line.provenance;
  if (p.schema !== line.type) {
    bad('schema_mismatch', `provenance.schema ${String(p.schema)} does not match type ${line.type}`);
  }
  checkId(p.device_id, 'provenance.device_id', 'invalid', lineNo);
  if (!isIndex(p.sequence)) bad('invalid', `provenance.sequence ${p.sequence} is not an index`);
  if (p.source !== 'simulated' && p.source !== 'device_capture') {
    bad('invalid', `provenance.source ${String(p.source)} is not a declared origin`);
  }
  if (typeof p.synthetic !== 'boolean') {
    bad('invalid', `provenance.synthetic ${String(p.synthetic)} is not a boolean`);
  }
  // A record that disagrees with itself about this is refused rather than
  // corrected. `synthetic` is the flag every downstream trust policy keys on, and
  // silently rewriting it would be this parser deciding which half of a
  // contradiction to believe.
  if (p.synthetic !== (p.source === 'simulated')) {
    bad(
      'synthetic_mismatch',
      `provenance.synthetic ${p.synthetic} contradicts source ${p.source}`,
    );
  }

  const c = line.consent;
  checkId(c.receipt_id, 'consent.receipt_id', 'consent_invalid', lineNo);
  checkId(c.subject_ref, 'consent.subject_ref', 'consent_invalid', lineNo);
  checkId(c.withdrawal_ref, 'consent.withdrawal_ref', 'consent_invalid', lineNo);
  if (c.scope !== CONSENT_SCOPE) {
    bad(
      'consent_invalid',
      `consent scope ${String(c.scope)} does not authorise ${CONSENT_SCOPE}`,
    );
  }
  if (c.privacy_max !== CONSENT_PRIVACY_CLASS) {
    bad(
      'consent_invalid',
      `consent privacy_max ${String(c.privacy_max)} misprices this record; ADR-023 §6 prices it ${CONSENT_PRIVACY_CLASS}`,
    );
  }
  if (!isEpochS(c.granted_unix_s)) bad('consent_invalid', `consent granted_unix_s ${c.granted_unix_s}`);
  if (!isEpochS(c.expires_unix_s)) bad('consent_invalid', `consent expires_unix_s ${c.expires_unix_s}`);
  if (!(c.expires_unix_s > c.granted_unix_s)) {
    bad('consent_invalid', 'consent expires no later than it was granted');
  }
  if (c.expires_unix_s - c.granted_unix_s > MAX_CONSENT_WINDOW_S) {
    bad(
      'consent_invalid',
      `consent window is ${Math.round(c.expires_unix_s - c.granted_unix_s)} s; a receipt outliving ${MAX_CONSENT_WINDOW_S} s is a settings checkbox with a timestamp on it`,
    );
  }

  const m = line.measurement;
  checkId(m.calibration_id, 'measurement.calibration_id', 'invalid', lineNo);
  if (!Array.isArray(m.beam) || m.beam.length !== 3) {
    bad('invalid', 'measurement.beam is not a 3-vector');
  }
  let norm = 0;
  for (const component of m.beam) {
    if (!Number.isFinite(component)) bad('invalid', `beam component ${component} is not finite`);
    norm += component * component;
  }
  if (Math.sqrt(norm) < 1e-6) bad('invalid', 'beam direction has no length');

  if (!Number.isFinite(m.prf_hz) || m.prf_hz < MIN_PRF_HZ || m.prf_hz > MAX_PRF_HZ) {
    bad('invalid', `prf_hz ${m.prf_hz} outside [${MIN_PRF_HZ}, ${MAX_PRF_HZ}]`);
  }
  // A lambda above a metre is a sub-343 Hz carrier, which is not a chirp this
  // instrument emits. The bound is there to catch a metres/millimetres slip,
  // which is the mistake that actually happens and which scales every
  // displacement the corpus can ever report by a thousand, silently.
  if (!Number.isFinite(m.lambda_m) || m.lambda_m <= 0 || m.lambda_m > 1) {
    bad('invalid', `lambda_m ${m.lambda_m} is not a two-way wavelength scale in metres`);
  }
  if (!isIndex(m.pings) || m.pings < 1 || m.pings > MAX_DWELL_PINGS) {
    bad('invalid', `pings ${m.pings} outside 1..=${MAX_DWELL_PINGS}`);
  }
  if (!isIndex(m.bins) || m.bins < 1 || m.bins > MAX_PROFILE_BINS) {
    bad('invalid', `bins ${m.bins} outside 1..=${MAX_PROFILE_BINS}`);
  }
  if (m.pings * m.bins > MAX_DWELL_SAMPLES) {
    bad(
      'invalid',
      `dwell is ${m.pings}x${m.bins} = ${m.pings * m.bins} complex samples, past the ${MAX_DWELL_SAMPLES} cap`,
    );
  }
  if (!Number.isFinite(m.start_range_m) || m.start_range_m < 0) {
    bad('invalid', `start_range_m ${m.start_range_m}`);
  }
  if (!Number.isFinite(m.range_step_m) || m.range_step_m <= 0) {
    bad('invalid', `range_step_m ${m.range_step_m}`);
  }
  const endRangeM = m.start_range_m + m.range_step_m * m.bins;
  if (endRangeM > MAX_RANGE_M) {
    bad('invalid', `profile spans to ${endRangeM.toFixed(1)} m, past the ${MAX_RANGE_M} m bound`);
  }
  if (!Array.isArray(m.iq)) bad('invalid', 'measurement.iq is not an array');
  // Length checked against the declared shape before a single element is read.
  if (m.iq.length !== m.pings * m.bins * 2) {
    bad(
      'invalid',
      `iq has ${m.iq.length} values; ${m.pings}x${m.bins} interleaved needs ${m.pings * m.bins * 2}`,
    );
  }
  for (let i = 0; i < m.iq.length; i++) {
    // Refused, not zeroed. `@batvu/field` substitutes zero for a corrupt
    // magnitude bin because it is one bin of an envelope among hundreds; here the
    // phasor IS the measurement, and a zeroed phasor is a fabricated phase that
    // no later stage can tell from a real one.
    if (!Number.isFinite(m.iq[i]!)) bad('invalid', `iq[${i}] is ${m.iq[i]}`);
  }
  if (!Number.isFinite(m.noise_floor) || m.noise_floor < 0) {
    bad('invalid', `noise_floor ${m.noise_floor}`);
  }
  if (typeof m.saturated !== 'boolean') bad('invalid', 'measurement.saturated is not a boolean');

  const t = line.teacher;
  if (t.frame_type !== LIDAR_FRAME_TYPE) {
    bad('schema_mismatch', `teacher.frame_type ${String(t.frame_type)} is not ${LIDAR_FRAME_TYPE}`);
  }
  checkId(t.sensor, 'teacher.sensor', 'invalid', lineNo);
  if (!isIndex(t.sequence)) bad('invalid', `teacher.sequence ${t.sequence} is not an index`);
  if (!Number.isFinite(t.range_m) || t.range_m <= 0 || t.range_m > MAX_RANGE_M) {
    bad('invalid', `teacher.range_m ${t.range_m} out of bounds`);
  }
  // The same refusal `@batvu/field` applies to a detection outside the profile it
  // came from. A label pointing at a surface the dwell could not have heard is
  // not a label for that dwell, and a corpus of those is a corpus of pairs that
  // were never paired.
  if (t.range_m + 1e-6 < m.start_range_m || t.range_m > endRangeM + 1e-6) {
    bad(
      'invalid',
      `teacher.range_m ${t.range_m} lies outside the recorded profile [${m.start_range_m}, ${endRangeM}] m`,
    );
  }
  if (!isIndex(t.range_confidence) || t.range_confidence > MAX_DEPTH_CONFIDENCE) {
    bad('invalid', `teacher.range_confidence ${t.range_confidence} outside 0..=${MAX_DEPTH_CONFIDENCE}`);
  }
  if (!isIndex(t.sample_count) || t.sample_count < 1 || t.sample_count > MAX_TEACHER_SAMPLES) {
    bad('invalid', `teacher.sample_count ${t.sample_count} outside 1..=${MAX_TEACHER_SAMPLES}`);
  }
  if (typeof t.body_in_scene !== 'boolean') bad('invalid', 'teacher.body_in_scene is not a boolean');
  if (t.body_on_beam !== null && typeof t.body_on_beam !== 'boolean') {
    bad('invalid', 'teacher.body_on_beam is neither a boolean nor null');
  }
  if (t.body_on_beam === true && t.body_in_scene === false) {
    bad('invalid', 'teacher reports a body on the beam and no body in the scene');
  }
  if (!Array.isArray(t.pose) || t.pose.length !== POSE_VALUES) {
    bad('invalid', `teacher.pose is not ${POSE_VALUES} column-major values`);
  }
  for (let i = 0; i < t.pose.length; i++) {
    if (!Number.isFinite(t.pose[i]!)) bad('invalid', `teacher.pose[${i}] is ${t.pose[i]}`);
  }
  // Indices 3, 7, 11, 15 are the w components of the four columns, so an affine
  // camera transform has (0, 0, 0, 1) there. Checking it catches the mistake
  // this field invites — a row-major matrix written into a column-major slot,
  // which transposes the rotation and silently relocates every pose in the file.
  for (const i of [3, 7, 11]) {
    if (Math.abs(t.pose[i]!) > 1e-3) {
      bad('invalid', `teacher.pose[${i}] is ${t.pose[i]}; expected a column-major affine transform`);
    }
  }
  if (Math.abs(t.pose[15]! - 1) > 1e-3) {
    bad('invalid', `teacher.pose[15] is ${t.pose[15]}; expected a column-major affine transform`);
  }
  const k = t.intrinsics;
  if (!Number.isFinite(k.fx) || k.fx <= 0 || !Number.isFinite(k.fy) || k.fy <= 0) {
    bad('invalid', `teacher.intrinsics focal length (${k.fx}, ${k.fy})`);
  }
  if (!Number.isFinite(k.cx) || !Number.isFinite(k.cy)) {
    bad('invalid', `teacher.intrinsics principal point (${k.cx}, ${k.cy})`);
  }
  if (!isIndex(k.image_width) || k.image_width < 1 || !isIndex(k.image_height) || k.image_height < 1) {
    bad('invalid', `teacher.intrinsics image size ${k.image_width}x${k.image_height}`);
  }

  const clock = line.clock;
  if (!isEpochS(clock.ultrasonic_unix_s)) {
    bad('invalid', `clock.ultrasonic_unix_s ${clock.ultrasonic_unix_s} is not a capture time`);
  }
  // An IEEE double holds integers exactly to 2^53 - 1, which is 104 days of
  // uptime in nanoseconds. Past that the value on the wire is already not the
  // value the phone had, so it is refused rather than rounded.
  if (!isIndex(clock.lidar_timestamp_ns)) {
    bad('invalid', `clock.lidar_timestamp_ns ${clock.lidar_timestamp_ns} is not an exact nanosecond count`);
  }
  if (clock.lidar_domain !== 'arkit_uptime' && clock.lidar_domain !== 'unix_epoch') {
    bad('invalid', `clock.lidar_domain ${String(clock.lidar_domain)} is not a declared origin`);
  }
  if (!Number.isFinite(clock.offset_s)) bad('invalid', `clock.offset_s ${clock.offset_s}`);
  if (!Number.isFinite(clock.skew_s) || clock.skew_s < 0) {
    bad('invalid', `clock.skew_s ${clock.skew_s} is not a non-negative uncertainty`);
  }

  const lidarUnixS = clock.lidar_timestamp_ns / 1e9 + clock.offset_s;
  if (!isEpochS(lidarUnixS)) {
    bad(
      'invalid',
      `clock offset maps the teacher frame to ${lidarUnixS} s, which is not a capture time`,
    );
  }

  // One pulse repetition interval. Below it the label cannot be attributed to a
  // different ping than the one it was taken with; above it, it can, and a label
  // attributed to the wrong ping in a slow-time series is a label for a moment
  // the dwell measured something else. `MAX_CLOCK_SKEW_S` is the backstop at the
  // bottom of the PRF range — ADR-023 §2's "the same phone, in the same second".
  const skewBoundS = Math.min(1 / m.prf_hz, MAX_CLOCK_SKEW_S);
  if (clock.skew_s > skewBoundS) {
    bad(
      'clock_skew',
      `clock skew ${clock.skew_s} s exceeds one pulse repetition interval (${skewBoundS} s at ${m.prf_hz} Hz)`,
    );
  }

  const dwellS = m.pings / m.prf_hz;
  const startS = clock.ultrasonic_unix_s;
  const endS = startS + dwellS;
  if (lidarUnixS < startS - skewBoundS || lidarUnixS > endS + skewBoundS) {
    bad(
      'teacher_outside_dwell',
      `teacher frame at ${lidarUnixS} s lies outside the dwell [${startS}, ${endS}] s`,
    );
  }

  // Consent has to cover the WHOLE dwell. A receipt that expires halfway through
  // did not authorise the second half, and the second half is on the same line.
  if (startS < c.granted_unix_s || endS > c.expires_unix_s) {
    bad(
      'consent_invalid',
      `dwell [${startS}, ${endS}] s is not inside the consent window [${c.granted_unix_s}, ${c.expires_unix_s}] s`,
    );
  }
}

/** Build the parsed record. Runs only on a line `validateLine` has passed. */
function buildRecord(line: PresencePairLine): PairedDwell {
  const m = line.measurement;
  const data = new Float32Array(m.iq.length);
  for (let i = 0; i < m.iq.length; i++) data[i] = m.iq[i]!;

  const n = Math.hypot(m.beam[0], m.beam[1], m.beam[2]);
  const measurement: DwellMeasurement = {
    data,
    pings: m.pings,
    bins: m.bins,
    prfHz: m.prf_hz,
    lambdaM: m.lambda_m,
    startRangeM: m.start_range_m,
    rangeStepM: m.range_step_m,
    beam: [m.beam[0] / n, m.beam[1] / n, m.beam[2] / n],
    noiseFloor: m.noise_floor,
    saturated: m.saturated,
    calibrationId: m.calibration_id.trim(),
  };

  const skewBoundS = Math.min(1 / m.prf_hz, MAX_CLOCK_SKEW_S);
  const clock: ReconciledClock = {
    ultrasonicUnixS: line.clock.ultrasonic_unix_s,
    ultrasonicEndUnixS: line.clock.ultrasonic_unix_s + m.pings / m.prf_hz,
    lidarUnixS: line.clock.lidar_timestamp_ns / 1e9 + line.clock.offset_s,
    lidarDomain: line.clock.lidar_domain,
    offsetS: line.clock.offset_s,
    skewS: line.clock.skew_s,
    skewBoundS,
  };

  const consent: ConsentReceipt = {
    receiptId: line.consent.receipt_id.trim(),
    subjectRef: line.consent.subject_ref.trim(),
    scope: line.consent.scope,
    privacyMax: line.consent.privacy_max,
    grantedUnixS: line.consent.granted_unix_s,
    expiresUnixS: line.consent.expires_unix_s,
    withdrawalRef: line.consent.withdrawal_ref.trim(),
  };

  const t = line.teacher;
  const label: TeacherLabel = {
    frameType: t.frame_type,
    sensor: t.sensor.trim(),
    sequence: t.sequence,
    rangeM: t.range_m,
    rangeConfidence: t.range_confidence,
    sampleCount: t.sample_count,
    bodyInScene: t.body_in_scene,
    bodyOnBeam: t.body_on_beam,
    pose: [...t.pose],
    intrinsics: {
      fx: t.intrinsics.fx,
      fy: t.intrinsics.fy,
      cx: t.intrinsics.cx,
      cy: t.intrinsics.cy,
      imageWidth: t.intrinsics.image_width,
      imageHeight: t.intrinsics.image_height,
    },
  };

  return {
    deviceId: line.provenance.device_id.trim(),
    sequence: line.provenance.sequence,
    source: line.provenance.source,
    synthetic: line.provenance.synthetic,
    consent,
    clock,
    measurement,
    // Sealed here and nowhere else. The parser is the only place a label enters
    // this process, so it is the only place the seal has to hold.
    label: sealTeacherLabel(label),
  };
}

/** What a caller hands `encodeRecord`. camelCase in, snake_case out, as
 *  `@batvu/field`'s `EncodeOptions` does. */
export interface EncodeRecordOptions {
  deviceId: string;
  /** Dwell index within the capture session. */
  sequence: number;
  source: CorpusSource;
  consent: ConsentReceipt;
  clock: {
    ultrasonicUnixS: number;
    lidarTimestampNs: number;
    lidarDomain: 'arkit_uptime' | 'unix_epoch';
    offsetS: number;
    skewS: number;
  };
  measurement: {
    beam: readonly [number, number, number];
    calibrationId: string;
    prfHz: number;
    lambdaM: number;
    pings: number;
    bins: number;
    startRangeM: number;
    rangeStepM: number;
    /** Interleaved `(re, im)`, ping-major. */
    iq: Float32Array | Float64Array | readonly number[];
    noiseFloor: number;
    saturated: boolean;
  };
  label: TeacherLabel;
}

/**
 * Build one wire record.
 *
 * `synthetic` is derived from `source` rather than accepted from the caller, so
 * this function structurally cannot emit the contradiction `validateLine`
 * refuses. Everything else is validated on the way out — an emitter that writes
 * a file its own reader rejects has produced a recording that cannot be
 * diagnosed afterwards, because the phone is gone and the room has changed.
 */
export function encodeRecord(options: EncodeRecordOptions): PresencePairLine {
  const m = options.measurement;
  const n = Math.hypot(m.beam[0], m.beam[1], m.beam[2]);
  if (!(n > 1e-9)) throw new CorpusError('invalid', 'beam direction has no length');

  const iq = new Array<number>(m.iq.length);
  for (let i = 0; i < m.iq.length; i++) iq[i] = significant(m.iq[i]!, 7);

  const line: PresencePairLine = {
    type: SCHEMA_TYPE,
    consent: {
      receipt_id: options.consent.receiptId,
      subject_ref: options.consent.subjectRef,
      scope: options.consent.scope,
      privacy_max: options.consent.privacyMax,
      granted_unix_s: round(options.consent.grantedUnixS, 6),
      expires_unix_s: round(options.consent.expiresUnixS, 6),
      withdrawal_ref: options.consent.withdrawalRef,
    },
    provenance: {
      schema: SCHEMA_TYPE,
      device_id: options.deviceId,
      sequence: options.sequence,
      source: options.source,
      synthetic: options.source === 'simulated',
    },
    clock: {
      // Microseconds. Epoch seconds are ~1.76e9, so six decimals is already
      // sixteen significant figures — the last of them a digit an IEEE double
      // does not have. Against a bound of one pulse repetition interval (66.7 ms
      // at 15 Hz) that is four orders of headroom.
      ultrasonic_unix_s: round(options.clock.ultrasonicUnixS, 6),
      lidar_timestamp_ns: Math.round(options.clock.lidarTimestampNs),
      lidar_domain: options.clock.lidarDomain,
      offset_s: round(options.clock.offsetS, 6),
      skew_s: round(options.clock.skewS, 9),
    },
    measurement: {
      beam: [round(m.beam[0] / n, 7), round(m.beam[1] / n, 7), round(m.beam[2] / n, 7)],
      calibration_id: options.measurement.calibrationId,
      prf_hz: round(m.prfHz, 6),
      lambda_m: round(m.lambdaM, 9),
      pings: m.pings,
      bins: m.bins,
      start_range_m: round(m.startRangeM, 6),
      range_step_m: round(m.rangeStepM, 9),
      iq,
      noise_floor: round(m.noiseFloor, 9),
      saturated: Boolean(m.saturated),
    },
    teacher: {
      frame_type: options.label.frameType,
      sensor: options.label.sensor,
      sequence: options.label.sequence,
      range_m: round(options.label.rangeM, 6),
      range_confidence: options.label.rangeConfidence,
      sample_count: options.label.sampleCount,
      body_in_scene: options.label.bodyInScene,
      body_on_beam: options.label.bodyOnBeam,
      pose: options.label.pose.map((v) => round(v, 7)),
      intrinsics: {
        fx: round(options.label.intrinsics.fx, 6),
        fy: round(options.label.intrinsics.fy, 6),
        cx: round(options.label.intrinsics.cx, 6),
        cy: round(options.label.intrinsics.cy, 6),
        image_width: options.label.intrinsics.imageWidth,
        image_height: options.label.intrinsics.imageHeight,
      },
    },
  };

  validateLine(line);
  return line;
}

/** Serialise a record and check it against the byte cap its own reader enforces. */
export function encodeLine(line: PresencePairLine): string {
  validateLine(line);
  const text = JSON.stringify(line);
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_LINE_BYTES) {
    throw new CorpusError(
      'line_too_long',
      `encoded dwell is ${bytes} bytes, past the ${MAX_LINE_BYTES} cap — take fewer pings or fewer bins`,
    );
  }
  return text;
}

/** A whole corpus as `.presence.jsonl` text.
 *
 *  A trailing newline, so appending one file to another cannot glue two records
 *  onto one line. */
export function encodeCorpus(lines: readonly PresencePairLine[]): string {
  if (lines.length === 0) return '';
  return `${lines.map(encodeLine).join('\n')}\n`;
}

function asObject(value: unknown, what: string, line: number): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CorpusError('unknown_field', `${what} is not an object`, line);
  }
  return value as Record<string, unknown>;
}

/** Set equality between a record's keys and the format's vocabulary. */
function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  what: string,
  line: number,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new CorpusError('unknown_field', `${what} carries unknown field ${key}`, line);
    }
  }
  for (const key of allowed) {
    if (value[key] === undefined) {
      throw new CorpusError('unknown_field', `${what} is missing field ${key}`, line);
    }
  }
}

/** A non-negative integer an IEEE double represents exactly. */
function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isEpochS(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= YEAR_2100_S;
}

function checkId(value: unknown, what: string, code: CorpusErrorCode, line: number): void {
  if (typeof value !== 'string') {
    throw new CorpusError(code, `${what} is not a string`, line);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || new TextEncoder().encode(trimmed).length > MAX_ID_BYTES) {
    throw new CorpusError(code, `${what} must be 1..=${MAX_ID_BYTES} bytes`, line);
  }
  // Identifiers reach logs, filenames and a consent audit trail. Control
  // characters in any of those are somebody else's bug being handed a foothold,
  // and a consent receipt is the last place to be relaxed about it.
  for (let i = 0; i < trimmed.length; i++) {
    const code_ = trimmed.charCodeAt(i);
    if (code_ <= 0x1f || (code_ >= 0x7f && code_ <= 0x9f)) {
      throw new CorpusError(code, `${what} contains control characters`, line);
    }
  }
}

/** Round to a fixed number of decimals. */
function round(v: number, decimals: number): number {
  if (!Number.isFinite(v)) return v;
  const scale = 10 ** decimals;
  return Math.round(v * scale) / scale;
}

/**
 * Round to significant figures.
 *
 * Relative, not absolute, and that distinction is the whole reason this exists
 * separately from `round`. A fixed number of decimals is right for a range in
 * metres and catastrophic for a phasor: the weak bins are where a small target
 * sits, their `(re, im)` can be orders of magnitude below the wall's, and
 * rounding them to seven decimal places sets them to zero — deleting the phase
 * this file was written to preserve, in exactly the bins that mattered.
 *
 * Seven significant figures is a relative error near 1e-7, which on a phasor is
 * a phase error near 1e-7 rad. Against 0.7 rad per millimetre of radial motion
 * (`dphi = 4*pi*d/lambda` at 18 mm), that is seven orders of magnitude below the
 * quantity being measured.
 */
function significant(v: number, digits: number): number {
  if (!Number.isFinite(v)) return v;
  return Number(v.toPrecision(digits));
}
