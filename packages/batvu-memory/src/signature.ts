// SPDX-License-Identifier: MIT
//
// A room signature: 128 numbers that survive the one thing BatVu does not know.
//
// ## The symmetry, which is the whole design
//
// BatVu builds its map in the world frame of `@batvu/core`'s geometry module —
// East-North-Up, `+Z` up. Two of those three axes are pinned by physics: the
// phone's accelerometer measures gravity, so `beta` and `gamma` fix which way is
// down, and therefore ELEVATION IS ABSOLUTE. A voxel 30° above the horizon is
// 30° above the horizon in every scan of every room.
//
// The third is not pinned. iOS reports `alpha` relative to an arbitrary origin
// unless the page uses the non-standard `webkitCompassHeading`, so BatVu treats
// azimuth as relative to wherever the scan happened to start (see the frames
// note in `geometry.ts`). Scan the same room twice, a quarter turn apart, and
// every voxel moves — rigidly, by one unknown rotation about `+Z`.
//
// So the unknown is not "some rotation". It is exactly the group SO(2) about
// gravity, and a signature that is invariant under SO(2) about `+Z` and nothing
// more is invariant under precisely as much as it has to be. Discarding the
// other two degrees of freedom, as a fully rotation-invariant descriptor would,
// would be throwing away measurements the accelerometer already paid for.
//
// ## How the invariance is obtained
//
// Bin the map into E elevation bands × A azimuth bins. A rotation by an integer
// number `m` of azimuth bins is then a circular SHIFT of each band's azimuth
// row. The DFT shift theorem says a circular shift multiplies the k-th
// coefficient by `exp(-2πi·k·m/A)` — a unit complex number — so the MAGNITUDE
// spectrum is unchanged:
//
//     x[(a - m) mod A]  ──DFT──▶  X[k]·exp(-2πi·k·m/A)
//     |X[k]·exp(...)| = |X[k]|                              exactly, for all k
//
// That is exact for shifts that land on a bin boundary and approximate
// otherwise, because a real rotation lands mid-bin and the binning smears
// energy between neighbours. The smear is a phase error of at most `π·k/A`
// radians in the k-th coefficient — it grows LINEARLY IN k. Keeping only the
// lowest K harmonics is therefore not merely dimension reduction; it is the
// part of the spectrum where the invariance actually holds. K = 6 of A = 64
// bounds the worst-case mid-bin phase error at `π·6/64` ≈ 17°.
//
// ## What it will not do
//
// - **It is not invariant to translation.** Move the phone two metres and the
//   range profile changes for real; this says "not the same place", and it is
//   not wrong to, because from two metres away it is a different vantage point.
//   The recognisable unit is a *standing spot*, not a room.
// - **It cannot separate congruent rooms.** Two identical hotel rooms, two
//   identical offices, the two ends of a symmetric corridor: same shape, same
//   signature. Geometry is all this has; there is no texture, no colour, no
//   radio fingerprint. Pair it with one of those if you need identity.
// - **It degrades with partial coverage.** A sweep that covered 60% of the
//   sphere leaves empty azimuth sectors, and an empty sector is evidence-shaped:
//   it moves with the sweep, not with the room. `coverage` rides along in the
//   descriptor so a caller can refuse a comparison it should not trust, and
//   `__tests__/signature.test.ts` measures how fast the similarity actually
//   falls off rather than asserting that it does not.
// - **It is a similarity, not a probability.** Cosine 0.97 does not mean 97%
//   confident. Thresholds must be picked against a measured distribution, which
//   is what `bench/` does.

import { OccupancyGrid, type Vec3 } from '@batvu/core';

/** Elevation bands. 8 over the sphere is ~22.5° each — coarse enough to be
 *  stable under the beam's ±30° cone, fine enough to separate floor, walls and
 *  ceiling, which is the distinction that carries most of a room's shape. */
export const ELEVATION_BANDS = 8;

/** Azimuth bins. Powers of two keep the shift-theorem argument exact for the
 *  rotations that matter and make the naive DFT cheap. */
export const AZIMUTH_BINS = 64;

/** Retained harmonics per band, including DC. See the phase-error bound above. */
export const HARMONICS = 6;

/** Radial mass-histogram bins. Rotation-invariant on its own — range does not
 *  change when you turn around. */
export const RADIAL_BINS = 24;

/** Total descriptor length: 48 + 48 + 24 + 8. */
export const SIGNATURE_DIM =
  ELEVATION_BANDS * HARMONICS * 2 + RADIAL_BINS + ELEVATION_BANDS;

export interface SignatureOptions {
  /** Log-odds at or above which a voxel counts as evidence of a surface.
   *  Defaults to the grid's own `occupiedThreshold` so the descriptor and the
   *  display never disagree about what is a wall. */
  occupiedThreshold?: number;
  /** Scan origin in world metres. Defaults to the grid centre. */
  origin?: Vec3;
  /** Fraction of the sphere the beam actually visited, from
   *  `ScanState.coverage`. Carried, not used in the arithmetic. */
  coverage?: number;
  /** Largest range represented in the radial histogram. Defaults to the grid's
   *  half-extent — beyond that the cube, not the room, is doing the shaping. */
  maxRangeM?: number;
}

/** A room descriptor: a unit vector plus the provenance needed to judge it. */
export interface RoomSignature {
  /** Unit-norm descriptor, `SIGNATURE_DIM` long. */
  vector: Float32Array;
  /** Voxels that carried occupied evidence. */
  occupiedVoxels: number;
  /** Voxels with any evidence at all. */
  knownVoxels: number;
  /** Occupancy-weighted mean range, metres. */
  meanRangeM: number;
  /** Sphere fraction swept, if the caller supplied it. */
  coverage: number;
  /** Azimuth bins that received any occupied mass, out of `AZIMUTH_BINS`. This
   *  is the descriptor's own view of how complete the scan was, and it is the
   *  honest gate on whether a comparison means anything. */
  azimuthSupport: number;
}

/**
 * Reduce an occupancy grid to a heading-invariant descriptor.
 *
 * One pass over the grid. At the default 0.1 m / 6 m that is 1.7 M voxels, and
 * the work per voxel is a threshold test and — only for the survivors — an
 * `atan2` and an `asin`. Occupied voxels are a low-percent minority of any real
 * map, so the cost is dominated by the scan, not the trigonometry.
 */
export function roomSignature(
  grid: OccupancyGrid,
  options: SignatureOptions = {},
): RoomSignature {
  const threshold = options.occupiedThreshold ?? grid.config.occupiedThreshold;
  const origin = options.origin ?? { x: 0, y: 0, z: 0 };
  const maxRange = options.maxRangeM ?? grid.config.extentM;

  const cells = grid.data;
  const dim = grid.dim;
  const voxelM = grid.config.voxelM;
  const gridOrigin = grid.origin;

  // mass[e][a] — occupancy probability summed over the sector.
  // rangeSum[e][a] — mass-weighted range, divided out below.
  const mass = new Float64Array(ELEVATION_BANDS * AZIMUTH_BINS);
  const rangeSum = new Float64Array(ELEVATION_BANDS * AZIMUTH_BINS);
  const radial = new Float64Array(RADIAL_BINS);
  const elevation = new Float64Array(ELEVATION_BANDS);

  let occupiedVoxels = 0;
  let knownVoxels = 0;
  let totalMass = 0;
  let rangeMassSum = 0;

  for (let index = 0; index < cells.length; index++) {
    const logOdds = cells[index]!;
    if (logOdds === 0) continue;
    knownVoxels++;
    if (logOdds < threshold) continue;
    occupiedVoxels++;

    const i = index % dim;
    const j = Math.floor(index / dim) % dim;
    const k = Math.floor(index / (dim * dim));
    const x = gridOrigin + (i + 0.5) * voxelM - origin.x;
    const y = gridOrigin + (j + 0.5) * voxelM - origin.y;
    const z = gridOrigin + (k + 0.5) * voxelM - origin.z;

    const r = Math.hypot(x, y, z);
    if (r < 1e-9) continue;

    // Weight by the probability, not by the count. A voxel corroborated by six
    // pings should not be worth the same as one that scraped over the line, or
    // the descriptor is a function of how long you stood there.
    const p = 1 / (1 + Math.exp(-logOdds));

    // Azimuth measured as `geometry.ts` measures it: 0 = +Y (north),
    // increasing toward +X (east). The absolute zero is arbitrary — that is
    // the entire point — but it must be the SAME arbitrary zero as the map's.
    const azimuth = Math.atan2(x, y);
    const el = Math.asin(Math.min(1, Math.max(-1, z / r)));

    const aBin = Math.min(
      AZIMUTH_BINS - 1,
      Math.max(0, Math.floor(((azimuth + Math.PI) / (2 * Math.PI)) * AZIMUTH_BINS)),
    );
    const eBin = Math.min(
      ELEVATION_BANDS - 1,
      Math.max(0, Math.floor(((el + Math.PI / 2) / Math.PI) * ELEVATION_BANDS)),
    );
    const slot = eBin * AZIMUTH_BINS + aBin;

    mass[slot]! += p;
    rangeSum[slot]! += p * r;
    elevation[eBin]! += p;
    totalMass += p;
    rangeMassSum += p * r;

    const rBin = Math.min(
      RADIAL_BINS - 1,
      Math.max(0, Math.floor((r / Math.max(maxRange, 1e-6)) * RADIAL_BINS)),
    );
    radial[rBin]! += p;
  }

  // Mean range per sector. An empty sector has no range; zero is the only
  // available answer and it is at least a CONSISTENT one — the same room
  // scanned the same way produces the same holes, and a rotation moves the
  // holes with the room, so the shift theorem still holds over the zeros.
  const meanRange = new Float64Array(ELEVATION_BANDS * AZIMUTH_BINS);
  for (let s = 0; s < meanRange.length; s++) {
    meanRange[s]! = mass[s]! > 0 ? rangeSum[s]! / mass[s]! : 0;
  }

  const massSpectrum = azimuthMagnitudeSpectrum(mass);
  const rangeSpectrum = azimuthMagnitudeSpectrum(meanRange);

  let azimuthSupport = 0;
  for (let a = 0; a < AZIMUTH_BINS; a++) {
    for (let e = 0; e < ELEVATION_BANDS; e++) {
      if (mass[e * AZIMUTH_BINS + a]! > 0) {
        azimuthSupport++;
        break;
      }
    }
  }

  // Each block is L2-normalised on its own before concatenation. Without that
  // the mass spectrum — whose scale is "how many voxels" — would dominate the
  // range spectrum, whose scale is metres, and the descriptor would mostly
  // encode how long the scan ran.
  const vector = new Float32Array(SIGNATURE_DIM);
  let at = 0;
  at = writeNormalizedBlock(vector, at, massSpectrum);
  at = writeNormalizedBlock(vector, at, rangeSpectrum);
  at = writeNormalizedBlock(vector, at, radial);
  at = writeNormalizedBlock(vector, at, elevation);
  normalizeInPlace(vector);

  return {
    vector,
    occupiedVoxels,
    knownVoxels,
    meanRangeM: totalMass > 0 ? rangeMassSum / totalMass : 0,
    coverage: options.coverage ?? 0,
    azimuthSupport,
  };
}

/**
 * Magnitude of the first `HARMONICS` DFT coefficients along azimuth, per band.
 *
 * Naive O(A²) per band: 64² × 8 ≈ 33 k multiply-adds, microseconds. An FFT here
 * would be faster arithmetic and slower to read, and the profile says this is
 * not where the time goes.
 */
function azimuthMagnitudeSpectrum(field: Float64Array): Float64Array {
  const out = new Float64Array(ELEVATION_BANDS * HARMONICS);
  for (let e = 0; e < ELEVATION_BANDS; e++) {
    const base = e * AZIMUTH_BINS;
    for (let k = 0; k < HARMONICS; k++) {
      let re = 0;
      let im = 0;
      for (let a = 0; a < AZIMUTH_BINS; a++) {
        const angle = (-2 * Math.PI * k * a) / AZIMUTH_BINS;
        const v = field[base + a]!;
        re += v * Math.cos(angle);
        im += v * Math.sin(angle);
      }
      out[e * HARMONICS + k]! = Math.hypot(re, im);
    }
  }
  return out;
}

function writeNormalizedBlock(
  target: Float32Array,
  offset: number,
  block: Float64Array,
): number {
  let sumSquares = 0;
  for (let i = 0; i < block.length; i++) sumSquares += block[i]! * block[i]!;
  const norm = Math.sqrt(sumSquares);
  // A block that is genuinely all zero — a scan that saw nothing at all —
  // stays zero rather than becoming a unit vector pointing somewhere arbitrary.
  const scale = norm > 1e-12 ? 1 / norm : 0;
  for (let i = 0; i < block.length; i++) target[offset + i]! = block[i]! * scale;
  return offset + block.length;
}

function normalizeInPlace(v: Float32Array): void {
  let sumSquares = 0;
  for (let i = 0; i < v.length; i++) sumSquares += v[i]! * v[i]!;
  const norm = Math.sqrt(sumSquares);
  if (norm <= 1e-12) return;
  for (let i = 0; i < v.length; i++) v[i]! = v[i]! / norm;
}

/**
 * Cosine similarity of two descriptors, in `[-1, 1]`.
 *
 * Both are unit-norm by construction, so this is a dot product — but it is
 * computed as a true cosine anyway, because an all-zero signature (a scan that
 * saw nothing) is a legal input and a bare dot product would silently report
 * perfect similarity between two of them.
 */
export function signatureSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(
      `batvu: signature length mismatch (${a.length} vs ${b.length})`,
    );
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 1e-12 ? dot / denom : 0;
}
