// SPDX-License-Identifier: MIT
//
// @batvu/field — putting a sonar scan on RuField's wire.
//
// BatVu measures a room. RuField MFS is the schema several ruvnet projects use
// to describe what a camera-free sensor measured, and `Modality::Ultrasonic` —
// registry code 7 — has been in that registry since v0.1 with nothing
// implementing it. This package, and the `UltrasonicReplayAdapter` it was
// written against in `ruvnet/rufield`, are that implementation.
//
// ## The direction of travel
//
// The path that matters runs one way: BatVu writes `.ultrasonic.jsonl`, rufield
// parses it, signs it, and hands `FieldEvent`s to a fusion engine. `wire.ts`
// owns that format and `recorder.ts` owns the stream-level rules — strictly
// increasing timestamps, one sensor per recording — that the format alone
// cannot express.
//
// The reverse direction does not exist to be built against. RuView's
// `/api/field` and `/ws/field` are GET-only: it produces field events, it does
// not ingest them, and neither does rufield-viewer. So `event.ts` serves the
// producer side instead, which is what plugs BatVu into `rufield-viewer
// --source live --upstream <host>` — a consumer that already ships and already
// works.
//
// ## The line this package will not cross
//
// It does not sign. The signature is over serde's byte-exact rendering of a
// Rust struct, and reproducing that from JavaScript is the one part of this
// integration that could pass every test and still fail on a phone. BatVu emits
// the measurement; rufield mints the credential. See the note at the top of
// `wire.ts`.

export {
  encodePing,
  encodeLine,
  validateLine,
  MAX_LINE_BYTES,
  MAX_PROFILE_BINS,
  MAX_DETECTIONS,
  MAX_PINGS,
  MAX_ID_BYTES,
  MAX_RANGE_M,
  DEFAULT_PROFILE_BINS,
} from './wire.js';
export type { UltrasonicLine, UltrasonicSource, EncodeOptions } from './wire.js';

export { UltrasonicRecorder } from './recorder.js';
export type { RecorderOptions } from './recorder.js';

export {
  toFieldEvent,
  fieldSurfaceBody,
  FieldSurface,
  SPEC_VERSION,
  COARSE_BINS,
  RING_CAPACITY,
} from './event.js';
export type { FieldEventOptions } from './event.js';
