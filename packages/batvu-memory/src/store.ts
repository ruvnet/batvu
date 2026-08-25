// SPDX-License-Identifier: MIT
//
// "Have I been here before?" — a small, honest vector store.
//
// ## Why this is not a RuVector client
//
// RuVector is a Rust vector-memory substrate with local ONNX embeddings and a
// persistent database. BatVu runs in iOS Safari. It cannot load an ONNX runtime
// worth the download, it cannot open a database file, and it has no server to
// talk to — the whole project's build shape (ADR-002) exists to keep it that
// way.
//
// So this is the other half of the seam. `RoomMemory` holds the descriptors the
// phone produces, in the layout a vector store wants, and `toFieldEmbedding`
// emits them in rufield's `FieldEmbedding` shape — the exact type
// `rufield-ruvector`'s `EmbeddingBackend` moves across its boundary. A
// deployment that HAS RuVector reads that and indexes it; a phone on aeroplane
// mode keeps the same descriptors in `localStorage` and answers the same
// question locally. Neither side has to know which one is running.
//
// The similarity metric is cosine over `roomSignature`'s unit vectors, and the
// search is a linear scan. At the scale this operates on — a person's home is
// tens of standing spots, not millions — an index would be slower than the scan
// it replaced. `MAX_ENTRIES` is what stops that assumption from silently
// becoming false.

import {
  SIGNATURE_DIM,
  SIGNATURE_VERSION,
  signatureSimilarity,
  type RoomSignature,
} from './signature.js';

/** Hard cap on remembered places. A linear scan over 4096 × 128 floats is
 *  ~0.5 M multiply-adds — under a millisecond, and bounded. Past that the
 *  store refuses rather than degrading quietly. */
export const MAX_ENTRIES = 4096;

/** Cap on a label's length. Labels are user- or network-supplied strings that
 *  end up in JSON, in logs and possibly in a UI. */
export const MAX_LABEL_BYTES = 256;

/** Default similarity floor for reporting a hit at all.
 *
 *  This is a FILTER, not a decision. Every descriptor entry is non-negative, so
 *  cosine similarity has a high floor and unrelated rooms routinely score above
 *  0.5 — a level threshold alone is much less selective than its value makes it
 *  look. What separates rooms is the MARGIN between the best hit and the next
 *  one, which is why `RecallHit` carries it and `recognize` gates on it.
 *
 *  The value sits below the worst same-room-rotated similarity measured in
 *  `__tests__/signature.test.ts` (>0.95 over a full turn on the simulator's
 *  rooms) so a genuine re-scan is never filtered out before the margin is
 *  computed. Any real deployment must re-measure both numbers; a threshold
 *  carried over from a simulator is exactly the kind of number that looks
 *  validated and is not. */
export const DEFAULT_RECALL_THRESHOLD = 0.9;

/** Default margin the best hit must beat the runner-up by before `recognize`
 *  will call it a match.
 *
 *  Measured on the simulator's four rooms, where the gap between the worst
 *  same-room-rotated pair and the best different-room pair is small but
 *  consistent. Four rooms is not a population, and a real home with several
 *  similarly-shaped rooms will need a larger margin — the honest thing this
 *  number does is force the caller to look at it. */
export const DEFAULT_RECALL_MARGIN = 0.02;

export interface RoomRecord {
  /** Caller's identifier for the place. */
  id: string;
  /** Human label, if any. */
  label?: string;
  /** The descriptor. */
  vector: Float32Array;
  /** Sphere fraction swept when this was captured — how much to trust it. */
  coverage: number;
  /** Occupancy-weighted mean range, metres. Cheap sanity check: a 2 m room and
   *  a 6 m room should not be confused however well their spectra line up. */
  meanRangeM: number;
  /** Azimuth bins that carried evidence, out of 64. */
  azimuthSupport: number;
  /** Times this record has been corroborated by a matching recall. */
  observations: number;
}

export interface RecallHit {
  record: RoomRecord;
  /** Cosine similarity. High floor — read the margin, not this. */
  similarity: number;
  /** How far this hit beats the next-best one. `Infinity` when it is the only
   *  candidate, because there is nothing for it to be confused with. */
  margin: number;
}

export interface RecallOptions {
  /** Maximum hits to return. Default 5. */
  topK?: number;
  /** Minimum similarity to report at all. Default `DEFAULT_RECALL_THRESHOLD`. */
  minSimilarity?: number;
  /** Margin over the runner-up that `recognize` requires. Default
   *  `DEFAULT_RECALL_MARGIN`. Ignored by `recall`, which reports everything
   *  above `minSimilarity` and lets the caller decide. */
  minMargin?: number;
  /** Refuse to answer from a scan that swept less than this fraction of the
   *  sphere. Default 0 — off, because the honest default is to answer and let
   *  the caller see `coverage`, not to silently return nothing. */
  minCoverage?: number;
}

/** rufield `FieldEmbedding` (rufield-core/src/inference.rs:161). Structural,
 *  not imported: BatVu does not depend on a Rust crate, and a hand-written
 *  mirror that `__tests__` pins against the real field list is more honest than
 *  a generated binding nobody checks. */
export interface FieldEmbedding {
  modality: string;
  vector: number[];
  privacy_class: 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'P5';
  source_event_id: string;
}

export class RoomMemory {
  private readonly records = new Map<string, RoomRecord>();

  get size(): number {
    return this.records.size;
  }

  /**
   * Store or corroborate a place.
   *
   * Re-remembering an existing id does NOT average the two descriptors. It is
   * tempting — averaging looks like it should sharpen the estimate — but the
   * two scans are of a place that may genuinely have changed (a door opened, a
   * chair moved), and an average of two states is a description of neither. The
   * newest observation wins and `observations` records that it was not the
   * first.
   */
  remember(id: string, signature: RoomSignature, label?: string): RoomRecord {
    const key = checkId(id);
    checkVersion(signature.version);
    const vector = checkVector(signature.vector);
    if (!this.records.has(key) && this.records.size >= MAX_ENTRIES) {
      throw new Error(
        `batvu: room memory is full (${MAX_ENTRIES} places); drop one before adding another`,
      );
    }
    const previous = this.records.get(key);
    const record: RoomRecord = {
      id: key,
      vector,
      coverage: finite(signature.coverage, 'coverage'),
      meanRangeM: finite(signature.meanRangeM, 'meanRangeM'),
      azimuthSupport: Math.max(0, Math.floor(signature.azimuthSupport)),
      observations: (previous?.observations ?? 0) + 1,
    };
    const text = label ?? previous?.label;
    if (text !== undefined) record.label = checkLabel(text);
    this.records.set(key, record);
    return record;
  }

  forget(id: string): boolean {
    return this.records.delete(id);
  }

  get(id: string): RoomRecord | undefined {
    return this.records.get(id);
  }

  all(): RoomRecord[] {
    return [...this.records.values()];
  }

  /** Best matches, most similar first. */
  recall(signature: RoomSignature, options: RecallOptions = {}): RecallHit[] {
    const topK = Math.max(1, Math.floor(options.topK ?? 5));
    const min = options.minSimilarity ?? DEFAULT_RECALL_THRESHOLD;
    const minCoverage = options.minCoverage ?? 0;
    if (signature.coverage < minCoverage) return [];

    checkVersion(signature.version);
    const query = checkVector(signature.vector);

    // Scored against EVERY record, not only the ones above the floor, because
    // the margin is measured against the runner-up — and the runner-up may sit
    // below the reporting threshold. Filtering first would report an infinite
    // margin for a hit that in fact had a close competitor.
    const scored = [...this.records.values()].map((record) => ({
      record,
      similarity: signatureSimilarity(query, record.vector),
    }));
    // Ties broken by id so the ordering is total and the tests are not
    // hostage to Map insertion order.
    scored.sort((a, b) =>
      b.similarity === a.similarity
        ? a.record.id.localeCompare(b.record.id)
        : b.similarity - a.similarity,
    );

    const hits: RecallHit[] = [];
    for (let i = 0; i < scored.length && hits.length < topK; i++) {
      const entry = scored[i]!;
      if (entry.similarity < min) break;
      const next = scored[i + 1];
      hits.push({
        record: entry.record,
        similarity: entry.similarity,
        margin: next ? entry.similarity - next.similarity : Number.POSITIVE_INFINITY,
      });
    }
    return hits;
  }

  /**
   * The single best match, or null — the question the UI actually asks.
   *
   * Requires the margin as well as the level. A room that scores 0.96 against
   * two stored places, and 0.955 against a third, has not been recognised; it
   * has been confused, and the honest answer to "where am I" is nothing.
   */
  recognize(signature: RoomSignature, options: RecallOptions = {}): RecallHit | null {
    const minMargin = options.minMargin ?? DEFAULT_RECALL_MARGIN;
    const best = this.recall(signature, { ...options, topK: 1 })[0];
    if (!best) return null;
    return best.margin >= minMargin ? best : null;
  }

  toJSON(): { version: number; dim: number; records: SerializedRecord[] } {
    return {
      version: SIGNATURE_VERSION,
      dim: SIGNATURE_DIM,
      records: this.all().map((r) => ({
        id: r.id,
        ...(r.label !== undefined ? { label: r.label } : {}),
        vector: [...r.vector],
        coverage: r.coverage,
        meanRangeM: r.meanRangeM,
        azimuthSupport: r.azimuthSupport,
        observations: r.observations,
      })),
    };
  }

  /**
   * Rebuild from JSON.
   *
   * This is a trust boundary: the JSON may have come from `localStorage`, which
   * any script on the origin can write, or from a sync service. Every field is
   * re-validated. A store that trusted its own serialised form would accept a
   * 40-million-element vector and hang the tab on the first recall.
   */
  static fromJSON(value: unknown): RoomMemory {
    const memory = new RoomMemory();
    if (!isObject(value)) throw new Error('batvu: room memory JSON is not an object');
    // Version before dimension, and both. v1 and v2 descriptors are BOTH 128
    // long and BOTH unit-norm, so the dimension check cannot tell them apart —
    // a v2 build silently comparing v2 queries against v1 records would return
    // confident nonsense rather than an error. There is no migration: the
    // descriptor is derived from a grid nobody kept, so an old store is
    // rebuilt by re-scanning, not converted.
    if (value.version !== SIGNATURE_VERSION) {
      throw new Error(
        `batvu: room memory is version ${String(value.version)}, this build writes version ${SIGNATURE_VERSION}; re-scan to rebuild it`,
      );
    }
    if (value.dim !== SIGNATURE_DIM) {
      throw new Error(
        `batvu: room memory holds ${String(value.dim)}-dim signatures, this build makes ${SIGNATURE_DIM}`,
      );
    }
    const records = value.records;
    if (!Array.isArray(records)) throw new Error('batvu: room memory records is not an array');
    if (records.length > MAX_ENTRIES) {
      throw new Error(`batvu: room memory JSON holds ${records.length} records (max ${MAX_ENTRIES})`);
    }
    for (const raw of records) {
      if (!isObject(raw)) throw new Error('batvu: room memory record is not an object');
      const vector = raw.vector;
      if (!Array.isArray(vector) || vector.length !== SIGNATURE_DIM) {
        throw new Error(
          `batvu: room memory record has a ${Array.isArray(vector) ? vector.length : 'non-array'} vector (need ${SIGNATURE_DIM})`,
        );
      }
      const record: RoomRecord = {
        id: checkId(String(raw.id)),
        vector: checkVector(Float32Array.from(vector.map((v) => Number(v)))),
        coverage: finite(Number(raw.coverage), 'coverage'),
        meanRangeM: finite(Number(raw.meanRangeM), 'meanRangeM'),
        azimuthSupport: Math.max(0, Math.floor(Number(raw.azimuthSupport) || 0)),
        observations: Math.max(1, Math.floor(Number(raw.observations) || 1)),
      };
      if (typeof raw.label === 'string') record.label = checkLabel(raw.label);
      memory.records.set(record.id, record);
    }
    return memory;
  }
}

interface SerializedRecord {
  id: string;
  label?: string;
  vector: number[];
  coverage: number;
  meanRangeM: number;
  azimuthSupport: number;
  observations: number;
}

/**
 * Present a signature the way rufield moves embeddings across its RuVector
 * seam (`rufield-core/src/inference.rs:161`).
 *
 * `privacy_class` is fixed at `P3`, and the choice is load-bearing. The
 * descriptor is not raw signal (P0) and not a per-ping feature (P1); it is an
 * anonymous aggregate of a room's geometry, which is what P3 names. It is also
 * the ceiling: no arrangement of these 128 numbers describes a person, so no
 * caller can talk this into P4 or P5.
 */
export function toFieldEmbedding(
  signature: RoomSignature,
  sourceEventId: string,
): FieldEmbedding {
  checkVersion(signature.version);
  return {
    modality: 'ultrasonic',
    vector: [...checkVector(signature.vector)],
    privacy_class: 'P3',
    source_event_id: checkId(sourceEventId),
  };
}

function checkVersion(version: number): void {
  if (version !== SIGNATURE_VERSION) {
    throw new Error(
      `batvu: signature is version ${version}, this build compares version ${SIGNATURE_VERSION}`,
    );
  }
}

function checkVector(v: Float32Array): Float32Array {
  if (v.length !== SIGNATURE_DIM) {
    throw new Error(`batvu: signature must be ${SIGNATURE_DIM} long, got ${v.length}`);
  }
  for (let i = 0; i < v.length; i++) {
    if (!Number.isFinite(v[i]!)) {
      throw new Error(`batvu: signature element ${i} is not finite`);
    }
  }
  return Float32Array.from(v);
}

function checkId(id: string): string {
  const trimmed = id.trim();
  if (trimmed.length === 0) throw new Error('batvu: room id must not be empty');
  if (trimmed.length > MAX_LABEL_BYTES) {
    throw new Error(`batvu: room id exceeds ${MAX_LABEL_BYTES} characters`);
  }
  return trimmed;
}

function checkLabel(label: string): string {
  if (label.length > MAX_LABEL_BYTES) {
    throw new Error(`batvu: room label exceeds ${MAX_LABEL_BYTES} characters`);
  }
  return label;
}

function finite(value: number, what: string): number {
  if (!Number.isFinite(value)) throw new Error(`batvu: ${what} is not finite`);
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
