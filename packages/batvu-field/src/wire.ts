// SPDX-License-Identifier: MIT
//
// The `.ultrasonic.jsonl` line: BatVu's half of a contract whose other half is
// written in Rust.
//
// `rufield-adapters::ultrasonic::UltrasonicReplayAdapter` parses these lines
// into signed RuField `FieldEvent`s. That parser is deliberately hostile — it
// caps line length before `serde_json` sees the bytes, bounds every array,
// rejects every non-finite and negative value, requires strictly increasing
// timestamps, refuses a detection that lies outside the profile it came from,
// and (crucially) uses `deny_unknown_fields`, so a key this file invents is a
// hard parse error rather than a silently ignored one.
//
// The bounds below are that parser's bounds, restated. They are duplicated on
// purpose and the duplication is the point: an emitter that can only produce
// files its own consumer accepts is worth more than one that discovers the
// contract at ingest time, on someone else's machine, halfway through a
// recording. `__tests__/wire.test.ts` pins them, and the fixture in
// `artifacts/field/` is parsed by the Rust adapter's own test suite, so a
// divergence fails a build rather than a deployment.
//
// ## What is deliberately NOT here
//
// **A signature.** The event is signed on the Rust side, over
// `serde_json::to_vec` of the whole `FieldEvent` with the signature fields
// cleared. That message is defined by serde's declaration-order field emission,
// its omission of `skip_serializing_if` options, `BTreeMap` key ordering, and
// serde_json's shortest-round-trip float formatting. Reproducing those bytes
// from TypeScript is possible and it is the single most brittle thing this
// integration could contain: a float that JavaScript prints as `0.1` and Rust
// prints as `0.1` agree, right up until one of them does not, and the failure
// mode is a signature that verifies in CI and fails in the field. So BatVu
// emits the measurement and rufield mints the credential.
//
// **A `source` the caller can choose freely.** It is on the wire because the
// adapter cross-checks it against what the deployment is configured to accept,
// so a recording can never talk its way into a higher trust tier. Simulator
// output is `simulated`, full stop — that is what makes `provenance.synthetic`
// true downstream, and what keeps it out of a production trust policy.

import type { Detection, PingResult, Vec3 } from '@batvu/core';

/** Where the samples came from. Mirrors `rufield_adapters::UltrasonicSource`. */
export type UltrasonicSource = 'simulated' | 'device_capture';

/** Maximum UTF-8 bytes in one line. Mirrors `MAX_LINE_BYTES`. */
export const MAX_LINE_BYTES = 262_144;

/** Maximum range bins in one profile. Mirrors `MAX_PROFILE_BINS`. */
export const MAX_PROFILE_BINS = 4096;

/** Maximum detections per ping. Mirrors `MAX_DETECTIONS`. */
export const MAX_DETECTIONS = 64;

/** Maximum pings in one recording. Mirrors `MAX_PINGS`. */
export const MAX_PINGS = 100_000;

/** Maximum UTF-8 bytes in an identifier. Mirrors `MAX_ID_BYTES`. */
export const MAX_ID_BYTES = 256;

/** Largest physically meaningful range, metres. Mirrors `MAX_RANGE_M`. */
export const MAX_RANGE_M = 50;

/** Profile bins written by default.
 *
 *  256 bins across the usable span is ~1.5 cm each — finer than the 9.6 cm the
 *  waveform actually resolves, so the reduction from a multi-thousand-sample
 *  envelope costs nothing measurable while keeping a line comfortably inside
 *  the byte cap. Writing the whole envelope instead would put ~8000 numbers on
 *  every line for no additional information. */
export const DEFAULT_PROFILE_BINS = 256;

/** One recorded ping, exactly as it appears on the wire.
 *
 *  Every key here is a field of the Rust `PingRecord`, and the Rust struct
 *  denies unknown fields — this type is the whole permitted vocabulary. */
export interface UltrasonicLine {
  /** Capture time, SECONDS since the Unix epoch, fractional. */
  timestamp: number;
  source: UltrasonicSource;
  device_id: string;
  /** Beam direction in the scan's local ENU frame. Need not be unit length on
   *  the wire; the parser normalizes and rejects a zero vector. */
  beam: [number, number, number];
  start_range_m: number;
  range_step_m: number;
  /** Compressed echo amplitude per range bin, non-negative. */
  profile: number[];
  detections: Array<{ range_m: number; snr_db: number; width_m: number }>;
  noise_floor: number;
  blast_amplitude: number;
  saturated: boolean;
}

export interface EncodeOptions {
  /** Stable sensor identity. This is the key the trust registry binds to and
   *  the key the replay watermark is stored under, so it must be stable across
   *  scans — a fresh id per scan means a fresh enrolment per scan. */
  deviceId: string;
  /** Where the samples came from. */
  source: UltrasonicSource;
  /** Capture time in seconds since the epoch. */
  timestamp: number;
  /** Beam direction in the scan's local frame. */
  beam: Vec3;
  /** Bins to write. Default `DEFAULT_PROFILE_BINS`. */
  profileBins?: number;
  /** Near edge of the written profile, metres. Default 0.3 — inside the blind
   *  disc, because the blast's skirt is diagnostic even where the ranges are
   *  not trustworthy. */
  minRangeM?: number;
  /** Far edge of the written profile, metres. Default 5. */
  maxRangeM?: number;
}

/**
 * Turn one processed ping into a wire line.
 *
 * The envelope is max-pooled, never averaged. A mean smears a sharp echo across
 * its neighbours and a wall stops looking like a wall; a maximum keeps every
 * peak the detector found and discards only the shape between them.
 *
 * Throws rather than emitting anything the Rust parser would reject. An emitter
 * that writes a file its own consumer refuses has produced a recording that
 * cannot be diagnosed after the fact — the phone is gone, the room has changed,
 * and all that is left is a parse error on a line number.
 */
export function encodePing(
  result: PingResult,
  envelope: Float32Array,
  options: EncodeOptions,
): UltrasonicLine {
  const bins = Math.max(1, Math.floor(options.profileBins ?? DEFAULT_PROFILE_BINS));
  if (bins > MAX_PROFILE_BINS) {
    throw new Error(`batvu: profileBins ${bins} exceeds the ${MAX_PROFILE_BINS} wire cap`);
  }
  const minRange = options.minRangeM ?? 0.3;
  const maxRange = options.maxRangeM ?? 5;
  if (!(maxRange > minRange)) {
    throw new Error(`batvu: profile window [${minRange}, ${maxRange}] is empty`);
  }
  if (!(minRange >= 0) || !(maxRange <= MAX_RANGE_M)) {
    throw new Error(`batvu: profile window must lie inside [0, ${MAX_RANGE_M}] m`);
  }
  if (!Number.isFinite(options.timestamp) || options.timestamp < 0) {
    throw new Error(`batvu: timestamp ${options.timestamp} is not a capture time`);
  }
  const deviceId = checkId(options.deviceId, 'deviceId');

  const step = (maxRange - minRange) / bins;
  const profile = new Array<number>(bins).fill(0);

  // Walk the envelope once and drop each bin into the output cell its range
  // lands in. Walking the OUTPUT and searching the envelope would be the
  // obvious loop and it silently skips input bins when the output is coarser,
  // which is exactly when the peak matters most.
  for (let i = 0; i < envelope.length; i++) {
    const range = result.startRangeM + i * result.rangeStepM;
    if (range < minRange || range >= maxRange) continue;
    const value = envelope[i]!;
    // The envelope is a magnitude, so a non-finite or negative value is
    // corruption rather than a quiet echo. Zero is the only safe substitute,
    // and `sanitized` on the result already records that it happened.
    if (!Number.isFinite(value) || value < 0) continue;
    const bin = Math.min(bins - 1, Math.floor((range - minRange) / step));
    if (value > profile[bin]!) profile[bin] = value;
  }

  const detections = result.detections
    .filter((d) => usable(d, minRange, maxRange))
    .slice(0, MAX_DETECTIONS)
    .map((d) => ({
      range_m: round(d.rangeM, 6),
      snr_db: round(d.snrDb, 4),
      width_m: round(Math.max(0, d.widthM), 6),
    }))
    .sort((a, b) => a.range_m - b.range_m);

  const beam = unit(options.beam);

  return {
    timestamp: options.timestamp,
    source: options.source,
    device_id: deviceId,
    beam,
    start_range_m: round(minRange, 6),
    range_step_m: round(step, 9),
    profile: profile.map((v) => round(v, 7)),
    detections,
    noise_floor: round(nonNegative(result.noiseFloor), 9),
    blast_amplitude: round(nonNegative(result.blastAmplitude), 7),
    saturated: Boolean(result.saturated),
  };
}

/**
 * Serialise a line and check it against every bound the Rust parser enforces.
 *
 * The byte-length check is the one that has to happen here rather than there:
 * on the far side it is a defence against a hostile file, but on this side it
 * is the difference between finding out now and finding out at ingest.
 */
export function encodeLine(line: UltrasonicLine): string {
  validateLine(line);
  const text = JSON.stringify(line);
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_LINE_BYTES) {
    throw new Error(
      `batvu: encoded ping is ${bytes} bytes, past the ${MAX_LINE_BYTES} wire cap — reduce profileBins`,
    );
  }
  return text;
}

/** Every invariant the Rust `build_ping` enforces, checked before writing. */
export function validateLine(line: UltrasonicLine): void {
  const bad = (message: string): never => {
    throw new Error(`batvu: ${message}`);
  };

  if (!Number.isFinite(line.timestamp) || line.timestamp < 0) {
    bad(`timestamp ${line.timestamp} is not a capture time`);
  }
  // The Rust side converts seconds to a u64 nanosecond clock. Year 2100 is the
  // documented ceiling; past it a `as u64` cast would saturate and one poisoned
  // event would permanently block every honest one from that device, because
  // the replay watermark only ever advances.
  if (line.timestamp > 4_102_444_800) {
    bad(`timestamp ${line.timestamp} is past the year-2100 clock bound`);
  }
  if (line.source !== 'simulated' && line.source !== 'device_capture') {
    bad(`source ${String(line.source)} is not a declared origin`);
  }
  checkId(line.device_id, 'device_id');

  if (line.profile.length === 0 || line.profile.length > MAX_PROFILE_BINS) {
    bad(`profile has ${line.profile.length} bins (expected 1..=${MAX_PROFILE_BINS})`);
  }
  for (let i = 0; i < line.profile.length; i++) {
    const v = line.profile[i]!;
    if (!Number.isFinite(v) || v < 0) bad(`profile bin ${i} is ${v}`);
  }
  if (line.detections.length > MAX_DETECTIONS) {
    bad(`${line.detections.length} detections (maximum ${MAX_DETECTIONS})`);
  }

  if (!Number.isFinite(line.range_step_m) || line.range_step_m <= 0) {
    bad(`range_step_m ${line.range_step_m} must be finite and positive`);
  }
  if (!Number.isFinite(line.start_range_m) || line.start_range_m < 0) {
    bad(`start_range_m ${line.start_range_m} must be finite and non-negative`);
  }
  const end = line.start_range_m + line.range_step_m * line.profile.length;
  if (end > MAX_RANGE_M) {
    bad(`profile spans to ${end.toFixed(1)} m, past the ${MAX_RANGE_M} m physical bound`);
  }

  let norm = 0;
  for (const component of line.beam) {
    if (!Number.isFinite(component)) bad(`beam component ${component} is not finite`);
    norm += component * component;
  }
  if (Math.sqrt(norm) < 1e-6) bad('beam direction has no length');

  if (!Number.isFinite(line.noise_floor) || line.noise_floor < 0) {
    bad(`noise_floor ${line.noise_floor}`);
  }
  if (!Number.isFinite(line.blast_amplitude) || line.blast_amplitude < 0) {
    bad(`blast_amplitude ${line.blast_amplitude}`);
  }

  for (let i = 0; i < line.detections.length; i++) {
    const d = line.detections[i]!;
    if (!Number.isFinite(d.range_m) || d.range_m < 0 || d.range_m > MAX_RANGE_M) {
      bad(`detection ${i} range ${d.range_m} out of bounds`);
    }
    // A detection outside the profile it was found in is an inconsistent
    // record, and accepting it would put an echo into a fused map that no
    // measurement in the file supports.
    if (d.range_m + 1e-6 < line.start_range_m || d.range_m > end + 1e-6) {
      bad(
        `detection ${i} at ${d.range_m} m lies outside the profile [${line.start_range_m}, ${end}] m`,
      );
    }
    if (!Number.isFinite(d.snr_db) || !Number.isFinite(d.width_m) || d.width_m < 0) {
      bad(`detection ${i} has a bad snr or width`);
    }
  }
}

function usable(d: Detection, minRange: number, maxRange: number): boolean {
  return (
    Number.isFinite(d.rangeM) &&
    Number.isFinite(d.snrDb) &&
    d.rangeM >= minRange &&
    d.rangeM <= maxRange
  );
}

function unit(v: Vec3): [number, number, number] {
  const n = Math.hypot(v.x, v.y, v.z);
  if (!(n > 1e-9)) throw new Error('batvu: beam direction has no length');
  return [round(v.x / n, 7), round(v.y / n, 7), round(v.z / n, 7)];
}

function nonNegative(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Round to a fixed number of decimals.
 *
 * Not cosmetic. A `Float32Array` value printed at full `double` precision
 * spends seventeen characters saying something a float never knew, and a
 * recording is thousands of those per second. Seven decimals is far below the
 * noise floor of any of these quantities and roughly halves the file.
 */
function round(v: number, decimals: number): number {
  if (!Number.isFinite(v)) return 0;
  const scale = 10 ** decimals;
  return Math.round(v * scale) / scale;
}

function checkId(value: string, what: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || new TextEncoder().encode(trimmed).length > MAX_ID_BYTES) {
    throw new Error(`batvu: ${what} must be 1..=${MAX_ID_BYTES} bytes`);
  }
  // Identifiers reach logs, filenames, a viewer UI and a trust registry's map
  // keys. Control characters in any of those are somebody else's bug being
  // handed a foothold.
  if (hasControlCharacter(trimmed)) {
    throw new Error(`batvu: ${what} contains control characters`);
  }
  return trimmed;
}

/** True if any code unit is a C0 or C1 control character.
 *
 *  Written as a loop rather than a regex literal so the source file itself
 *  contains no control characters — a regex spelled with the raw bytes is
 *  invisible in a diff and survives a copy-paste as something else entirely. */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}
