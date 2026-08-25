// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import {
  TRANSDUCER_AXIS_DEVICE,
  angleBetween,
  angularCoverage,
  beamDirection,
  coneRays,
  deviceToWorld,
  dot,
  fromSpherical,
  normalize,
  sphericalBin,
  toSpherical,
  vec3,
  type Vec3,
} from '../src/index.js';

describe('device-to-world rotation', () => {
  it('is the identity at zero attitude', () => {
    const v = vec3(0.3, -0.5, 0.8);
    const w = deviceToWorld(v, { alpha: 0, beta: 0, gamma: 0 });
    expect(w.x).toBeCloseTo(v.x, 6);
    expect(w.y).toBeCloseTo(v.y, 6);
    expect(w.z).toBeCloseTo(v.z, 6);
  });

  it('preserves length for any attitude — it is a rotation, not a transform', () => {
    const v = vec3(0.3, -0.5, 0.8);
    const len = Math.hypot(v.x, v.y, v.z);
    for (const o of [
      { alpha: 30, beta: 45, gamma: -20 },
      { alpha: 180, beta: -90, gamma: 60 },
      { alpha: 359, beta: 12, gamma: 89 },
    ]) {
      const w = deviceToWorld(v, o);
      expect(Math.hypot(w.x, w.y, w.z)).toBeCloseTo(len, 5);
    }
  });

  it('turns the beam with heading', () => {
    // Phone flat, screen up, bottom edge pointing north: the beam goes north.
    const north = beamDirection({ alpha: 0, beta: 0, gamma: 0 });
    expect(north.x).toBeCloseTo(0, 5);
    expect(north.y).toBeCloseTo(-1, 5);

    // A 90 degree heading change must rotate the beam by 90 degrees.
    const turned = beamDirection({ alpha: 90, beta: 0, gamma: 0 });
    expect(angleBetween(north, turned)).toBeCloseTo(Math.PI / 2, 3);
  });

  it('points the beam where a hand-held phone points when tilted forward', () => {
    // beta = -90 tips the phone so the screen faces forward and the bottom edge
    // points DOWN in device terms — which in the world means the beam swings
    // toward the horizon. The property that matters: tilting must move the beam
    // out of the horizontal plane it started in, and by the tilted amount.
    const flat = beamDirection({ alpha: 0, beta: 0, gamma: 0 });
    const tilted = beamDirection({ alpha: 0, beta: 45, gamma: 0 });
    expect(angleBetween(flat, tilted)).toBeCloseTo(Math.PI / 4, 3);
    expect(Math.abs(tilted.z)).toBeGreaterThan(0.5);
  });

  it('names the transducer axis rather than burying it in arithmetic', () => {
    // Guards against the silent whole-map mirroring that a sign flip here causes.
    expect(TRANSDUCER_AXIS_DEVICE).toEqual({ x: 0, y: -1, z: 0 });
  });
});

describe('spherical coordinates', () => {
  it('round-trips through azimuth and elevation', () => {
    for (const d of [vec3(0, 1, 0), vec3(1, 0, 0), vec3(0, 0, 1), normalize(vec3(1, 2, -3))]) {
      const back = fromSpherical(toSpherical(d));
      const n = normalize(d);
      expect(back.x).toBeCloseTo(n.x, 5);
      expect(back.y).toBeCloseTo(n.y, 5);
      expect(back.z).toBeCloseTo(n.z, 5);
    }
  });

  it('puts north at azimuth zero and up at elevation +pi/2', () => {
    expect(toSpherical(vec3(0, 1, 0)).azimuth).toBeCloseTo(0, 6);
    expect(toSpherical(vec3(1, 0, 0)).azimuth).toBeCloseTo(Math.PI / 2, 6);
    expect(toSpherical(vec3(0, 0, 1)).elevation).toBeCloseTo(Math.PI / 2, 6);
  });

  it('bins directions into a bounded index space', () => {
    const bins = new Set<number>();
    for (let az = -180; az < 180; az += 5) {
      for (let el = -85; el <= 85; el += 5) {
        const d = fromSpherical({
          azimuth: (az * Math.PI) / 180,
          elevation: (el * Math.PI) / 180,
        });
        const b = sphericalBin(d, 36, 18);
        expect(b).toBeGreaterThanOrEqual(0);
        expect(b).toBeLessThan(36 * 18);
        bins.add(b);
      }
    }
    expect(bins.size).toBeGreaterThan(100);
  });
});

describe('cone sampling — the inverse sensor model geometry', () => {
  it('returns the axis alone for a degenerate cone', () => {
    const axis = normalize(vec3(1, 1, 0));
    expect(coneRays(axis, 0, 16)).toHaveLength(1);
    expect(coneRays(axis, 0.5, 1)).toHaveLength(1);
  });

  it('keeps every ray inside the requested half-angle', () => {
    const axis = normalize(vec3(0.2, -0.9, 0.3));
    const half = (30 * Math.PI) / 180;
    const rays = coneRays(axis, half, 64);
    expect(rays).toHaveLength(64);
    for (const r of rays) {
      expect(Math.hypot(r.x, r.y, r.z)).toBeCloseTo(1, 5);
      expect(angleBetween(axis, r)).toBeLessThanOrEqual(half + 1e-6);
    }
  });

  it('spreads rays through the cone rather than clustering on the axis', () => {
    const axis = vec3(0, 0, 1);
    const half = (30 * Math.PI) / 180;
    const rays = coneRays(axis, half, 200);
    const angles = rays.map((r) => angleBetween(axis, r));
    // Uniform in solid angle means the MEDIAN ray sits at about
    // acos(1 - (1-cos(half))/2), not at half/2.
    const median = angles.sort((a, b) => a - b)[Math.floor(angles.length / 2)]!;
    const expected = Math.acos(1 - (1 - Math.cos(half)) / 2);
    expect(median).toBeCloseTo(expected, 2);
    // And the outer half of the cone must be populated.
    expect(angles.filter((a) => a > half * 0.7).length).toBeGreaterThan(rays.length / 3);
  });

  it('stays well conditioned for axes aligned with any coordinate axis', () => {
    // A fixed basis seed degenerates when the beam aligns with it — this is the
    // "map goes wrong only when you point exactly north" class of bug.
    for (const axis of [vec3(1, 0, 0), vec3(0, 1, 0), vec3(0, 0, 1), vec3(-1, 0, 0)]) {
      const rays = coneRays(axis, 0.4, 32);
      for (const r of rays) {
        expect(Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.z)).toBe(true);
        expect(Math.hypot(r.x, r.y, r.z)).toBeCloseTo(1, 5);
      }
      // The rays must actually differ from one another.
      const spread = Math.max(...rays.map((r) => angleBetween(rays[0]!, r)));
      expect(spread).toBeGreaterThan(0.1);
    }
  });
});

describe('angular coverage — the scan progress signal', () => {
  it('is zero for no looks and small for a single direction', () => {
    expect(angularCoverage([])).toBe(0);
    expect(angularCoverage([vec3(0, 1, 0)])).toBeCloseTo(1 / (36 * 18), 6);
  });

  it('rises as a sweep covers more of the sphere', () => {
    const sweep = (count: number): Vec3[] => {
      const out: Vec3[] = [];
      for (let i = 0; i < count; i++) {
        out.push(
          fromSpherical({
            azimuth: (i / count) * 2 * Math.PI - Math.PI,
            elevation: 0,
          }),
        );
      }
      return out;
    };
    const narrow = angularCoverage(sweep(6));
    const wide = angularCoverage(sweep(36));
    expect(wide).toBeGreaterThan(narrow);
    // A horizontal sweep can only ever reach one elevation band out of 18.
    expect(wide).toBeLessThan(0.1);
  });

  it('does not credit repeated looks in the same direction', () => {
    const same = new Array(50).fill(vec3(0, 1, 0));
    expect(angularCoverage(same)).toBeCloseTo(1 / (36 * 18), 6);
  });
});

describe('vector helpers', () => {
  it('normalizes and degrades gracefully at zero', () => {
    const n = normalize(vec3(3, 4, 0));
    expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 6);
    expect(normalize(vec3(0, 0, 0))).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('computes angles safely at the numerical extremes', () => {
    expect(angleBetween(vec3(1, 0, 0), vec3(1, 0, 0))).toBeCloseTo(0, 6);
    expect(angleBetween(vec3(1, 0, 0), vec3(-1, 0, 0))).toBeCloseTo(Math.PI, 6);
    expect(Number.isFinite(angleBetween(vec3(1, 0, 0), vec3(1.0000001, 0, 0)))).toBe(true);
  });

  it('has a dot product consistent with the angle', () => {
    const a = normalize(vec3(1, 2, 3));
    const b = normalize(vec3(-2, 1, 0.5));
    expect(dot(a, b)).toBeCloseTo(Math.cos(angleBetween(a, b)), 6);
  });
});
