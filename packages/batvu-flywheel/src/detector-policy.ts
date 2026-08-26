// SPDX-License-Identifier: MIT
//
// The micro-motion detector's policy encoding: the second wheel's levers.
//
// This is a SEPARATE wheel from the one `policy.ts` encodes, and the separation
// is the point. That wheel evolves the sonar's operating policy against
// SIMULATED rooms; the simulator is the ground truth for ranging (ADR-015) and
// scoring a chirp against it is legitimate. This wheel evolves the micro-motion
// detector's parameters against REAL captures, and ADR-023 §4 bars the
// simulator from the problem entirely: `Target::breathing` is a unit-test
// fixture for arithmetic, and a detector tuned against it would be a detector
// tuned to agree with the code that produced it. Nothing in this file or in
// `detector-evaluator.ts` imports from `@batvu/sim`, and that absence is a
// requirement, not an accident.
//
// ## Four levers, chosen to be independent
//
// | lever         | what it controls                                   | what it trades                       |
// |---------------|----------------------------------------------------|--------------------------------------|
// | `dwell`       | how long the instrument stares at one bearing      | frequency resolution vs time on task |
// | `band`        | which slow-time rates the periodicity test searches | selectivity vs missing the rate      |
// | `periodicity` | the statistic's threshold, and the SNR gate that   | detections vs false alarms           |
// |               | makes the null true                                 |                                      |
// | `commonMode`  | how much of the operator's own motion is removed,  | rejected dwells vs believed ones     |
// |               | and how much residual is tolerated                  |                                      |
//
// The flywheel mutates ONE lever per candidate, so overlapping levers would make
// the lift curve unreadable. These four touch disjoint fields.
//
// `minSnrDb` sits with the THRESHOLD rather than on a lever of its own because
// it is not a taste knob: `@batvu/micromotion` derives its false-alarm rate from
// a null whose linearisation is only good while the per-ping phase error is
// small, and bins below the gate are refused precisely so the quoted rate stays
// true. Moving the gate without moving `alpha` changes what the quoted rate
// means, so they move together.
//
// ## The band edges are a HYPOTHESIS, and are not a clinical claim
//
// `DwellOptions.bandHz` has no default in `@batvu/micromotion`, deliberately:
// a breathing band is a figure this repository has no citation for, and ADR-023
// declines to assert the chest-wall excursion for the same reason. The ladder
// below does not fix that by asserting one. What it encodes is arithmetic —
// for a fixed alpha, Fisher's g threshold falls as K (the Fourier bins inside
// the band) falls, so a narrower band buys power for a tone that is inside it
// and buys nothing at all for one that is outside. Narrowing is therefore a
// direction, not an answer, and the gate is what decides how far it survives.
// TODO(ADR-023): the edges a real corpus supports replace these rungs. Until
// then they are a starting point that has never met a room.

import { encodeLever } from './policy.js';

/** A detector policy is the same opaque `Record<string, string>` the engine
 *  requires — it never interprets a lever, which is its design rule. */
export type DetectorPolicy = Record<string, string>;

export const DETECTOR_LEVERS = ['dwell', 'band', 'periodicity', 'commonMode'] as const;
export type DetectorLever = (typeof DETECTOR_LEVERS)[number];

/** Fields each lever owns. Disjoint by construction — see the module note. */
const LEVER_FIELDS: Record<DetectorLever, readonly string[]> = {
  dwell: ['dwellS', 'minCycles'],
  band: ['bandLowHz', 'bandHighHz'],
  periodicity: ['alpha', 'minSnrDb'],
  commonMode: ['commonModeRejection', 'commonModeMaxPeakM'],
};

const NUMERIC = new Set([
  'dwellS',
  'minCycles',
  'bandLowHz',
  'bandHighHz',
  'alpha',
  'minSnrDb',
  'commonModeMaxPeakM',
]);

/**
 * `@batvu/micromotion`'s `DwellOptions`, mirrored.
 *
 * TODO(ADR-023): `@batvu/micromotion` is being written concurrently and is not
 * yet a resolvable workspace dependency of this package — it is absent from
 * `tsconfig.json`'s references, from `package.json`, and from the vitest alias
 * table, none of which this file owns. Importing it by name today would break
 * `tsc --noEmit` and every test in the repository, so the shape it is called
 * with is mirrored here structurally instead. At integration this interface is
 * deleted and `import type { DwellOptions } from '@batvu/micromotion'` takes
 * its place; the field names are already the ones that package declares, so the
 * swap is mechanical and a mismatch is a compile error rather than a silent
 * disagreement.
 */
export interface DwellOptions {
  /** `[low, high]` in hertz — the band searched, and the band the false-alarm
   *  rate is exact over. */
  bandHz: readonly [number, number];
  /** Per-ping SNR below which a bin is refused as `no_return`. */
  minSnrDb: number;
  /** Cycles of the SLOWEST searched rate that must fit in the dwell before any
   *  score is produced. */
  minCycles: number;
  /** False-alarm rate the reported thresholds are quoted at. */
  alpha: number;
  /** Subtract the across-bin common-mode phase. */
  commonModeRejection: boolean;
}

export interface ResolvedDetectorPolicy {
  /** Seconds of slow time to take from each capture. Capture-side, not a
   *  `DwellOptions` field: the record holds whatever was recorded and the lever
   *  decides how much of it this candidate is allowed to look at. */
  dwellS: number;
  /** What the analyzer is called with. */
  dwellOptions: DwellOptions;
  /** Refuse a dwell whose measured `commonModePeakM` exceeds this, in metres.
   *
   *  The second half of "common-mode rejection strength", and the half that is
   *  not a flag. The estimator models TRANSLATION ALONG THE BORESIGHT, which is
   *  common-mode across range; rotation and cross-beam translation are not, and
   *  are not compensated. A dwell whose measured common-mode excursion is large
   *  is a dwell where the uncompensated remainder is probably large too, so the
   *  honest response is to decline it rather than to believe its scores. ADR-023
   *  §3 names handheld motion as the blocker that can end the enquiry cheaply;
   *  this is the knob that says how cheaply. */
  commonModeMaxPeakM: number;
  /** `1 - alpha`: the line `micromotionBand` is thresholded at, in the units the
   *  score is reported in. Derived, never encoded separately — two independent
   *  copies of the same threshold is how a calibrated number stops being one. */
  scoreThreshold: number;
}

/** Parse one detector lever. Throws on anything malformed.
 *
 *  Same strictness, and for the same reason, as `decodeLever` in `policy.ts`: a
 *  malformed lever that quietly fell back to a default would make the wheel
 *  measure the DEFAULT, promote it as though it were the mutation, and sign a
 *  receipt attesting to a policy that never ran. Here the receipt would also be
 *  attesting to a false-alarm rate that was never the one under test. */
export function decodeDetectorLever(
  lever: DetectorLever,
  value: string,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  const allowed = new Set(LEVER_FIELDS[lever]);
  for (const part of value.split(';')) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      throw new Error(`batvu/flywheel: malformed detector lever entry ${JSON.stringify(trimmed)}`);
    }
    const key = trimmed.slice(0, eq).trim();
    const raw = trimmed.slice(eq + 1).trim();
    if (!allowed.has(key)) {
      throw new Error(
        `batvu/flywheel: ${JSON.stringify(key)} does not belong to detector lever '${lever}'`,
      );
    }
    if (NUMERIC.has(key)) {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        throw new Error(`batvu/flywheel: ${key}=${JSON.stringify(raw)} is not a finite number`);
      }
      out[key] = n;
    } else {
      out[key] = raw;
    }
  }
  return out;
}

/**
 * Turn a detector policy into the arguments the analyzer takes.
 *
 * Every field is REQUIRED. `resolvePolicy` in `policy.ts` can start from
 * `DEFAULT_SONAR_CONFIG` and overlay whatever the lever carries, because a
 * sonar config that is missing a field still describes a chirp somebody chose.
 * There is no defensible default detector here: the band has no default in
 * `@batvu/micromotion` on purpose, and a dwell length inherited from nowhere
 * would silently decide how many of the corpus's captures are decidable at all.
 * A policy that does not say is an error.
 */
export function resolveDetectorPolicy(policy: DetectorPolicy): ResolvedDetectorPolicy {
  const fields: Record<string, string | number> = {};
  for (const lever of DETECTOR_LEVERS) {
    const value = policy[lever];
    if (value === undefined) {
      throw new Error(`batvu/flywheel: detector policy is missing lever '${lever}'`);
    }
    Object.assign(fields, decodeDetectorLever(lever, value));
  }
  for (const key of [...NUMERIC, 'commonModeRejection']) {
    if (fields[key] === undefined) {
      throw new Error(`batvu/flywheel: detector policy is missing '${key}'`);
    }
  }

  const dwellS = Number(fields.dwellS);
  const minCycles = Number(fields.minCycles);
  const bandLowHz = Number(fields.bandLowHz);
  const bandHighHz = Number(fields.bandHighHz);
  const alpha = Number(fields.alpha);
  const commonModeMaxPeakM = Number(fields.commonModeMaxPeakM);
  const rejection = String(fields.commonModeRejection);

  if (dwellS <= 0) throw new Error(`batvu/flywheel: dwellS must be positive, got ${dwellS}`);
  if (minCycles < 1) throw new Error(`batvu/flywheel: minCycles must be at least 1`);
  if (!(bandLowHz > 0) || !(bandHighHz > bandLowHz)) {
    throw new Error(`batvu/flywheel: band must satisfy 0 < low < high, got [${bandLowHz}, ${bandHighHz}]`);
  }
  // alpha is a false-alarm RATE. 0 makes the threshold unreachable and 1 makes
  // every dwell fire, and both would be reported as if they were calibrated.
  if (!(alpha > 0) || !(alpha < 1)) {
    throw new Error(`batvu/flywheel: alpha must lie strictly in (0, 1), got ${alpha}`);
  }
  if (!(commonModeMaxPeakM > 0)) {
    throw new Error(`batvu/flywheel: commonModeMaxPeakM must be positive, got ${commonModeMaxPeakM}`);
  }
  if (rejection !== 'on' && rejection !== 'off') {
    throw new Error(`batvu/flywheel: commonModeRejection must be 'on' or 'off', got ${JSON.stringify(rejection)}`);
  }

  return {
    dwellS,
    dwellOptions: {
      bandHz: [bandLowHz, bandHighHz] as const,
      minSnrDb: Number(fields.minSnrDb),
      minCycles,
      alpha,
      commonModeRejection: rejection === 'on',
    },
    commonModeMaxPeakM,
    scoreThreshold: 1 - alpha,
  };
}

/**
 * The gen-0 root: deliberately, defensibly BAD.
 *
 * Same argument as `badRootPolicy` in `policy.ts` — a wheel started from a tuned
 * configuration has no headroom and its flat lift curve proves only that the
 * gate works. Each fault here is one a person would plausibly ship on the first
 * afternoon:
 *
 * - **a two-second dwell.** Shorter than a single cycle of anything in the band,
 *   so `@batvu/micromotion` refuses every capture as `insufficient_dwell`. The
 *   root therefore DECIDES NOTHING: `noopRate` starts at 1 and `primary` at 0,
 *   which is the honest description of an instrument that has abstained on the
 *   whole corpus, and it leaves the strictest clause in the frozen gate — the
 *   no-op rate must strictly improve — the most room it will ever have.
 * - **one cycle of the slowest rate.** A periodogram cannot see a period it has
 *   observed once; asking for one is asking for the leakage skirt.
 * - **a band from 0.2 to 8 Hz.** Nearly everything the pulse rate can resolve,
 *   so K is enormous, Fisher's g is diluted across hundreds of ordinates, and
 *   an oscillating fan is inside the search.
 * - **alpha = 0.5.** A stated false-alarm rate of one in two, which is a coin.
 * - **a 0 dB SNR gate.** At 0 dB the per-ping phase standard deviation is 0.71
 *   rad, unwrapping fails, and the exponential null the p-value comes from is
 *   simply false — the number would still be printed.
 * - **no common-mode rejection, and a one-metre tolerance.** The operator's hand
 *   is left in the signal and no dwell is ever refused for it.
 */
export function badRootDetectorPolicy(): DetectorPolicy {
  return {
    dwell: encodeLever({ dwellS: 2, minCycles: 1 }),
    band: encodeLever({ bandLowHz: 0.2, bandHighHz: 8.0 }),
    periodicity: encodeLever({ alpha: 0.5, minSnrDb: 0 }),
    commonMode: encodeLever({ commonModeRejection: 'off', commonModeMaxPeakM: 1.0 }),
  };
}

/**
 * The candidate ladders the proposer walks.
 *
 * Ordered on arithmetic, not on results:
 *
 * - **dwell** lengthens. `Δf = PRF/N`, so the dwell IS the frequency
 *   resolution, and a dwell shorter than `minCycles` periods of the slowest
 *   searched rate cannot produce a score at all. It costs time on one bearing,
 *   which is the whole tension ADR-023 §3 names: this instrument and the sweep
 *   are mutually exclusive modes.
 * - **band** narrows. For fixed alpha the g threshold falls with K, so a
 *   narrower band is more sensitive to a tone inside it — and blind to one
 *   outside it. Which edges are right is the empirical question the corpus
 *   exists to answer; see the module note.
 * - **periodicity** tightens alpha and raises the SNR gate together, so the
 *   quoted false-alarm rate keeps meaning what it says as it falls.
 * - **commonMode** turns rejection on and then tightens the residual the
 *   detector will tolerate. Note that tightening it can only ever ADD
 *   abstentions, and the frozen gate demands the no-op rate strictly improve —
 *   so this lever is structurally hard to promote once rejection is on. That is
 *   not a defect in the gate. It is the gate correctly refusing to buy
 *   selectivity with silence, and if it never promotes past rung 1 then the
 *   honest result is that this corpus did not show the tighter tolerance paying
 *   for itself.
 */
export const DETECTOR_LADDERS: Record<DetectorLever, string[]> = {
  dwell: [
    encodeLever({ dwellS: 2, minCycles: 1 }),
    encodeLever({ dwellS: 12, minCycles: 2 }),
    encodeLever({ dwellS: 20, minCycles: 3 }),
    encodeLever({ dwellS: 30, minCycles: 3 }),
    encodeLever({ dwellS: 45, minCycles: 4 }),
  ],
  band: [
    encodeLever({ bandLowHz: 0.2, bandHighHz: 8.0 }),
    encodeLever({ bandLowHz: 0.15, bandHighHz: 4.0 }),
    encodeLever({ bandLowHz: 0.12, bandHighHz: 2.0 }),
    encodeLever({ bandLowHz: 0.1, bandHighHz: 1.2 }),
    encodeLever({ bandLowHz: 0.1, bandHighHz: 0.7 }),
  ],
  periodicity: [
    encodeLever({ alpha: 0.5, minSnrDb: 0 }),
    encodeLever({ alpha: 0.1, minSnrDb: 4 }),
    encodeLever({ alpha: 0.05, minSnrDb: 8 }),
    encodeLever({ alpha: 0.01, minSnrDb: 10 }),
    encodeLever({ alpha: 0.001, minSnrDb: 12 }),
  ],
  commonMode: [
    encodeLever({ commonModeRejection: 'off', commonModeMaxPeakM: 1.0 }),
    encodeLever({ commonModeRejection: 'on', commonModeMaxPeakM: 0.05 }),
    encodeLever({ commonModeRejection: 'on', commonModeMaxPeakM: 0.02 }),
    encodeLever({ commonModeRejection: 'on', commonModeMaxPeakM: 0.01 }),
    encodeLever({ commonModeRejection: 'on', commonModeMaxPeakM: 0.005 }),
  ],
};

/**
 * A deterministic, model-free proposer: step up the lever's ladder.
 *
 * Identical in shape and in argument to `ladderStep` in `policy.ts`, including
 * `stride`: a strictly-ordered ladder dead-ends when rung N+1 scores worse than
 * rung N, because the base policy does not move on a rejection and a stride-1
 * proposer then re-offers the same rejected candidate forever. Advancing the
 * stride after a rejection lets the wheel step over a bad rung.
 *
 * That matters more here than it does for the sonar wheel. The `dwell` and
 * `band` ladders are COUPLED through `minCycles / bandLowHz`: a longer dwell
 * buys nothing while the band's low edge still demands more seconds than the
 * dwell has, and a narrower band buys nothing while every capture is refused
 * for being too short. Several early rungs on each ladder are therefore
 * genuinely unpromotable on their own, and stride is what carries the search
 * past them.
 */
export function detectorLadderStep(lever: DetectorLever, current: string, stride = 1): string {
  const ladder = DETECTOR_LADDERS[lever];
  const at = ladder.indexOf(current);
  if (at < 0) return ladder[0]!; // off-ladder value: start the climb
  return ladder[Math.min(at + Math.max(1, stride), ladder.length - 1)]!;
}

/** Human-readable summary of what a lever step changed. */
export function describeDetectorStep(lever: DetectorLever, from: string, to: string): string {
  const a = decodeDetectorLever(lever, from);
  const b = decodeDetectorLever(lever, to);
  const changed = Object.keys(b).filter((k) => String(a[k]) !== String(b[k]));
  if (changed.length === 0) return `${lever}: unchanged (ladder exhausted)`;
  return `${lever}: ${changed.map((k) => `${k} ${a[k]} -> ${b[k]}`).join(', ')}`;
}
