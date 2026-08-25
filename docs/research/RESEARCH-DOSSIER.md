# BatVu Research Dossier

*Swarm synthesis, 2026-08-25. Five research lenses, one adversarial verification pass. Where a
verdict corrected a claim, the corrected form is what appears below; §10 lists every correction.*

---

## 0. Executive summary — can an iPhone do this, and how well?

Yes, but not the product the name implies. An iPhone in iOS Safari can build a **pose-tagged
spherical depth panorama of a room from a single standing position**, with a range cell of roughly
**7–10 cm**, per-direction range accuracy of roughly **0.5 m**, and a working envelope of about
**0.3 m to 4–5 m** for hard flat surfaces. It cannot produce a bat-like 3-D occupancy volume with
crisp walls, and it cannot do it from a single ping.

Five numbers set the ceiling, and none of them are fixable with better DSP:

| Limit | Value | Consequence |
|---|---|---|
| Usable band (transducer + codec) | ~17.5–20.5 kHz, B ≈ 3 kHz | Δr = c/2B = 5.7 cm nominal; **9.3 cm realizable** after the mandatory transmit taper |
| Microphone channels in iOS Safari | 1 (mono) | No ILD, no ITD, no beamforming. Every bearing degree comes from phone pose |
| Radiating aperture at λ = 17.9 mm | 2–10 mm (ka = 0.7–3.5) | No transmit beam exists. Each ping insonifies a 30–60° cone |
| Emission cap (ICNIRP 2024 / IRPA, 20 kHz ⅓-octave, public) | **70 dB SPL** | Binds *before* the transducer does. Link budget is capped from the top |
| Reverberation, not noise | Critical distance ≈ 0.74 m | Beyond ~1 m the floor is the room's own tail, ~30 dB above mic self-noise |

The honest framing: **BatVu is a short-range, sweep-to-fill acoustic scanner, not a snapshot depth
sensor.** The user stands still and sweeps the phone like a flashlight; each 1-D range profile is
painted into a spherical occupancy grid through a wide cone; the map sharpens where cones intersect.
Range is precise (mm-class CRLB on an isolated echo, cm-class in practice), bearing is metres-blurry
at 3 m. That anisotropy — roughly **66–99 : 1 in resolution, ~490 : 1 in precision** — is the
governing visual and architectural fact of the whole project.

Three things would make this a different, better product and all three require abandoning the
browser: a native app with 96/192 kHz capture, access to the iPhone's 3–4 element mic array, and
ARKit VIO for 6-DoF pose. None are reachable from iOS Safari in 2026. Say so in the README rather
than letting the gap read as a bug.

---

## 1. Bat biosonar as blueprint — what a 1-speaker/1-mic phone can and cannot copy

| Bat mechanism | Bat's numbers | Phone equivalent | Verdict |
|---|---|---|---|
| FM sweep → range resolution | B ≈ 60 kHz → Δr = 2.86 mm | B = 3 kHz → Δr = 5.72 mm ×10; **9.3 cm realizable** | **Transfers, 15–24× worse** |
| Delay-jitter accuracy inside the cell | 0.5–1 µs → 0.086–0.17 mm | σ_r = c√3/(2πB√(2·SNR)) = 2.2 mm @ B=3 kHz, 20 dB | **Transfers** (report separately from resolution) |
| Adaptive PRF, PRF = c/(2·k·r_est), k ≈ 2–3 | 10 → 200 Hz | Pure scheduling, free | **Transfers** |
| Three-phase call state machine (search/approach/buzz) | 8 ms/10 Hz → 0.3 ms/200 Hz | T and PRF driven by nearest strong return | **Transfers** |
| Blind range r = cT/2 | 0.3 ms → 5.1 cm | 5 ms → 0.86 m | **Transfers, 17× worse** |
| Stapedius self-deafening reflex, 20–25 dB | mechanical | Digital sub-sample template subtraction, **20–35 dB** | **Transfers, comparable — not "strictly better"** |
| CF tone for Doppler / flutter | 83 kHz, Δf = 484 Hz per m/s | 20 kHz, Δf = 117 Hz per m/s; 0.1 m/s needs T ≥ 86 ms | **Do not ship.** Duty cycle and blind range both forbid it (§10-C4) |
| Doppler-shift compensation, TX/RX frequency duplexing | pre-shift emission, 200 Hz window | A static wall returns at *exactly* f₀ from a static phone — zero separation | **Does not transfer** |
| Binaural azimuth (ITD 58 µs, ILD 20–30 dB) | MAA 1.5–3° | iOS Safari exposes one mono channel | **Hard blocker — impossible** |
| Pinna/tragus spectral-notch elevation | 2.17 octaves of band, ~1 kHz/° | Phone has 0.24 octave (17.5→20.5 kHz) | **Hard blocker — impossible** |
| Head-scanning / pinna waggle, **incoherent** multi-look | 2–8 Hz, tens of degrees | IMU-pose-tagged incoherent accumulation | **Transfers — and is the *only* source of bearing** |
| Coherent multi-pulse integration | bats cannot | Phone cannot either: 420°/ping at 0.2 m/s | **Neither can do it** (§10-C6) |
| Source level | 130–140 dB SPL @ 10 cm | 65–70 dB SPL @ 1 m (= 85–90 @ 10 cm), ICNIRP-capped | **~45–55 dB deficit** |
| Atmospheric absorption | 3.28 dB/m @ 100 kHz | **0.52 dB/m @ 20 kHz** | **Phone wins** — but this is not why bats are short-range |
| Spectral jamming avoidance | weak/absent in the literature | Do not copy. Use dithered PRI + TDMA | **Myth — do not implement** |

Two places the phone genuinely beats the bat: **absorption** (6× less loss per metre) and **a
deterministic known transmit waveform** (which enables sub-sample blast cancellation and a
matched filter derived from the measured loopback). Neither offsets the ~50 dB source-level deficit.

---

## 2. The platform envelope — iPhone + iOS Safari hard numbers

| Quantity | Value | Source | Confidence |
|---|---|---|---|
| AudioContext sample rate | **Read at runtime.** 48000 typical, 44100 observed on current devices | howler#1141, godot#36643, standardized-audio-context#489 | high |
| Codec decimation passband edge | ≈ 0.45·fs → 21.6 kHz @ 48 k, **19.8 kHz @ 44.1 k** | codec filter geometry; not an analog AA filter | medium |
| Loudspeaker HF cliff (measured loopback, iPhone 7/8) | significant attenuation **above 19 kHz**, sharp drop above 20 kHz | SonicPACT, arxiv 2012.04770 | high |
| Mic channels from getUserMedia | **1** (mono); no array access | W3C/WebRTC, Chromium 40403559 | high |
| `echoCancellation:false` | the **only** implemented constraint; disables AEC + AGC + the ~12 kHz VPIO low-pass together | WebKit bug 179411, r252681, 2019-11-19 | high |
| `autoGainControl` / `noiseSuppression` constraints | **unimplemented in WebKit**; silently dropped, absent from `getSettings()` | WebKit bug 204444 (NEW, 2026-04-06) | high |
| Output latency | `AudioContext.outputLatency` **absent** (undefined) in Safari; `baseLatency` present | WebKit FIXME; MDN BCD | high |
| Round-trip WebAudio→speaker→air→mic→worklet | 10–40 ms, route-dependent, unreported | multiple | high |
| Ringer/mute switch | silences Web Audio under `ambient`; Safari's `auto` starts ambient | WebKit 237322; `navigator.audioSession` is Safari-only | high |
| Output routing with active capture | forced to **built-in loudspeaker** on modern iOS (steals from headphones); page has no `setSinkId`, no audiooutput devices | multiple 2024–2026 reports | medium |
| System output volume | **not readable, not settable** from the browser — an unknown 40+ dB scaling | iOS platform | high |
| AudioWorklet | Safari 14.1 / iOS 14.5, 128-frame quantum (2.667 ms @ 48 k) | Safari release notes | high |
| Worklet global scope | no `fetch`, no `instantiateStreaming`, **no `TextEncoder`/`TextDecoder`**, no `setTimeout` | WorkletGlobalScope IDL | high |
| wasm SIMD (`+simd128`) | Safari 16.4+ | WebKit | high |
| WebXR / ARKit | **absent on iOS in 2026**; visionOS 2 only, and no `immersive-ar` even there | Apple forums 743655/756850 | high |
| DeviceOrientation/Motion | two separate `requestPermission()` calls, user gesture + HTTPS + a **Settings → Safari → Motion & Orientation** toggle; ~60 Hz upper bound | MDN, w3c/deviceorientation#6 | high |
| Absolute yaw | only `webkitCompassHeading` (±10°, −1 when uncalibrated, **opposite sign to `alpha`**); `deviceorientationabsolute` never fires | w3c/deviceorientation#6 | high |
| Attitude quality | pitch/roll gravity-referenced, 0.5–2°; yaw ±10–20° | CoreMotion | medium |
| rAF rate | **not 60 Hz-capped any more** — Safari 26.x exposes a 120 Hz toggle; 30 Hz in Low Power Mode | Safari 26 coverage | medium |
| WebGL float targets | `EXT_color_buffer_half_float` yes, `EXT_color_buffer_float` no | Khronos WebGL#3093 | medium |
| `navigator.vibrate` | **contested in 2026** — BCD#29166 reports it working; feature-detect, do not hard-block | mdn/browser-compat-data#29166 | low |
| Emission cap, 20 kHz ⅓-octave (17.8–22.4 kHz) | **70 dB SPL public / 75 dB occupational** (ICNIRP 2024 reaffirming IRPA 1984) | ICNIRP Ultrasound Statement 2024 | medium |
| Mic self-noise | 29 dBA EIN → **−14 dB SPL/√Hz** → 20.8 dB SPL in 3 kHz | MEMS SNR 65 dB re 94 dB SPL | medium |
| Air absorption (ISO 9613-1, 20 °C/50 % RH) | 0.443 / 0.483 / 0.524 / 0.607 dB/m at 18/19/20/22 kHz | ISO 9613-1, recomputed | high |

**Five startup gates that must fail loudly**, because every one of them otherwise renders an empty
room that looks like a real result:

1. `echoCancellation:false` requested **and acoustically verified** (see §2 note below).
2. In-band energy present in the loopback above 12 kHz (catches voice processing).
3. A direct-path matched-filter peak exists, and its amplitude varies < ~1 dB across 20 pings
   (catches AGC and earpiece routing).
4. `ctx.sampleRate ≥ 44100` **plus** measured loopback bandwidth — a Bluetooth 16 kHz capture is
   *upsampled into a 48000 context*, so the rate assertion alone does not detect it.
5. Both motion permissions granted (bearing is load-bearing, not optional).

> **Correction that matters most here:** `track.getSettings()` cannot verify audio hygiene on iOS.
> WebKit omits unimplemented constraints entirely, so `noiseSuppression`/`autoGainControl` will be
> *absent*, not `false`. Verification must be acoustic. Re-run it on `devicechange`,
> `visibilitychange`, and on any unexplained step in direct-path amplitude or delay.

---

## 3. Signal design — the defended operating point

### The waveform

| Parameter | Value | Derivation |
|---|---|---|
| Waveform | LFM chirp, **alternating up/down slope** | Doppler bias cancels in the pair average; +6–11 dB against the prior ping's tail |
| Band (default) | **17.5–20.5 kHz**, f_c = 19.0 kHz, **B = 3.0 kHz** | Sits below the measured iPhone loopback cliff at 19–20 kHz and inside 0.45·fs at both 48 k and 44.1 k |
| Band (auto-widen) | 17.5–21.5 kHz, B = 4.0 kHz | Only if startup loopback shows ≥ −10 dB at 21 kHz relative to 19 kHz |
| Band (44.1 kHz route) | 16.8–19.8 kHz, B = 3.0 kHz | Top capped at 0.45·fs; accept, do not hard-fail |
| Duration T | **5 ms** (240 samples @ 48 kHz) | Blind range cT/2 = 0.86 m. T **cancels out of SRR**, so longer buys nothing against the dominant clutter |
| Time–bandwidth | BT = 15 → **11.8 dB** compression gain | 10·log₁₀(BT) |
| Transmit envelope | **Full Hann amplitude taper (Tukey α = 1.0 exactly)** | −44 to −49 dB PSL vs −13.6 dB unweighted. α = 0.75 gives only −26 dB — the cliff is sharp |
| Receive weighting | **None (plain matched filter)** | Receive windows do not work at this BT (§4). Blast dominance is handled by cancellation, not by tapering |
| PRF | **15 Hz** (PRI 66.7 ms) | Unambiguous range 11.4 m; prior ping's tail 16 dB down at RT60 = 0.25 s |
| Duty cycle | **7.5 %** | −11.3 dB of time-averaging against the 70 dB SPL cap |
| Drive level | 3 dB below the measured 1 dB/1 dB compression point (typically −6 to −3 dBFS) | Automated startup sweep, per device |
| Realizable Δr | **9.3 cm** (B = 3 kHz) / **7.0 cm** (B = 4 kHz) | 1.62 × c/2B, the measured mainlobe widening from the Hann transmit taper |

### Why each choice

**Short T, wide B.** Signal-to-reverberation ratio is independent of T (echo and reverb tail both
scale with transmitted energy) and improves **+3 dB per doubling of B** (reverberation is
range-cell-limited clutter, so shrinking the cell is the only lever). Blind range, meanwhile, is
linear in T. So T should be as short as the *noise* budget permits and every Hz of bandwidth should
be fought for. This inverts the usual "longer chirp = more gain" intuition and is the single
strongest DSP result in the swarm.

**Transmit taper, not receive window.** At BT = 15–40 the matched-filter sidelobe floor is set by
Fresnel ripple on the sharp-edged chirp spectrum, not by the receive window. Measured PSL at BT = 40
with a constant-envelope transmit: rect −13.6, Hann −31.1, Hamming −34.6, Taylor(6,−50) −34.7,
Blackman −33.8, **Blackman-Harris −32.6 dB** — a 3.6 dB spread across design PSLs spanning 60 dB.
The fix is a full Hann taper on the *transmitted* buffer, which costs 4.48 dB (4.27 dB of lost
energy at fixed peak amplitude — a microspeaker is peak-limited, and ∫hann²/T = 3/8 exactly — plus
0.21 dB of receive mismatch) and buys ~30–35 dB of sidelobe.

**PRF from the bat law.** Run the three-mode scheduler with a single input, r_est = range to the
nearest strong return: PRF = c/(2·k·r_est), k ≈ 2–3, and T < 2·r_nearest/c. Note these last two are
**one** constraint, not two — T < 2r/c is algebraically identical to cT/2 < r (§10-C2).

**No CF segment.** A hybrid CF-FM frame is unaffordable on three budgets: duty cycle (a 20–30 ms CF
tone at 15 Hz is 30–45 %, against 7.5 % design and a 70 dB cap), blind range (cT/2 = 3.4–5.1 m,
erasing the entire domestic window), and premise (a static wall's CF echo returns at *exactly* f₀
from a static phone, so there is no TX/RX frequency separation to exploit). Doppler-based mover
segmentation is obtainable from the LFM chirp's own Doppler, in post, without any CF segment.

---

## 4. DSP pipeline — stage by stage

| # | Stage | Formula / method | Cost | Notes |
|---|---|---|---|---|
| 1 | Capture | 48 k (or 44.1 k) mono, `echoCancellation:false` | — | Acoustically verified, not `getSettings()`-verified |
| 2 | Quadrature demod | ×exp(−j2πf_c t), FIR LP at 1.8 kHz, decimate D = 6 → 8 kHz complex | ~0.06 Mflop/ping | Range cell 2.14 cm; envelope becomes free (`|z|`, no Hilbert) |
| 3 | **Direct-blast t₀ fiducial** | first crossing above threshold in the blast region → per-ping zero-range anchor | negligible | **Timestamp before cancelling.** Absorbs output latency, FIR group delay (64 samples = 0.229 m for a 129-tap filter) and clock drift in one step |
| 4 | Blast cancellation | estimate sub-sample delay τ and complex gain per ping; subtract a **fractionally resampled** template | ~0.01 Mflop | residual = 2·sin(π f_c τ). 1 sample of error → **+5.7 dB, worse than not cancelling**. 40 dB needs τ < 80 ns = 0.0038 samples. CRLB ceiling 38–48 dB; expect **20–35 dB** |
| 5 | Matched filter | 512-pt complex FFT multiply against conjugated reference derived from the **measured** loopback | 0.063 Mflop/ping = 1.26 Mflop/s @ 20 Hz | Measured reference makes the HF rolloff a known quantity rather than a loss |
| 6 | Envelope | \|z\| | free | — |
| 7 | Detection | **OSGO-CFAR**, 2×16 training, k = 12/half, greatest-of, guard ±4 cells (±8.6 cm > mainlobe) | ~0.01 Mflop | CA-CFAR inflates Pfa 57× at a clutter edge; OS-CFAR 115×; OSGO only 7.2×. A furnished room is simultaneously multi-target *and* clutter-edge |
| 8 | Sub-cell interpolation | parabolic on \|z\|² | free | σ_r = c√3/(2πB√(2·SNR)) = **2.2 mm @ 20 dB, B = 3 kHz** |
| 9 | Pose fusion | rank-1 outer product into the spherical grid (§5) | 304 k int8 updates/ping = 3.0 M/s @ 10 Hz | The dominant cost in the whole pipeline |

**Total DSP: under 1 % of one core.** Compute is not the constraint; a direct time-domain
convolution (18.4 MMAC/s) would also suffice. Spend the engineering budget on pose, fusion and
rendering.

**CFAR threshold sensitivity, corrected:** α = N(Pfa^(−1/N) − 1). At N = 32: 10.28 dB at Pfa = 1e-4,
11.42 at 1e-5, 12.37 at 1e-6 — i.e. **~1.0–1.1 dB per decade**, not 2.1. The lever is weak, so the
search grid must be wide ({−6,−5,−4,−3,−2}) and a single adjacent step will move `primary` by less
than the run-to-run floor.

**Rejected with numbers, not opinion.** Golay pairs (210° of inter-half phase at 0.1 m/s leaves
−5.1 dB PSL, ~11 dB *worse* than uncoded); m-sequences (L = 511 aperiodic PSL is **−26.9 dB**, not
the −54 dB periodic figure, and occupies 128 ms during which the phone moves 1.5λ); stationary-phase
NLFM (−23.2 dB measured at BT = 40; needs BT ≳ 100); and **any coherent pulse-to-pulse
accumulator** — echo phase advances 420° per 50 ms PRI at 0.2 m/s, so it will pass on static
synthetic fixtures and fail in the hand.

---

## 5. From range profiles to a room map — the v1 representation and update rule

**Representation: a spherical log-odds grid in world frame.**

```
L : int8[az 180][el 90][range 128]     az,el step 2°,  range step 5 cm → 6.4 m
                                       = 2,073,600 cells = 2.07 MB
```

Chosen over a Cartesian voxel grid for two reasons. (a) From a **fixed origin** a Cartesian grid is
a strictly lossy re-encoding of this one. (b) The update is separable: the cone weight depends only
on direction, the inverse-sensor column only on range, so it is a **rank-1 outer product** —
no ray casting, no interpolation, no per-voxel geometry.

**Update rule, per chirp:**

```
Â(ρ)  = matched-filter envelope, peak-normalised
r0    = first bin above 0.25·peak, beyond the blanking radius
l_inv(k) = 0.9·Â(ρ_k)  −  0.45·[ ρ_k < r0 − 0.12 m ]        # occupancy − free-space carve
w_ang(d) = exp( −½ (d / 0.6β)² )  for |d| ≤ β,  β ≈ 30–45°   # Gaussian two-way beam taper
L[d][k] += w_ang(d) · l_inv(k)
clamp L to ±4          (p ∈ [0.018, 0.982])
```

Three empirical results drive this:

1. **Deposit the full envelope, not the first-arrival range.** The amplitude-weighted full-envelope
   estimator beat the classic Elfes hard-cone/single-range model in all 27 tested configurations,
   cutting the short bias from −0.21 m to −0.12 m at β = 45°. The two-pass "carve free, then deposit"
   (RCD-style) variant is measurably *worse* (bias −0.23 to −0.40 m) — do not build it.
2. **Bin evidence by orientation before fusing.** Same-origin measurements are not independent, so
   naive log-odds summation *degrades* with more data: free-space IoU falls 0.814 → 0.774 from
   n = 36 to n = 720. Quantise each measurement's boresight to 2°, average within a bin, sum only
   across distinct bins. This recovers IoU to 0.790 and is three lines. It must be in v1, because
   without it a longer scan makes the map worse — the opposite of what the UI implies.
3. **Information saturates at ~36 chirps.** Measured per-direction range RMSE at β = 45°: 0.54 m
   (n = 36), 0.56 (120), 0.56 (360), 0.56 (720). From a fixed origin each direction's first-arrival
   range is a deterministic function of the scene, so repeated looks are the same measurement.
   **Budget the scan for angular coverage, not duration.** Cap at 20–30 s and make the UI a spherical
   coverage meter (fraction of direction bins with ≥ 1 look), never a countdown.

**Pose.** Orientation only, fixed origin. Quaternion from `alpha/beta/gamma`, yaw re-referenced to
`webkitCompassHeading` when `webkitCompassAccuracy ≥ 0` (mind the opposite sign convention),
otherwise flag the map as phone-relative in the UI. Slerp to each chirp's transmit midpoint.
Use `DeviceMotion` acceleration **only as a walk detector**: a leaky-integrated speed estimate above
~0.3 m/s for > 0.5 s invalidates the scan. Never integrate it for position — a 0.5° tilt error leaks
g·sin ε = 0.0855 m/s² of gravity, which double-integrates to 0.043 m at 1 s, 0.385 m at 3 s and
**4.28 m at 10 s**. Holding 5 cm over 10 s would need ε < 0.006°.

**Yaw error is recoverable.** Because the map is a function of direction from one origin, a ±10–20°
compass error rotates the entire panorama rigidly. Snap the dominant wall normals to a Manhattan
frame at render time. Do not invest in magnetometer calibration.

**Specularity is half problem, half gift.** At λ = 17.9 mm the Rayleigh criterion is h_rms < λ/8 =
2.2 mm, and painted drywall is 0.05–0.5 mm — so walls are mirrors and return almost nothing at 45°.
But that same physics *self-collimates* the measurement: gating returns to within ±8° of surface
normal dropped simulated RMSE from 1.09 m to 0.55 m at unchanged β = 45°. Weight occupancy
deposition toward boresight when the return is strong and narrow in range (the specular signature).
**This is the highest-value item in the accuracy backlog**, because receive beamforming — the other
3–5× lever — requires multichannel capture that iOS Safari does not provide.

**Scoring.** Primary: free-space IoU (target ≥ 0.75) and per-direction range RMSE (≤ 0.70 m).
Secondary: occupied recall at a 20 cm dilation tolerance (≥ 0.40) and symmetric Chamfer (≤ 0.30 m).
**Never gate on raw occupied IoU at zero tolerance** — it reads 0.119 / 0.119 / 0.121 for β =
10/20/45°, i.e. it is saturated by grid quantisation against sub-centimetre-thick surfaces and would
make any promotion gate a coin flip.

---

## 6. Bat-vision rendering — the v1 views

**The render primitive is an arc, never a point.** A single chirp's evidence is "something at
r = 2.30 ± 0.05 m somewhere in a 60° wedge". Draw exactly that: an anisotropic Gaussian ~9 cm thick
in range and 50–90° wide in bearing. Crispness must be *earned* by overlapping wedges intersecting.
This one rule is the difference between an instrument and a fake camera.

Portrait layout on a 393×852 pt screen:

| Region | Height | Content |
|---|---|---|
| Status bar | 60 pt | measured `sampleRate`, AEC state, achieved bandwidth, chirps/s, SNR dB |
| **PPI (hero)** | 393 pt | plan view, phone centred, forward up, 8 m radius, rings at 1/2/4/8 m |
| A-scope | 140 pt | matched-filter envelope in dB vs range, with the CFAR threshold drawn as a second line |
| B-scope | 140 pt | yaw × range — **the coverage meter**: dark = you haven't looked there |
| Controls | 120 pt | bottom third only, ≥ 44×44 pt targets, one-handed |

The A-scope is the honesty anchor, not a debug view: putting raw evidence directly beneath the
interpretation is what keeps the product from over-claiming. Never draw B-scope columns 1 px wide —
at 15 Hz a 6 s 180° sweep gives 1.5°/column, ~35× finer than the beam; splat every column to beam
width or the display fabricates angular resolution.

**Five draw calls.** (1) fullscreen triangle unwrapping the polar R16F map to Cartesian through a
256×1 inferno LUT; (2) ≤ 8 k sparse CFAR "splashes" as `gl.POINTS`, additive into RGBA16F;
(3) optional instanced-quad arc splats for recent chirps; (4) fullscreen log tone map
L = log(1+40·E)/log(41) — this is what stops tens of thousands of additive splats from clipping to
white across 40 dB of echo dynamic range; (5) a separate DPR-3 2D canvas for rings, labels and the
`aria-live` mirror. ~3.3 Mpx of fill/frame at DPR 2. Cap the WebGL canvas at
`min(devicePixelRatio, 2)` — 0.444× the pixels on a 3× phone, perceptually invisible on a glowy
layer. Enforce `points × pointSize² ≤ 25 Mpx` at runtime so the display degrades gracefully instead
of stuttering (a stuttering sonar reads as a broken sensor).

**Colour: inferno.** Monotonic in L*, CVD-safe, true-black low end so free space is unlit OLED
pixels. Free space in desaturated cool blue-grey, unknown as pure background — the three semantic
states separate by luminance alone. Ban jet/turbo. Add posterior contours at p = 0.5/0.8/0.95 so the
map reads without colour at all. Ship a light "chart" mode and a high-contrast mode (threshold at
0.8, 2 px white stroke on black, labelled rings) — the latter doubles as the export format.

**Audification is the accessibility product, not a gimmick** (haptics are unreliable on iOS; audio is
the only dependable non-visual channel). Three modes:

- **Heterodyne** — mic → GainNode (gain 0, oscillator at f_LO summed into `gain.gain`) → lowpass.
  f_LO = 16.5–17.5 kHz maps the band to 0.5–4.5 kHz with no *difference*-term fold. **But the sum
  term at 34–38 kHz aliases back to 10–14 kHz at 48 kHz sampling** — a single biquad at 5 kHz
  attenuates that by only ~9 dB, so use a 4th–8th order lowpass cascade or oversample the modulator.
- **×10 time expansion** — `AudioBufferSourceNode.playbackRate = 0.1`. 40 ms → 400 ms, 18–22 kHz →
  1.8–2.2 kHz, harmonic structure and relative amplitude preserved. Trigger every 8th chirp.
- **Rate-coded proximity tone** — parking-sensor idiom, 2 Hz at 4 m rising to 20 Hz at 0.4 m, pitch
  held constant so timbre stays free for echo strength. Pan by yaw via `StereoPannerNode`.

**Drive the expanding-wavefront ripple from the same ×10 clock**, retriggered at 2.5 Hz. The user
then *hears* the echo land exactly as the ring touches the wall. Three independent constraints
converge on 2.5 Hz: gapless expanded audio (2.5 × 400 ms = 1.0 s/s), the ripple retrigger rate, and
WCAG 2.3.1 (≤ 3 flashes/s over > 25 % of the field). Honour `prefers-reduced-motion` by freezing the
ripple. Drive every fade from `performance.now()` deltas, never frame counts — rAF is 30, 60 *or*
120 Hz depending on Low Power Mode and a Safari 26 toggle.

**Scope.** Elevation of the *beam axis* is available from gravity-referenced pitch (0.5–2°), so a
3-D spherical grid is buildable; elevation *within* a beam is not. Ship the plan view as the hero,
render the shell as a coarse 3-D option, and never promise a watertight mesh.

---

## 7. Reuse from ruvnet/ultrasonic — what transfers, what does not

**Transfers:**

| Item | Path | Why |
|---|---|---|
| Band + rate envelope | `src/embed/ultrasonic_encoder.py:16-20` (18500/19500 Hz @ 48000, Nyquist guard) | Independent confirmation of the 48 kHz / 17–20 kHz operating envelope |
| Matched-filter-against-regenerated-replica architecture | `src/decode/ultrasonic_decoder.py:154-177` | Swap the sine bank for the chirp replica; the structure is right |
| "First crossing above threshold, not best peak" | `ultrasonic_decoder.py:148-150` | Accidentally the correct primitive for locking the **direct blast** (earliest arrival is t₀ by definition). Wrong for target detection — that needs full peak extraction + CFAR |
| Synthetic-loopback test pattern | `src/tests/test_ultrasonic_decoder.py:75-215` | generate → impair → decode → assert, with no audio hardware. This is exactly what makes the Rust DSP crate CI-testable on Linux |
| f·T-integer phase discipline | `ultrasonic_encoder.py:211` | 18500·0.01 = 185 and 19500·0.01 = 195 are integers, so the per-bit phase reset happens to be continuous. At T = 0.005 or 0.001 they are half-integers → a π jump every bit |

**Does not transfer:**

| Item | Path | Why not |
|---|---|---|
| The 24-bit preamble as a ranging code | `ultrasonic_encoder.py:82`, `ultrasonic_decoder.py:121` | "10101010" is periodic: measured **−2.5 dB** matched-filter sidelobes every 10 ms = **every 1.72 m of range**, vs −46 dB for an LFM. Every wall would ghost |
| 1 kHz FSK separation | `ultrasonic_encoder.py:16-20` | Δf·T = 10, i.e. 10× the non-coherent orthogonality minimum, spending 1 kHz on one bit. c/2B at 1 kHz = 17.2 cm |
| Hamming(7,4), CRC-16-CCITT, interleaving, per-tone bandpass | `encoder:97-192`, `decoder:57-66,465-599` | **Verified dead in both directions.** `freq_0_filter`/`freq_1_filter` appear only at their assignment lines; the FEC methods appear only in `test_enhanced_error_correction.py`. Not battle-tested |
| `_apply_windowing` | `encoder:232-246` | Fades only 1 % of each bit, 0.9 → 1.0 — a **−20 dB step at every bit boundary**, splattering into the audible 15–17 kHz |
| Peak normalisation | `encoder:248-272`, `audio_decoder.py:82-84` | Destroys the absolute amplitude that **is** the sonar measurement |
| `scipy.signal.filtfilt` | `decoder:104` | Non-causal, needs the whole buffer. Unusable in a 128-sample AudioWorklet quantum |
| `amplitude = 0.1` | `encoder:20` | A steganographic choice (hide under host audio). BatVu's chirp is the only content — drive to the measured compression point, ~17–19 dB more |
| The word "calibration" | `test_calibration.py:16-89` | A 210-point synthetic grid search over `AudioSegment.silent()` scored on string roundtrip. SNR is computed **once in the entire repo**, in an example, never in a test. BatVu needs a BER/ROC-vs-SNR harness and a real measured loopback response |

**Multi-device.** If BatVu ever runs two phones, the FSK modem earns its keep as a **narrow
out-of-band control plane** at 17.0/17.5 kHz (Δf·T = 1.0 at bit_duration = 0.002 s, both f·T
integers, 500 bps) negotiating TDMA slots — not as a ranging waveform, and not via frequency hopping.
Waveform orthogonality is too weak: up/down slope buys **6–11 dB**, not 20–25, and a second phone's
direct blast sits 20–50 dB above a far-wall echo.

---

## 8. Harness integration — horizon and flywheel

### horizon: scan-session control

```
sweep := 10 chirps @ 66.7 ms PRI = 667 ms
HaltConfig { maxIterations: 45, noProgressLimit: 3, repeatedFailureLimit: 3 }

// per sweep — ORDER IS LOAD-BEARING
loop {
  if let Some(reason) = halt.beforeModel() { return outcome(reason) }   // consume FIRST
  emitSweep()                                                           // then step
  halt.observe({
    progress: `h${floor(entropyBits/4096)}:k${floor(determinedVoxels/256)}`,
    failure:  faultEnum() ?? null            // MUST pass null, not omit the key
  })
}

fn faultEnum() -> Option<&str> {             // coarse enums only: no floats, no timestamps
  if clippedFrames > 1%          { "mic-saturated" }
  else if poseCovTrace > 0.03    { "pose-lost" }
  else if cfarDetections == 0    { "no-detections" }
  else if medianPeakSnr < 6.0    { "snr-floor" }
  else { None }
}

outcome: no-progress      -> Mapped     (the room is mapped — this is SUCCESS, not pathology)
         iteration-budget -> Timeboxed  (partial but usable; show it, do not error)
         repeated-failure -> Aborted(fault)  (surface the fault to the user)
```

Four verified facts drive this shape:

- The Rust reducer compares `last_progress` by **exact string equality** (`crate/src/lib.rs:454`).
  A sha256 of the grid or a raw entropy float changes every sweep, so `no-progress` would **never
  fire** and the scan would always run to budget while appearing to work. Quantise. State hashes go
  in `HorizonCheckpoint.stateHash`, never in `progress`.
- The failure signature is three-way: `Str` → compare-and-count, `Null` → clear the streak, **absent
  → no-op**. `halt.ts:92` preserves this with `if ('failure' in opts)`.
- `observe()` only *arms*; `beforeModel()` consumes. Because the driver calls `beforeModel()` at the
  **top** of each iteration (`driver.ts:131-142`), total sweeps = `maxIterations` exactly — **no
  extra emissions to charge to the SPL ledger** (§10-C10), provided BatVu's own loop preserves that
  order. Pin it in a test.
- `turnBoundary()` is a full state reset — call it when the user moves to a new anchor pose, and
  **never on resume** (`resumeTurn` deliberately skips it), or a converged scan re-burns three
  sweeps.

**Checkpoint contents.** Grid in IndexedDB, referenced only by digest; `hashCheckpoint` canonicalises
the entire object on every snapshot, so a 2 MB grid must never enter the transcript.

```
workspaceCommit:   "sha256:…"                    // the grid blob
transcript:        one ~80-byte line per sweep   // 45 sweeps ≈ 4 KB
evaluationHistory: per-sweep metric rows         // same rows the flywheel evaluator consumes
budget:            { chirpsEmitted, splDbaSeconds, dspMs, carveMs, batteryPct }
archiveBranch:     "room:kitchen@2026-08-25T14:02Z"
memoryCursor:      "pose:<poseGraphHead>"
```

**CommandGuard: no for the browser, yes for CI.** There is no shell on an iPhone and nothing to
smuggle — routing chirp parameters through a command classifier is exactly the veneer to avoid.
`LongHorizonDriver` structurally requires a shell command per step (`driver.ts:150` classifies
`step.command` unconditionally), so the browser composes a ~40-line `ScanDriver` from
`HaltController` + `hashCheckpoint` directly, and `LongHorizonDriver` + `CommandGuard` are reserved
for the CI harness that shells out to cargo/wasm-opt/fixture runners. Policy there:
`allow: [cargo, node, npm, wasm-opt, python3]` (because `defaultUnknown` is `'gate'`),
`secretPaths: ['fixtures/recordings/']`, `netTools: [curl, wget, nc, ssh]` — a mutated evaluator
script must not egress a room recording.

### flywheel: policy evolution

Levers (each with a **fixed canonical decimal format** — `'0.85'` and `'0.850'` are different cache
keys and different genomes): `chirp.f0Hz`, `chirp.f1Hz`, `chirp.durationMs`, `chirp.taperAlpha`,
`window.*`, `pri.ms`, `cfar.{type,guardCells,trainCells,pfaLog10,osRank}`,
`occ.{logOddsHit,logOddsMiss,clampMin,clampMax}`, `beam.{halfAngleDeg,carveMode}`, `voxel.sizeM`,
`integrate.pings`. Rotate 5 of 21 targets per generation (all 21 would be 181 s/gen ≈ 36 min for 12
generations; 5 is ~43 s/gen). `cacheEvaluations: true` — the evaluator over seeded procedural rooms
and fixed WAVs is deterministic, the documented safe case.

```
Score.primary     = mean free-space IoU + occupied recall@20cm over the FULL room volume
Score.noopRate    = mean over pings of max(0, 1 − detections/3)      // CONTINUOUS
Score.costPerWin  = (wasmDspMs + carveMs) / newlyDeterminedVoxels    // |log-odds| crossed 0.7
Score.regressed   = emissionDose>70dB || falseCarve>0.5% || f1>=0.98·fs/2
                    || pri < 2·Rmax/c + T || perPingMs > pri.ms
```

> **The one hazard that must not be missed.** `gate.ts:22` requires a **strict** noopRate
> improvement: `if (!(cand.noopRate < base.noopRate)) reject`. A discrete "fraction of pings with
> zero detections" saturates at exactly 0 on easy rooms and then **nothing can ever promote again** —
> the run silently dies. Hence the continuous definition above.

Two further verified gate facts: the anchor is compared **only on `.primary`, against the root anchor
forever** (`run.ts:170`), so the bar never ratchets; and `regressed` is read only from the *holdout*
(`run.ts:159` passes no `anchor` field, making the gate's own anchor clause dead code). Therefore
**put at least one safety-prone room in the holdout** (absorptive walls, phone jitter) rather than
relying on the anchor to catch a false-carve regression. Anchor suite (never optimised against): an
anechoic-null room whose ground truth is *free space everywhere* — a policy that lowers the CFAR
threshold to win IoU on cluttered holdout rooms hallucinates walls here and its score collapses.

### Build shape (from horizon, with four deliberate deviations)

Copy verbatim: `crate/` inside the npm package with an empty `[workspace]` table,
`crate-type = ["cdylib","rlib"]` (so `cargo test` runs native unit tests on the same DSP code),
`lto = true`, `codegen-units = 1`, `panic = "abort"`, plain
`cargo build --release --target wasm32-unknown-unknown` + copy into `wasm/`, no wasm-bindgen, `{}`
imports, and the `[u32 LE len][bytes]` packed return with the
**re-view-on-buffer-identity-change guard** (`core.ts:26-33`) copied exactly.

Change:

1. `opt-level` `"s"` → **3**, plus `-C target-feature=+simd128` with a feature-detected non-SIMD
   fallback module for Safari < 16.4.
2. **Do not copy `hz_alloc`'s leak.** It is `Vec::with_capacity` + `mem::forget` with no free export
   (`lib.rs:917-923`); at 20 pings/s that is ~640 KB/s of monotonic growth, ~38 MB/min, and wasm
   linear memory never shrinks. On iOS this is not "grows memory", it is **the tab being jetsammed
   mid-scan with "A problem repeatedly occurred"** — a crash, not a catchable exception, and
   untestable in Linux CI. Instead: one persistent ring buffer at init, `bv_input_ptr()`,
   `bv_capacity()`, `bv_process(nSamples) -> ptr`, zero per-call allocation; pre-grow the heap once
   and never grow during capture. Keep the JSON `hz_eval` path for low-rate control ops only.
3. **Browser loader.** `core.ts` imports `node:fs`/`node:path`/`node:url` at module scope, and
   `index.ts:50` pulls `node:child_process` through `executor.ts`; `package.json` exports only `"."`,
   so `@metaharness/horizon/halt` is unresolvable and the barrel is unusable in a browser. Vendor
   `halt.ts` (121 lines) and `checkpoint.ts` near-term. Use `instantiateStreaming` with an
   `arrayBuffer` fallback (Safari rejects without `Content-Type: application/wasm`), plus a
   `fromModule(mod)` entry point: `compileStreaming` on the main thread, `postMessage` the
   `WebAssembly.Module` into the AudioWorklet, `new WebAssembly.Instance(mod, {})` synchronously
   there. **The worklet scope has no `TextEncoder`/`TextDecoder`** — horizon's `core.ts` builds both
   at module scope and will throw on construction inside a worklet.
4. Add an `op: "digest"` sha256 to the Rust core and reimplement `hashCheckpoint` over it —
   `crypto.subtle.digest` is async (incompatible with the sync signature) and secure-context-only.
5. `panic = "abort"` turns a bounds check on a mis-sized audio buffer into an unrecoverable instance
   trap with no message, which inside an AudioWorklet takes the audio graph down mid-scan.
   **Validate every length explicitly at the ABI boundary.**

---

## 9. Link budget and expected performance

Assumptions, all reconciled to single values: SL = **68 dB SPL @ 1 m** (design value; ICNIRP-capped
at 70), NSD = **−14 dB SPL/√Hz**, α = **0.52 dB/m**, wall reflection loss **6 dB**, T = 5 ms,
B = 3 kHz, taper loss L_w = 4.48 dB, RT60 = **0.25 s**.

Matched-filter SNR collapses to **SNR = SPL_echo − NSD + 10·log₁₀(T) − L_w** — bandwidth cancels out
of the noise budget entirely (−10log₁₀B + 10log₁₀BT = 10log₁₀T). At these values,
**SNR = SPL_echo − 13.5 dB.**

Walls obey the image-source law **20log₁₀(2R) + 2αR**, not 40log₁₀(R). Point targets obey the
two-way 40log₁₀(R) law with TS = 10log₁₀(σ/4π).

| Range | Wall echo (dB SPL) | Noise-limited SNR | Modelled SRR (single ping) | Detectable? |
|---|---|---|---|---|
| 1 m | 54.9 | 41.4 dB | ≈ +6 dB | Yes, comfortably |
| 2 m | 47.9 | 34.4 dB | ≈ +2 dB | Yes |
| 3 m | 43.3 | 29.8 dB | ≈ −1 dB | Yes, with multi-look coverage |
| 4 m | 39.8 | 26.2 dB | ≈ −2 dB | Marginal on hard walls |
| 6 m | 34.1 | 20.6 dB | ≈ −3 dB | **No — do not render beyond ~5 m** |

| Target | 1 m | 3 m | 6 m |
|---|---|---|---|
| Person (σ = 0.5 m², TS = −14 dB) | +38 dB | +17 dB | +2 dB |
| Mug / chair leg (σ = 0.02 m², TS = −28 dB) | +24 dB | +3 dB | −12 dB |

**The system is reverberation-limited, not noise-limited, by ~30 dB beyond ~1 m.** Critical distance
r_c = 0.057√(V/RT60) = 0.79 m at V = 50 m³. The only levers on SRR are bandwidth (+3 dB/doubling),
room damping (not controllable), directivity (negligible — λ/D ≫ 1), and **pose diversity**.

> **Corrected, and it matters:** incoherent integration does **not** buy the full Swerling detection
> gain against reverberation. Reverberation from a static scene at a static pose is a deterministic
> convolution — averaging identical realisations reduces nothing. Only *pose* diversity decorrelates
> it, and the same swarm measured that information from a fixed origin **saturates at ~36 chirps**.
> Budget **3–6 dB** of SRR lift from a 2–3 s sweep, not +12 to +19 dB.

**Honest range envelope to design and market against:**

| | Value | Set by |
|---|---|---|
| Minimum range | **0.3–0.7 m** with blast cancellation; ~0.9 m without | 20–35 dB achievable cancellation, and cT/2 = 0.86 m |
| Maximum, hard flat surfaces near normal incidence | **4–5 m** | Reverberation, corroborated by BatMapper's measured ~4 m |
| Maximum, soft/absorptive or oblique | 2–2.5 m | Carpet and curtains absorb 4–7 dB/bounce at 20 kHz vs 0.2–0.5 dB for painted drywall |
| Maximum, small objects (chair leg, torso) | 1.5–2 m | Point-target 40log₁₀(R) |
| Range accuracy on a single dominant surface | σ_r = 2.2 mm @ 20 dB (CRLB); **1–2 cm realised** | Multipath, surface roughness, pose |
| Range **resolution** between two surfaces | **9.3 cm** | 1.62 × c/2B |
| Cross-range blur at 3 m | **0.5–1.5 m** | Beam width + incoherent multi-look |

Report accuracy and resolution as **two separate numbers in the UI**. Conflating them makes the
product look either broken or dishonest.

---

## 10. What the swarm got wrong — every corrected claim

| # | Before | After |
|---|---|---|
| **C1** | σ_r = c/(2B√(2·SNR)) is the Cramér–Rao bound → 4.0 mm @ B = 3 kHz, 20 dB | That is the **Δr/√(2SNR) rule of thumb**, conservative by exactly π/√3 = **1.814×**. The CRLB is σ_r = c√3/(2πB√(2·SNR)) = **2.2 mm**. Three lenses quoted 1.67 / 3.0 / 4.0 mm for the same quantity. **Use one formula codebase-wide** |
| **C2** | The clutter-interference rule T < 2·r_clutter/c is a *second, independent* constraint that binds harder than blind range | It is **algebraically identical** to cT/2 < r. One constraint, not two. Applying a safety factor twice needlessly halves T and costs 3 dB per halving |
| **C3** | Blackman-Harris receive weighting gives ~−67 dB and solves the direct-blast dynamic range | At BT = 15–40 **receive windows do not deliver their design PSL** — all land at −27 to −35 dB (Fresnel ripple, not the window). Blackman-Harris measures **−32.6 dB**, 35 dB short, and buys nothing over Hann while widening the mainlobe. The fix is a full Hann taper on the **transmit** chirp (−46 dB) plus sub-sample blast cancellation |
| **C4** | Ship a hybrid CF-FM frame — long CF tone for ego-velocity, short FM for range | **Do not ship CF.** 30–45 % duty against a 7.5 % design and a 70 dB cap; cT/2 = 3.4–5.1 m of blind range erases the room; and the premise fails — a static wall's CF echo returns at exactly f₀, so there is no TX/RX frequency separation on a phone |
| **C5** | Up/down chirp alternation buys 20–25 dB of device separation | Measured **6–11 dB** (−10.5 dB Hann-tapered at BT = 40, reproduced independently to 0.2 dB). Enough to reject the prior ping's reverb tail; nowhere near enough to separate two phones whose blasts sit 20–50 dB above a far wall. **Two-device needs TDMA** |
| **C6** | The phone can coherently integrate N pulses for +10log₁₀(N) dB — "the phone beats the bat" | The transmitter is phase-stable but the **channel is not**: 420° of phase per 50 ms PRI at 0.2 m/s, λ/2 traversed in one ping. Coherent accumulation is unavailable handheld — and will *pass on static synthetic fixtures*, which is how it gets shipped |
| **C7** | 40 pings ≈ +12 dB, lifting SRR to +18/+11/+8 dB — "the whole viability argument" | The Swerling table is right (N = 40 → +18.9 dB, so the claim contradicted itself by 7 dB) but it is a gain against **noise**. Reverberation is deterministic; averaging identical realisations reduces nothing. Budget **3–6 dB** from pose diversity. Corroborated by the same swarm's saturation-at-36-chirps result |
| **C8** | SAR cross-range δ = λR/2L gives 5–9 cm at 3 m — "roughly isotropic voxels, this is the README number" | **Unreachable.** Coherent synthesis needs 2.1 mm of position knowledge; a 0.5° tilt error alone leaks 8.7 mg of gravity → 10.7 mm after 0.5 s, 5× over budget. A 0.3 m arm-reach baseline was measured to buy *literally nothing* (IoU 0.118 vs 0.121). Honest cross-range at 3 m: **0.5–1.5 m**. There is **no usable coherent aperture in the browser at any duration** — make it a disabled experiment, not a runtime mode |
| **C9** | `track.getSettings()` verifies that AEC/NS/AGC are off | **Only `echoCancellation` is implemented in WebKit** (and it disables AEC + AGC + the 12 kHz low-pass together). `noiseSuppression`/`autoGainControl` are silently dropped and **absent** from `getSettings()` — an absent key is not `false`. Verify **acoustically** |
| **C10** | horizon emits one extra sweep after the halt arms — charge 500 ms to the SPL ledger | `beforeModel()` is consumed at the **top** of each iteration (`driver.ts:131-142`), so total sweeps = `maxIterations` exactly. **Zero phantom emissions** — provided the loop order is beforeModel → step → observe. Pin it in a test |
| **C11** | Force `new AudioContext({sampleRate: 48000})` and hard-fail on 44100 | **Do the opposite.** Forcing a mismatched rate inserts a software resampler (a documented source of iOS crackling) and *masks* the degraded routes — a 16 kHz Bluetooth capture upsampled into a 48000 context passes the assertion. Construct with no option, read `ctx.sampleRate`, synthesise the chirp at runtime, cap the band at 0.45·fs, and hard-fail only on the **acoustic** self-check |
| **C12** | ACGIH/NIOSH 105 dB SPL ceiling at 20 kHz — "not a safety blocker" | 105 dB is a *hearing-damage* criterion. The governing limit for the 17.8–22.4 kHz ⅓-octave band is **ICNIRP 2024 / IRPA 1984: 75 dB occupational, 70 dB public**. The permissive 110/100 dB values start at 25 kHz, which this design cannot reach. **The 30–35 dB ambiguity is the difference between "the link budget closes comfortably" and "emission is the binding constraint"** |
| **C13** | SL = 72 dB SPL @ 1 m at 19 kHz | The same claim cited a measurement of 50 dB @ 1 m and never reconciled the 22 dB gap; another lens gave 50–65. **Unmeasured. Use 65–70 dB @ 1 m** and treat every derived range as carrying ±10 dB. Moot above 70 anyway, per C12. **Measure this first — everything hangs off it** |
| **C14** | Receive beamforming across the iPhone's mic array is a 3–5× accuracy lever — put it in the backlog | It requires multichannel capture that **iOS Safari does not expose**. Backlog ranking becomes: (1) specular self-collimation (measured 1.09 → 0.55 m RMSE), (2) angular coverage, (3) fusion math. Beamforming is a native-app v3 item |
| **C15** | Absorption is quadratic in f; "bats are short-range *because* they chose high frequency" | Effective exponent is **~1.1–1.3** above the relaxation frequencies (20→40 kHz is 2.51×, 40→100 kHz is 2.49×). A quadratic assumption over-predicts 100 kHz by 4×. And bats are short-range primarily from R⁻⁴ spreading against tiny target strength |
| **C16** | Heterodyne at f_LO = 17.5 kHz has "no sideband fold" | The **difference** term is clean, but the **sum** term at 35.5–39.5 kHz aliases back to **8.5–12.5 kHz** at 48 kHz sampling — squarely audible, and a single biquad at 5 kHz attenuates it by only ~9 dB. Use a 4th–8th order cascade |
| **C17** | A 4096-pt FFT matched filter costs ~100 kflop/chirp | One 4096-pt complex FFT alone is 5N·log₂N = **246 kflop**; fast convolution ≈ **516 kflop**. Conclusion (compute negligible) unaffected |
| **C18** | ELF-SLAM's 50 ms window = 8.6 m round trip = 4.3 m one-way, confirming a 4 m ceiling | 50 ms × 343 = **17.15 m of travel = 8.6 m one-way**. The window does *not* corroborate a 4 m ceiling; reverberation and BatMapper's measurement do |
| **C19** | 129-tap FIR group delay moved a 1.00 m wall to 0.86 m and a 3.00 m wall to 2.66 m | A positive group delay makes targets appear **farther** (1.23 / 3.23 m), and the two quoted offsets differ from each other, so they cannot be a constant delay bias. Re-diagnose. The remedy is unchanged: reference everything to the direct-blast peak |
| **C20** | m-sequence L = 511 has −54 dB PSL | That is the **periodic** sidelobe. **Aperiodic** (what a one-shot ping sees) measures **−26.9 dB** — a 27 dB error that would make m-sequences look viable |
| **C21** | Golay pair with 210° inter-half phase error leaves a **+6 dB** residual | Measured **−5.1 dB** relative to the peak — ~11 dB worse than uncoded, not above it. Conclusion (dead for handheld) unaffected |
| **C22** | CFAR Pfa lever moves the threshold ~2.1 dB per decade at N = 32 | 2.09 dB is across **two** decades. **~1.0–1.1 dB per decade** — the lever is even weaker, so the grid must be wide |
| **C23** | Elevation is unobtainable; scope v1 to 2.5-D | Elevation *within* a beam is impossible; elevation of the **beam axis** comes from gravity-referenced pitch at 0.5–2°. A 3-D spherical grid is buildable — just not a watertight mesh |
| **C24** | RT60 quoted as 0.197 s, 0.30 s and 0.40 s in three places | Pin **0.25 s** as the design value for 18–22 kHz in a furnished domestic room (0.4 s = worst-case hard-surfaced hallway). Prior-ping tail suppression is 15.2 / 10.0 / 7.5 dB across those three values — every SRR and PRF number depends on it |
| **C25** | Anisotropy is 30–100× | Two different ratios were conflated: **~66–99 : 1** resolution anisotropy, **~490 : 1** precision anisotropy. Sizing the render splat off the wrong one mis-sizes it by 5–16× |
| **C26** | `navigator.vibrate` is a HARD BLOCKER on iOS | **Contested in 2026** — mdn/browser-compat-data#29166 reports it working, unresolved. Feature-detect; keep audio primary; do not put "hard blocker" in the README |
| **C27** | 52 % of adults under 30 respond at 20 kHz | Reflects testing at high presentation levels; thresholds at 20 kHz are typically 80–100 dB SPL. The 18–19 kHz audibility risk is the real one — which **strengthens** the case for pushing f_c as high as the transducer allows |
| **C28** | 16–23 kHz (B = 7 kHz) is a bandwidth stretch goal | 23 kHz is above the codec passband and dead at 44.1 kHz; 16 kHz is loudly audible. **B = 7 kHz is not an option** |
| **C29** | "Digital blast suppression is strictly better than the stapedius reflex; FMCW with no blind range at all" | Realistic cancellation is **20–35 dB** (CRLB ceiling 38–48). Whole-sample misalignment makes it **+5.7 dB worse**. There are **two** direct paths (structure-borne at 3000–5000 m/s arrives 0.01–0.05 ms ahead of airborne) so one template does not null both. Minimum range 0.3–0.7 m, not zero |
| **C30** | `hz_alloc`'s leak "grows wasm memory ~38 MB/min" | On iOS the observed failure is the **tab being killed** ("A problem repeatedly occurred") — a crash, not a catchable exception, and invisible in a 10-second Linux CI fixture |

---

## 11. Open risks and things that must be measured on real hardware

**Before writing any DSP** — a ~30-line self-test page, run on every target iPhone, with the ringer
switch both ways, with and without AirPods connected, and after a foreground/background cycle:

| # | Measure | Why it can end the project |
|---|---|---|
| 1 | Does `echoCancellation:false` actually defeat voice processing? (in-band energy above 12 kHz in the loopback) | AEC removes exactly a known played-out signal and its echoes — the entire payload — and it fails **silently**, as an empty room |
| 2 | **Emitted SPL at 18/19/20/21 kHz** and the speaker's magnitude response | The ±10 dB spread on SL is the largest unresolved number in the project; 6 dB = 2× range on the wall law. Note the browser cannot read system volume, so this is only ever meaningful *relative to the direct-path fiducial in the same session* |
| 3 | Recovered loopback bandwidth (not `ctx.sampleRate`) | A 16 kHz Bluetooth capture is upsampled into a 48000 context and passes every rate assertion |
| 4 | Direct-path peak amplitude std-dev across 20 pings | Catches AGC and catches earpiece routing (> 10 dB below the loudspeaker reference) |
| 5 | Achievable blast cancellation depth | Sets the minimum mappable range. Target 25–35 dB; below ~20 dB the near field is lost |
| 6 | 1 dB/1 dB compression point of the speaker | Above it you buy heat and audible intermodulation instead of range |
| 7 | Actual RT60 at 18–22 kHz in 3–4 representative rooms | Every SRR, PRF and clutter number depends on the single value we pinned at 0.25 s |
| 8 | Monostatic phone-related transfer function (speaker+chassis+mic over a 2-sphere on a turntable) | The effective β is the largest unknown gating angular performance, and it is the closest software substitute for a pinna |

**Open risks:**

- **Audibility and pets.** 18–19 kHz is audible to most teenagers above 60–70 dB SPL; dog thresholds
  near 0–10 dB SPL at 19 kHz mean 68 dB @ 1 m is 60–70 dB above them. Ship a persistent "emitting"
  indicator, a hard session timeout, a pet warning, and a one-tap stop in thumb reach.
- **Acoustically dead rooms will map visibly worse.** Carpet and curtains cost 4–7 dB per bounce at
  20 kHz. Set that expectation in-app rather than letting it read as a defect.
- **Route changes mid-session.** `devicechange` fires unreliably on iOS; treat an unexplained step in
  direct-path amplitude or delay as a route change and re-calibrate.
- **Backgrounding kills the scan.** iOS suspends the AudioContext and mutes tracks; WebGL contexts
  are lost. The grid must live in worker/wasm memory and be checkpointed to IndexedDB.
- **Speed of sound.** c = 331.3 + 0.606·T gives 0.89 % per 5 °C = 2.7 cm at 3 m. A one-line
  temperature or known-distance calibration is a cheap bias removal.
- **Sidelobe/PSL acceptance tests are the only DSP surface that CI can prove.** Everything except the
  transducer is deterministic: image-source RIR, checked-in measured loopback WAV, mic noise at
  −14 dB SPL/√Hz, assert recovered ranges, PSL, ISLR, CFAR Pfa and free-space IoU. Reserve exactly
  one device lane for the four platform gates, which are untestable on Linux.

---

## 12. ADR outline

| ADR | Decision (one line) |
|---|---|
| **ADR-001** | BatVu is an orientation-only, fixed-origin swept range-profile scanner producing a spherical depth panorama — not a snapshot 3-D depth sensor — because iOS Safari gives one mono mic, no beam, and no VIO. |
| **ADR-002** | Target is a browser app in iOS Safari (WebAudio + getUserMedia + AudioWorklet), with the DSP hot path in a Rust crate compiled to `wasm32-unknown-unknown`, so the whole system except the transducer is CI-testable on Linux. |
| **ADR-003** | Transmit an LFM chirp at 17.5–20.5 kHz (B = 3 kHz), T = 5 ms, PRF 15 Hz, 7.5 % duty, alternating up/down slope, auto-widening to B = 4 kHz only when the startup loopback proves the device passes 21 kHz. |
| **ADR-004** | Apply a full Hann amplitude taper (Tukey α = 1.0 exactly) to the **transmitted** chirp and use a plain matched filter on receive; receive windows do not deliver their design sidelobe level at BT ≤ 40. |
| **ADR-005** | Derive t = 0 from the direct-path leakage peak in every ping, and never from a transmit timestamp or `AudioContext.outputLatency`; timestamp the blast **before** cancelling it. |
| **ADR-006** | Cancel the direct blast by per-ping sub-sample delay + complex-gain estimation with a fractionally resampled template; whole-sample subtraction is prohibited because it is measurably worse than no cancellation. |
| **ADR-007** | The accumulator is **incoherent** (envelope-domain) at every level; coherent pulse-to-pulse integration and synthetic aperture are disabled experiments, not runtime modes. |
| **ADR-008** | Detection uses OSGO-CFAR (2×16 training, k = 12/half, guard ±4 cells), because a furnished room is simultaneously a multi-target and a clutter-edge environment. |
| **ADR-009** | The live map is a spherical int8 log-odds grid (180 az × 90 el × 128 range = 2.07 MB) updated by a rank-1 outer product; Cartesian conversion happens only at display time. |
| **ADR-010** | Fuse the **full matched-filter envelope** under a Gaussian beam weight, with evidence averaged inside 2° orientation bins and summed only across distinct bins, because naive log-odds summation degrades with scan length. |
| **ADR-011** | Cap the scan at ~30 s / ~45 sweeps and drive the UI with a spherical coverage meter, because information from a fixed origin saturates at ~36 chirps. |
| **ADR-012** | `DeviceMotion` acceleration is used only to detect that the user walked and invalidate the scan — never integrated for position. |
| **ADR-013** | Absolute yaw comes from `webkitCompassHeading` when valid, otherwise the map is explicitly phone-relative; compass error is absorbed by a Manhattan-frame snap at render time, not by magnetometer calibration. |
| **ADR-014** | Emission is capped at **70 dB SPL @ 1 m** (ICNIRP 2024 / IRPA public limit for the 20 kHz ⅓-octave band), not the 105 dB ACGIH hearing-damage ceiling. |
| **ADR-015** | Audio hygiene is verified **acoustically** at startup and on route change — `track.getSettings()` cannot verify constraints WebKit does not implement — and the app refuses to enter mapping mode on failure. |
| **ADR-016** | The `AudioContext` is constructed with no `sampleRate` option; the chirp is synthesised at runtime for the measured rate with the band capped at 0.45·fs. |
| **ADR-017** | The wasm ABI is two-tier: a zero-allocation binary hot path (`bv_input_ptr`/`bv_capacity`/`bv_process`) over a pre-grown persistent ring buffer, plus horizon's JSON `hz_eval` shape for low-rate config and telemetry only. |
| **ADR-018** | The wasm module is compiled on the main thread and `postMessage`d into the AudioWorklet as a `WebAssembly.Module`; the worklet has no `fetch`, no `instantiateStreaming` and no `TextEncoder`. |
| **ADR-019** | Copy horizon's build shape (detached `[workspace]`, `cdylib`+`rlib`, no wasm-bindgen, `panic = "abort"`) but with `opt-level = 3`, `+simd128` plus a scalar fallback, and explicit length validation at every ABI boundary. |
| **ADR-020** | Scan-session control uses horizon's `HaltController` directly in a ~40-line `ScanDriver`; `LongHorizonDriver` and `CommandGuard` are used only in the Node/CI harness, where shell commands are real. |
| **ADR-021** | The halt progress signature is a **quantised** two-bucket string (`h<entropy/4096>:k<voxels/256>`), never a hash or a float, and failure signatures are coarse enums with an explicit `null` on success. |
| **ADR-022** | `no-progress` means the room is mapped (success), `iteration-budget` means a usable partial map, `repeated-failure` means abort with a user-facing fault. |
| **ADR-023** | Flywheel `noopRate` is defined continuously as `mean(max(0, 1 − detections/3))` so it never saturates at 0 and permanently blocks the strict promotion clause. |
| **ADR-024** | Promotion is scored on free-space IoU and tolerance-dilated occupied recall, never on zero-tolerance occupied IoU, which is saturated at ~0.12 regardless of beam width. |
| **ADR-025** | At least one safety-prone room lives in the **holdout** (not only the anchor), because `regressed` is evaluated only against the holdout score. |
| **ADR-026** | CI runs a synthetic room simulator (image-source RIR + measured loopback WAV fixture + mic noise) as the unit under test; exactly one device lane covers the four untestable platform gates. |
| **ADR-027** | Reuse from ruvnet/ultrasonic is limited to the band constants, the replica-correlation architecture and the synthetic-loopback test pattern; the FSK preamble, the dead FEC, the 1 % window, peak normalisation and `filtfilt` are explicitly excluded. |
| **ADR-028** | Multi-device coordination, if built, uses TDMA negotiated over a narrow 17.0/17.5 kHz FSK control plane — not waveform orthogonality, not frequency hopping. |
| **ADR-029** | The renderer's primitive is an anisotropic arc, and the UI reports range **accuracy** and range **resolution** as two separate numbers. |
| **ADR-030** | Audification (heterodyne, ×10 time expansion, rate-coded proximity) is the primary non-visual channel and ships in v1; haptics are a feature-detected enhancement only. |
