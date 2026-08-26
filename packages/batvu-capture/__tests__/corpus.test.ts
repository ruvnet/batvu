// SPDX-License-Identifier: MIT
//
// What these tests can and cannot establish.
//
// They establish that the format round-trips, that every bound in `schema.ts` is
// enforced, and that a record which fails any of them takes the whole file with
// it. That is the entire contract `@batvu/capture` offers, and it is checkable
// here because it is a statement about parsing rather than about rooms.
//
// They establish NOTHING about detection. There is no simulated breather in this
// file and there is not going to be one: ADR-023 §4 confines `Target::breathing`
// to proving that the phase arithmetic is arithmetic, and a test in a corpus
// package asserting that a detector finds a simulated person would be asserting
// that the code agrees with the code. The one signal-shaped fixture below —
// a 0.3 Hz phase modulation in one bin — is here to prove that the ENCODER does
// not destroy the phase it is carrying, which is a property of `significant()`,
// not a property of anybody's chest.
//
// The records are hand-built rather than captured because BatVu has captured
// nothing. When a real `.presence.jsonl` exists, the test that matters is the
// one this file cannot contain.

import { describe, expect, it } from 'vitest';
import {
  CONSENT_PRIVACY_CLASS,
  CONSENT_SCOPE,
  CorpusError,
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
  MIN_PRF_HZ,
  SCHEMA_TYPE,
  encodeCorpus,
  encodeLine,
  encodeRecord,
  openTeacherLabel,
  parseCorpus,
  validateLine,
  type EncodeRecordOptions,
  type PresencePairLine,
  type SealedTeacherLabel,
  type TeacherLabel,
} from '@batvu/capture';

/** Dwell start. The same epoch second `@batvu/field`'s tests use, so a reader
 *  comparing the two files is not also converting between clocks. */
const T0 = 1_756_162_800;
const PRF_HZ = 15;
const PINGS = 128;
const BINS = 32;
/** `c / f` at 19 kHz in 343 m/s air. Arithmetic, and the only physical constant
 *  this file is entitled to. ADR-023 §1. */
const LAMBDA_M = 343 / 19_000;
/** The bin the fixture puts a modulated phasor in. */
const LOUD_BIN = 12;
/** A bin nine orders of magnitude quieter, to catch a rounding scheme that
 *  works on the wall and deletes everything else. */
const FAINT_BIN = 20;
const FAINT_AMPLITUDE = 1e-9;
/** Modulation of the loud bin: 0.3 Hz, 0.7 rad — one millimetre at `LAMBDA_M`
 *  by `dphi = 4*pi*d/lambda`. A number to round-trip, not a claim about people. */
const MOD_HZ = 0.3;
const MOD_RAD = 0.7;

function phaseOf(ping: number, bin: number): number {
  if (bin === LOUD_BIN) return MOD_RAD * Math.sin((2 * Math.PI * MOD_HZ * ping) / PRF_HZ);
  if (bin === FAINT_BIN) return 0.4;
  return bin * 0.1;
}

function amplitudeOf(bin: number): number {
  if (bin === LOUD_BIN) return 0.5;
  if (bin === FAINT_BIN) return FAINT_AMPLITUDE;
  return 0.02;
}

function fixtureIq(pings = PINGS, bins = BINS): Float64Array {
  const iq = new Float64Array(pings * bins * 2);
  for (let p = 0; p < pings; p++) {
    for (let b = 0; b < bins; b++) {
      const a = amplitudeOf(b);
      const phi = phaseOf(p, b);
      iq[p * bins * 2 + b * 2] = a * Math.cos(phi);
      iq[p * bins * 2 + b * 2 + 1] = a * Math.sin(phi);
    }
  }
  return iq;
}

/** Uptime the fixture's LiDAR frame is stamped with. Twelve thousand seconds of
 *  it, so the offset that maps it onto the epoch is unmistakably an offset. */
const UPTIME_NS = 12_345_000_000_000;

/** The offset that lands a teacher frame at `at` seconds on the epoch. */
function offsetFor(at: number): number {
  return at - UPTIME_NS / 1e9;
}

function fixtureLabel(): TeacherLabel {
  return {
    frameType: LIDAR_FRAME_TYPE,
    sensor: 'apple-arkit-scene-depth',
    sequence: 4211,
    rangeM: 1.2,
    rangeConfidence: 2,
    sampleCount: 41,
    bodyInScene: true,
    bodyOnBeam: null,
    // Column-major, as `simd_float4x4.columnMajorArray` writes it.
    pose: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.5, 1.2, -0.3, 1],
    intrinsics: { fx: 1500, fy: 1500, cx: 960, cy: 720, imageWidth: 1920, imageHeight: 1440 },
  };
}

/** A dwell whose LiDAR frame lands four seconds in, on an uptime clock. */
function fixtureOptions(overrides: Partial<EncodeRecordOptions> = {}): EncodeRecordOptions {
  return {
    deviceId: 'batvu-capture-test-01',
    sequence: 0,
    source: 'simulated',
    consent: {
      receiptId: 'receipt-0001',
      subjectRef: 'subject-9f3a',
      scope: CONSENT_SCOPE,
      privacyMax: CONSENT_PRIVACY_CLASS,
      grantedUnixS: T0 - 10,
      expiresUnixS: T0 + 60,
      withdrawalRef: 'batvu://consent/receipt-0001/withdraw',
    },
    clock: {
      ultrasonicUnixS: T0,
      lidarTimestampNs: UPTIME_NS,
      lidarDomain: 'arkit_uptime',
      offsetS: offsetFor(T0 + 4),
      skewS: 0.01,
    },
    measurement: {
      beam: [0, 1, 0],
      calibrationId: 'cal-2026-08-26-a',
      prfHz: PRF_HZ,
      lambdaM: LAMBDA_M,
      pings: PINGS,
      bins: BINS,
      startRangeM: 0.3,
      rangeStepM: 0.05,
      iq: fixtureIq(),
      noiseFloor: 4e-4,
      saturated: false,
    },
    label: fixtureLabel(),
    ...overrides,
  };
}

function fixtureLine(overrides: Partial<EncodeRecordOptions> = {}): PresencePairLine {
  return encodeRecord(fixtureOptions(overrides));
}

/** Deep copy so a mutation in one case cannot leak into the next. */
function clone(line: PresencePairLine): PresencePairLine {
  return structuredClone(line);
}

function refusal(run: () => unknown): CorpusError {
  try {
    run();
  } catch (error) {
    if (error instanceof CorpusError) return error;
    throw error;
  }
  throw new Error('expected a CorpusError and nothing was thrown');
}

describe('the .presence.jsonl record', () => {
  it('round-trips a dwell and its label', () => {
    const line = fixtureLine();
    const records = parseCorpus(encodeCorpus([line]), { accept: 'simulated' });

    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.deviceId).toBe('batvu-capture-test-01');
    expect(record.source).toBe('simulated');
    expect(record.synthetic).toBe(true);
    expect(record.consent.receiptId).toBe('receipt-0001');
    expect(record.measurement.pings).toBe(PINGS);
    expect(record.measurement.bins).toBe(BINS);
    expect(record.measurement.data).toHaveLength(PINGS * BINS * 2);
    expect(record.measurement.calibrationId).toBe('cal-2026-08-26-a');
    expect(Math.hypot(...record.measurement.beam)).toBeCloseTo(1, 6);

    // Both clocks, and the reconciliation between them.
    expect(record.clock.ultrasonicUnixS).toBe(T0);
    expect(record.clock.ultrasonicEndUnixS).toBeCloseTo(T0 + PINGS / PRF_HZ, 6);
    expect(record.clock.lidarUnixS).toBeCloseTo(T0 + 4, 5);
    expect(record.clock.lidarDomain).toBe('arkit_uptime');
    expect(record.clock.skewBoundS).toBeCloseTo(1 / PRF_HZ, 9);

    const label = openTeacherLabel(record.label);
    expect(label).toEqual(fixtureLabel());
  });

  it('preserves phase, including in a bin nine orders below the wall', () => {
    // This asserts a property of `significant()` and nothing else. Rounding to a
    // fixed number of DECIMALS would leave `FAINT_BIN` as (0, 0) — a fabricated
    // phase of zero — and the loud bin would survive, so a test that only looked
    // at the loud bin would pass while the format quietly deleted every small
    // target in the corpus.
    //
    // Five decimal places of phase, which pins `significant()` at six digits or
    // better rather than at the seven it is called with. The exact round-trip is
    // not available to assert: `buildRecord` narrows the wire's f64 into a
    // `Float32Array`, so the number that comes back has 24 bits of mantissa
    // whatever the encoder wrote. The tolerance is that narrowing, not slack.
    const record = parseCorpus(encodeCorpus([fixtureLine()]), { accept: 'simulated' })[0]!;
    const { data } = record.measurement;

    for (const [bin, tolerance] of [
      [LOUD_BIN, 5],
      [FAINT_BIN, 5],
    ] as const) {
      for (const ping of [0, 37, PINGS - 1]) {
        const re = data[ping * BINS * 2 + bin * 2]!;
        const im = data[ping * BINS * 2 + bin * 2 + 1]!;
        expect(Math.hypot(re, im)).toBeGreaterThan(0);
        expect(Math.atan2(im, re)).toBeCloseTo(phaseOf(ping, bin), tolerance);
      }
    }
    // And the faint bin really is faint, so the check above was not trivially
    // reading the loud one.
    const faintRe = data[FAINT_BIN * 2]!;
    const faintIm = data[FAINT_BIN * 2 + 1]!;
    expect(Math.hypot(faintRe, faintIm)).toBeCloseTo(FAINT_AMPLITUDE, 15);
  });

  it('carries only the keys this format has agreed to, and never one called presence', () => {
    const line = fixtureLine();
    expect(Object.keys(line).sort()).toEqual([
      'clock',
      'consent',
      'measurement',
      'provenance',
      'teacher',
      'type',
    ]);
    expect(Object.keys(line.consent).sort()).toEqual([
      'expires_unix_s',
      'granted_unix_s',
      'privacy_max',
      'receipt_id',
      'scope',
      'subject_ref',
      'withdrawal_ref',
    ]);
    expect(Object.keys(line.clock).sort()).toEqual([
      'lidar_domain',
      'lidar_timestamp_ns',
      'offset_s',
      'skew_s',
      'ultrasonic_unix_s',
    ]);
    expect(Object.keys(line.provenance).sort()).toEqual([
      'device_id',
      'schema',
      'sequence',
      'source',
      'synthetic',
    ]);
    expect(Object.keys(line.teacher).sort()).toEqual([
      'body_in_scene',
      'body_on_beam',
      'frame_type',
      'intrinsics',
      'pose',
      'range_confidence',
      'range_m',
      'sample_count',
      'sensor',
      'sequence',
    ]);

    // ADR-023 §5. `type` contains the substring, because the file is named for
    // the question; no KEY anywhere is that word, because nothing here answers
    // it. Walk the tree rather than grep the text, so the two cannot be
    // confused.
    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
      for (const [k, v] of Object.entries(value)) {
        keys.add(k);
        walk(v);
      }
    };
    walk(JSON.parse(encodeLine(line)));
    expect(keys.has('presence')).toBe(false);

    // And a record that invents one is a parse error, not a field somebody
    // ignored — which is what makes the paragraph above structural.
    const invented = { ...clone(line), presence: 0.91 } as unknown as PresencePairLine;
    const error = refusal(() => parseCorpus(encodeCorpus([line]) + `${JSON.stringify(invented)}\n`, { accept: 'simulated' }));
    expect(error.code).toBe('unknown_field');
    expect(error.message).toMatch(/unknown field presence/);
  });
});

describe('consent, which is structural', () => {
  it('refuses the whole file when one record has no consent receipt', () => {
    const good = fixtureLine();
    const later = fixtureLine({
      sequence: 1,
      clock: { ...fixtureOptions().clock, ultrasonicUnixS: T0 + 30, offsetS: offsetFor(T0 + 34) },
    });
    const stripped = clone(later) as unknown as Record<string, unknown>;
    delete stripped['consent'];

    const text = `${encodeLine(good)}\n${JSON.stringify(stripped)}\n`;
    const error = refusal(() => parseCorpus(text, { accept: 'simulated' }));
    expect(error.code).toBe('consent_missing');
    expect(error.line).toBe(2);

    // The point of the refusal: the good first record is not returned either.
    // A corpus that half-loads has silently dropped the record whose subject
    // withdrew, and nothing downstream can tell that from a shorter capture.
    expect(() => parseCorpus(text, { accept: 'simulated' })).toThrow(CorpusError);
    expect(parseCorpus(encodeLine(good), { accept: 'simulated' })).toHaveLength(1);
  });

  it('refuses a receipt that is present but incomplete', () => {
    const line = clone(fixtureLine());
    const consent = line.consent as unknown as Record<string, unknown>;
    delete consent['withdrawal_ref'];
    const error = refusal(() =>
      parseCorpus(`${JSON.stringify(line)}\n`, { accept: 'simulated' }),
    );
    expect(error.code).toBe('consent_missing');
    expect(error.message).toMatch(/missing withdrawal_ref/);
  });

  it('refuses a receipt that does not authorise this capture', () => {
    const base = fixtureOptions();
    const cases: Array<[Partial<EncodeRecordOptions['consent']>, RegExp]> = [
      [{ scope: 'batvu.range.mapping.v1' }, /does not authorise/],
      [{ privacyMax: 'P2' }, /misprices/],
      [{ receiptId: '' }, /receipt_id/],
      // Escaped, not a literal control byte: a formatter or a copy-paste that
      // strips 0x07 would turn the fixture into the string 'ab' and this case
      // would stop testing the check it names.
      [{ subjectRef: 'a\u0007b' }, /control characters/],
      [{ withdrawalRef: '   ' }, /withdrawal_ref/],
      [{ grantedUnixS: T0 + 60, expiresUnixS: T0 - 10 }, /expires no later/],
      [{ grantedUnixS: T0 - 10, expiresUnixS: T0 + MAX_CONSENT_WINDOW_S }, /settings checkbox/],
      // Granted after the dwell began: the first pings were unconsented.
      [{ grantedUnixS: T0 + 1 }, /not inside the consent window/],
      // Expired mid-dwell: the last pings were.
      [{ expiresUnixS: T0 + 1 }, /not inside the consent window/],
    ];

    for (const [patch, message] of cases) {
      const error = refusal(() =>
        encodeRecord({ ...base, consent: { ...base.consent, ...patch } }),
      );
      expect(error.code).toBe('consent_invalid');
      expect(error.message).toMatch(message);
    }
  });
});

describe('the two clocks', () => {
  it('refuses a pair whose residual skew exceeds one pulse repetition interval', () => {
    const base = fixtureOptions();
    // 1/15 s = 66.7 ms. Just inside is fine; just outside is not a pair.
    expect(() =>
      encodeRecord({ ...base, clock: { ...base.clock, skewS: 1 / PRF_HZ - 1e-6 } }),
    ).not.toThrow();

    const error = refusal(() =>
      encodeRecord({ ...base, clock: { ...base.clock, skewS: 1 / PRF_HZ + 1e-3 } }),
    );
    expect(error.code).toBe('clock_skew');
    expect(error.message).toMatch(/one pulse repetition interval/);

    // At the bottom of the PRF range the backstop binds instead: one second,
    // which is ADR-023 §2's own phrasing.
    const slow = fixtureOptions({
      measurement: {
        ...base.measurement,
        prfHz: MIN_PRF_HZ,
        pings: 8,
        iq: fixtureIq(8, BINS),
      },
      clock: { ...base.clock, skewS: MAX_CLOCK_SKEW_S + 0.001 },
    });
    expect(refusal(() => encodeRecord(slow)).code).toBe('clock_skew');
  });

  it('refuses a teacher frame taken outside the dwell it labels', () => {
    const base = fixtureOptions();
    // The offset maps uptime onto the epoch. Push the mapped instant a minute
    // past the end of the dwell and the label describes a different moment.
    const error = refusal(() =>
      encodeRecord({ ...base, clock: { ...base.clock, offsetS: offsetFor(T0 + 60) } }),
    );
    expect(error.code).toBe('teacher_outside_dwell');

    // Before the dwell is equally not a pair.
    expect(
      refusal(() =>
        encodeRecord({ ...base, clock: { ...base.clock, offsetS: offsetFor(T0 - 60) } }),
      ).code,
    ).toBe('teacher_outside_dwell');

    // A frame at either edge of the dwell is.
    for (const at of [T0, T0 + PINGS / PRF_HZ]) {
      expect(() =>
        encodeRecord({ ...base, clock: { ...base.clock, offsetS: offsetFor(at) } }),
      ).not.toThrow();
    }
  });

  it('refuses a nanosecond count a double cannot hold exactly', () => {
    const base = fixtureOptions();
    const error = refusal(() =>
      encodeRecord({
        ...base,
        clock: { ...base.clock, lidarTimestampNs: Number.MAX_SAFE_INTEGER + 2 },
      }),
    );
    expect(error.code).toBe('invalid');
    expect(error.message).toMatch(/exact nanosecond count/);
  });
});

describe('trust, in both directions', () => {
  it('refuses simulated output to a caller that asked for device captures', () => {
    const text = encodeCorpus([fixtureLine({ source: 'simulated' })]);
    const error = refusal(() => parseCorpus(text, { accept: 'device_capture' }));
    expect(error.code).toBe('source_mismatch');
    expect(error.message).toMatch(/declares source simulated .* accepts device_capture/);
  });

  it('refuses a device capture to a caller that asked for simulation', () => {
    // The direction that matters more: a caller expecting the simulator handed a
    // recording of somebody's home.
    const text = encodeCorpus([fixtureLine({ source: 'device_capture' })]);
    const error = refusal(() => parseCorpus(text, { accept: 'simulated' }));
    expect(error.code).toBe('source_mismatch');
    expect(error.message).toMatch(/declares source device_capture .* accepts simulated/);
  });

  it('derives synthetic from source on write and refuses a record that contradicts itself', () => {
    expect(fixtureLine({ source: 'simulated' }).provenance.synthetic).toBe(true);
    expect(fixtureLine({ source: 'device_capture' }).provenance.synthetic).toBe(false);

    const line = clone(fixtureLine({ source: 'device_capture' }));
    line.provenance.synthetic = true;
    const error = refusal(() => parseCorpus(`${JSON.stringify(line)}\n`, { accept: 'device_capture' }));
    expect(error.code).toBe('synthetic_mismatch');
  });
});

describe('the bounds, all of them', () => {
  it('refuses a line past the byte cap before it parses it', () => {
    // MALFORMED as well as oversized, and that is the whole test. A valid
    // oversized line cannot distinguish the two orderings — an implementation
    // that parsed first would reach the same `line_too_long` and the same
    // message, having already paid for the allocation the cap exists to
    // prevent. Unterminated JSON can only reach `line_too_long` if the cap ran
    // before `JSON.parse` did.
    const oversized = `{"pad":"${'a'.repeat(MAX_LINE_BYTES)}`;
    const error = refusal(() => parseCorpus(oversized, { accept: 'simulated' }));
    expect(error.code).toBe('line_too_long');
    expect(error.message).toMatch(/maximum is/);

    // The control: the same malformed JSON, under the cap, is a parse error.
    const small = refusal(() => parseCorpus('{"pad":"aaa', { accept: 'simulated' }));
    expect(small.code).toBe('parse');
  });

  it('encodes the largest dwell every other cap permits', () => {
    // The byte cap claims to be DERIVED from the sample cap. That claim is only
    // worth anything if the worst case actually fits, and the worst case is not
    // a typical phasor: `JSON.stringify` writes exponential notation only below
    // 1e-6, so the widest number `significant(v, 7)` can produce is a negative
    // value just above it — `-0.000001234567`, fifteen characters. Those are
    // exactly the values a faint bin holds.
    //
    // So this builds the real thing and runs it through the package's own
    // encoder. An arithmetic assertion between two constants would have agreed
    // with whichever bytes-per-number figure it was written with.
    const bins = 1024;
    const pings = MAX_DWELL_SAMPLES / bins;
    expect(Number.isInteger(pings)).toBe(true);
    expect(pings).toBeLessThanOrEqual(MAX_DWELL_PINGS);
    expect(bins).toBeLessThanOrEqual(MAX_PROFILE_BINS);

    const iq = new Float32Array(MAX_DWELL_SAMPLES * 2);
    iq.fill(-1.234567e-6);
    expect(JSON.stringify(Number((-1.234567e-6).toPrecision(7)))).toHaveLength(15);

    const line = fixtureLine({
      measurement: { ...fixtureOptions().measurement, pings, bins, rangeStepM: 0.0036, iq },
    });
    const text = encodeLine(line);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(MAX_LINE_BYTES);
    // And it is not passing because the encoder quietly dropped the phase: the
    // array really is 2 * MAX_DWELL_SAMPLES numbers wide.
    expect(line.measurement.iq).toHaveLength(MAX_DWELL_SAMPLES * 2);
  }, 60_000);

  it('refuses an oversized iq before it copies it', () => {
    // `encodeRecord` rounds every element into a fresh array, and it used to do
    // that before anything had checked how many elements there were — so a
    // caller handing over a hundred megabytes of phasors paid for a copy of it
    // and then got a refusal. Same argument as the byte cap running before
    // `JSON.parse`, on the write side.
    const error = refusal(() =>
      encodeRecord(
        fixtureOptions({
          measurement: {
            ...fixtureOptions().measurement,
            iq: new Float32Array(2 * MAX_DWELL_SAMPLES + 2),
          },
        }),
      ),
    );
    expect(error.message).toMatch(/iq carries/);
  });

  it('refuses a corpus past the record cap', () => {
    // A minimal dwell — two pings, one bin — so `MAX_RECORDS + 1` of them is a
    // file rather than an afternoon. Every dwell is a second later than the last
    // so the monotonic check cannot fire first and mask the one being tested.
    const base = fixtureOptions({
      consent: {
        ...fixtureOptions().consent,
        expiresUnixS: T0 + MAX_RECORDS + 100,
      },
      measurement: {
        ...fixtureOptions().measurement,
        pings: 2,
        bins: 1,
        rangeStepM: 1,
        iq: fixtureIq(2, 1),
      },
    });

    const lines: string[] = [];
    for (let i = 0; i <= MAX_RECORDS; i++) {
      const at = T0 + i;
      lines.push(
        JSON.stringify(
          encodeRecord({
            ...base,
            sequence: i,
            clock: { ...base.clock, ultrasonicUnixS: at, offsetS: offsetFor(at) },
          }),
        ),
      );
    }

    const error = refusal(() => parseCorpus(`${lines.join('\n')}\n`, { accept: 'simulated' }));
    expect(error.code).toBe('too_many_records');
    expect(error.line).toBe(MAX_RECORDS + 1);

    // One fewer is a corpus.
    expect(
      parseCorpus(`${lines.slice(0, MAX_RECORDS).join('\n')}\n`, { accept: 'simulated' }),
    ).toHaveLength(MAX_RECORDS);
  });

  it('refuses an empty corpus rather than returning nothing', () => {
    expect(refusal(() => parseCorpus('\n\n  \n', { accept: 'simulated' })).code).toBe('empty');
  });

  it('refuses every structural and physical bound', () => {
    const good = fixtureLine();
    const on = (patch: (line: PresencePairLine) => void): CorpusError => {
      const line = clone(good);
      patch(line);
      return refusal(() => validateLine(line, 1));
    };

    expect(on((l) => (l.type = 'batvu.presence.pair.v2')).code).toBe('schema_mismatch');
    expect(on((l) => (l.provenance.schema = 'something.else')).code).toBe('schema_mismatch');
    expect(on((l) => (l.teacher.frame_type = 'ruview.lidar.depth.v2')).code).toBe(
      'schema_mismatch',
    );

    expect(on((l) => (l.provenance.device_id = 'x'.repeat(MAX_ID_BYTES + 1))).message).toMatch(
      /1..=256 bytes/,
    );
    expect(on((l) => (l.provenance.device_id = '')).code).toBe('invalid');
    expect(on((l) => (l.provenance.sequence = -1)).message).toMatch(/is not an index/);

    expect(on((l) => (l.measurement.beam = [0, 0, 0])).message).toMatch(/no length/);
    expect(on((l) => (l.measurement.beam = [0, Number.NaN, 0])).message).toMatch(/not finite/);
    expect(on((l) => (l.measurement.prf_hz = MIN_PRF_HZ - 0.5)).message).toMatch(/prf_hz/);
    expect(on((l) => (l.measurement.prf_hz = MAX_PRF_HZ + 1)).message).toMatch(/prf_hz/);
    // A millimetres/metres slip: 18.05 instead of 0.01805 scales every
    // displacement the corpus can report by a thousand.
    expect(on((l) => (l.measurement.lambda_m = 18.05)).message).toMatch(/wavelength scale/);
    expect(on((l) => (l.measurement.lambda_m = 0)).message).toMatch(/wavelength scale/);
    expect(on((l) => (l.measurement.pings = MAX_DWELL_PINGS + 1)).message).toMatch(/pings/);
    expect(on((l) => (l.measurement.pings = 0)).message).toMatch(/pings/);
    expect(on((l) => (l.measurement.bins = MAX_PROFILE_BINS + 1)).message).toMatch(/bins/);
    expect(
      on((l) => {
        l.measurement.pings = MAX_DWELL_PINGS;
        l.measurement.bins = MAX_PROFILE_BINS;
      }).message,
    ).toMatch(/complex samples, past the/);
    expect(on((l) => l.measurement.iq.pop()).message).toMatch(/interleaved needs/);
    expect(on((l) => (l.measurement.iq[3] = Number.NaN)).message).toMatch(/iq\[3\]/);
    expect(on((l) => (l.measurement.noise_floor = -1)).message).toMatch(/noise_floor/);
    expect(on((l) => (l.measurement.start_range_m = -1)).message).toMatch(/start_range_m/);
    expect(on((l) => (l.measurement.range_step_m = 0)).message).toMatch(/range_step_m/);
    expect(on((l) => (l.measurement.range_step_m = MAX_RANGE_M)).message).toMatch(
      /past the 50 m bound/,
    );
    expect(on((l) => (l.measurement.calibration_id = '')).message).toMatch(/calibration_id/);

    expect(on((l) => (l.teacher.range_m = 0)).message).toMatch(/range_m/);
    // Inside the profile is the pairing condition: a label pointing at a surface
    // this dwell could not have heard is not a label for this dwell.
    expect(on((l) => (l.teacher.range_m = 4)).message).toMatch(/outside the recorded profile/);
    expect(on((l) => (l.teacher.range_confidence = MAX_DEPTH_CONFIDENCE + 1)).message).toMatch(
      /range_confidence/,
    );
    expect(on((l) => (l.teacher.sample_count = 0)).message).toMatch(/sample_count/);
    expect(
      on((l) => {
        l.teacher.body_on_beam = true;
        l.teacher.body_in_scene = false;
      }).message,
    ).toMatch(/no body in the scene/);
    expect(on((l) => l.teacher.pose.pop()).message).toMatch(/column-major values/);
    // A row-major matrix in a column-major slot: the w components stop being
    // (0, 0, 0, 1) and every pose in the file is silently transposed.
    expect(on((l) => (l.teacher.pose[3] = 0.5)).message).toMatch(/column-major affine/);
    expect(on((l) => (l.teacher.pose[15] = 0)).message).toMatch(/column-major affine/);
    expect(on((l) => (l.teacher.intrinsics.fx = 0)).message).toMatch(/focal length/);
    expect(on((l) => (l.teacher.intrinsics.image_width = 0)).message).toMatch(/image size/);
    expect(on((l) => (l.teacher.sensor = '')).message).toMatch(/sensor/);

    expect(on((l) => (l.clock.ultrasonic_unix_s = -1)).message).toMatch(/capture time/);
    expect(on((l) => (l.clock.ultrasonic_unix_s = 5e9)).message).toMatch(/capture time/);
    expect(on((l) => (l.clock.lidar_domain = 'gps' as never)).message).toMatch(/lidar_domain/);
    // The variant that used to be in the enum and could never be honest: epoch
    // nanoseconds do not survive `Number.isSafeInteger`, so a record declaring
    // it was refused for its timestamp while a record carrying UPTIME
    // nanoseconds under that label sailed through unchecked. Now it is refused
    // by name, like any other undeclared origin.
    expect(on((l) => (l.clock.lidar_domain = 'unix_epoch' as never)).message).toMatch(
      /lidar_domain/,
    );
    expect(on((l) => (l.clock.skew_s = -1)).message).toMatch(/non-negative uncertainty/);
    expect(on((l) => (l.clock.offset_s = Number.NaN)).message).toMatch(/offset_s/);
  });

  it('refuses a corpus that changes device or lets two dwells overlap', () => {
    const first = fixtureLine();
    const second = fixtureLine({
      sequence: 1,
      clock: { ...fixtureOptions().clock, ultrasonicUnixS: T0 + 30, offsetS: offsetFor(T0 + 34) },
      consent: { ...fixtureOptions().consent, expiresUnixS: T0 + 120 },
    });
    expect(() =>
      parseCorpus(`${encodeLine(first)}\n${encodeLine(second)}\n`, { accept: 'simulated' }),
    ).not.toThrow();

    const renamed = clone(second);
    renamed.provenance.device_id = 'batvu-capture-test-02';
    expect(
      refusal(() =>
        parseCorpus(`${encodeLine(first)}\n${JSON.stringify(renamed)}\n`, {
          accept: 'simulated',
        }),
      ).code,
    ).toBe('device_mismatch');

    // The first dwell runs to T0 + 8.53. One transducer cannot be staring down
    // two bearings at once, so a dwell starting at T0 + 4 is not a later dwell.
    const overlapping = clone(second);
    overlapping.clock.ultrasonic_unix_s = T0 + 4;
    overlapping.clock.offset_s = offsetFor(T0 + 5);
    expect(
      refusal(() =>
        parseCorpus(`${encodeLine(first)}\n${JSON.stringify(overlapping)}\n`, {
          accept: 'simulated',
        }),
      ).code,
    ).toBe('non_monotonic');
  });

  it('refuses a line that is not JSON, and one that is not an object', () => {
    expect(refusal(() => parseCorpus('{not json', { accept: 'simulated' })).code).toBe('parse');
    expect(refusal(() => parseCorpus('[1,2,3]', { accept: 'simulated' })).code).toBe(
      'unknown_field',
    );
  });
});

describe('the seal between the measurement and the label', () => {
  it('keeps the label out of reach of anything that reads the measurement', () => {
    const record = parseCorpus(encodeCorpus([fixtureLine()]), { accept: 'simulated' })[0]!;

    // The handle carries nothing. This is the runtime half of the guarantee, and
    // it is the half that matters, because the paths that would leak a label are
    // the ones that lost their types: a JSON dump, a spread into a feature bag,
    // a logging helper typed `any`.
    const leaked = record.label as unknown as Record<string, unknown>;
    expect(Object.keys(record.label)).toEqual(['sealed']);
    expect(leaked['rangeM']).toBeUndefined();
    expect(leaked['bodyInScene']).toBeUndefined();
    expect(JSON.stringify(record.label)).not.toContain('1.2');
    expect(JSON.stringify({ ...record, measurement: null })).not.toContain(
      'apple-arkit-scene-depth',
    );

    // @ts-expect-error the sealed handle has no readable members; this is the
    // compile-time half, checked by `npm run lint:tests` in this package.
    void record.label.rangeM;

    // And the measurement a detector reads has no teacher-shaped field on it at
    // all — `@batvu/micromotion`'s `ComplexProfileDwell` keys, plus the geometry
    // and identity it carries through, and nothing else.
    expect(Object.keys(record.measurement).sort()).toEqual([
      'beam',
      'bins',
      'calibrationId',
      'data',
      'lambdaM',
      'noiseFloor',
      'pings',
      'prfHz',
      'rangeStepM',
      'saturated',
      'startRangeM',
    ]);

    // The one way in says what it is doing.
    expect(openTeacherLabel(record.label).rangeM).toBe(1.2);
    expect(openTeacherLabel(record.label).bodyInScene).toBe(true);
  });

  it('refuses a label handle it did not mint', () => {
    const forged = { sealed: 'batvu.presence.teacher.v1' } as unknown as SealedTeacherLabel;
    expect(() => openTeacherLabel(forged)).toThrow(/not a sealed teacher label/);

    // Including one reconstructed from a serialised record, which is the way a
    // seal would actually be lost.
    const record = parseCorpus(encodeCorpus([fixtureLine()]), { accept: 'simulated' })[0]!;
    const revived = JSON.parse(JSON.stringify(record)) as { label: SealedTeacherLabel };
    expect(() => openTeacherLabel(revived.label)).toThrow(/not a sealed teacher label/);
  });

  it('hands back a frozen label, so an evaluator cannot edit the answers', () => {
    const record = parseCorpus(encodeCorpus([fixtureLine()]), { accept: 'simulated' })[0]!;
    const label = openTeacherLabel(record.label);
    expect(Object.isFrozen(label)).toBe(true);
    expect(() => {
      (label as { rangeM: number }).rangeM = 9;
    }).toThrow();
    expect(openTeacherLabel(record.label).rangeM).toBe(1.2);
  });
});

describe('the schema constants', () => {
  it('pins the strings a consumer in another language will match on', () => {
    expect(SCHEMA_TYPE).toBe('batvu.presence.pair.v1');
    expect(LIDAR_FRAME_TYPE).toBe('ruview.lidar.depth.v1');
    expect(CONSENT_SCOPE).toBe('batvu.micromotion.corpus.v1');
    expect(CONSENT_PRIVACY_CLASS).toBe('P4');
  });
});
