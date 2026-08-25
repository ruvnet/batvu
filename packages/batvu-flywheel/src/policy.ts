// SPDX-License-Identifier: MIT
//
// The policy encoding: which knobs the wheel is allowed to turn, and how they
// are written down.
//
// `@metaharness/flywheel`'s `Policy` is `Record<string, string>` and the engine
// never interprets a lever's meaning — that is its central design rule, and it
// is what keeps the promotion engine free of any sonar knowledge. So the meaning
// lives here, in a codec, and the codec is strict: an unparseable lever is an
// error, never a silent fallback to a default.
//
// That strictness is load-bearing for a promotion system. If a malformed lever
// quietly reverted to the default value, the wheel would measure the DEFAULT,
// promote it as though it were the mutation, and record a receipt attesting to
// a policy that was never actually run. Every promotion downstream of that
// would be signed nonsense.
//
// ## Three levers, chosen to be independent
//
// | lever      | what it controls                          | what it trades          |
// |------------|-------------------------------------------|-------------------------|
// | `waveform` | what is emitted                            | resolution vs SNR       |
// | `detector` | what counts as an echo                     | misses vs ghosts        |
// | `mapping`  | how an echo becomes occupancy              | sharpness vs confidence |
//
// The flywheel mutates ONE lever per candidate, so levers that overlap would
// make the lift curve unreadable: a gain credited to `detector` might really
// have come from a `waveform` change it implied. These three touch disjoint
// parameters.

import {
  DEFAULT_SONAR_CONFIG,
  mainlobeHalfWidth,
  type SonarConfig,
  type WindowName,
} from '@batvu/core';
import { DEFAULT_OCCUPANCY_CONFIG, type OccupancyConfig } from '@batvu/core';

export type SonarPolicy = Record<string, string>;

export const LEVERS = ['waveform', 'detector', 'mapping'] as const;
export type Lever = (typeof LEVERS)[number];

/** Fields each lever owns. Disjoint by construction — see the module note. */
const LEVER_FIELDS: Record<Lever, readonly string[]> = {
  waveform: ['f0', 'f1', 'durationS', 'txWindow', 'tukeyAlpha', 'amplitude', 'rxTaper'],
  detector: [
    'cfarKind',
    'cfarGuardMainlobes',
    'cfarTrainRatio',
    'cfarPfa',
    'cfarOsRankFrac',
    'cfarMergeGapMainlobes',
    'cfarMinProminenceDb',
    'minSnrDb',
  ],
  mapping: [
    'beamHalfAngleDeg',
    'logOddsHit',
    'logOddsMiss',
    'occupiedThreshold',
    'freeMarginM',
    'snrReferenceDb',
  ],
};

const NUMERIC = new Set([
  'f0',
  'f1',
  'durationS',
  'tukeyAlpha',
  'amplitude',
  'cfarGuardMainlobes',
  'cfarTrainRatio',
  'cfarPfa',
  'cfarOsRankFrac',
  'cfarMergeGapMainlobes',
  'cfarMinProminenceDb',
  'minSnrDb',
  'beamHalfAngleDeg',
  'logOddsHit',
  'logOddsMiss',
  'occupiedThreshold',
  'freeMarginM',
  'snrReferenceDb',
]);

/** Serialise `key=value` pairs into one lever string. */
export function encodeLever(fields: Record<string, string | number>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .join(';');
}

/** Parse one lever string. Throws on anything malformed — see the module note. */
export function decodeLever(lever: Lever, value: string): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  const allowed = new Set(LEVER_FIELDS[lever]);
  for (const part of value.split(';')) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) throw new Error(`batvu/flywheel: malformed lever entry ${JSON.stringify(trimmed)}`);
    const key = trimmed.slice(0, eq).trim();
    const raw = trimmed.slice(eq + 1).trim();
    if (!allowed.has(key)) {
      throw new Error(`batvu/flywheel: ${JSON.stringify(key)} does not belong to lever '${lever}'`);
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

export interface ResolvedPolicy {
  sonar: SonarConfig;
  occupancy: OccupancyConfig;
}

/**
 * Turn a policy into the concrete configs the pipeline and mapper take.
 *
 * The CFAR windows are expressed as MULTIPLES of the compressed mainlobe, not
 * as absolute cell counts, and resolved here against whatever waveform the
 * `waveform` lever settled on. That is not tidiness — it is the only way to keep
 * the levers independent. The core hard-rejects a guard band narrower than the
 * mainlobe, and the mainlobe is a function of the WAVEFORM, so an absolute guard
 * value makes lever combinations that simply cannot run: promote a wider taper
 * and the detector lever silently becomes invalid. As a ratio, every combination
 * of every rung is realisable by construction, and what the wheel tunes is the
 * quantity that actually generalises.
 *
 * Order matters: `waveform` resolves first, because `detector` is measured
 * against it.
 */
export function resolvePolicy(policy: SonarPolicy): ResolvedPolicy {
  const sonar: SonarConfig = { ...DEFAULT_SONAR_CONFIG };
  const occupancy: OccupancyConfig = { ...DEFAULT_OCCUPANCY_CONFIG };

  const waveform = policy.waveform;
  if (waveform !== undefined) {
    for (const [k, v] of Object.entries(decodeLever('waveform', waveform))) {
      (sonar as unknown as Record<string, unknown>)[k] =
        k === 'txWindow' || k === 'rxTaper' ? (v as WindowName) : v;
    }
  }

  const detector = policy.detector;
  if (detector !== undefined) {
    const f = decodeLever('detector', detector);
    const mainlobe = mainlobeHalfWidth(sonar);
    if (f.cfarKind !== undefined) sonar.cfarKind = f.cfarKind === 'os' ? 'os' : 'ca';
    if (f.cfarGuardMainlobes !== undefined) {
      sonar.cfarGuard = Math.max(4, Math.ceil(Number(f.cfarGuardMainlobes) * mainlobe));
    }
    if (f.cfarTrainRatio !== undefined) {
      sonar.cfarTrain = Math.max(8, Math.ceil(Number(f.cfarTrainRatio) * sonar.cfarGuard));
    }
    if (f.cfarMergeGapMainlobes !== undefined) {
      sonar.cfarMergeGap = Math.max(1, Math.ceil(Number(f.cfarMergeGapMainlobes) * mainlobe));
    }
    if (f.cfarPfa !== undefined) sonar.cfarPfa = Number(f.cfarPfa);
    if (f.cfarOsRankFrac !== undefined) sonar.cfarOsRankFrac = Number(f.cfarOsRankFrac);
    if (f.cfarMinProminenceDb !== undefined) {
      sonar.cfarMinProminenceDb = Number(f.cfarMinProminenceDb);
    }
    if (f.minSnrDb !== undefined) sonar.minSnrDb = Number(f.minSnrDb);
  }

  const mapping = policy.mapping;
  if (mapping !== undefined) {
    for (const [k, v] of Object.entries(decodeLever('mapping', mapping))) {
      (occupancy as unknown as Record<string, unknown>)[k] = v;
    }
  }
  return { sonar, occupancy };
}

/**
 * The gen-0 root: deliberately, defensibly BAD.
 *
 * A flywheel demonstrates nothing starting from a tuned configuration — there is
 * no headroom, the gate rejects everything, and the lift curve is a flat line
 * that proves only that the gate works. Starting from a policy with real,
 * diagnosable faults is what makes the climb readable, and each fault here is
 * one a person would plausibly ship:
 *
 * - a 1 kHz sweep (28 cm resolution — a chair and the wall behind it merge)
 * - a rectangular transmit window (an audible click on every ping, and -13 dB
 *   range sidelobes that a wide guard band will read as objects)
 * - a guard band barely clearing the mainlobe, so a target's own skirt sits in
 *   its noise estimate and every detection reports a thin margin
 * - Pfa 1e-2 and a 2 dB SNR gate (a hundred times the false alarms)
 * - 1 dB prominence, so every sidelobe becomes its own object
 * - a 60-degree beam assumption (every wall smears into fog)
 * - an occupied threshold BELOW the per-ping hit weight, so a single wide-beam
 *   ping declares a whole 60-degree arc occupied with no corroboration
 *
 * The same pattern `@metaharness/radio` uses for its comms policy: evolve from a
 * deliberately bad root under a frozen gate, and let the receipts show the climb.
 */
export function badRootPolicy(): SonarPolicy {
  return {
    waveform: encodeLever({
      f0: 19_000,
      f1: 20_000,
      durationS: 0.004,
      txWindow: 'rect',
      tukeyAlpha: 0,
      amplitude: 0.45,
      rxTaper: 'rect',
    }),
    detector: encodeLever({
      cfarKind: 'ca',
      cfarGuardMainlobes: 1.02,
      cfarTrainRatio: 1.0,
      cfarPfa: 1e-2,
      cfarOsRankFrac: 0.75,
      cfarMergeGapMainlobes: 0.25,
      cfarMinProminenceDb: 1,
      minSnrDb: 2,
    }),
    mapping: encodeLever({
      beamHalfAngleDeg: 60,
      logOddsHit: 0.3,
      logOddsMiss: 0.1,
      // BELOW logOddsHit: one wide-beam ping is enough to declare a whole
      // 60-degree arc occupied, with no corroboration from a second attitude.
      occupiedThreshold: 0.25,
      freeMarginM: 0.02,
      snrReferenceDb: 40,
    }),
  };
}

/** The hand-tuned policy, for comparison against whatever the wheel finds. */
export function defaultPolicy(): SonarPolicy {
  return {
    waveform: encodeLever({
      f0: DEFAULT_SONAR_CONFIG.f0,
      f1: DEFAULT_SONAR_CONFIG.f1,
      durationS: DEFAULT_SONAR_CONFIG.durationS,
      txWindow: DEFAULT_SONAR_CONFIG.txWindow,
      tukeyAlpha: DEFAULT_SONAR_CONFIG.tukeyAlpha,
      amplitude: DEFAULT_SONAR_CONFIG.amplitude,
      rxTaper: DEFAULT_SONAR_CONFIG.rxTaper,
    }),
    detector: encodeLever({
      cfarKind: DEFAULT_SONAR_CONFIG.cfarKind,
      // The shipped defaults ARE 1.5 mainlobes of guard, 2x that of training and
      // 1.0 mainlobe of merge gap — the same arithmetic `sized_for` does.
      cfarGuardMainlobes: 1.5,
      cfarTrainRatio: 2.0,
      cfarPfa: DEFAULT_SONAR_CONFIG.cfarPfa,
      cfarOsRankFrac: DEFAULT_SONAR_CONFIG.cfarOsRankFrac,
      cfarMergeGapMainlobes: 1.0,
      cfarMinProminenceDb: DEFAULT_SONAR_CONFIG.cfarMinProminenceDb,
      minSnrDb: DEFAULT_SONAR_CONFIG.minSnrDb,
    }),
    mapping: encodeLever({
      beamHalfAngleDeg: DEFAULT_OCCUPANCY_CONFIG.beamHalfAngleDeg,
      logOddsHit: DEFAULT_OCCUPANCY_CONFIG.logOddsHit,
      logOddsMiss: DEFAULT_OCCUPANCY_CONFIG.logOddsMiss,
      occupiedThreshold: DEFAULT_OCCUPANCY_CONFIG.occupiedThreshold,
      freeMarginM: DEFAULT_OCCUPANCY_CONFIG.freeMarginM,
      snrReferenceDb: DEFAULT_OCCUPANCY_CONFIG.snrReferenceDb,
    }),
  };
}

/**
 * The candidate ladders the proposer walks.
 *
 * Ordered worst-to-best on the strength of the physics in
 * `crates/batvu-dsp` — wider sweeps resolve better, tapers suppress sidelobes,
 * guard bands must clear the mainlobe. That ordering is a HYPOTHESIS, not an
 * answer: the wheel still has to measure each step against a holdout and a
 * frozen anchor, and a rung that does not prove lift is rejected like any other
 * candidate. Encoding the hypothesis makes the search tractable; the gate is
 * what keeps it honest.
 */
export const LADDERS: Record<Lever, string[]> = {
  waveform: [
    // Rung 0 is the bad root. The climb widens the sweep toward the band the
    // hardware can actually radiate, replaces the rectangular transmit window
    // with a full Hann taper, and stops before asking the speaker for more
    // bandwidth than it has.
    encodeLever({ f0: 19_000, f1: 20_000, durationS: 0.004, txWindow: 'rect', tukeyAlpha: 0, amplitude: 0.45, rxTaper: 'rect' }),
    encodeLever({ f0: 18_500, f1: 20_500, durationS: 0.004, txWindow: 'tukey', tukeyAlpha: 0.3, amplitude: 0.5, rxTaper: 'rect' }),
    encodeLever({ f0: 18_000, f1: 20_500, durationS: 0.005, txWindow: 'tukey', tukeyAlpha: 0.6, amplitude: 0.55, rxTaper: 'rect' }),
    encodeLever({ f0: 17_500, f1: 20_500, durationS: 0.005, txWindow: 'hann', tukeyAlpha: 1.0, amplitude: 0.6, rxTaper: 'rect' }),
    encodeLever({ f0: 17_500, f1: 21_500, durationS: 0.006, txWindow: 'hann', tukeyAlpha: 1.0, amplitude: 0.6, rxTaper: 'rect' }),
  ],
  detector: [
    encodeLever({ cfarKind: 'ca', cfarGuardMainlobes: 1.02, cfarTrainRatio: 1.0, cfarPfa: 1e-2, cfarOsRankFrac: 0.75, cfarMergeGapMainlobes: 0.25, cfarMinProminenceDb: 1, minSnrDb: 2 }),
    encodeLever({ cfarKind: 'ca', cfarGuardMainlobes: 1.2, cfarTrainRatio: 1.5, cfarPfa: 1e-3, cfarOsRankFrac: 0.75, cfarMergeGapMainlobes: 0.6, cfarMinProminenceDb: 4, minSnrDb: 4 }),
    encodeLever({ cfarKind: 'ca', cfarGuardMainlobes: 1.5, cfarTrainRatio: 2.0, cfarPfa: 1e-4, cfarOsRankFrac: 0.75, cfarMergeGapMainlobes: 1.0, cfarMinProminenceDb: 6, minSnrDb: 6 }),
    encodeLever({ cfarKind: 'os', cfarGuardMainlobes: 1.5, cfarTrainRatio: 2.0, cfarPfa: 1e-4, cfarOsRankFrac: 0.6, cfarMergeGapMainlobes: 1.0, cfarMinProminenceDb: 6, minSnrDb: 6 }),
    encodeLever({ cfarKind: 'os', cfarGuardMainlobes: 2.2, cfarTrainRatio: 2.0, cfarPfa: 1e-5, cfarOsRankFrac: 0.5, cfarMergeGapMainlobes: 1.2, cfarMinProminenceDb: 8, minSnrDb: 8 }),
  ],
  mapping: [
    encodeLever({ beamHalfAngleDeg: 60, logOddsHit: 0.3, logOddsMiss: 0.1, occupiedThreshold: 0.25, freeMarginM: 0.02, snrReferenceDb: 40 }),
    encodeLever({ beamHalfAngleDeg: 45, logOddsHit: 0.6, logOddsMiss: 0.25, occupiedThreshold: 1.0, freeMarginM: 0.08, snrReferenceDb: 30 }),
    encodeLever({ beamHalfAngleDeg: 30, logOddsHit: 0.85, logOddsMiss: 0.4, occupiedThreshold: 1.4, freeMarginM: 0.15, snrReferenceDb: 20 }),
    encodeLever({ beamHalfAngleDeg: 22, logOddsHit: 0.95, logOddsMiss: 0.5, occupiedThreshold: 1.8, freeMarginM: 0.18, snrReferenceDb: 18 }),
    encodeLever({ beamHalfAngleDeg: 16, logOddsHit: 1.1, logOddsMiss: 0.6, occupiedThreshold: 2.2, freeMarginM: 0.2, snrReferenceDb: 15 }),
  ],
};

/**
 * A deterministic, model-free proposer: step one rung up the lever's ladder.
 *
 * No live model, so a flywheel run reproduces exactly in CI and a replay bundle
 * verifies without network access. A pure function of `(current value, lever)`,
 * not of any hidden counter — which is what makes the replay meaningful rather
 * than a recording.
 */
export function ladderStep(lever: Lever, current: string): string {
  const ladder = LADDERS[lever];
  const at = ladder.indexOf(current);
  if (at < 0) return ladder[0]!; // off-ladder value: start the climb
  return ladder[Math.min(at + 1, ladder.length - 1)]!;
}

/** Human-readable summary of what a lever step changed. */
export function describeStep(lever: Lever, from: string, to: string): string {
  const a = decodeLever(lever, from);
  const b = decodeLever(lever, to);
  const changed = Object.keys(b).filter((k) => String(a[k]) !== String(b[k]));
  if (changed.length === 0) return `${lever}: unchanged (ladder exhausted)`;
  return `${lever}: ${changed.map((k) => `${k} ${a[k]} -> ${b[k]}`).join(', ')}`;
}
