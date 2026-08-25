// SPDX-License-Identifier: MIT
//
// The claim under test is narrow and checkable: turn the phone, get the same
// descriptor. Everything else here exists to stop that claim from being true
// for a boring reason — a descriptor that is constant, or all zeros, or so
// coarse that every room looks alike, would pass an invariance test perfectly.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { BatVuCore, OccupancyGrid, ScanSession, type Vec3 } from '@batvu/core';
import {
  clutteredOffice,
  corridor,
  emptyHall,
  horizontalSweep,
  livingRoom,
  rasterSweep,
  simulateScan,
  smallBathroom,
  type Room,
  type ScanPose,
} from '@batvu/sim';
import {
  AZIMUTH_BINS,
  HARMONICS,
  RoomMemory,
  SIGNATURE_DIM,
  SIGNATURE_VERSION,
  harmonicAttenuation,
  roomSignature,
  signatureSimilarity,
  toFieldEmbedding,
} from '../src/index.js';

let core: BatVuCore;

beforeAll(async () => {
  core = await BatVuCore.load();
});

/** Rotate a vector about +Z (up) — the one degree of freedom BatVu does not
 *  know, and therefore the one the descriptor has to absorb. */
function rotateZ(v: Vec3, radians: number): Vec3 {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c, z: v.z };
}

/**
 * Map a room, optionally with the phone's heading reference offset.
 *
 * This is the honest simulation of the thing being tested. The acoustics are
 * computed from the TRUE beam direction — the room does not care what the
 * compass says — but the map is built from the REPORTED direction, rotated by
 * `headingOffset`. That is exactly what an arbitrary `alpha` origin does: the
 * same physical sweep of the same room produces a map rigidly rotated about Z.
 */
function mapRoom(
  room: Room,
  poses: ScanPose[],
  headingOffset = 0,
): { grid: OccupancyGrid; session: ScanSession } {
  const pings = simulateScan(core, room, poses, { seed: 0x51ee7 });
  const session = new ScanSession(core);
  for (const ping of pings) {
    session.pingWithBeam(ping.samples, rotateZ(ping.pose.beam, headingOffset), ping.pose.origin);
  }
  return { grid: session.grid, session };
}

const SWEEP = rasterSweep(24, 3, 50);

describe('room signature', () => {
  it('is the declared length and a unit vector', () => {
    const { grid, session } = mapRoom(livingRoom(), SWEEP);
    const sig = roomSignature(grid);
    session.destroy();

    expect(sig.vector.length).toBe(SIGNATURE_DIM);
    expect(sig.occupiedVoxels).toBeGreaterThan(0);
    const norm = Math.hypot(...sig.vector);
    expect(norm).toBeCloseTo(1, 5);
  });

  it('survives a heading offset that lands on a bin boundary — exactly', () => {
    // 2π/64 per bin. Six bins is 33.75°, well past anything a binning artefact
    // could be hiding, and it is an EXACT circular shift, so the DFT shift
    // theorem should hold to floating-point precision rather than approximately.
    const binStep = (2 * Math.PI) / AZIMUTH_BINS;
    const room = clutteredOffice();

    const a = mapRoom(room, SWEEP, 0);
    const b = mapRoom(room, SWEEP, 6 * binStep);
    const sigA = roomSignature(a.grid);
    const sigB = roomSignature(b.grid);
    a.session.destroy();
    b.session.destroy();

    expect(signatureSimilarity(sigA.vector, sigB.vector)).toBeGreaterThan(0.995);
  });

  it('survives a heading offset that lands mid-bin — approximately, and that is the honest word', () => {
    // 17°, deliberately not a multiple of the 5.625° bin. The invariance is now
    // only as good as the binning, and the point of the test is to record how
    // good that actually is rather than to assert it is perfect.
    const room = clutteredOffice();
    const a = mapRoom(room, SWEEP, 0);
    const b = mapRoom(room, SWEEP, (17 * Math.PI) / 180);
    const sim = signatureSimilarity(roomSignature(a.grid).vector, roomSignature(b.grid).vector);
    a.session.destroy();
    b.session.destroy();

    expect(sim).toBeGreaterThan(0.97);
  });

  it('holds across a full turn, not just one convenient angle', () => {
    const room = livingRoom();
    const base = mapRoom(room, SWEEP, 0);
    const reference = roomSignature(base.grid);
    base.session.destroy();

    let worst = 1;
    for (let deg = 30; deg < 360; deg += 30) {
      const rotated = mapRoom(room, SWEEP, (deg * Math.PI) / 180);
      const sim = signatureSimilarity(reference.vector, roomSignature(rotated.grid).vector);
      rotated.session.destroy();
      worst = Math.min(worst, sim);
    }
    expect(worst).toBeGreaterThan(0.95);
  });

  it('separates different rooms by more than rotation perturbs the same one', () => {
    // The test that stops the invariance from being vacuous. If the worst
    // same-room similarity is not clear of the best different-room similarity,
    // there is no threshold that works and the descriptor is decoration.
    const rooms: Room[] = [livingRoom(), corridor(), smallBathroom(), emptyHall()];
    const sigs = rooms.map((room) => {
      const m = mapRoom(room, SWEEP, 0);
      const s = roomSignature(m.grid);
      m.session.destroy();
      return s;
    });

    let bestDifferent = -1;
    for (let i = 0; i < sigs.length; i++) {
      for (let j = i + 1; j < sigs.length; j++) {
        bestDifferent = Math.max(
          bestDifferent,
          signatureSimilarity(sigs[i]!.vector, sigs[j]!.vector),
        );
      }
    }

    // Same room, worst case over a full turn.
    let worstSame = 1;
    for (const deg of [23, 90, 187, 301]) {
      const rotated = mapRoom(rooms[0]!, SWEEP, (deg * Math.PI) / 180);
      worstSame = Math.min(
        worstSame,
        signatureSimilarity(sigs[0]!.vector, roomSignature(rotated.grid).vector),
      );
      rotated.session.destroy();
    }

    expect(worstSame).toBeGreaterThan(bestDifferent + 0.02);
  });

  it('reports its own support rather than pretending a partial sweep is a whole one', () => {
    // A sweep that covers a 120-degree arc instead of the whole turn. Note that
    // a raster sliced by COUNT is not partial in azimuth — it is serpentine, so
    // the first row already visits every heading. The sweep has to be truncated
    // in ANGLE for the descriptor to be missing anything, which is itself worth
    // knowing: partial coverage in elevation is much less damaging than partial
    // coverage in azimuth, because azimuth is the axis the invariance rides on.
    const room = livingRoom();
    const full = mapRoom(room, rasterSweep(24, 3, 50), 0);
    const partial = mapRoom(room, horizontalSweep(10, 0, -180, -60), 0);

    const sigFull = roomSignature(full.grid, { coverage: 0.8 });
    const sigPartial = roomSignature(partial.grid, { coverage: 0.3 });

    expect(sigFull.azimuthSupport).toBeGreaterThan(sigPartial.azimuthSupport);
    expect(sigPartial.azimuthSupport).toBeLessThan(AZIMUTH_BINS);
    expect(sigFull.coverage).toBe(0.8);

    // And the descriptors diverge, which is the honest outcome: a third of a
    // room is not the room. The number is recorded rather than asserted tightly
    // because it is a MEASUREMENT of how fast the descriptor degrades, and the
    // useful form of that fact is the gap between it and the same-room-rotated
    // similarity above 0.95.
    const sim = signatureSimilarity(sigFull.vector, sigPartial.vector);
    full.session.destroy();
    partial.session.destroy();
    expect(sim).toBeLessThan(0.95);
  });

  it('the k=0 harmonic is the band mass, so the old standalone elevation block was a copy', () => {
    // Why v2 replaced the elevation-mass block with a mean-range one. The DC
    // coefficient of a band's azimuth row is by definition the sum of the row,
    // which IS the band's mass — so carrying both spent eight dimensions on a
    // duplicate and silently double-weighted elevation.
    const m = mapRoom(livingRoom(), SWEEP);
    const sig = roomSignature(m.grid, { bandNormalize: false });
    m.session.destroy();

    // Block 1 is [0, 48): massSpectrum, laid out as [e * HARMONICS + k].
    // Its DC entries are the only ones a rotation cannot touch at all.
    const dc = [];
    for (let e = 0; e < 8; e++) dc.push(sig.vector[e * HARMONICS]!);
    expect(dc.filter((v) => v > 0).length).toBeGreaterThan(0);

    // Block 4 is [120, 128): elevRange. It is a RANGE in metres, so once both
    // are block-normalised they must not be proportional to one another —
    // which is exactly what "no longer redundant" means.
    const elev = [...sig.vector.slice(120, 128)];
    const ratios = dc
      .map((v, i) => (v > 1e-9 ? elev[i]! / v : Number.NaN))
      .filter((v) => Number.isFinite(v));
    expect(ratios.length).toBeGreaterThan(2);
    const spread = Math.max(...ratios) / Math.min(...ratios);
    expect(spread).toBeGreaterThan(1.1);
  });

  it('the attenuation model it argues from is the one the measurement agrees with', () => {
    // The file claims the mid-bin loss is a magnitude attenuation of
    // sqrt(1 - 2d(1-d)(1 - cos(2*pi*k/A))), worst at d = 1/2. If that model is
    // right, the retained harmonics are barely touched and the discarded ones
    // are annihilated — which is the actual reason K is 6 and not 32.
    expect(harmonicAttenuation(1, 0.5)).toBeCloseTo(0.9988, 3);
    expect(harmonicAttenuation(5, 0.5)).toBeCloseTo(0.9699, 3);
    expect(harmonicAttenuation(32, 0.5)).toBeCloseTo(0, 6);
    // A bin-aligned shift costs nothing at any harmonic — the shift theorem.
    for (let k = 0; k < AZIMUTH_BINS / 2; k++) {
      expect(harmonicAttenuation(k, 0)).toBeCloseTo(1, 9);
    }
    // Monotone in k across the retained band, so truncation is principled.
    for (let k = 1; k < HARMONICS; k++) {
      expect(harmonicAttenuation(k, 0.5)).toBeLessThan(harmonicAttenuation(k - 1, 0.5));
    }
  });

  it('returns a zero vector for an empty map instead of a confident nonsense one', () => {
    const sig = roomSignature(new OccupancyGrid());
    expect(sig.occupiedVoxels).toBe(0);
    expect(sig.vector.every((v) => v === 0)).toBe(true);
    // And two empty maps must NOT look like the same room.
    expect(signatureSimilarity(sig.vector, sig.vector)).toBe(0);
  });

  it('is deterministic — the same grid twice is the same 128 numbers', () => {
    const m = mapRoom(smallBathroom(), SWEEP, 0);
    const a = roomSignature(m.grid);
    const b = roomSignature(m.grid);
    m.session.destroy();
    expect([...a.vector]).toEqual([...b.vector]);
  });
});

describe('room memory', () => {
  it('recognises a room it was shown from a different heading', () => {
    const memory = new RoomMemory();
    const room = clutteredOffice();

    const learned = mapRoom(room, SWEEP, 0);
    memory.remember('office', roomSignature(learned.grid, { coverage: 0.7 }), 'the office');
    learned.session.destroy();

    const seenAgain = mapRoom(room, SWEEP, (74 * Math.PI) / 180);
    const hit = memory.recognize(roomSignature(seenAgain.grid, { coverage: 0.7 }));
    seenAgain.session.destroy();

    expect(hit).not.toBeNull();
    expect(hit!.record.id).toBe('office');
    expect(hit!.record.label).toBe('the office');
    // Sole candidate: nothing to be confused with.
    expect(hit!.margin).toBe(Number.POSITIVE_INFINITY);
  });

  it('refuses to name a room it cannot separate from another', () => {
    // The reason `recognize` gates on margin rather than level. Two records
    // that both score high against a query mean the query has been CONFUSED,
    // not recognised, and the honest answer to "where am I" is nothing.
    const memory = new RoomMemory();
    const room = livingRoom();
    const a = mapRoom(room, SWEEP, 0);
    const sig = roomSignature(a.grid);
    memory.remember('twin-a', sig);
    memory.remember('twin-b', sig);
    a.session.destroy();

    const again = mapRoom(room, SWEEP, (40 * Math.PI) / 180);
    const query = roomSignature(again.grid);
    again.session.destroy();

    // Both are reported by `recall`, with a margin of ~0 between them...
    const hits = memory.recall(query, { topK: 2 });
    expect(hits).toHaveLength(2);
    expect(hits[0]!.margin).toBeLessThan(0.001);
    // ...and `recognize` declines to pick one.
    expect(memory.recognize(query)).toBeNull();
  });

  it('refuses a stored descriptor from a different signature version', () => {
    const memory = new RoomMemory();
    const m = mapRoom(livingRoom(), SWEEP, 0);
    memory.remember('a', roomSignature(m.grid));
    m.session.destroy();

    const json = memory.toJSON();
    expect(json.version).toBe(SIGNATURE_VERSION);
    // v1 and v2 are both 128 long and both unit-norm, so only the version
    // number can tell them apart.
    expect(() => RoomMemory.fromJSON({ ...json, version: 1 })).toThrow(/re-scan/);
  });

  it('declines to recognise a room it has never seen', () => {
    const memory = new RoomMemory();
    const learned = mapRoom(corridor(), SWEEP, 0);
    memory.remember('corridor', roomSignature(learned.grid));
    learned.session.destroy();

    const elsewhere = mapRoom(emptyHall(), SWEEP, 0);
    const hit = memory.recognize(roomSignature(elsewhere.grid));
    elsewhere.session.destroy();

    expect(hit).toBeNull();
  });

  it('counts corroborations without averaging two states of one room together', () => {
    const memory = new RoomMemory();
    const room = livingRoom();
    const first = mapRoom(room, SWEEP, 0);
    const sig1 = roomSignature(first.grid);
    memory.remember('home', sig1, 'home');
    first.session.destroy();

    const second = mapRoom(room, SWEEP, (30 * Math.PI) / 180);
    const sig2 = roomSignature(second.grid);
    const record = memory.remember('home', sig2);
    second.session.destroy();

    expect(record.observations).toBe(2);
    expect(record.label).toBe('home');
    // The newest scan wins outright — no blending.
    expect([...record.vector]).toEqual([...sig2.vector]);
  });

  it('round-trips through JSON and re-validates on the way back in', () => {
    const memory = new RoomMemory();
    const m = mapRoom(livingRoom(), SWEEP, 0);
    memory.remember('a', roomSignature(m.grid, { coverage: 0.6 }), 'living room');
    m.session.destroy();

    const restored = RoomMemory.fromJSON(JSON.parse(JSON.stringify(memory.toJSON())));
    expect(restored.size).toBe(1);
    expect(restored.get('a')!.label).toBe('living room');
    expect(restored.get('a')!.coverage).toBeCloseTo(0.6, 6);
  });

  it('refuses hostile JSON rather than allocating whatever it is told to', () => {
    const good = new RoomMemory();
    const m = mapRoom(livingRoom(), SWEEP, 0);
    good.remember('a', roomSignature(m.grid));
    m.session.destroy();
    const base = good.toJSON();

    expect(() => RoomMemory.fromJSON({ ...base, dim: 40_000_000 })).toThrow(/signatures/);
    expect(() => RoomMemory.fromJSON({ ...base, version: 99 })).toThrow(/version/);
    expect(() => RoomMemory.fromJSON('not an object')).toThrow(/not an object/);
    expect(() =>
      RoomMemory.fromJSON({ ...base, records: [{ ...base.records[0], vector: [1, 2, 3] }] }),
    ).toThrow(/vector/);
    expect(() =>
      RoomMemory.fromJSON({
        ...base,
        records: [{ ...base.records[0]!, vector: base.records[0]!.vector.map(() => NaN) }],
      }),
    ).toThrow(/finite/);
  });

  it('emits a rufield FieldEmbedding that cannot be talked above P3', () => {
    const m = mapRoom(livingRoom(), SWEEP, 0);
    const embedding = toFieldEmbedding(roomSignature(m.grid), 'evt-1');
    m.session.destroy();

    expect(embedding.modality).toBe('ultrasonic');
    expect(embedding.privacy_class).toBe('P3');
    expect(embedding.vector).toHaveLength(SIGNATURE_DIM);
    expect(Object.keys(embedding).sort()).toEqual([
      'modality',
      'privacy_class',
      'source_event_id',
      'vector',
    ]);
  });
});

afterAll(() => {
  // nothing global to tear down; sessions are destroyed at their use sites
});
