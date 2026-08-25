// SPDX-License-Identifier: MIT
//
// @batvu/memory — the difference between mapping a room and recognising one.
//
// BatVu's hardest limitation is that it has no global pose. Orientation-only
// tracking (ADR-011) pins the origin and integrates attitude, so the map is a
// spherical shell of one room seen from one standing spot, in a frame whose
// azimuth zero is wherever the phone happened to be pointing when the scan
// started. Geometric localisation — "I am at (3.2, 1.1) in the floor plan" —
// is therefore off the table, and no amount of post-processing puts it back.
//
// Associative recognition is a different question and it is answerable. Reduce
// the map to a descriptor that is invariant to the one unknown — heading — and
// two scans of the same standing spot land in the same place in descriptor
// space whichever way the phone was facing. That is not localisation. It is
// "I have been here before", which for a wearable is most of what localisation
// was wanted for.
//
// `signature.ts` has the maths and, more importantly, the list of things this
// cannot do.

export {
  roomSignature,
  signatureSimilarity,
  ELEVATION_BANDS,
  AZIMUTH_BINS,
  HARMONICS,
  RADIAL_BINS,
  SIGNATURE_DIM,
  SIGNATURE_VERSION,
  harmonicAttenuation,
} from './signature.js';
export type { RoomSignature, SignatureOptions } from './signature.js';

export {
  RoomMemory,
  toFieldEmbedding,
  MAX_ENTRIES,
  MAX_LABEL_BYTES,
  DEFAULT_RECALL_THRESHOLD,
  DEFAULT_RECALL_MARGIN,
} from './store.js';
export type {
  RoomRecord,
  RecallHit,
  RecallOptions,
  FieldEmbedding,
} from './store.js';
