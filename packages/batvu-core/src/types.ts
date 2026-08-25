// SPDX-License-Identifier: MIT

/** Window functions, in their two distinct roles: transmit amplitude taper and
 *  receive-side range-sidelobe control. See `crates/batvu-dsp/src/window.rs`. */
export type WindowName =
  | 'rect'
  | 'hann'
  | 'hamming'
  | 'blackman'
  | 'blackman-harris'
  | 'tukey';

export const WINDOW_NAMES: readonly WindowName[] = [
  'rect',
  'hann',
  'hamming',
  'blackman',
  'blackman-harris',
  'tukey',
] as const;

/** One reflector in a simulated 1-D scene, matching the Rust `sim::Target`. */
export interface SimTarget {
  rangeM: number;
  reflectivity: number;
  /** 2 for a compact object, 1 for a large flat surface. A wall returns far
   *  more energy than a chair at the same range, and conflating them makes the
   *  link budget optimistic by 10 dB or more. */
  spreading: number;
}

/** Scene-level acoustics for the Rust simulator. */
export interface SimScene {
  temperatureC?: number;
  absorptionDbPerM?: number;
  speakerMicSepM?: number;
  directPathGain?: number;
  noiseRms?: number;
  /** Unknown capture latency to prepend — the thing direct-path sync cancels. */
  latencySamples?: number;
  recordLen?: number;
  seed?: number;
  clip?: boolean;
}
