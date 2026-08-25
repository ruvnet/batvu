// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import {
  OccupancyGrid,
  occupancyIoU,
  normalize,
  vec3,
  scoreRanges,
  chamferDistance,
  type PingResult,
  type Vec3,
} from '../src/index.js';

/** A ping result with the fields the mapper actually reads. */
function ping(detections: { rangeM: number; snrDb?: number; widthM?: number }[]): PingResult {
  return {
    t0: 14,
    blastAmplitude: 0.4,
    saturated: false,
    sanitized: 0,
    startRangeM: 0.5,
    rangeStepM: 0.003575,
    noiseFloor: 1e-4,
    envLen: 2000,
    detections: detections.map((d) => ({
      rangeM: d.rangeM,
      amplitude: 0.05,
      snrDb: d.snrDb ?? 25,
      widthM: d.widthM ?? 0.07,
    })),
  };
}

const OPTS = { minRangeM: 0.5, maxRangeM: 6 };

describe('the occupancy grid', () => {
  it('sizes its backing store predictably', () => {
    const g = new OccupancyGrid({ extentM: 6, voxelM: 0.1 });
    expect(g.dim).toBe(120);
    expect(g.voxelCount).toBe(120 ** 3);
    // 14 MB (log-odds plus the per-ping touch stamps) — fine on a phone. The
    // same extent at 5 cm would be 110 MB and at 2 cm 7 GB, which is the whole
    // reason the grid is bounded.
    expect(g.byteLength / 1e6).toBeCloseTo(13.8, 0);
  });

  it('maps world points to voxels and back to their centres', () => {
    const g = new OccupancyGrid({ extentM: 2, voxelM: 0.5 });
    const idx = g.indexOf(vec3(0.1, 0.1, 0.1));
    expect(idx).toBeGreaterThanOrEqual(0);
    const c = g.centerOf(idx);
    expect(Math.abs(c.x - 0.1)).toBeLessThanOrEqual(0.25);
    expect(Math.abs(c.y - 0.1)).toBeLessThanOrEqual(0.25);
    // Outside the cube is -1, not a wrapped index — silently wrapping would
    // fold far echoes back into the middle of the room.
    expect(g.indexOf(vec3(99, 0, 0))).toBe(-1);
    expect(g.indexOf(vec3(0, -99, 0))).toBe(-1);
  });

  it('carves free space along the beam when nothing comes back', () => {
    const g = new OccupancyGrid({ extentM: 4, voxelM: 0.1 });
    const beam = vec3(0, 1, 0);
    g.integrate(ping([]), { beam, ...OPTS });

    // Silence means the cone is clear all the way out.
    expect(g.logOddsAt(vec3(0, 2, 0))).toBeLessThan(0);
    expect(g.logOddsAt(vec3(0, 3.5, 0))).toBeLessThan(0);
    expect(g.occupiedCount()).toBe(0);
    // Behind the phone is untouched — the beam never looked there.
    expect(g.logOddsAt(vec3(0, -2, 0))).toBe(0);
  });

  it('leaves the space behind a detection unknown rather than free', () => {
    const g = new OccupancyGrid({ extentM: 4, voxelM: 0.1 });
    g.integrate(ping([{ rangeM: 2 }]), { beam: vec3(0, 1, 0), ...OPTS });

    expect(g.logOddsAt(vec3(0, 1.0, 0))).toBeLessThan(0); // in front: carved free
    expect(g.logOddsAt(vec3(0, 2.0, 0))).toBeGreaterThan(0); // the surface
    // Shadowed: a first reflector hides everything behind it, and claiming that
    // space is free would delete real furniture from the map.
    expect(g.logOddsAt(vec3(0, 3.5, 0))).toBe(0);
  });

  it('spreads a single detection across the whole beam cone', () => {
    const g = new OccupancyGrid({ extentM: 4, voxelM: 0.1, beamHalfAngleDeg: 30 });
    g.integrate(ping([{ rangeM: 2 }]), { beam: vec3(0, 1, 0), ...OPTS });

    // On-axis and 25 degrees off-axis both carry evidence: the sensor genuinely
    // cannot tell them apart, and pretending otherwise is the fabrication this
    // whole model exists to avoid.
    const offAxis = normalize(vec3(Math.sin(0.44), Math.cos(0.44), 0));
    expect(g.logOddsAt(vec3(0, 2, 0))).toBeGreaterThan(0);
    expect(g.logOddsAt({ x: offAxis.x * 2, y: offAxis.y * 2, z: 0 })).toBeGreaterThan(0);
    // But 50 degrees off-axis is outside the beam and stays untouched.
    const outside = normalize(vec3(Math.sin(0.9), Math.cos(0.9), 0));
    expect(g.logOddsAt({ x: outside.x * 2, y: outside.y * 2, z: 0 })).toBe(0);
  });

  it('sharpens only where cones from different attitudes intersect', () => {
    // THE load-bearing property of the whole design: one wide-beam ping cannot
    // localise anything, and a sweep can.
    const cfg = { extentM: 4, voxelM: 0.1, beamHalfAngleDeg: 25, occupiedThreshold: 1.4 };
    const target = vec3(0, 2, 0);

    const one = new OccupancyGrid(cfg);
    one.integrate(ping([{ rangeM: 2 }]), { beam: vec3(0, 1, 0), ...OPTS });
    expect(one.occupiedCount()).toBe(0);

    // Now look at the same target from three attitudes, all of which still see
    // it at 2 m but whose cones only overlap near the truth.
    const many = new OccupancyGrid(cfg);
    for (const deg of [-20, 0, 20]) {
      const a = (deg * Math.PI) / 180;
      many.integrate(ping([{ rangeM: 2 }]), {
        beam: normalize(vec3(Math.sin(a), Math.cos(a), 0)),
        ...OPTS,
      });
    }
    expect(many.occupiedCount()).toBeGreaterThan(0);

    // And what became occupied is near the target, not smeared over the arc.
    const points = many.occupiedPoints();
    const centroid = points.reduce((acc, p) => ({ x: acc.x + p.x / points.length, y: acc.y + p.y / points.length, z: acc.z + p.z / points.length }), { x: 0, y: 0, z: 0 });
    expect(Math.hypot(centroid.x - target.x, centroid.y - target.y, centroid.z - target.z)).toBeLessThan(0.4);
  });

  it('weights evidence by SNR', () => {
    const strong = new OccupancyGrid({ extentM: 4, voxelM: 0.1 });
    const weak = new OccupancyGrid({ extentM: 4, voxelM: 0.1 });
    strong.integrate(ping([{ rangeM: 2, snrDb: 40 }]), { beam: vec3(0, 1, 0), ...OPTS });
    weak.integrate(ping([{ rangeM: 2, snrDb: 4 }]), { beam: vec3(0, 1, 0), ...OPTS });
    expect(strong.logOddsAt(vec3(0, 2, 0))).toBeGreaterThan(weak.logOddsAt(vec3(0, 2, 0)));
  });

  it('ignores a saturated ping entirely', () => {
    const g = new OccupancyGrid({ extentM: 4, voxelM: 0.1 });
    const clipped = { ...ping([{ rangeM: 2 }]), saturated: true };
    const stats = g.integrate(clipped, { beam: vec3(0, 1, 0), ...OPTS });
    // A clipped record's ranges are fiction. It still carves free space — the
    // absence of a valid detection is treated as silence, not as a surface.
    expect(stats.detections).toBe(0);
    expect(stats.voxelsOccupiedEvidence).toBe(0);
    expect(g.occupiedCount()).toBe(0);
  });

  it('clamps log-odds so the map can still change its mind', () => {
    const g = new OccupancyGrid({ extentM: 4, voxelM: 0.1, logOddsMax: 4 });
    for (let i = 0; i < 200; i++) {
      g.integrate(ping([{ rangeM: 2 }]), { beam: vec3(0, 1, 0), ...OPTS });
    }
    expect(g.logOddsAt(vec3(0, 2, 0))).toBeLessThanOrEqual(4 + 1e-6);

    // Saturation would make the surface permanent; clamping lets 200 pings of
    // free space undo it, which is what "the chair moved" looks like.
    for (let i = 0; i < 200; i++) {
      g.integrate(ping([]), { beam: vec3(0, 1, 0), ...OPTS });
    }
    expect(g.logOddsAt(vec3(0, 2, 0))).toBeLessThan(0);
  });

  it('produces a signature that tracks map changes and nothing else', () => {
    const g = new OccupancyGrid({ extentM: 4, voxelM: 0.1 });
    const empty = g.stateSignature();
    g.integrate(ping([{ rangeM: 2 }]), { beam: vec3(0, 1, 0), ...OPTS });
    const afterOne = g.stateSignature();
    expect(afterOne).not.toBe(empty);

    // A second identical ping DOES change the map (log-odds accumulate)...
    g.integrate(ping([{ rangeM: 2 }]), { beam: vec3(0, 1, 0), ...OPTS });
    expect(g.stateSignature()).not.toBe(afterOne);

    // ...but once every voxel has saturated, the signature settles, which is
    // exactly the no-progress signal the halt controller waits for.
    for (let i = 0; i < 60; i++) {
      g.integrate(ping([{ rangeM: 2 }]), { beam: vec3(0, 1, 0), ...OPTS });
    }
    const settled = g.stateSignature();
    g.integrate(ping([{ rangeM: 2 }]), { beam: vec3(0, 1, 0), ...OPTS });
    expect(g.stateSignature()).toBe(settled);
  });

  it('reports entropy as confidence, not coverage', () => {
    const g = new OccupancyGrid({ extentM: 4, voxelM: 0.1 });
    expect(g.meanEntropy()).toBe(0); // nothing known at all

    g.integrate(ping([{ rangeM: 2, snrDb: 8 }]), { beam: vec3(0, 1, 0), ...OPTS });
    const uncertain = g.meanEntropy();
    expect(uncertain).toBeGreaterThan(0.5);

    for (let i = 0; i < 20; i++) {
      g.integrate(ping([{ rangeM: 2, snrDb: 30 }]), { beam: vec3(0, 1, 0), ...OPTS });
    }
    expect(g.meanEntropy()).toBeLessThan(uncertain);
  });

  it('resets to a blank map', () => {
    const g = new OccupancyGrid({ extentM: 4, voxelM: 0.2 });
    g.integrate(ping([{ rangeM: 2 }]), { beam: vec3(0, 1, 0), ...OPTS });
    expect(g.knownCount()).toBeGreaterThan(0);
    g.reset();
    expect(g.knownCount()).toBe(0);
    expect(g.updateCount).toBe(0);
  });

  it('rejects nonsensical geometry rather than producing a broken grid', () => {
    expect(() => new OccupancyGrid({ voxelM: 0 })).toThrow(/voxelM/);
    expect(() => new OccupancyGrid({ extentM: -1 })).toThrow(/extentM/);
  });
});

describe('occupancyIoU', () => {
  it('scores a perfect map at 1 and an empty one at 0', () => {
    const g = new OccupancyGrid({ extentM: 2, voxelM: 0.25, occupiedThreshold: 1.4 });
    const truth = (p: Vec3): boolean => Math.hypot(p.x, p.y - 1.5, p.z) < 0.3;
    // Nothing predicted, something true -> 0.
    expect(occupancyIoU(g, truth)).toBe(0);
    // Nothing predicted, nothing true -> 1 (vacuously correct).
    expect(occupancyIoU(g, () => false)).toBe(1);
  });

  it('rewards a map that actually finds the object', () => {
    const cfg = { extentM: 3, voxelM: 0.15, beamHalfAngleDeg: 20, occupiedThreshold: 1.4 };
    const g = new OccupancyGrid(cfg);
    for (const deg of [-15, 0, 15]) {
      const a = (deg * Math.PI) / 180;
      g.integrate(ping([{ rangeM: 1.5 }]), {
        beam: normalize(vec3(Math.sin(a), Math.cos(a), 0)),
        ...OPTS,
      });
    }
    const nearTruth = (p: Vec3): boolean => Math.abs(Math.hypot(p.x, p.y, p.z) - 1.5) < 0.2 && p.y > 1.0 && Math.abs(p.z) < 0.3;
    const wrongTruth = (p: Vec3): boolean => p.y < -1;
    expect(occupancyIoU(g, nearTruth)).toBeGreaterThan(occupancyIoU(g, wrongTruth));
  });
});

describe('range scoring', () => {
  it('matches strongest detections to targets without double-counting', () => {
    const s = scoreRanges(
      [
        { rangeM: 2.01, snrDb: 30 },
        { rangeM: 2.03, snrDb: 10 }, // a second claim on the same target
        { rangeM: 4.0, snrDb: 20 },
      ],
      [2.0, 4.0],
      0.1,
    );
    expect(s.truePositives).toBe(2);
    expect(s.falsePositives).toBe(1);
    expect(s.falseNegatives).toBe(0);
    expect(s.recall).toBe(1);
    expect(s.precision).toBeCloseTo(2 / 3, 5);
  });

  it('does not let recall alone look like success', () => {
    const ghosts = Array.from({ length: 40 }, (_, i) => ({ rangeM: 0.6 + i * 0.15, snrDb: 7 }));
    const s = scoreRanges(ghosts, [2.0, 4.1], 0.1);
    expect(s.recall).toBeGreaterThan(0.5);
    expect(s.f1).toBeLessThan(0.2); // F1 sees through it
  });

  it('measures range error over matched pairs only', () => {
    const s = scoreRanges([{ rangeM: 2.05, snrDb: 20 }], [2.0, 5.0], 0.1);
    expect(s.rangeRmseM).toBeCloseTo(0.05, 5);
    expect(s.maxErrorM).toBeCloseTo(0.05, 5);
    expect(s.falseNegatives).toBe(1);
  });

  it('handles the empty cases without NaN leaking into a score', () => {
    const empty = scoreRanges([], [], 0.1);
    expect(empty.precision).toBe(1);
    expect(empty.recall).toBe(1);
    expect(empty.f1).toBe(1);

    const allMissed = scoreRanges([], [2.0], 0.1);
    expect(allMissed.recall).toBe(0);
    expect(allMissed.f1).toBe(0);
    expect(Number.isNaN(allMissed.rangeRmseM)).toBe(true);
  });
});

describe('chamferDistance', () => {
  it('is zero for identical clouds and grows with displacement', () => {
    const a = [vec3(0, 0, 0), vec3(1, 0, 0)];
    expect(chamferDistance(a, a)).toBeCloseTo(0, 6);
    const b = [vec3(0, 0, 0.5), vec3(1, 0, 0.5)];
    expect(chamferDistance(a, b)).toBeCloseTo(0.5, 6);
  });

  it('is infinite when one side is empty', () => {
    expect(chamferDistance([], [vec3(0, 0, 0)])).toBe(Infinity);
  });
});
