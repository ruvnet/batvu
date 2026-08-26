// SPDX-License-Identifier: MIT
//
// Slow-time micro-motion: what is left of a ping once the magnitude has been
// divided out.
//
// ## What arrives here, and what this file refuses to say
//
// The input is a DWELL: N complex range profiles taken on ONE bearing at the
// pulse repetition frequency. The output, per range bin, is a
// `micromotion_band` score in `[0, 1]` with a calibrated false-alarm rate, the
// estimated rate in hertz, and the value of the statistic that produced them.
//
// It does not output `presence`, and no arrangement of these functions
// produces one. ADR-023 §5: BatVu populates `range_m` and `micromotion_band`;
// deciding that a periodically moving surface at 2.4 m is a person is a fusion
// rule's job, run against other modalities, with a consent flag and a P4
// ceiling attached. A range-only sensor asserting personhood is the exact
// claim `gate_no_event_claims_a_person` exists to forbid, and a periodogram
// does not change the physics that motivated it — a coat on a chair in a
// draught moves too.
//
// ## Why phase, when the pipeline throws it away
//
// `envelope()` writes `√(re² + im²)` and every stage downstream sees
// magnitudes. Two-way phase for a radial displacement `d` is
//
//     Δφ = 4πd / λ,     λ = c / f
//
// which is arithmetic, not a measurement, and is the one relation this file is
// entitled to assume. At the centre of the shipping 17.5–20.5 kHz chirp —
// 19 kHz, 343 m/s — `λ = 18.05 mm`, so **1 mm of radial motion is 0.696 rad,
// about 40°**. (ADR-023 quotes 42°, which is the same arithmetic at 20 kHz.)
//
// Against that, the range resolution is `c / 2B = 343 / 6000 = 5.7 cm`. A
// millimetre of motion is 1/57th of a resolution cell: it does not move the
// compressed peak out of its bin, it ROTATES THE PHASOR INSIDE IT. That ratio
// — 57× — is the entire reason this file exists, and it is also why the
// magnitude path can be left exactly as it is.
//
// The excursion of a breathing chest is a clinical figure this repository has
// no citation for and does not assert. What is asserted is the conversion, and
// that the conversion is invertible: `d = Δφ·λ/4π`.
//
// ## Slow time, and the two limits it imposes
//
// Fix a range bin and read it across pings. The sequence `z[p]` is a phasor
// whose argument tracks that bin's radial displacement, sampled at the PRF.
// Two hard limits follow, both arithmetic:
//
// - **Unambiguous displacement per ping.** Unwrapping assumes successive
//   samples move by less than π, so `|Δd| < λ/4 = 4.5 mm` between pings — at
//   15 pings a second, a radial rate of 68 mm/s. Faster than that and the
//   unwrapped track is wrong, not noisy.
// - **Frequency resolution.** `Δf = PRF/N`, so the dwell length is the
//   resolution. Nothing here can distinguish two rates closer than that, and a
//   dwell shorter than a few periods of the slowest rate searched cannot see a
//   period at all. That case is REFUSED (`insufficient_dwell`) rather than
//   answered with a confident zero.
//
// ## The blocker, modelled: the sensor moves too
//
// ADR-023 §3 names this as the thing that can kill the idea cheaply. If 1 mm
// of target motion is 40° of phase, a few millimetres of hand movement is
// HUNDREDS of degrees — the operator is a far louder micro-motion source than
// the subject, and every periodogram in the dwell would be reporting the hand.
//
// What separates them is not amplitude, it is support. A translation of the
// phone along the boresight changes the two-way path to EVERY scatterer on
// that ray by the same amount, so it appears as an identical phase increment
// in every range bin. A target's motion appears in the bins the target
// occupies and nowhere else. So the sensor's motion is common-mode across
// range and the target's is not, and the estimator below is the obvious
// consequence: form the amplitude-weighted mean phase increment across the
// bins that have a usable return, and subtract it.
//
// This is a model of translation along the boresight. Rotation about the
// phone, and translation across the beam, are not common-mode in this sense
// and are not compensated. `commonModePeakM` is reported so that a caller can
// see how hard the step had to work; a dwell where it is millimetres is a
// dwell to distrust whatever the scores say.
//
// ## The null distribution, and where the false-alarm rate comes from
//
// The statistic is Fisher's g — the largest in-band periodogram ordinate as a
// fraction of the total in-band power:
//
//     g = max_{k∈B} P[k] / Σ_{k∈B} P[k]
//
// **Null hypothesis.** The bin holds a rigid reflector: constant amplitude `A`,
// constant range, plus receiver noise independent from ping to ping. For a
// complex sample `z = A·e^{iθ} + n` with `n` circular Gaussian, per-component
// variance `σ²`, the phase error is `≈ Im(n·e^{-iθ})/A` to first order, so the
// displacement sequence after mean removal is zero-mean white Gaussian with
//
//     σ_φ = σ/A = 1/√(2ρ),    ρ = A²/2σ² = A²/noiseFloor²
//     σ_d = σ_φ·λ/4π
//
// At ρ = 10 dB that is 0.224 rad, or 0.32 mm per ping at 19 kHz.
//
// **From white noise to exponential bins.** For a real white Gaussian sequence
// of length N, the DFT ordinates at the distinct Fourier frequencies
// `k = 1 … ⌊(N-1)/2⌋` have independent real and imaginary parts, each
// `N(0, Nσ_d²/2)`. So `P[k] = |X[k]|²` is the sum of two squared Gaussians of
// equal variance — an **Exponential** random variable — and the ordinates are
// mutually independent. `k = 0` and, for even N, `k = N/2` are real-valued and
// χ²₁ rather than exponential; both are excluded. Nothing else is done to the
// sequence: the window is rectangular, there is no zero-padding, and the only
// thing removed is the mean, which is EXACTLY the `k = 0` projection and
// therefore leaves every other ordinate untouched. That is not a stylistic
// choice, it is what keeps the null exact.
//
// **The distribution of g.** Let `E₁ … E_K` be i.i.d. Exponential and
// `S = ΣE_k`. The scale cancels in `g = max E_k / S`, and `(E_k/S)` is uniform
// on the simplex. For one index, `P(E₁/S ≥ x)` is the volume fraction of
// `{u ∈ Δ^{K-1} : u₁ ≥ x}`, which the substitution `u₁ = x + v₁` maps onto a
// simplex scaled by `(1-x)`, giving `(1-x)^{K-1}`. At most `⌊1/x⌋` of the
// events can hold at once, and by inclusion–exclusion
//
//     P(g ≥ x) = Σ_{j=1}^{⌊1/x⌋} (-1)^{j-1} · C(K,j) · (1 - jx)^{K-1}
//
// (Fisher, 1929.) It is exact, it has no free parameters, and it depends on
// nothing but K — the number of Fourier bins inside the searched band.
//
// **The reported score is the calibrated quantity.** `micromotionBand = 1 - p`
// where `p = P(g ≥ g_observed)`. So under the null, `P(score ≥ 1 - α) = α`
// exactly, for every α, and a caller who wants a 1-in-100 false-alarm rate
// thresholds at 0.99. `statisticThreshold` reports the same line in units of g.
//
// **Three caveats, all of which are real.**
//
// - The null is *a rigid reflector*, not *an empty bin*. With no return the
//   phase is uniform on (-π, π] and unwrapping produces a random walk, whose
//   periodogram is red and for which every number above is wrong. Bins below
//   `minSnrDb` are therefore REFUSED (`no_return`), and that gate is part of
//   the false-alarm claim rather than a convenience.
// - Common-mode rejection is estimated from the data, so with B usable bins it
//   removes O(1/B) of each bin's noise power and induces O(1/B) correlation
//   between bins. At B ≳ 32 this sits below the precision at which a
//   false-alarm rate can be measured empirically at all.
// - Nothing above models LEAKAGE. A strong out-of-band component — a residual
//   drift the common-mode step did not catch, a fan — spills into the in-band
//   ordinates through the rectangular window's `1/Δk` skirts, and the resulting
//   false alarms are not counted by the figure this file quotes. ADR-023 is
//   explicit that the honest adversary is a curtain over a radiator, and the
//   honest answer is that this detector has never met one.

/** A dwell of complex range profiles: N profiles on one bearing, in slow-time
 *  order. Plain typed arrays and nothing else — no wasm, no I/O. */
export interface ComplexProfileDwell {
  /** Interleaved `(re, im)` pairs, ping-major: bin `b` of ping `p` lives at
   *  `p*bins*2 + b*2`. This is the layout `envelope()`'s complex sibling
   *  writes a profile in, one profile after another. */
  data: Float32Array | Float64Array;
  /** Number of profiles (slow-time samples). */
  pings: number;
  /** Range bins per profile. */
  bins: number;
  /** Pulse repetition frequency in hertz — the slow-time sample rate. */
  prfHz: number;
  /** Two-way wavelength scale, metres. See `wavelengthM`; there is no default,
   *  because picking one would be inventing a centre frequency. */
  lambdaM: number;
  /** Range of bin 0, metres. Carried into the output, not used in the maths. */
  startRangeM?: number;
  /** Metres per range bin. Carried into the output. */
  rangeStepM?: number;
}

export interface DwellOptions {
  /** `[low, high]` in hertz: the band the periodicity test searches, and the
   *  band the false-alarm rate is exact over.
   *
   *  Required, with no default. A breathing band is a clinical figure this
   *  repository has no citation for (ADR-023 declines to assert the excursion
   *  for the same reason). The caller states what it is searching for; this
   *  file states how often noise would have fired.
   *  TODO(ADR-023): a measured band, from real captures with a LiDAR-derived
   *  label, is one of the things the corpus is for. */
  bandHz: readonly [number, number];
  /** RMS magnitude of the complex noise in one bin of one profile, in the same
   *  units as `data`, so that `snr = A²/noiseFloor²`. Defaults to
   *  `estimateNoiseFloor`, whose assumption is stated there. */
  noiseFloor?: number;
  /** Per-ping SNR below which a bin is refused as `no_return`. Default 10 dB.
   *
   *  Not a taste threshold: at 10 dB the phase noise is `1/√(2·10) = 0.224`
   *  rad, so an unwrap error needs a 14σ excursion and the linearisation the
   *  null distribution rests on is good to a few percent. At 0 dB the phase
   *  std is 0.71 rad, wraps happen, and the exponential null is simply false. */
  minSnrDb?: number;
  /** Cycles of the SLOWEST searched rate that must fit in the dwell before any
   *  score is produced. Default 3. */
  minCycles?: number;
  /** False-alarm rate the reported thresholds are quoted at. Default 0.01.
   *  Changes no arithmetic — the score is calibrated for every α at once. */
  alpha?: number;
  /** Subtract the across-bin common-mode phase. Default true. Off is for
   *  showing what the step was worth, not for production. */
  commonModeRejection?: boolean;
}

export interface MicroMotionBin {
  /** Range-bin index within the profile. */
  bin: number;
  /** Range in metres, if the dwell carried the geometry. */
  rangeM: number | null;
  /** `no_return` means the bin failed the SNR gate: its phase is not a
   *  measurement of anything and no statistic was computed for it. */
  status: 'ok' | 'no_return';
  /** The ADR-023 §5 feature, in `[0, 1]`: `1 - p` under the null documented at
   *  the top of this file. Threshold it at `1 - α` to buy a false-alarm rate
   *  of α. It is NOT a probability that anything is present, and there is no
   *  `presence` field here or anywhere else in this package. */
  micromotionBand: number;
  /** `P(g ≥ observed)` under the null. */
  pValue: number;
  /** Fisher's g: the peak's share of in-band power, in `[1/K, 1]`. */
  statistic: number;
  /** Centre frequency of the winning Fourier bin, hertz. Accurate to ±Δf/2 by
   *  construction — no interpolation, so the figure has a stated tolerance
   *  rather than an implied one. */
  rateHz: number | null;
  /** Displacement AMPLITUDE (half of peak-to-peak) at `rateHz`, metres, from
   *  `A = 2|X[k]|/N`. Exact for a tone on a Fourier bin; worst case, half a bin
   *  off, the rectangular window's scalloping loss makes this `2/π = 0.64` of
   *  the truth. A lower bound, in other words. */
  displacementM: number | null;
  /** Per-ping displacement noise `σ_φ·λ/4π`, metres — what a millimetre has to
   *  compete with in ONE ping. The dwell divides it by `√N` in a DFT bin. */
  displacementNoiseM: number | null;
  /** Per-ping SNR in dB, from `Â² = mean|z|² - noiseFloor²`. */
  snrDb: number;
}

export interface MicroMotionDwell {
  /** `insufficient_dwell` means no score was computed for any bin, and `bins`
   *  is empty. A short dwell is not evidence of stillness. */
  status: 'ok' | 'insufficient_dwell';
  /** Why, when the status is not `ok`. */
  reason: string | null;
  /** Dwell length, seconds. */
  dwellS: number;
  prfHz: number;
  /** `PRF/N` — the resolution, and the tolerance on every `rateHz`. */
  freqResolutionHz: number;
  bandHz: readonly [number, number];
  /** K: Fourier bins inside the band. The only parameter of the null. */
  bandBins: number;
  alpha: number;
  /** The g above which the null fires with probability α. */
  statisticThreshold: number;
  /** `1 - alpha`: the same line, in the units the score is reported in. */
  scoreThreshold: number;
  noiseFloor: number;
  /** True when the floor was estimated from the dwell rather than measured. */
  noiseFloorEstimated: boolean;
  commonModeRejected: boolean;
  /** Peak absolute common-mode displacement over the dwell, metres — the
   *  sensor's own motion as this dwell measured it. Always computed, whether
   *  or not it was subtracted, because it is the number ADR-023 says can end
   *  the enquiry. */
  commonModePeakM: number;
  /** Usable bins, in bin order. Empty when `status !== 'ok'`. */
  bins: MicroMotionBin[];
}

/** Terms of the inclusion–exclusion series that are ever evaluated.
 *
 *  ODD on purpose. Bonferroni: truncating inclusion–exclusion after an odd
 *  number of terms leaves an UPPER bound on the probability, so a truncated
 *  series can overstate a p-value but never understate it, and the realised
 *  false-alarm rate stays at or below the quoted one. Truncation only bites
 *  for `g < 1/11`, where the p-value is indistinguishable from 1 anyway. */
const MAX_INCLUSION_TERMS = 11;

/** Two-way wavelength: `c/f`. Arithmetic, exported so a caller states its own
 *  centre frequency and temperature rather than inheriting a guess from here. */
export function wavelengthM(freqHz: number, speedOfSoundMs: number): number {
  return speedOfSoundMs / freqHz;
}

/** Per-ping phase standard deviation for a given per-ping SNR, `1/√(2ρ)`.
 *
 *  The small-angle linearisation of `arg(A + n)`, so it is a good figure while
 *  it is a small number and worthless once it approaches a radian — which is
 *  exactly what `minSnrDb` is for. */
export function phaseNoiseStdRad(snrDb: number): number {
  return 1 / Math.sqrt(2 * Math.pow(10, snrDb / 10));
}

/**
 * `P(g ≥ x)` for Fisher's g with `k` independent exponential ordinates.
 *
 * The series derived at the top of this file. Evaluated in logs, because
 * `C(k,j)` runs away long before the `(1-jx)^{k-1}` factor that cancels it.
 */
export function fisherGPValue(g: number, k: number): number {
  if (!Number.isFinite(g) || k < 2) return 1;
  if (g >= 1) return 0;
  if (g <= 1 / k) return 1;

  const terms = Math.min(Math.floor(1 / g), MAX_INCLUSION_TERMS);
  let logBinomial = 0;
  let sum = 0;
  for (let j = 1; j <= terms; j++) {
    logBinomial += Math.log((k - j + 1) / j);
    const rest = 1 - j * g;
    if (rest <= 0) break;
    const term = Math.exp(logBinomial + (k - 1) * Math.log(rest));
    sum += j % 2 === 1 ? term : -term;
  }
  return Math.min(1, Math.max(0, sum));
}

/**
 * The g whose p-value is `alpha`. Bisection, because the series is monotone
 * decreasing in g and there is no closed-form inverse.
 *
 * The first term alone gives `x ≈ 1 - (α/k)^{1/(k-1)}`, which is where the
 * bracket comes from and is worth reading as the sanity check: at k = 21 and
 * α = 0.01 it puts the line at g = 0.32, i.e. the winning rate must hold about
 * a third of all in-band power before this file will say so.
 */
export function fisherGThreshold(alpha: number, k: number): number {
  if (k < 2) return 1;
  if (alpha <= 0) return 1;
  if (alpha >= 1) return 1 / k;
  let lo = 1 / k;
  let hi = 1;
  for (let i = 0; i < 80; i++) {
    const mid = 0.5 * (lo + hi);
    if (fisherGPValue(mid, k) > alpha) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/**
 * Unwrap a phase sequence in place, so that successive samples never differ by
 * more than π.
 *
 * The assumption is the one stated at the top: the true inter-ping phase step
 * is under π, i.e. under `λ/4` of radial displacement. Where that holds this is
 * exact; where it does not, it is confidently wrong, which is why the SNR gate
 * and the common-mode step both run before it.
 */
export function unwrapInPlace(phase: Float64Array): Float64Array {
  let offset = 0;
  for (let i = 1; i < phase.length; i++) {
    const delta = phase[i]! - (phase[i - 1]! - offset);
    offset -= 2 * Math.PI * Math.round(delta / (2 * Math.PI));
    phase[i]! += offset;
  }
  return phase;
}

/**
 * Noise floor from the dwell itself: the median over range bins of the RMS
 * magnitude.
 *
 * The assumption is that most range bins of a room hold no target, which is
 * true of a range profile and false of a dwell pointed at a wall two metres
 * away in a corridor. It is a fallback, and `noiseFloorEstimated` in the output
 * says when it was used, because a floor that is too high refuses real bins and
 * a floor that is too low admits bins whose phase is a random walk.
 */
export function estimateNoiseFloor(dwell: ComplexProfileDwell): number {
  const { data, pings, bins } = dwell;
  const power = new Float64Array(bins);
  for (let b = 0; b < bins; b++) {
    let sum = 0;
    for (let p = 0; p < pings; p++) {
      const i = (p * bins + b) * 2;
      const re = data[i]!;
      const im = data[i + 1]!;
      sum += re * re + im * im;
    }
    power[b]! = sum / pings;
  }
  const sorted = Array.from(power).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median =
    sorted.length % 2 === 1
      ? sorted[mid]!
      : 0.5 * (sorted[mid - 1]! + sorted[mid]!);
  return Math.sqrt(Math.max(0, median));
}

/**
 * The whole detector: a dwell of complex profiles in, a scored range profile
 * out.
 *
 * Three passes over the cube. The first measures each bin's amplitude and
 * decides which bins are worth listening to; the second builds the common-mode
 * track from those bins alone — a bin whose phase is a random walk must not be
 * allowed to vote on where the phone went; the third scores each surviving bin.
 * The DFT is naive over the in-band Fourier bins only, which for a 40 s dwell
 * in a half-hertz band is 21 bins of 600 points, and the trig table is built
 * once for the dwell rather than once per range bin.
 */
export function analyzeDwell(
  dwell: ComplexProfileDwell,
  options: DwellOptions,
): MicroMotionDwell {
  const { data, pings, bins, prfHz, lambdaM } = dwell;
  if (!Number.isInteger(pings) || pings < 2 || !Number.isInteger(bins) || bins < 1) {
    throw new Error(`batvu: dwell must have pings ≥ 2 and bins ≥ 1 (got ${pings}×${bins})`);
  }
  if (data.length !== pings * bins * 2) {
    throw new Error(
      `batvu: dwell data length ${data.length} is not 2·${pings}·${bins} interleaved re/im`,
    );
  }
  if (!(prfHz > 0) || !Number.isFinite(prfHz)) {
    throw new Error(`batvu: prfHz ${prfHz} must be finite and positive`);
  }
  if (!(lambdaM > 0) || !Number.isFinite(lambdaM)) {
    throw new Error(`batvu: lambdaM ${lambdaM} must be finite and positive`);
  }
  const bandLo = options.bandHz[0];
  const bandHi = options.bandHz[1];
  if (!(bandLo > 0) || !(bandHi > bandLo) || bandHi > prfHz / 2) {
    throw new Error(
      `batvu: band [${bandLo}, ${bandHi}] Hz must satisfy 0 < lo < hi ≤ PRF/2 (${prfHz / 2})`,
    );
  }

  const minSnrDb = options.minSnrDb ?? 10;
  const minCycles = options.minCycles ?? 3;
  const alpha = options.alpha ?? 0.01;
  const rejectCommonMode = options.commonModeRejection ?? true;
  const noiseFloorEstimated = options.noiseFloor === undefined;
  const noiseFloor = options.noiseFloor ?? estimateNoiseFloor(dwell);

  const dwellS = pings / prfHz;
  const df = prfHz / pings;
  // k = 0 is the mean, already removed. For even N the k = N/2 ordinate is
  // real-valued and χ²₁, not exponential; excluding it keeps the null exact
  // even though a breathing band never comes near Nyquist.
  const kNyquist = Math.floor((pings - 1) / 2);
  // The ±1e-9 is not slack in the band, it is slack in the DIVISION: a band
  // edge that lands exactly on a Fourier bin (0.6/0.025 evaluates to
  // 24.000000000000004) would otherwise be included or excluded by the last
  // bit of a float, and K is the only parameter of the null distribution.
  const kLo = Math.max(1, Math.ceil(bandLo / df - 1e-9));
  const kHi = Math.min(kNyquist, Math.floor(bandHi / df + 1e-9));
  const bandBins = kHi - kLo + 1;

  const header = {
    dwellS,
    prfHz,
    freqResolutionHz: df,
    bandHz: options.bandHz,
    bandBins: Math.max(0, bandBins),
    alpha,
    statisticThreshold: bandBins >= 2 ? fisherGThreshold(alpha, bandBins) : 1,
    scoreThreshold: 1 - alpha,
    noiseFloor,
    noiseFloorEstimated,
    commonModeRejected: rejectCommonMode,
  };

  // Both refusals return before any bin is touched, so `commonModePeakM` is
  // zero because nothing was measured, not because the phone was still. The
  // status and the reason are the fields to read.
  if (dwellS * bandLo < minCycles) {
    return {
      ...header,
      status: 'insufficient_dwell',
      reason:
        `dwell of ${dwellS.toFixed(1)} s holds ${(dwellS * bandLo).toFixed(1)} cycles ` +
        `of the ${bandLo} Hz band edge; ${minCycles} required`,
      commonModePeakM: 0,
      bins: [],
    };
  }
  if (bandBins < 2) {
    return {
      ...header,
      status: 'insufficient_dwell',
      reason:
        `band [${bandLo}, ${bandHi}] Hz holds ${Math.max(0, bandBins)} Fourier bins at ` +
        `${df.toFixed(4)} Hz resolution; a maximum over fewer than 2 is not a test`,
      commonModePeakM: 0,
      bins: [],
    };
  }

  // Pass 1: amplitude per bin, and the SNR gate.
  const snrGate = Math.pow(10, minSnrDb / 10);
  const meanPower = new Float64Array(bins);
  const usable = new Uint8Array(bins);
  const floorPower = noiseFloor * noiseFloor;
  for (let b = 0; b < bins; b++) {
    let sum = 0;
    let finite = true;
    for (let p = 0; p < pings; p++) {
      const i = (p * bins + b) * 2;
      const re = data[i]!;
      const im = data[i + 1]!;
      if (!Number.isFinite(re) || !Number.isFinite(im)) {
        finite = false;
        break;
      }
      sum += re * re + im * im;
    }
    meanPower[b]! = finite ? sum / pings : 0;
    // Â² = mean|z|² - E|n|². A bin with no return at all lands at or below the
    // floor and its "phase" is uniform on (-π, π]; refusing it is the whole
    // point of the gate.
    const signal = meanPower[b]! - floorPower;
    usable[b]! = finite && signal > 0 && signal > snrGate * floorPower ? 1 : 0;
  }

  // Pass 2: the common-mode track.
  //
  // Σ_b z[b,p]·conj(z[b,p-1]) over usable bins is the maximum-likelihood
  // estimate of a phase increment shared by all of them, and it is amplitude
  // weighted for free: a bright bin measures the increment better than a dim
  // one and contributes proportionally. `arg` of the sum lands in (-π, π], so
  // the cumulative sum below is already unwrapped under the same λ/4 per ping
  // assumption as everything else.
  //
  // The estimator's failure mode is worth naming: a SINGLE dominant scatterer
  // that is itself moving will be absorbed into the common mode and subtracted
  // away. That is right for the phone's own motion and wrong for a target that
  // outshines the room, and from one bearing the two are the same measurement.
  // It is ADR-023's blocker restated, not a defect in this function.
  const commonPhase = new Float64Array(pings);
  let commonPeak = 0;
  for (let p = 1; p < pings; p++) {
    let re = 0;
    let im = 0;
    for (let b = 0; b < bins; b++) {
      if (usable[b]! === 0) continue;
      const i = (p * bins + b) * 2;
      const j = ((p - 1) * bins + b) * 2;
      const ar = data[i]!;
      const ai = data[i + 1]!;
      const br = data[j]!;
      const bi = data[j + 1]!;
      re += ar * br + ai * bi;
      im += ai * br - ar * bi;
    }
    commonPhase[p]! = commonPhase[p - 1]! + (re === 0 && im === 0 ? 0 : Math.atan2(im, re));
    commonPeak = Math.max(commonPeak, Math.abs(commonPhase[p]!));
  }
  const metresPerRadian = lambdaM / (4 * Math.PI);
  const commonModePeakM = commonPeak * metresPerRadian;

  // The trig table: cos/sin of 2πkn/N for the in-band k only, built once for
  // the dwell instead of once per range bin.
  const table = new Float64Array(bandBins * pings * 2);
  for (let ki = 0; ki < bandBins; ki++) {
    const k = kLo + ki;
    for (let n = 0; n < pings; n++) {
      const angle = (-2 * Math.PI * k * n) / pings;
      table[(ki * pings + n) * 2]! = Math.cos(angle);
      table[(ki * pings + n) * 2 + 1]! = Math.sin(angle);
    }
  }

  const phase = new Float64Array(pings);
  const out: MicroMotionBin[] = [];
  for (let b = 0; b < bins; b++) {
    const rangeM =
      dwell.startRangeM !== undefined && dwell.rangeStepM !== undefined
        ? dwell.startRangeM + b * dwell.rangeStepM
        : null;
    const snrDb =
      floorPower > 0 && meanPower[b]! > floorPower
        ? 10 * Math.log10((meanPower[b]! - floorPower) / floorPower)
        : -Infinity;

    if (usable[b]! === 0) {
      // A refusal, not a measurement of stillness. `status` is the field to
      // read; the zero score exists so the type stays a number.
      out.push({
        bin: b,
        rangeM,
        status: 'no_return',
        micromotionBand: 0,
        pValue: 1,
        statistic: 0,
        rateHz: null,
        displacementM: null,
        displacementNoiseM: null,
        snrDb: Number.isFinite(snrDb) ? snrDb : -Infinity,
      });
      continue;
    }

    for (let p = 0; p < pings; p++) {
      const i = (p * bins + b) * 2;
      phase[p]! = Math.atan2(data[i + 1]!, data[i]!);
    }
    unwrapInPlace(phase);

    // Displacement, mean removed. Mean removal is exactly the k = 0 projection,
    // so it changes no other ordinate and the null survives it untouched. The
    // per-bin constant — the scatterer's own reflection phase — goes with it,
    // which is the only reason a bin's absolute phase never has to be known.
    let mean = 0;
    for (let p = 0; p < pings; p++) {
      const corrected = rejectCommonMode ? phase[p]! - commonPhase[p]! : phase[p]!;
      phase[p]! = corrected * metresPerRadian;
      mean += phase[p]!;
    }
    mean /= pings;
    for (let p = 0; p < pings; p++) phase[p]! -= mean;

    let total = 0;
    let peak = -1;
    let peakK = kLo;
    for (let ki = 0; ki < bandBins; ki++) {
      let re = 0;
      let im = 0;
      const base = ki * pings * 2;
      for (let n = 0; n < pings; n++) {
        const v = phase[n]!;
        re += v * table[base + n * 2]!;
        im += v * table[base + n * 2 + 1]!;
      }
      const power = re * re + im * im;
      total += power;
      if (power > peak) {
        peak = power;
        peakK = kLo + ki;
      }
    }

    // A perfectly constant track — no noise, no motion — has no power anywhere
    // and no rate to report. g = 1/K is the "no evidence" value, and p = 1.
    const g = total > 0 ? peak / total : 1 / bandBins;
    const pValue = fisherGPValue(g, bandBins);
    const amplitude = total > 0 ? (2 * Math.sqrt(peak)) / pings : 0;

    out.push({
      bin: b,
      rangeM,
      status: 'ok',
      micromotionBand: 1 - pValue,
      pValue,
      statistic: g,
      rateHz: total > 0 ? peakK * df : null,
      displacementM: total > 0 ? amplitude : 0,
      displacementNoiseM: phaseNoiseStdRad(snrDb) * metresPerRadian,
      snrDb,
    });
  }

  return { ...header, status: 'ok', reason: null, commonModePeakM, bins: out };
}

/**
 * The feature map a fusion consumer receives for one range bin.
 *
 * One key. ADR-023 §5 authorises `micromotion_band` and nothing else, so the
 * rate and the statistic ride outside the feature map as diagnostics — a
 * sensor inventing wire keys is how a schema stops meaning anything.
 *
 * There is deliberately no `presence` key. Fusion has one, `weighted_bayes`
 * over several modalities decides it, and a range sensor that filled it in
 * would be asserting the exact distinction — a person from a coat on a chair —
 * that one transducer pair cannot make.
 */
export function micromotionFeature(bin: MicroMotionBin): { micromotion_band: number } {
  return { micromotion_band: bin.status === 'ok' ? bin.micromotionBand : 0 };
}
