// SPDX-License-Identifier: MIT
//
// Pose: turning "which way is the phone pointing" into a direction vector.
//
// This is the layer that makes a range-only sensor into a spatial one. The DSP
// core answers "there is something 2.4 m away"; only the pose says 2.4 m *in
// which direction*. Everything BatVu can claim about a room's shape rests on
// this file being right.
//
// ## Frames
//
// World frame is East-North-Up, right-handed:
//   +X = east, +Y = north, +Z = up.
//
// Device frame follows the W3C DeviceOrientation convention: +x out the right
// edge of the screen, +y out the top, +z out of the screen toward the user. The
// speaker and mic are at the BOTTOM of the phone and radiate roughly along the
// device's -y axis... which is exactly the kind of assumption that silently
// mirrors an entire map, so it is a named, testable constant rather than
// arithmetic buried in a rotation.
//
// ## What the browser actually gives us
//
// `DeviceOrientationEvent` reports intrinsic Z-X'-Y'' Tait-Bryan angles
// (alpha, beta, gamma) in degrees. `alpha` is heading, and on iOS it is relative
// to an arbitrary origin unless you use the non-standard `webkitCompassHeading`
// — so BatVu treats azimuth as RELATIVE to wherever the scan started. That is
// fine for mapping a room's shape and useless for mapping it onto a floor plan,
// and pretending otherwise would be the single easiest way to ship a lie.

/** A unit direction vector in the world frame. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Device attitude as the W3C reports it, in degrees. */
export interface DeviceOrientation {
  /** Rotation about Z (heading), 0..360. */
  alpha: number;
  /** Rotation about X' (front-back tilt), -180..180. */
  beta: number;
  /** Rotation about Y'' (left-right tilt), -90..90. */
  gamma: number;
}

/**
 * Which way the transducers point in the DEVICE frame.
 *
 * Speaker and mic sit on the bottom edge and radiate along -y with a strong
 * component out the back. Held like a torch — screen up, bottom edge forward —
 * that puts the beam where the user is looking. Getting the sign wrong here
 * mirrors the whole map front-to-back, so `alignsWithHandheldUse` in the tests
 * pins it down.
 */
export const TRANSDUCER_AXIS_DEVICE: Vec3 = { x: 0, y: -1, z: 0 };

const DEG = Math.PI / 180;

export function vec3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export function normalize(v: Vec3): Vec3 {
  const n = Math.hypot(v.x, v.y, v.z);
  if (n < 1e-12) return { x: 0, y: 0, z: 0 };
  return { x: v.x / n, y: v.y / n, z: v.z / n };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function scale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Angle between two vectors in radians, numerically safe at 0 and pi. */
export function angleBetween(a: Vec3, b: Vec3): number {
  const na = normalize(a);
  const nb = normalize(b);
  return Math.acos(Math.min(1, Math.max(-1, dot(na, nb))));
}

/**
 * Rotate a device-frame vector into the world frame.
 *
 * The W3C composition is intrinsic Z-X'-Y'' — `R = Rz(alpha) * Rx(beta) *
 * Ry(gamma)` — and the order is not a detail: any other order gives a rotation
 * that looks plausible while tilting the map.
 */
export function deviceToWorld(v: Vec3, o: DeviceOrientation): Vec3 {
  const a = o.alpha * DEG;
  const b = o.beta * DEG;
  const g = o.gamma * DEG;

  const [ca, sa] = [Math.cos(a), Math.sin(a)];
  const [cb, sb] = [Math.cos(b), Math.sin(b)];
  const [cg, sg] = [Math.cos(g), Math.sin(g)];

  // Ry(gamma)
  let x = cg * v.x + sg * v.z;
  let y = v.y;
  let z = -sg * v.x + cg * v.z;

  // Rx(beta)
  const y1 = cb * y - sb * z;
  const z1 = sb * y + cb * z;
  y = y1;
  z = z1;

  // Rz(alpha)
  const x2 = ca * x - sa * y;
  const y2 = sa * x + ca * y;
  x = x2;
  y = y2;

  return { x, y, z };
}

/** Where the sonar beam points in the world, for a given device attitude. */
export function beamDirection(o: DeviceOrientation): Vec3 {
  return normalize(deviceToWorld(TRANSDUCER_AXIS_DEVICE, o));
}

/** Azimuth (radians, 0 = +Y/north, increasing toward +X/east) and elevation
 *  (radians, 0 = horizon, +pi/2 = up) of a direction. */
export interface Spherical {
  azimuth: number;
  elevation: number;
}

export function toSpherical(d: Vec3): Spherical {
  const n = normalize(d);
  return {
    azimuth: Math.atan2(n.x, n.y),
    elevation: Math.asin(Math.min(1, Math.max(-1, n.z))),
  };
}

export function fromSpherical(s: Spherical): Vec3 {
  const ce = Math.cos(s.elevation);
  return {
    x: ce * Math.sin(s.azimuth),
    y: ce * Math.cos(s.azimuth),
    z: Math.sin(s.elevation),
  };
}

/**
 * Sample `count` directions inside a cone of half-angle `halfAngleRad` about
 * `axis`, spread by the Fibonacci spiral.
 *
 * This is the geometric heart of the inverse sensor model. A phone speaker has
 * no beam worth the name — its pattern at 20 kHz is tens of degrees wide — so an
 * echo at 2.4 m constrains a spherical CAP, not a ray. Representing that
 * honestly means spreading the evidence across the cap, and it is only where
 * caps from different attitudes INTERSECT that the map sharpens. Casting one ray
 * per ping instead would draw a crisp, confident, wrong picture.
 *
 * The spiral gives near-uniform solid-angle coverage for any count, so the
 * ray budget is a smooth quality/cost lever rather than a step function.
 */
export function coneRays(axis: Vec3, halfAngleRad: number, count: number): Vec3[] {
  const n = Math.max(1, Math.floor(count));
  const a = normalize(axis);
  if (n === 1 || halfAngleRad <= 0) return [a];

  // An orthonormal basis around the axis. Choosing the seed by the axis's
  // SMALLEST component keeps the cross product well conditioned; using a fixed
  // seed degenerates when the axis happens to align with it.
  const abs = { x: Math.abs(a.x), y: Math.abs(a.y), z: Math.abs(a.z) };
  const seed: Vec3 =
    abs.x <= abs.y && abs.x <= abs.z
      ? { x: 1, y: 0, z: 0 }
      : abs.y <= abs.z
        ? { x: 0, y: 1, z: 0 }
        : { x: 0, y: 0, z: 1 };
  const u = normalize(cross(a, seed));
  const v = cross(a, u);

  const cosHalf = Math.cos(halfAngleRad);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const out: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    // Uniform in solid angle: cos(theta) uniform on [cosHalf, 1].
    const cosTheta = 1 - ((i + 0.5) / n) * (1 - cosHalf);
    const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
    const phi = i * golden;
    out.push(
      normalize({
        x: a.x * cosTheta + (u.x * Math.cos(phi) + v.x * Math.sin(phi)) * sinTheta,
        y: a.y * cosTheta + (u.y * Math.cos(phi) + v.y * Math.sin(phi)) * sinTheta,
        z: a.z * cosTheta + (u.z * Math.cos(phi) + v.z * Math.sin(phi)) * sinTheta,
      }),
    );
  }
  return out;
}

/**
 * Angular coverage of a set of beam directions, as a fraction of the full
 * sphere estimated by binning.
 *
 * This is the scan's PROGRESS SIGNAL: it is what tells the horizon halt
 * controller that sweeping further is no longer learning anything. A scan that
 * has covered one wall thoroughly and nothing else has high confidence and low
 * coverage, and only coverage can tell the difference.
 */
export function angularCoverage(directions: Vec3[], azBins = 36, elBins = 18): number {
  if (directions.length === 0) return 0;
  const seen = new Set<number>();
  for (const d of directions) {
    seen.add(sphericalBin(d, azBins, elBins));
  }
  return seen.size / (azBins * elBins);
}

/** Bin index for a direction on an (azimuth x elevation) grid. */
export function sphericalBin(d: Vec3, azBins: number, elBins: number): number {
  const { azimuth, elevation } = toSpherical(d);
  const az = Math.min(
    azBins - 1,
    Math.max(0, Math.floor(((azimuth + Math.PI) / (2 * Math.PI)) * azBins)),
  );
  const el = Math.min(
    elBins - 1,
    Math.max(0, Math.floor(((elevation + Math.PI / 2) / Math.PI) * elBins)),
  );
  return el * azBins + az;
}
