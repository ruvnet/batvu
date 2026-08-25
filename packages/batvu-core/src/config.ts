// SPDX-License-Identifier: MIT
//
// The sonar configuration surface, mirroring the Rust core's JSON ABI key for
// key. Every field here is a knob a flywheel policy is allowed to move, which is
// why the type is flat: `@metaharness/flywheel`'s `Policy` is
// `Record<string, string>`, and a flat config maps onto it without inventing a
// path language.

import type { WindowName } from './types.js';

export interface SonarConfig {
  /** Sample rate in Hz. 48000 on iOS — not negotiable, see ADR-003. */
  fs: number;
  /** Sweep start frequency in Hz. */
  f0: number;
  /** Sweep end frequency in Hz. */
  f1: number;
  /** Pulse duration in seconds. */
  durationS: number;
  /** Amplitude taper on the transmitted pulse (audible-click control). */
  txWindow: WindowName;
  /** Tukey shoulder fraction when `txWindow` is `tukey`. */
  tukeyAlpha: number;
  /** Peak transmit amplitude, 0..1. Kept below clipping: a clipped ultrasonic
   *  chirp folds harmonics down into the audible band. */
  amplitude: number;
  /** Receive-side spectral taper — the range-sidelobe lever. */
  rxTaper: WindowName;

  /** `ca` (cell-averaging) or `os` (ordered-statistic). */
  cfarKind: 'ca' | 'os';
  /** Training cells each side. */
  cfarTrain: number;
  /** Guard cells each side. MUST clear the compressed mainlobe. */
  cfarGuard: number;
  /** Design probability of false alarm, per cell. */
  cfarPfa: number;
  /** OS-CFAR rank as a fraction of the training population. */
  cfarOsRankFrac: number;
  /** Absolute floor on the threshold, linear amplitude. */
  cfarMinThreshold: number;
  /** Join above-threshold runs closer than this many cells. */
  cfarMergeGap: number;
  /** Prominence a peak inside a run needs to count as its own object. */
  cfarMinProminenceDb: number;

  temperatureC: number;
  speakerMicSepM: number;
  minRangeM: number;
  maxRangeM: number;
  /** Use the direct-path blast as the time origin. Effectively always true;
   *  false exists so tests can prove how much it is doing. */
  syncToDirectPath: boolean;
  directSearchS: number;
  minSnrDb: number;
  blastCancellation: boolean;
  /**
   * Pulse repetition interval in samples, or 0 when it is not known.
   *
   * Only a LIVE capture needs this, and it is the difference between a map and
   * a smear. The microphone ring is continuous, so the record handed to the DSP
   * is the last 284 ms of it — which at 15 pings a second contains about four
   * transmit blasts, all the same sound at the same level. Choosing between
   * them by amplitude is choosing by noise.
   *
   * That does not corrupt a range. It corrupts the POSE TAG: the attitude
   * attached to the ping is the attitude now, and the echoes may be three pings
   * old — up to ~16 degrees away at a natural sweep rate, randomly, every ping.
   * Corroboration cannot average that out, because it is not noise on a
   * measurement, it is a measurement filed in the wrong place.
   *
   * Blasts repeat on an exact schedule and echoes do not, so telling the core
   * the interval lets it step from the strongest arrival to the most recent
   * blast without comparing amplitudes at all. Use `priSamplesFor`.
   *
   * 0 means "one blast in this record", which is true of every simulated scene
   * and of any one-shot capture — and is why no test caught this.
   */
  priSamples: number;
}

/**
 * The defended operating point (ADR-003, ADR-004).
 *
 * **17.5-20.5 kHz**, not the tempting 18-22 kHz. Nyquist at 48 kHz is 24 kHz,
 * but the real ceiling is far lower: an iPhone's speaker and microphone both
 * fall off a cliff between 19 and 20 kHz, so bandwidth claimed above ~20.5 kHz
 * is bandwidth the hardware will not radiate. The band widens to 4 kHz only
 * after an on-device loopback proves the top end is actually there.
 *
 * **5 ms**, giving a time-bandwidth product of 15 and 11.8 dB of pulse
 * compression. Lengthening the pulse buys SNR and costs blind range at `cT/2`;
 * 5 ms puts the blind range at 0.86 m, already at the edge of useful.
 *
 * **A full Hann transmit taper and NO receive window.** The transmit envelope is
 * where sidelobe control is cheapest — it costs 4.5 dB of radiated energy and
 * buys -45 dB peak sidelobes. A receive window on top adds single-digit dB of
 * suppression that sits far below any real room's reverberation floor, while
 * costing 19% of the range resolution, which is observable. Measured, not
 * assumed: `crates/batvu-dsp/examples/taper_study.rs`.
 *
 * Realisable range resolution is therefore **9.6 cm**, not the nominal
 * `c/2B = 5.7 cm` — the transmit taper widens the mainlobe by 1.67x, and
 * quoting the nominal figure would overstate the sensor by two thirds.
 *
 * CFAR windows are the values `CfarConfig::sized_for` derives for this waveform.
 * They are written out rather than computed so a promoted flywheel policy is a
 * complete, inspectable record of what actually ran; `wasm.test.ts` asserts they
 * still agree with the core's own arithmetic.
 */
export const DEFAULT_SONAR_CONFIG: SonarConfig = {
  fs: 48_000,
  f0: 17_500,
  f1: 20_500,
  durationS: 0.005,
  txWindow: 'hann',
  tukeyAlpha: 1.0,
  amplitude: 0.6,
  rxTaper: 'rect',

  cfarKind: 'ca',
  cfarTrain: 82,
  cfarGuard: 41,
  cfarPfa: 1e-4,
  cfarOsRankFrac: 0.75,
  cfarMinThreshold: 1e-6,
  cfarMergeGap: 27,
  cfarMinProminenceDb: 6,

  temperatureC: 20,
  speakerMicSepM: 0.1,
  minRangeM: 0.6,
  maxRangeM: 6,
  syncToDirectPath: true,
  directSearchS: 0.25,
  minSnrDb: 6,
  blastCancellation: true,
  // The simulator renders one blast per record, so the default is the
  // single-shot rule. A live session overrides it; see `priSamplesFor`.
  priSamples: 0,
};

/**
 * Pulse repetition frequency for the default operating point: 15 Hz.
 *
 * Slow enough that a 6 m echo has died before the next ping (see
 * `minPriSeconds`), and — with a 5 ms pulse — a 7.5% duty cycle, which is what
 * actually governs acoustic exposure and battery. A bat in its terminal buzz
 * reaches 200 Hz; it gets there by giving up range, which is the same trade
 * available here and not one a room scan wants to make.
 */
export const DEFAULT_PING_RATE_HZ = 15;

/**
 * Samples between transmit blasts at a given ping rate — what
 * `SonarConfig.priSamples` wants.
 *
 * Returns 0 for a rate that is not a usable rate, which is the honest answer:
 * "I do not know the interval", and the core falls back to the single-shot
 * rule rather than stepping by a garbage stride.
 */
export function priSamplesFor(config: SonarConfig, pingRateHz: number): number {
  if (!Number.isFinite(pingRateHz) || pingRateHz <= 0) return 0;
  if (!Number.isFinite(config.fs) || config.fs <= 0) return 0;
  return Math.round(config.fs / pingRateHz);
}

/**
 * Mainlobe widening factor for a receive taper, relative to a rectangular one.
 *
 * Mirrors the table in `crates/batvu-dsp/src/window.rs`, and
 * `wasm.test.ts` asserts the two agree — a drift here would silently
 * mis-size every CFAR guard band computed on the TypeScript side.
 */
export function mainlobeWidening(window: WindowName): number {
  switch (window) {
    case 'rect':
      return 1.0;
    case 'hamming':
      return 1.5;
    case 'hann':
      return 1.67;
    case 'blackman':
      return 2.0;
    case 'blackman-harris':
      return 2.66;
    case 'tukey':
      return 1.35;
  }
}

/**
 * Half-width of the compressed mainlobe in samples: `fs / B`, widened by the
 * receive taper.
 *
 * The quantity the CFAR guard band must clear. A guard narrower than this puts
 * a target's own mainlobe into its own noise estimate, and every target then
 * reports near-zero SNR — the failure mode that looks like "the sonar is
 * broken" and is actually one number being too small.
 */
export function mainlobeHalfWidth(config: SonarConfig): number {
  const b = Math.max(1, Math.abs(config.f1 - config.f0));
  // The WIDER of the two tapers, not the receive one alone. For an LFM sweep
  // frequency maps monotonically to time, so shaping the transmit envelope
  // shapes the band; with a full Hann transmit taper and no receive window, a
  // receive-only reading says 16 samples when it measures 42, and every guard
  // band sized from it comes out less than half as wide as it needs to be.
  const widening = Math.max(mainlobeWidening(config.txWindow), mainlobeWidening(config.rxTaper));
  return (config.fs / b) * widening;
}

/**
 * The CFAR windows a waveform needs, derived rather than guessed.
 *
 * Mirrors `CfarConfig::sized_for` in the Rust core; `wasm.test.ts` asserts the
 * two agree against the core's own `design` report, so this cannot drift.
 */
export function recommendedCfarWindows(config: SonarConfig): {
  guard: number;
  train: number;
  mergeGap: number;
} {
  const mainlobe = mainlobeHalfWidth(config);
  const guard = Math.max(4, Math.ceil(1.5 * mainlobe));
  return {
    guard,
    train: Math.max(16, 2 * guard),
    mergeGap: Math.max(2, Math.ceil(mainlobe)),
  };
}

/** Speed of sound in dry air: `331.3 * sqrt(1 + T/273.15)` m/s. */
export function speedOfSound(temperatureC: number): number {
  return 331.3 * Math.sqrt(Math.max(0, 1 + temperatureC / 273.15));
}

export interface DesignReport {
  speedOfSoundMs: number;
  bandwidthHz: number;
  timeBandwidth: number;
  compressionGainDb: number;
  rangeResolutionM: number;
  blindRangeM: number;
  maxUnambiguousRangeM: number;
  rangeStepM: number;
  sidelobeDb: number;
  /** Compressed mainlobe width in samples, after BOTH tapers. */
  mainlobeSamples: number;
  /** The CFAR windows the core would choose for this waveform. */
  recommendedGuard: number;
  recommendedTrain: number;
  recommendedMergeGap: number;
  /** Non-null means the config is unrealisable or self-defeating. */
  warning: string | null;
}

/** Samples of record to capture per ping to reach `maxRangeM`, plus headroom
 *  for the unknown output latency the direct-path sync has to absorb. */
export function recordLenFor(config: SonarConfig): number {
  const c = speedOfSound(config.temperatureC);
  const rangeSamples = ((2 * config.maxRangeM) / c) * config.fs;
  const latencyHeadroom = config.directSearchS * config.fs;
  const pulse = config.durationS * config.fs;
  return Math.ceil(rangeSamples + latencyHeadroom + pulse);
}

/**
 * The pulse repetition interval that keeps `maxRangeM` unambiguous.
 *
 * Ping again before the previous echo has died and a far wall's return lands in
 * the next record, where it is indistinguishable from a near object — the
 * "second-time-around echo" that makes a sonar report a chair that is not there.
 */
export function minPriSeconds(config: SonarConfig): number {
  const c = speedOfSound(config.temperatureC);
  return (2 * config.maxRangeM) / c + config.durationS;
}
