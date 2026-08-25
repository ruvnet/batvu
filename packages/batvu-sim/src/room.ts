// SPDX-License-Identifier: MIT
//
// A 3-D room, and what a beam pointed into it actually returns.
//
// The Rust core simulates a 1-D scene: a list of ranges with amplitudes. That is
// the right primitive for testing the DSP, and it is not enough to test MAPPING,
// which is entirely about direction. This module supplies the missing half — a
// scene with geometry, from which the per-attitude range list is DERIVED rather
// than assumed.
//
// Deriving it is what makes the end-to-end test meaningful. Hand-writing "at
// this attitude the sonar sees 2.4 m" bakes the answer into the test; casting
// rays through a room means the mapper is scored against the room, and a
// mistake in the beam geometry shows up as a wrong map instead of a passing test.
//
// ## The target-strength model
//
// A cone that a wall fills completely returns far more energy than one where a
// chair occupies 5% of the beam. So each cluster of ray hits carries the
// FRACTION of the beam it occupies, and its effective reflectivity scales with
// that fraction. The same fraction decides the spreading exponent: a surface
// filling much of the beam spreads as `1/r` (extended), a small one as `1/r^2`
// (compact). Both are the sonar equation's target-strength term, discretised.

import type { SimTarget, Vec3 } from '@batvu/core';

export interface Box {
  min: Vec3;
  max: Vec3;
  /** Reflection coefficient of the surface, 0..1. */
  reflectivity: number;
  label?: string;
}

export interface Room {
  name: string;
  /** The room shell. Rays start inside it and hit it from the inside. */
  shell: Box;
  /** Solid objects inside the room. */
  obstacles: Box[];
}

export interface RayHit {
  distanceM: number;
  reflectivity: number;
  /** Which object was hit; `null` means the room shell. */
  label: string | null;
}

const EPS = 1e-9;

/**
 * Distance at which a ray leaves an axis-aligned box it starts inside.
 * Slab method, returning the near exit — the wall the beam actually reaches.
 */
function exitDistance(origin: Vec3, dir: Vec3, box: Box): number | null {
  let tExit = Infinity;
  for (const axis of ['x', 'y', 'z'] as const) {
    const d = dir[axis];
    const o = origin[axis];
    if (Math.abs(d) < EPS) {
      // Parallel to this slab: outside it means the ray never was inside.
      if (o < box.min[axis] || o > box.max[axis]) return null;
      continue;
    }
    const t1 = (box.min[axis] - o) / d;
    const t2 = (box.max[axis] - o) / d;
    const tFar = Math.max(t1, t2);
    if (tFar < tExit) tExit = tFar;
  }
  return Number.isFinite(tExit) && tExit > 0 ? tExit : null;
}

/** Distance at which a ray starting outside a box enters it, or null. */
function entryDistance(origin: Vec3, dir: Vec3, box: Box): number | null {
  let tNear = -Infinity;
  let tFar = Infinity;
  for (const axis of ['x', 'y', 'z'] as const) {
    const d = dir[axis];
    const o = origin[axis];
    if (Math.abs(d) < EPS) {
      if (o < box.min[axis] || o > box.max[axis]) return null;
      continue;
    }
    const t1 = (box.min[axis] - o) / d;
    const t2 = (box.max[axis] - o) / d;
    tNear = Math.max(tNear, Math.min(t1, t2));
    tFar = Math.min(tFar, Math.max(t1, t2));
  }
  if (tNear > tFar || tFar < 0) return null;
  return tNear > 0 ? tNear : null; // origin inside the obstacle: no surface ahead
}

/** The first surface a ray meets: the nearest obstacle, or else the shell. */
export function castRay(room: Room, origin: Vec3, dir: Vec3): RayHit | null {
  let best: RayHit | null = null;
  for (const box of room.obstacles) {
    const t = entryDistance(origin, dir, box);
    if (t !== null && (best === null || t < best.distanceM)) {
      best = { distanceM: t, reflectivity: box.reflectivity, label: box.label ?? 'obstacle' };
    }
  }
  const wall = exitDistance(origin, dir, room.shell);
  if (wall !== null && (best === null || wall < best.distanceM)) {
    best = { distanceM: wall, reflectivity: room.shell.reflectivity, label: null };
  }
  return best;
}

/** Is a world point inside a solid object (or outside the room)? The ground
 *  truth predicate the occupancy IoU is scored against. */
export function isSolid(room: Room, p: Vec3): boolean {
  for (const box of room.obstacles) {
    if (
      p.x >= box.min.x && p.x <= box.max.x &&
      p.y >= box.min.y && p.y <= box.max.y &&
      p.z >= box.min.z && p.z <= box.max.z
    ) {
      return true;
    }
  }
  const s = room.shell;
  return !(p.x > s.min.x && p.x < s.max.x && p.y > s.min.y && p.y < s.max.y && p.z > s.min.z && p.z < s.max.z);
}

/**
 * A ground-truth predicate for the SURFACE shell rather than solid volume.
 *
 * Occupancy mapping can only ever mark surfaces — a sonar never sees the inside
 * of a wall — so scoring against solid volume punishes a correct map for not
 * filling in what it cannot observe. `toleranceM` should be about one voxel.
 */
export function surfacePredicate(room: Room, toleranceM: number): (p: Vec3) => boolean {
  return (p: Vec3): boolean => {
    const inside = isSolid(room, p);
    if (!inside) {
      // Free space counts as surface if it is within tolerance of something solid.
      return nearSolid(room, p, toleranceM);
    }
    // Solid space counts as surface only near its own boundary.
    return nearFree(room, p, toleranceM);
  };
}

function nearSolid(room: Room, p: Vec3, tol: number): boolean {
  for (const d of NEIGHBOUR_OFFSETS) {
    if (isSolid(room, { x: p.x + d.x * tol, y: p.y + d.y * tol, z: p.z + d.z * tol })) return true;
  }
  return false;
}

function nearFree(room: Room, p: Vec3, tol: number): boolean {
  for (const d of NEIGHBOUR_OFFSETS) {
    if (!isSolid(room, { x: p.x + d.x * tol, y: p.y + d.y * tol, z: p.z + d.z * tol })) return true;
  }
  return false;
}

const NEIGHBOUR_OFFSETS: Vec3[] = [
  { x: 1, y: 0, z: 0 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
];

export interface BeamSampleOptions {
  /** Beam half-angle in degrees. */
  halfAngleDeg: number;
  /** Rays used to sample the cone. More rays = a finer target-strength estimate. */
  rays: number;
  /** Ranges closer together than this fuse into one target. Set it to the
   *  sonar's range resolution: closer than that, the sonar cannot tell either. */
  clusterM: number;
  /** Furthest range worth simulating. */
  maxRangeM: number;
}

export const DEFAULT_BEAM_SAMPLE: BeamSampleOptions = {
  halfAngleDeg: 30,
  rays: 256,
  clusterM: 0.08,
  maxRangeM: 8,
};

/**
 * What the sonar would see from `origin` looking along `beam`: the 1-D target
 * list to hand the Rust simulator.
 *
 * The beam is sampled by ray casting, hits are clustered by range, and each
 * cluster's share of the beam becomes its target strength.
 */
export function sampleBeam(
  room: Room,
  origin: Vec3,
  beam: Vec3,
  rays: Vec3[],
  opts: BeamSampleOptions = DEFAULT_BEAM_SAMPLE,
): SimTarget[] {
  void beam;
  const hits: RayHit[] = [];
  for (const ray of rays) {
    const hit = castRay(room, origin, ray);
    if (hit && hit.distanceM > 0 && hit.distanceM <= opts.maxRangeM) hits.push(hit);
  }
  if (hits.length === 0) return [];

  hits.sort((a, b) => a.distanceM - b.distanceM);
  const clusters: { ranges: number[]; reflectivity: number; count: number }[] = [];
  for (const h of hits) {
    const last = clusters[clusters.length - 1];
    if (last && h.distanceM - last.ranges[last.ranges.length - 1]! <= opts.clusterM) {
      last.ranges.push(h.distanceM);
      last.reflectivity = (last.reflectivity * last.count + h.reflectivity) / (last.count + 1);
      last.count++;
    } else {
      clusters.push({ ranges: [h.distanceM], reflectivity: h.reflectivity, count: 1 });
    }
  }

  const total = rays.length;
  return clusters.map((c) => {
    const fraction = c.count / total;
    const meanRange = c.ranges.reduce((a, b) => a + b, 0) / c.ranges.length;
    return {
      rangeM: meanRange,
      // A surface returns in proportion to how much of the beam it intercepts.
      reflectivity: c.reflectivity * fraction,
      // Extended surfaces spread as 1/r, compact ones as 1/r^2. The crossover
      // is the point where a target stops being "a wall" and starts being "an
      // object", and 25% of the beam is a defensible place to put it.
      spreading: fraction >= 0.25 ? 1 : 2,
    };
  });
}

// ─────────────────────────────────────────────────────────── stock rooms ──

/** A plain rectangular room with the phone standing at the origin. */
export function emptyRoom(name: string, widthM: number, depthM: number, heightM: number): Room {
  return {
    name,
    shell: {
      min: { x: -widthM / 2, y: -depthM / 2, z: -heightM / 2 },
      max: { x: widthM / 2, y: depthM / 2, z: heightM / 2 },
      reflectivity: 0.85,
    },
    obstacles: [],
  };
}

/** An upright box obstacle centred on a floor position. */
export function pillar(
  label: string,
  centre: { x: number; y: number },
  sizeM: number,
  heightM: number,
  reflectivity = 0.7,
): Box {
  return {
    label,
    reflectivity,
    min: { x: centre.x - sizeM / 2, y: centre.y - sizeM / 2, z: -heightM / 2 },
    max: { x: centre.x + sizeM / 2, y: centre.y + sizeM / 2, z: heightM / 2 },
  };
}
