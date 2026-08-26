# @batvu/capture

ADR-023 Decisions 2 and 6: the paired-capture corpus, `.presence.jsonl`.

One record per dwell. Each record carries the ultrasonic **measurement** (complex
range profiles down one bearing, the beam, the calibration receipt), the LiDAR
**label** (true range along that beam and whether ARKit reported a body), a
**consent receipt**, and **provenance** including both clocks and the offset
between them. Pure functions over plain typed arrays — no wasm, no I/O, no
dependency on the rest of the workspace.

The pairing is the contribution. LiDAR cannot hear breathing and the sonar cannot
see a person, so neither sensor could produce this corpus alone; the reason it can
be produced at all is that RuView's iPhone app already streams
`ruview.lidar.depth.v1` off the same chassis, on the same pose, in the same
second.

## The record

```jsonc
{
  "type": "batvu.presence.pair.v1",
  "consent": {
    "receipt_id": "receipt-0001",
    "subject_ref": "subject-9f3a",          // an opaque handle, not a name
    "scope": "batvu.micromotion.corpus.v1",
    "privacy_max": "P4",
    "granted_unix_s": 1756162790,
    "expires_unix_s": 1756162860,
    "withdrawal_ref": "batvu://consent/receipt-0001/withdraw"
  },
  "provenance": {
    "schema": "batvu.presence.pair.v1",
    "device_id": "batvu-capture-test-01",
    "sequence": 0,
    "source": "simulated",                  // or "device_capture"
    "synthetic": true                       // must agree with source
  },
  "clock": {
    "ultrasonic_unix_s": 1756162800,        // BatVu's domain: Unix epoch
    "lidar_timestamp_ns": 12345000000000,   // ARKit's domain: system uptime
    "lidar_domain": "arkit_uptime",
    "offset_s": 1756150459,                 // add to lidar_timestamp_ns/1e9
    "skew_s": 0.01                          // residual uncertainty, not a delta
  },
  "measurement": {
    "beam": [0, 1, 0],
    "calibration_id": "cal-2026-08-26-a",
    "prf_hz": 15,
    "lambda_m": 0.01805263,
    "pings": 128,
    "bins": 32,
    "start_range_m": 0.3,
    "range_step_m": 0.05,
    "iq": [/* pings*bins*2 interleaved (re, im), ping-major */],
    "noise_floor": 0.0004,
    "saturated": false
  },
  "teacher": {
    "frame_type": "ruview.lidar.depth.v1",
    "sensor": "apple-arkit-scene-depth",
    "sequence": 4211,
    "range_m": 1.2,                         // depth-derived, along `beam`
    "range_confidence": 2,                  // min ARKit confidence over the footprint
    "sample_count": 41,
    "body_in_scene": true,                  // THE LABEL
    "body_on_beam": null,                   // null when the capture did not determine it
    "pose": [/* 16, column-major, as simd_float4x4.columnMajorArray writes it */],
    "intrinsics": { "fx": 1500, "fy": 1500, "cx": 960, "cy": 720,
                    "image_width": 1920, "image_height": 1440 }
  }
}
```

`measurement` is field-for-field assignable to `@batvu/micromotion`'s
`ComplexProfileDwell` once parsed, so `analyzeDwell(record.measurement)` is the
intended call and there is nothing to adapt. The packages do not depend on each
other.

**The depth map is not on the wire.** `RuViewLiDARFrame.Depth` is `width*height`
metres plus a confidence byte each — a centimetre-resolution picture of the inside
of somebody's home, in a file that already contains that person breathing. The
label needs one scalar out of it and one boolean, so that is what the record
carries. A consumer cannot un-discard what was never written.

**Nothing here writes `presence`.** The file is named for the question; the label
is the depth camera's report, and BatVu still populates `range_m` and
`micromotion_band` and nothing else. The vocabulary check makes that structural: a
record that invents a `presence` field is a parse error, and a test walks every
key of an encoded record to pin it.

## Refusals

There is no partial success. `parseCorpus` returns every record or throws a
`CorpusError` naming the line — a corpus that half-loads has silently dropped the
record whose subject withdrew, and nothing downstream can tell that from a shorter
capture. This is `UltrasonicReplayAdapter::from_jsonl_with`'s reasoning with the
nouns changed, and ADR-023 §6 is what makes it apply to consent.

| `code` | when |
| --- | --- |
| `line_too_long` | a line past `MAX_LINE_BYTES`, measured **before** `JSON.parse` |
| `too_many_records` | a file past `MAX_RECORDS` dwells |
| `empty` | no dwells at all |
| `parse` | not JSON |
| `unknown_field` | a key this format has not agreed to, or a required key absent |
| `schema_mismatch` | `type`, `provenance.schema` or `teacher.frame_type` naming something else |
| `consent_missing` | no receipt, or one missing a field that makes it one |
| `consent_invalid` | wrong scope, wrong privacy class, bad window, or a window that does not contain the whole dwell |
| `source_mismatch` | the declared source is not the one the caller accepts — **in both directions** |
| `synthetic_mismatch` | `provenance.synthetic` contradicting `provenance.source` |
| `device_mismatch` | the file changes device midway |
| `non_monotonic` | dwells that do not advance, or that overlap in time |
| `clock_skew` | residual skew past one pulse repetition interval |
| `teacher_outside_dwell` | the LiDAR frame lands outside the dwell it claims to label |
| `invalid` | any physical or structural bound |

`accept` has no default. Asking for `device_capture` and being handed simulator
output is the obvious failure; asking for `simulated` and being handed a real
person's home is the one that matters more.

## The two clocks

ADR-023 says "one device, one clock". That is true of the chassis and false of the
software: BatVu timestamps from the browser's epoch clock and `RuViewLiDARFrame`
timestamps from `ARFrame.timestamp`, a system-uptime `TimeInterval`. A record
carries both, plus the `offset_s` that maps one onto the other and the residual
uncertainty left after applying it.

Two checks follow, and both are derived from the record rather than chosen:

- **Skew** must not exceed one pulse repetition interval, `1/prf_hz` — 66.7 ms at
  BatVu's 15 pings a second. Below that, the label cannot be attributed to a
  different ping than the one it was taken with. Above it, it can, and a label
  attributed to the wrong ping of a slow-time series is a label for a moment the
  dwell measured something else. `MAX_CLOCK_SKEW_S = 1` is the backstop at the
  bottom of the PRF range, and it is ADR-023 §2's own phrasing rather than a
  measurement: "the label comes from the same phone, in the same second."
- **The mapped LiDAR instant** must land inside `[dwell start, dwell end]`, widened
  by that same bound.

The offset is measured on the device and this format has no way to check it.
Verifying it needs an event visible to both clocks, which needs hardware; the code
says so in a `TODO(ADR-023)` rather than guessing.

## Consent, structurally

ADR-023 §6: consent is per-capture and recorded in the capture. The receipt is
required, its `scope` is pinned to `batvu.micromotion.corpus.v1` (consent for a
range-mapping session is not consent for a recording chest motion can be recovered
from), its `privacy_max` is pinned to `P4` (RuField prices `breathing` there, with
`requires_consent = true`), and the whole dwell must fall inside its validity
window — a receipt that expires mid-dwell did not cover the second half of it.
`MAX_CONSENT_WINDOW_S` is one day, stated as a policy choice, because a receipt
valid for a year is the settings checkbox §6 refuses wearing a timestamp.

The privacy class is an equality check, not a comparison. `rufield_core`'s scale is
a taxonomy of kind, not a monotone ordering of restriction — P0 raw frames are held
edge-local while P1 derived features egress — so "at least P4" is not a sentence
that means anything.

There is no egress mode and there is not going to be one. The complex profiles
*are* the breathing phase; the egress-safe representation and the
presence-detecting representation are in direct tension by construction, and that
tension is the safety property.

## The seal between the measurement and the label

`record.measurement` is what a detector reads. `record.label` has no readable
members: `record.label.rangeM` is a compile error, `openTeacherLabel(record.label)`
is not, and the payload lives in a module-scope `WeakMap` so a `JSON.stringify`, a
spread into a feature bag, or a logging helper typed `any` sees an object with
nothing in it.

The failure this prevents is specific. Leak the LiDAR range into a feature and the
detector scores perfectly against a corpus it is reading the answers out of; the
flywheel promotes it, because `meetsPromotionRule` checks lift on a holdout and the
holdout has the answers in it too; and what ships reports a person whenever the
LiDAR would have. That is ADR-022's defect at its worst available severity.

Both halves are tested. The runtime half is asserted in `corpus.test.ts`; the
compile-time half is a `@ts-expect-error` in the same file, checked by
`npm run lint:tests --workspace @batvu/capture`, which fails if the seal ever
becomes readable.

## API

```ts
parseCorpus(text: string, options: { accept: CorpusSource }): PairedDwell[]
encodeRecord(options: EncodeRecordOptions): PresencePairLine
encodeLine(line: PresencePairLine): string
encodeCorpus(lines: readonly PresencePairLine[]): string
validateLine(line: PresencePairLine, lineNo?: number): void
openTeacherLabel(sealed: SealedTeacherLabel): TeacherLabel
sealTeacherLabel(label: TeacherLabel): SealedTeacherLabel
```

## Bounds

Every one is checked, and the byte cap runs before `JSON.parse` sees the line —
a cap applied after parsing has already allowed the allocation it was meant to
prevent.

| constant | value | why |
| --- | --- | --- |
| `MAX_LINE_BYTES` | 8 MiB | derived from `MAX_DWELL_SAMPLES`, not chosen |
| `MAX_RECORDS` | 4096 | days of capture at tens of seconds a dwell |
| `MAX_DWELL_PINGS` | 4096 | 273 s at 15 Hz; ADR-023 §3 asks for tens of seconds |
| `MAX_PROFILE_BINS` | 1024 | 7.3 m at BatVu's 7.1 mm step, past what the link budget reaches |
| `MAX_DWELL_SAMPLES` | 262144 | the product, because the factors multiply and the byte cap has to hold |
| `MIN_PRF_HZ` / `MAX_PRF_HZ` | 1 / 1000 | the floor is what makes the skew bound finite; the ceiling is the chirp's own length |
| `MAX_CLOCK_SKEW_S` | 1 | the backstop; the binding bound is `1/prf_hz` |
| `MAX_CONSENT_WINDOW_S` | 86400 | a policy choice, stated as one |
| `MAX_ID_BYTES` | 256 | as `@batvu/field` and `rufield-adapters` |
| `MAX_RANGE_M` | 50 | as `@batvu/field` |

`iq` is rounded to seven **significant** figures, not seven decimals. That
distinction is the format: a fixed number of decimals is right for a range in
metres and catastrophic for a phasor, because the weak bins are where a small
target sits and rounding them to seven decimal places sets them to zero —
fabricating a phase of zero in exactly the bins that mattered. Seven significant
figures is a relative error near 1e-7, which on a phasor is a phase error near
1e-7 rad; against `Δφ = 4πd/λ` at 18.05 mm — 0.696 rad per millimetre — that is
seven orders below the quantity being measured. A test asserts it in a bin nine
orders of magnitude below the wall.

## Status

This package has never parsed a capture. BatVu has measured zero real rooms, there
is no `.presence.jsonl` in this repository, and everything here is a format and its
refusals, unit-tested against records the tests construct. That proves the bounds
and proves nothing about people — ADR-023's own consequences section says most of
what it describes cannot be validated here.

There is deliberately no simulated breather in the test suite. ADR-023 §4 confines
`Target::breathing` to proving the phase arithmetic is arithmetic and bars it from
being evidence about people; a corpus package asserting detection performance
against one would be asserting that the code agrees with the code. The one
signal-shaped fixture — a 0.3 Hz phase modulation in one bin — exists to prove the
encoder does not destroy the phase it carries.

`TODO(ADR-023)`: `@batvu/field` closes a conformance loop by writing an artefact
the Rust adapter's own test suite reads, so a schema divergence fails a build. This
format has no counterpart, because nothing downstream parses `.presence.jsonl` yet
and §6 puts the consumer on the phone. The conformance test will be end-to-end
against a real capture or it will not exist.
