# @batvu/micromotion

ADR-023 Decision 3: the classical micro-motion detector.

Slow-time phase per range bin over a dwell, common-mode rejected, band-limited,
with a periodicity statistic whose false-alarm rate is **derived rather than
asserted**. Pure functions over plain typed arrays — no wasm, no I/O, no
dependency on the rest of the workspace.

## What it reports, and what it will not

Per range bin: a `micromotion_band` score in `[0, 1]`, the estimated rate in
hertz, the value of the statistic, and the displacement amplitude in metres.

It does **not** report `presence`, and there is no way to make it. BatVu
populates `range_m` and `micromotion_band`; deciding that a periodically moving
surface at 2.4 m is a person is a RuField fusion rule's job — `weighted_bayes`
over several modalities, with `requires_consent` and a P4 ceiling attached.
`gate_no_event_claims_a_person` does not move because this package exists.

## The measurement

Two-way phase for a radial displacement `d` is `Δφ = 4πd/λ`, `λ = c/f`. At the
centre of the shipping 17.5–20.5 kHz chirp — 19 kHz in 343 m/s air —
`λ = 18.05 mm`, so **1 mm of radial motion is 0.696 rad, about 40°**. (ADR-023
quotes 42°, the same arithmetic at 20 kHz.) Range resolution over the same
waveform is `c/2B = 5.7 cm`: a millimetre is 1/57th of a resolution cell, so it
does not move the compressed peak between bins, it rotates the phasor inside
one. That ratio is why this package exists and why the magnitude path is
untouched.

The excursion of a breathing chest is a clinical figure this repository has no
citation for and does not assert. Neither are the band edges: `bandHz` is a
required parameter with no default, and the false-alarm rate is exact for
whatever band the caller states.

## The false-alarm rate

The statistic is Fisher's g — the largest in-band periodogram ordinate as a
fraction of total in-band power.

**Null**: a rigid reflector. Constant amplitude `A`, constant range, receiver
noise independent from ping to ping. The phase error is `≈ Im(n e^{-iθ})/A`, so
the displacement track is zero-mean white Gaussian with `σ_φ = 1/√(2ρ)` and
`σ_d = σ_φ λ/4π`.

**From white noise to exponential bins**: the DFT of a real white Gaussian
sequence has independent real and imaginary parts of equal variance at each
distinct Fourier frequency, so `P[k] = |X[k]|²` is Exponential and the
ordinates are independent. `k = 0` and (for even N) `k = N/2` are real-valued
and χ²₁; both are excluded. The window is rectangular, there is no zero-padding,
and the only thing removed is the mean — which is exactly the `k = 0`
projection and therefore leaves every other ordinate untouched. That is what
keeps the null exact rather than approximate.

**The distribution**: with `E_k` i.i.d. Exponential and `S = ΣE_k`, the vector
`(E_k/S)` is uniform on the simplex, `P(E_1/S ≥ x) = (1-x)^{K-1}`, at most
`⌊1/x⌋` such events can hold at once, and inclusion–exclusion gives

```
P(g ≥ x) = Σ_{j=1..⌊1/x⌋} (-1)^{j-1} · C(K,j) · (1 - jx)^{K-1}
```

(Fisher, 1929.) Its only parameter is `K`, the number of Fourier bins inside the
searched band. The reported score is `1 - p`, so `P(score ≥ 1-α) = α` under the
null for every α at once, and thresholding at 0.99 buys a 1-in-100 false-alarm
rate. Measured over 2048 simulated rigid reflectors at 20 dB, K = 21:
**0.0103 at a nominal 0.01, and 0.0454 at a nominal 0.05.**

Three caveats, all real:

- The null is *a rigid reflector*, not *an empty bin*. With no return the phase
  is uniform and unwrapping produces a random walk with a red spectrum. Bins
  below `minSnrDb` (default 10 dB) are refused as `no_return`, and that gate is
  part of the false-alarm claim, not a convenience.
- Common-mode rejection is estimated from the data, so it removes O(1/B) of each
  bin's noise power and correlates bins at O(1/B).
- Nothing models **leakage**. A strong out-of-band component — a residual drift,
  a fan — spills through the rectangular window's skirts, and those false alarms
  are not in the figure above. ADR-023 is explicit that the honest adversary is
  a curtain over a radiator, and the honest answer is that this detector has
  never met one.

## The blocker, modelled

Translation of the phone along the boresight changes the two-way path to every
scatterer on that ray equally, so it appears as an identical phase increment in
every range bin; a target's motion does not. `analyzeDwell` forms the
amplitude-weighted mean phase increment across bins that pass the SNR gate and
subtracts it, and reports `commonModePeakM` — the sensor's own motion as this
dwell measured it — whether or not the subtraction was applied. A dwell where
that number is millimetres is a dwell to distrust whatever the scores say.

The step cannot separate the phone's motion from a single dominant scatterer
that is itself moving. That is ADR-023 §3 restated, not a defect here.

## API

```ts
analyzeDwell(dwell: ComplexProfileDwell, options: DwellOptions): MicroMotionDwell
micromotionFeature(bin: MicroMotionBin): { micromotion_band: number }
estimateNoiseFloor(dwell: ComplexProfileDwell): number
wavelengthM(freqHz: number, speedOfSoundMs: number): number
phaseNoiseStdRad(snrDb: number): number
unwrapInPlace(phase: Float64Array): Float64Array
fisherGPValue(g: number, k: number): number
fisherGThreshold(alpha: number, k: number): number
```

`dwell.data` is interleaved `(re, im)`, ping-major: bin `b` of ping `p` at
`p*bins*2 + b*2`.

Two refusals are returned rather than answered. A dwell too short to hold
`minCycles` (default 3) periods of the slowest searched rate, or a band holding
fewer than two Fourier bins, comes back as `status: 'insufficient_dwell'` with
an empty `bins` array — a short dwell is not evidence of stillness. A bin below
the SNR gate comes back as `status: 'no_return'` with a null rate.

## Limits that are arithmetic, not engineering

- **Unambiguous displacement per ping**: `|Δd| < λ/4 = 4.5 mm`, which at 15
  pings a second is a radial rate of 68 mm/s. Faster and the unwrapped track is
  wrong, not noisy.
- **Rate resolution**: `Δf = PRF/N`. Rates are reported at Fourier-bin centres
  with no interpolation, so the tolerance is ±Δf/2 and is stated rather than
  implied.
- **Displacement is a lower bound**: `A = 2|X[k]|/N` is exact for a tone on a
  Fourier bin and, worst case half a bin off, loses the rectangular window's
  scalloping factor of `2/π = 0.64`.

## Status

Measured against synthesised phase modulations, and therefore a prediction.
BatVu has measured zero real rooms. Nothing in the test suite depends on the
Rust simulator: ADR-023 §4 allows `Target::breathing` to exist as a unit-test
fixture for arithmetic and bars it from being evidence about people, so what is
tested here is only that the machinery computes what it claims to — a known
modulation in, the stated rate and displacement out, and pure noise firing at
the rate the derivation predicts.
