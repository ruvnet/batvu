// SPDX-License-Identifier: MIT
import { describe, expect, it, beforeAll } from 'vitest';
import {
  BatVuCore,
  DEFAULT_SONAR_CONFIG,
  OccupancyGrid,
  coneRays,
  occupancyIoU,
  recordLenFor,
  scoreRanges,
  vec3,
} from '@batvu/core';
import {
  castRay,
  emptyRoom,
  horizontalSweep,
  isSolid,
  livingRoom,
  pillar,
  rasterSweep,
  sampleBeam,
  simulateScan,
  surfacePredicate,
} from '@batvu/sim';

describe('ray casting', () => {
  it('finds the shell walls at their true distances', () => {
    const room = emptyRoom('box', 4, 6, 3); // +/-2 in x, +/-3 in y, +/-1.5 in z
    expect(castRay(room, vec3(0, 0, 0), vec3(0, 1, 0))!.distanceM).toBeCloseTo(3, 6);
    expect(castRay(room, vec3(0, 0, 0), vec3(1, 0, 0))!.distanceM).toBeCloseTo(2, 6);
    expect(castRay(room, vec3(0, 0, 0), vec3(0, 0, 1))!.distanceM).toBeCloseTo(1.5, 6);
    // The shell is hit from the inside, so it has no label.
    expect(castRay(room, vec3(0, 0, 0), vec3(0, 1, 0))!.label).toBeNull();
  });

  it('prefers a nearer obstacle to the wall behind it', () => {
    const room = emptyRoom('box', 4, 6, 3);
    room.obstacles = [pillar('post', { x: 0, y: 1.5 }, 0.4, 2, 0.7)];
    const hit = castRay(room, vec3(0, 0, 0), vec3(0, 1, 0))!;
    expect(hit.label).toBe('post');
    expect(hit.distanceM).toBeCloseTo(1.3, 6); // 1.5 - 0.4/2
    expect(hit.reflectivity).toBe(0.7);

    // Aimed past it, the wall comes back instead.
    const past = castRay(room, vec3(0, 0, 0), vec3(1, 0.2, 0))!;
    expect(past.label).toBeNull();
  });

  it('classifies solid space, including outside the room', () => {
    const room = emptyRoom('box', 4, 6, 3);
    room.obstacles = [pillar('post', { x: 0, y: 1.5 }, 0.4, 2, 0.7)];
    expect(isSolid(room, vec3(0, 1.5, 0))).toBe(true); // inside the post
    expect(isSolid(room, vec3(0, 0, 0))).toBe(false); // open floor
    expect(isSolid(room, vec3(0, 9, 0))).toBe(true); // beyond the wall
  });

  it('scores surfaces, not solid volume', () => {
    // A sonar never sees the inside of a wall, so scoring against solid volume
    // would punish a correct map for not filling in what it cannot observe.
    const room = emptyRoom('box', 4, 6, 3);
    const surface = surfacePredicate(room, 0.15);
    expect(surface(vec3(0, 2.95, 0))).toBe(true); // just inside the far wall
    expect(surface(vec3(0, 0, 0))).toBe(false); // middle of the room
    expect(surface(vec3(0, 5, 0))).toBe(false); // deep inside the wall
  });
});

describe('beam sampling', () => {
  it('reports one extended target for a wall filling the beam', () => {
    const room = emptyRoom('box', 8, 8, 4);
    const rays = coneRays(vec3(0, 1, 0), (20 * Math.PI) / 180, 128);
    const targets = sampleBeam(room, vec3(0, 0, 0), vec3(0, 1, 0), rays);
    expect(targets.length).toBeGreaterThanOrEqual(1);
    const strongest = targets.reduce((a, b) => (a.reflectivity >= b.reflectivity ? a : b));
    // A wall fills the beam, so it spreads as 1/r rather than 1/r^2.
    expect(strongest.spreading).toBe(1);
    expect(strongest.rangeM).toBeGreaterThan(3.9);
  });

  it('gives a small object a small share of the beam', () => {
    const room = emptyRoom('box', 8, 8, 4);
    room.obstacles = [pillar('post', { x: 0, y: 2 }, 0.2, 0.2, 0.9)];
    const rays = coneRays(vec3(0, 1, 0), (25 * Math.PI) / 180, 400);
    const targets = sampleBeam(room, vec3(0, 0, 0), vec3(0, 1, 0), rays);

    const post = targets.find((t) => Math.abs(t.rangeM - 1.9) < 0.2);
    expect(post, `targets: ${JSON.stringify(targets)}`).toBeDefined();
    // It occupies a sliver of the beam, so its effective target strength is a
    // sliver of the surface reflectivity — and it spreads as a point, 1/r^2.
    expect(post!.reflectivity).toBeLessThan(0.9 * 0.2);
    expect(post!.spreading).toBe(2);
  });

  it('returns nothing when everything is out of range', () => {
    const room = emptyRoom('hall', 40, 40, 10);
    const rays = coneRays(vec3(0, 1, 0), 0.3, 64);
    expect(sampleBeam(room, vec3(0, 0, 0), vec3(0, 1, 0), rays, {
      halfAngleDeg: 17,
      rays: 64,
      clusterM: 0.08,
      maxRangeM: 8,
    })).toEqual([]);
  });
});

describe('sweeps', () => {
  it('covers a full turn horizontally', () => {
    const poses = horizontalSweep(24);
    expect(poses).toHaveLength(24);
    for (const p of poses) {
      expect(Math.abs(p.beam.z)).toBeLessThan(1e-9); // level
      expect(Math.hypot(p.beam.x, p.beam.y, p.beam.z)).toBeCloseTo(1, 6);
    }
  });

  it('rasters serpentine so consecutive poses are adjacent', () => {
    const poses = rasterSweep(8, 3, 60);
    expect(poses).toHaveLength(24);
    // A real sweep does not teleport back to the start of each row.
    for (let i = 1; i < poses.length; i++) {
      const a = poses[i - 1]!.beam;
      const b = poses[i]!.beam;
      const angle = Math.acos(Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
      expect(angle).toBeLessThan(1.2);
    }
  });
});

describe('end-to-end: a room becomes a map', () => {
  let core: BatVuCore;
  beforeAll(async () => {
    core = await BatVuCore.load();
  });

  it('ranges the walls of an empty room correctly', () => {
    const room = emptyRoom('box', 4, 6, 3);
    const poses = horizontalSweep(8);
    const pings = simulateScan(core, room, poses, { sonar: DEFAULT_SONAR_CONFIG });
    expect(pings).toHaveLength(8);

    const plan = core.createPlan(
      DEFAULT_SONAR_CONFIG as unknown as Record<string, unknown>,
      recordLenFor(DEFAULT_SONAR_CONFIG),
    );
    try {
      let scored = 0;
      for (const p of pings) {
        if (p.truthRangesM.length === 0) continue;
        const result = plan.processSamples(p.samples);
        const s = scoreRanges(result.detections, p.truthRangesM, 0.15);
        // Every ping in a bare box points at a wall inside range; the detector
        // should find it, and should not invent a forest around it.
        expect(s.recall).toBeGreaterThan(0);
        expect(s.falsePositives).toBeLessThan(6);
        scored++;
      }
      expect(scored).toBeGreaterThan(4);
    } finally {
      plan.destroy();
    }
  });

  it('reconstructs a room better than it reconstructs a different room', () => {
    // The honest end-to-end assertion. An absolute IoU threshold would be a
    // number tuned until it passed; this asks the question that matters — does
    // the map resemble the room it scanned MORE than one it did not?
    const room = livingRoom();
    const poses = rasterSweep(20, 3, 50);
    const pings = simulateScan(core, room, poses, { sonar: DEFAULT_SONAR_CONFIG });

    const grid = new OccupancyGrid({ extentM: 4, voxelM: 0.12 });
    const plan = core.createPlan(
      DEFAULT_SONAR_CONFIG as unknown as Record<string, unknown>,
      recordLenFor(DEFAULT_SONAR_CONFIG),
    );
    try {
      for (const p of pings) {
        const result = plan.processSamples(p.samples);
        grid.integrate(result, {
          beam: p.pose.beam,
          origin: p.pose.origin,
          minRangeM: DEFAULT_SONAR_CONFIG.minRangeM,
          maxRangeM: DEFAULT_SONAR_CONFIG.maxRangeM,
        });
      }
    } finally {
      plan.destroy();
    }

    expect(grid.occupiedCount()).toBeGreaterThan(50);

    const right = occupancyIoU(grid, surfacePredicate(room, 0.12));
    // A room of a very different size and shape — the map should fit it worse.
    const wrong = occupancyIoU(grid, surfacePredicate(emptyRoom('other', 1.2, 1.2, 2.2), 0.12));
    expect(right).toBeGreaterThan(wrong * 1.5);
    expect(right).toBeGreaterThan(0.05);
  });

  it('replays bit for bit from the same seed', () => {
    const room = emptyRoom('box', 4, 5, 3);
    const poses = horizontalSweep(4);
    const a = simulateScan(core, room, poses, { seed: 1234 });
    const b = simulateScan(core, room, poses, { seed: 1234 });
    const c = simulateScan(core, room, poses, { seed: 9999 });

    expect(Array.from(a[0]!.samples)).toEqual(Array.from(b[0]!.samples));
    expect(Array.from(a[0]!.samples)).not.toEqual(Array.from(c[0]!.samples));
    // And no two pings within one scan share a noise realisation.
    expect(Array.from(a[0]!.samples)).not.toEqual(Array.from(a[1]!.samples));
  });
});
