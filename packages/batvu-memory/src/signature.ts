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
// gravity, and a descriptor invariant under SO(2) about `+Z` and nothing more
// is invariant under precisely as much as it has to be. Discarding the other two
// degrees of freedom, as a fully rotation-invariant descriptor would, would be
// throwing away measurements the accelerometer already paid for.
//
// ## Two of the four blocks are EXACTLY invariant
//
// A rotation `R_φ` about `+Z` maps `(x, y, z)` to
// `(x cosφ − y sinφ, x sinφ + y cosφ, z)`. It preserves `z`, and it preserves
// `r = √(x²+y²+z²)`. The occupancy probability belongs to the voxel and moves
// with it. So the multisets `{(p, r)}` and `{(p, z/r)}` are *identical* before
// and after — which makes the radial histogram and the elevation-marginal range
// profile literally the same numbers, with no approximation anywhere. 32 of the
// 128 dimensions are exactly invariant, not approximately.
//
// ## The other two: the DFT shift theorem, and where it stops working
//
// Bin the map into E elevation bands × A azimuth bins. A heading offset of an
// integer number `m` of bins is then a circular SHIFT of each band's azimuth
// row, and
//
//     f'[a] = f[(a − m) mod A]   ⟹   F'[k] = e^{−2πikm/A} · F[k]
//
// The prefactor has unit modulus, so `|F'[k]| = |F[k]|` **exactly**, for every
// harmonic and every band. That is why the retained quantity is the MAGNITUDE
// spectrum and the phase is thrown away.
//
// A real heading offset does not land on a bin boundary. For `φ = 2π(m+δ)/A`
// with `|δ| ≤ ½`, binning is a box filter and the sub-bin translation is, to
// first order, `f' ≈ (1−δ)·shift_m(f) + δ·shift_{m+1}(f)`, whose transform
// multiplies `F[k]` by `(1−δ) + δe^{−iω}` with `ω = 2πk/A`. The retained
// magnitude is therefore attenuated by
//
//     |F'[k]| / |F[k]| = √( 1 − 2δ(1−δ)(1 − cos ω) )
//
// which for the worst case `δ = ½` at `A = 64` is 0.9988 at `k = 1`, 0.9699 at
// `k = 5`, and **zero** at `k = A/2`. It is a magnitude attenuation, not a phase
// error — an earlier version of this file bounded the phase, which the
// descriptor discards, and so was bounding the wrong thing.
//
// This is why `K = 6` of `A = 64`. Not to make the vector shorter: because the
// attenuation grows monotonically in `k` and reaches total annihilation at
// Nyquist, so the low harmonics are the region where the invariance survives
// binning at all.
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
// - **The invariance proven by the tests is invariance to a RELABELLING of the
//   azimuth zero**, not to two physically different sweeps. The tests hold the
//   physical scan fixed and rotate the reported heading, which is exactly what
//   an arbitrary `alpha` origin does — and it is the only thing the shift
//   theorem covers. Two different partial sweeps of the same room are not
//   related by a circular shift and none of the maths above applies to them.
//   `bandNormalize` softens that case; it does not solve it.
// - **It is a similarity, not a probability.** Every entry is non-negative — a
//   magnitude of a non-negative field — so cosine similarity has a high floor
//   and even unrelated rooms score well above 0.5. Judge a match on the MARGIN
//   between the best and second-best hit, never on the raw level.

import { OccupancyGrid, type Vec3 } from '@batvu/core';

/** Descriptor format version.
 *
 *  v1 and v2 are both 128 long and both unit-norm, so a length check cannot
 *  tell them apart — a v2 build comparing v2 queries against v1 records would
 *  return confident nonsense. The version is what makes that loud. */
export const SIGNATURE_VERSION = 2;

/** Elevation bands. 8 over the sphere is ~22.5° each — coarse enough to be
 *  stable under the beam's ±30° cone, fine enough to separate floor, walls and
 *  ceiling, which is the distinction that carries most of a room's shape. */
export const ELEVATION_BANDS = 8;

/** Azimuth bins. A power of two keeps the shift-theorem argument exact for the
 *  rotations that land on a boundary, and makes the naive DFT cheap. */
export const AZIMUTH_BINS = 64;

/** Retained harmonics per band, `k = 0..5` including DC. See the attenuation
 *  bound above for why this number and not a larger one. */
export const HARMONICS = 6;

/** Radial mass-histogram bins. Exactly rotation-invariant on their own. */
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
  /** Near edge of the radial histogram. Defaults to 0.6 m — the blind disc
   *  inside which the outgoing pulse drowns everything out. Binning from zero
   *  instead, as an earlier version did, spends the first two bins on a region
   *  the sonar structurally cannot see. */
  minRangeM?: number;
  /** Far edge of the radial histogram. Defaults to the grid's half-extent —
   *  beyond that the cube, not the room, is doing the shaping. */
  maxRangeM?: number;
  /** Divide each band's azimuth row by the number of sectors that carried any
   *  evidence, before the DFT. Default true.
   *
   *  The divisor is a count over the whole row, so it is unchanged by a
   *  circular shift and the invariance argument survives intact. What it fixes
   *  is the partial-coverage failure: without it, a band swept in ten sectors
   *  looks six times fainter than one swept in sixty, and the descriptor ends
   *  up encoding how long the operator stood there. */
  bandNormalize?: boolean;
}

/** A room descriptor: a unit vector plus the provenance needed to judge it. */
export interface RoomSignature {
  /** Descriptor format version. */
  version: number;
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
 *
 * That full-grid pass is why this belongs at the END of a scan and never inside
 * `ScanSession.pingWithBeam`: at fifteen pings a second it would be the most
 * expensive thing on the phone's main thread, and there is nothing useful to
 * say about a room from a single ping anyway.
 */
export function roomSignature(
  grid: OccupancyGrid,
  options: SignatureOptions = {},
): RoomSignature {
  const threshold = options.occupiedThreshold ?? grid.config.occupiedThreshold;
  const origin = options.origin ?? { x: 0, y: 0, z: 0 };
  const minRange = options.minRangeM ?? 0.6;
  const maxRange = Math.max(options.maxRangeM ?? grid.config.extentM, minRange + 1e-6);
  const bandNormalize = options.bandNormalize ?? true;

  const cells = grid.data;
  const dim = grid.dim;
  const voxelM = grid.config.voxelM;
  const gridOrigin = grid.origin;

  // mass[e][a] — occupancy probability summed over the sector.
  // rangeSum[e][a] — mass-weighted range, divided out below.
  const mass = new Float64Array(ELEVATION_BANDS * AZIMUTH_BINS);
  const rangeSum = new Float64Array(ELEVATION_BANDS * AZIMUTH_BINS);
  const radial = new Float64Array(RADIAL_BINS);

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
    totalMass += p;
    rangeMassSum += p * r;

    const rBin = Math.min(
      RADIAL_BINS - 1,
      Math.max(0, Math.floor(((r - minRange) / (maxRange - minRange)) * RADIAL_BINS)),
    );
    radial[rBin]! += p;
  }

  // Mean range per sector. An empty sector has no range; zero is the only
  // available answer and it is at least a CONSISTENT one — the same room
  // scanned the same way produces the same holes, and a relabelling of the
  // azimuth zero moves the holes with the room, so the shift theorem still
  // holds over the zeros.
  const meanRange = new Float64Array(ELEVATION_BANDS * AZIMUTH_BINS);
  for (let s = 0; s < meanRange.length; s++) {
    meanRange[s]! = mass[s]! > 0 ? rangeSum[s]! / mass[s]! : 0;
  }

  // Sectors per band that carried evidence. A count over the whole row, so a
  // circular shift does not change it and neither does the normalisation.
  const bandSupport = new Int32Array(ELEVATION_BANDS);
  for (let e = 0; e < ELEVATION_BANDS; e++) {
    let seen = 0;
    for (let a = 0; a < AZIMUTH_BINS; a++) if (mass[e * AZIMUTH_BINS + a]! > 0) seen++;
    bandSupport[e]! = seen;
  }

  let massField = mass;
  if (bandNormalize) {
    massField = new Float64Array(mass.length);
    for (let e = 0; e < ELEVATION_BANDS; e++) {
      const divisor = Math.max(bandSupport[e]!, 1);
      for (let a = 0; a < AZIMUTH_BINS; a++) {
        const s = e * AZIMUTH_BINS + a;
        massField[s]! = mass[s]! / divisor;
      }
    }
  }

  const massSpectrum = azimuthMagnitudeSpectrum(massField);
  const rangeSpectrum = azimuthMagnitudeSpectrum(meanRange);

  // Elevation-marginal MEAN RANGE, not mass.
  //
  // The obvious block here is the mass per elevation band — and it is already
  // in the descriptor, because `|F_e[0]|` is by definition the sum of the row.
  // An earlier version carried both, which spent eight dimensions on a copy and
  // silently double-weighted elevation mass. The marginal mean range is the
  // quantity that was actually missing: how far away the floor is, how far away
  // the ceiling is. Both of its sums run over every azimuth bin, so like the
  // radial histogram it is EXACTLY invariant.
  const elevRange = new Float64Array(ELEVATION_BANDS);
  for (let e = 0; e < ELEVATION_BANDS; e++) {
    let sumRange = 0;
    let sumMass = 0;
    for (let a = 0; a < AZIMUTH_BINS; a++) {
      sumRange += rangeSum[e * AZIMUTH_BINS + a]!;
      sumMass += mass[e * AZIMUTH_BINS + a]!;
    }
    elevRange[e]! = sumMass > 1e-12 ? sumRange / sumMass : 0;
  }

  let azimuthSupport = 0;
  for (let a = 0; a < AZIMUTH_BINS; a++) {
    for (let e = 0; e < ELEVATION_BANDS; e++) {
      if (mass[e * AZIMUTH_BINS + a]! > 0) {
        azimuthSupport++;
        break;
      }
    }
  }

  // Each block is L2-normalised on its own before concatenation, so each
  // non-empty block contributes exactly norm ½ to the final vector and the four
  // are equally weighted by construction. Without it the mass spectrum — whose
  // scale is "how many voxels" — would swamp the range spectrum, whose scale is
  // metres, and the descriptor would mostly encode how long the scan ran.
  const vector = new Float32Array(SIGNATURE_DIM);
  let at = 0;
  at = writeNormalizedBlock(vector, at, massSpectrum);
  at = writeNormalizedBlock(vector, at, rangeSpectrum);
  at = writeNormalizedBlock(vector, at, radial);
  writeNormalizedBlock(vector, at, elevRange);
  normalizeInPlace(vector);

  return {
    version: SIGNATURE_VERSION,
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
 *
 * Every entry is non-negative, so in practice the range is `[0, 1]` with a high
 * floor. Do not read the level as a confidence; read the margin over the next
 * best candidate, which is what `RoomMemory.recognize` reports.
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

/**
 * The worst-case magnitude attenuation of harmonic `k` under a heading offset
 * that lands `delta` of a bin away from a boundary.
 *
 * Exported because it is the load-bearing claim in this file's argument, and a
 * claim that can be evaluated is a claim a test can check against the measured
 * similarity rather than against a comment.
 */
export function harmonicAttenuation(k: number, delta: number, bins = AZIMUTH_BINS): number {
  const omega = (2 * Math.PI * k) / bins;
  return Math.sqrt(Math.max(0, 1 - 2 * delta * (1 - delta) * (1 - Math.cos(omega))));
}
