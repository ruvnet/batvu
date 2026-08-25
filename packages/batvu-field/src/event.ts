// SPDX-License-Identifier: MIT
//
// A `FieldEvent` built in TypeScript, and the producer surface that serves it.
//
// ## Why this exists when `wire.ts` already exists
//
// `.ultrasonic.jsonl` is the ingest path: BatVu writes measurements, rufield
// reads them, signs them, and hands them to a fusion engine. That is the path
// that matters and it is the one that is tested end to end.
//
// This is the *other* direction, and it exists because of what a survey of the
// transport surfaces found: **RuView has no `FieldEvent` ingestion endpoint.**
// `/api/field` and `/ws/field` are both GET — RuView is a producer of field
// events, never a consumer, and `rufield-viewer` is a reader that PULLS from an
// upstream. There is nothing to POST to, in either repository, and building a
// client for one would mean writing the server first.
//
// So the integration inverts. `rufield-viewer --source live --upstream <host>`
// is a working, shipped consumer today; what it wants is a `GET /api/field`
// returning `{ "events": [...] }`. BatVu can be that upstream, which plugs into
// an existing tested reader without new server code in either project.
//
// ## Unsigned, and saying so
//
// These events carry no signature. `canonical_event_bytes` is
// `serde_json::to_vec` of a Rust struct — declaration-order fields, omitted
// `skip_serializing_if` options, `BTreeMap` ordering, serde_json's float
// formatting — and reproducing those bytes from JavaScript is the most brittle
// thing this integration could contain. An unsigned event is honest about what
// it is. A signed one that verifies in CI and fails in the field is not.
//
// The consequence is stated rather than worked around: an unsigned event is
// fusable only under `TrustPolicy::simulation()`, where `is_fusable` accepts
// anything marked `synthetic`. That is the correct home for simulator output
// and the wrong home for anything else, which is why the ingest path — the one
// rufield signs — is the path a real deployment uses.

import type { UltrasonicLine } from './wire.js';

/** The RuField MFS wire spec version these events declare. */
export const SPEC_VERSION = 'rufield.mfs.v0.1';

/** Bins in the network-safe coarse tensor. Matches the Rust adapter's
 *  `COARSE_BINS`, so the two sides describe a room at the same resolution. */
export const COARSE_BINS = 32;

/** Events retained by `FieldSurface`. Matches RuView's own ring size — a
 *  reader polling every 500 ms at 15 pings/s needs ~8, and 64 covers a reader
 *  that stalls for four seconds without letting a slow consumer backpressure
 *  the sonar loop. */
export const RING_CAPACITY = 64;

export interface FieldEventOptions {
  /** Zone the scan was taken in. */
  zoneId?: string;
  /** Physical placement hint. Default `handheld`. */
  placement?: string;
  /** Calibration receipt id, if one has been established. */
  calibrationId?: string;
  /** Sequence number, to keep `event_id` unique within a device. */
  sequence: number;
}

/**
 * Project one recorded ping into a complete RuField `FieldEvent`.
 *
 * The shape is `rufield_core::FieldEvent` exactly: field order is Rust's
 * declaration order, `Option` fields with `skip_serializing_if` are absent when
 * unset while the unmarked ones are present-and-null, and `features` is always
 * present. That is not cosmetic — `FieldEvent::validate_evidence_at` cross-
 * checks `tensor.timestamp_ns` against `timestamp_ns` and `sensor.modality`
 * against `tensor.modality`, and a consumer deserialising into the Rust struct
 * rejects a missing required field outright.
 */
export function toFieldEvent(
  line: UltrasonicLine,
  options: FieldEventOptions,
): Record<string, unknown> {
  const timestampNs = Math.round(line.timestamp * 1e9);
  const nearest = line.detections[0];
  const peakSnr = line.detections.reduce((acc, d) => Math.max(acc, d.snr_db), Number.NEGATIVE_INFINITY);
  const confidence = line.detections.length === 0 ? 0.5 : clamp01(peakSnr / 20);

  // The coarse tensor, not the recorded profile. The full per-bin profile is a
  // sensor frame and RuField classifies the analogous per-subcarrier CSI frame
  // P0, which the stock privacy policy denies to a network. This surface is a
  // network surface, so it serves the P1 reduction and nothing else — the
  // decision is expressed in what is on the wire, because a consumer cannot
  // un-coarsen a coarse profile but can ignore a label.
  const values = maxPool(line.profile, COARSE_BINS);

  return {
    spec_version: SPEC_VERSION,
    event_id: `batvu-${line.device_id}-${String(options.sequence).padStart(6, '0')}`,
    timestamp_ns: timestampNs,
    sensor: {
      modality: 'ultrasonic',
      vendor: 'batvu',
      device_id: line.device_id,
      placement: options.placement ?? 'handheld',
      coordinate_frame: 'enu_scan_local',
      // Orientation-only pose (ADR-011): the scan origin is pinned and never
      // moves, so the position is the origin by definition rather than by
      // measurement. Reporting anything else would invent a translation the
      // phone cannot observe.
      position_m: [0, 0, 0],
      orientation_xyzw: minimalRotationZTo(line.beam),
      clock_domain: 'device_monotonic',
    },
    tensor: {
      spec_version: SPEC_VERSION,
      timestamp_ns: timestampNs,
      modality: 'ultrasonic',
      // `range`, never `angle`. `FieldAxis::Angle` means angle-of-arrival bins
      // — the output of an array that measured direction. BatVu has one
      // microphone; the direction on an echo is where the phone was pointing.
      // That is pose, and it rides in the sensor descriptor above.
      axes: ['range'],
      shape: [values.length],
      values,
      confidence,
      noise_floor: line.noise_floor,
      calibration_id: options.calibrationId ?? null,
      privacy_class: 'P1',
    },
    observation: {
      zone_id: options.zoneId ?? null,
      space_cell: null,
      range_m: nearest ? nearest.range_m : null,
      velocity_mps: null,
      motion_vector: null,
      confidence,
      features: {
        echo_count: line.detections.length,
        // `range_m` is one of exactly six feature keys the fusion engine reads.
        // The typed `range_m` field above is NOT one of them: setting only that
        // produces a wire-correct event that is invisible to every range rule.
        range_m: nearest ? nearest.range_m : 0,
        peak_snr_db: line.detections.length === 0 ? 0 : peakSnr,
        noise_floor: line.noise_floor,
        blast_amplitude: line.blast_amplitude,
      },
      // `presence` is deliberately absent, though fusion reads it and setting
      // it would light up the shipped `person_present` rule. An echo at 2.4 m
      // is a surface; one transducer pair cannot tell a person from a coat on
      // a chair, and a range-only sensor reporting presence asserts exactly
      // that distinction.
      labels: line.detections.length === 0 ? ['clear_path'] : ['surface_echo'],
      privacy_class: 'P1',
    },
    provenance: {
      raw_hash: 'sha256:unsigned',
      firmware_hash: 'sha256:unsigned',
      model_id: 'batvu.sonar.matched_filter.v1',
      calibration_id: options.calibrationId ?? 'batvu_uncalibrated',
      // Derived from the recording's declared origin, never chosen freely.
      // Simulator output marked `synthetic: false` to get past a live trust
      // policy is the exact invariant violation the RuField ADRs name.
      synthetic: line.source === 'simulated',
    },
  };
}

/**
 * The body of a `GET /api/field` response, in the shape `rufield-viewer`
 * deserialises.
 *
 * Two omissions are deliberate and both come from reading the shipped client
 * rather than the shipped server. RuView emits `dev_signing_key` as a JSON
 * BOOL while the viewer's `ApiFieldPayload` types it `Option<String>`, and it
 * emits `signer_pubkey_hex` where the viewer reads `signer_pubkey`. Either
 * mismatch rejects the whole batch. The viewer has no `deny_unknown_fields`, so
 * leaving both out is safe, and `events` — the only key that carries anything —
 * is served alone.
 */
export function fieldSurfaceBody(events: ReadonlyArray<Record<string, unknown>>): {
  spec: string;
  endpoint: string;
  events: Array<Record<string, unknown>>;
} {
  return {
    spec: 'rufield',
    endpoint: '/api/field',
    events: [...events],
  };
}

/**
 * A bounded ring of events, oldest first.
 *
 * Lossy by design. A reader that stops reading must never be able to stall the
 * sonar loop or grow the phone's memory without limit — the newest measurement
 * is always the one worth keeping, and a scan that had to wait for an HTTP
 * client is a scan that has lost its timing.
 */
export class FieldSurface {
  private readonly ring: Array<Record<string, unknown>> = [];
  private sequence = 0;

  constructor(private readonly capacity: number = RING_CAPACITY) {
    if (!(capacity > 0)) throw new Error('batvu: field surface capacity must be positive');
  }

  get length(): number {
    return this.ring.length;
  }

  /** Project a ping and retain it. Returns the event that was stored. */
  publish(line: UltrasonicLine, options: Omit<FieldEventOptions, 'sequence'> = {}): Record<string, unknown> {
    const event = toFieldEvent(line, { ...options, sequence: this.sequence++ });
    this.ring.push(event);
    while (this.ring.length > this.capacity) this.ring.shift();
    return event;
  }

  /** Everything currently retained, oldest first. */
  events(): Array<Record<string, unknown>> {
    return [...this.ring];
  }

  /** The `GET /api/field` body. */
  body(): ReturnType<typeof fieldSurfaceBody> {
    return fieldSurfaceBody(this.ring);
  }

  clear(): void {
    this.ring.length = 0;
  }
}

/** Max-pool a profile to `bins` values, keeping peaks. A profile shorter than
 *  the target is returned unchanged rather than padded: padding would invent
 *  range cells the recording never measured. */
function maxPool(profile: readonly number[], bins: number): number[] {
  if (profile.length <= bins || bins <= 0) return [...profile];
  const out: number[] = [];
  for (let bin = 0; bin < bins; bin++) {
    // Integer boundaries, so every input bin lands in exactly one output bin
    // and none is dropped by a rounding seam.
    const start = Math.floor((bin * profile.length) / bins);
    const end = Math.max(start + 1, Math.floor(((bin + 1) * profile.length) / bins));
    let peak = 0;
    for (let i = start; i < Math.min(end, profile.length); i++) {
      const v = profile[i]!;
      if (v > peak) peak = v;
    }
    out.push(peak);
  }
  return out;
}

/** Quaternion `[x, y, z, w]` for the minimal rotation taking sensor-local `+Z`
 *  onto `beam`. Roll about the boresight is unobservable with one transducer
 *  pair, so the minimal rotation is the one that asserts nothing about the axis
 *  nobody measured. Matches the Rust adapter's `minimal_rotation_z_to`. */
function minimalRotationZTo(beam: readonly [number, number, number]): [number, number, number, number] {
  const [bx, by, bz] = beam;
  // Antiparallel is degenerate: every axis in the XY plane works, so pick one
  // deterministically rather than dividing by zero.
  if (bz <= -1 + 1e-6) return [1, 0, 0, 0];
  const w = 1 + bz;
  const x = -by;
  const y = bx;
  const norm = Math.hypot(x, y, 0, w);
  return [x / norm, y / norm, 0, w / norm];
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}
