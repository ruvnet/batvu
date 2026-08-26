# ADR-022: The blast pays for its own short path

**Status**: Accepted
**Date**: 2026-08-26
**Related**: ADR-006 (blast cancellation), ADR-015 (the simulator is the ground truth), ADR-021 (which blast)
**Closes**: [#4](https://github.com/ruvnet/batvu/issues/4)

## Context

ADR-015 makes `crates/batvu-dsp/src/sim.rs` the sole ground truth for every
test, benchmark and flywheel score in this repository. A modelling error there
is therefore not a simulator bug — it is a measurement error propagated into
every number the project publishes.

There was one, and it sat on the near field, which is where the two hardest
problems live.

**The direct-path blast was a bare constant.** `render()` applied
`direct_path_gain` verbatim while every echo paid `1/r^spreading` and two-way
absorption. The blast travels the ten-centimetre speaker-to-microphone baseline
and is the one arrival that should earn the enormous near-range gain a short
path implies. It earned nothing.

The module's own opening paragraph said the blast arrives "tens of dB above any
echo". The code delivered **11.4 dB** against a wall at 2.4 m. The
documentation was right and was never implemented.

Separately, `Target::wall` used `1/r`. An extended specular surface reflects
rather than scatters, so the returning wavefront curves as if from a source at
the phone's mirror image, `2r` away — `1/(2r)`. The missing factor of two is
6 dB of wall return the simulator was inventing.

## The evidence

Wall at 2.4 m, reflectivity 0.9, shipping defaults:

| | blast | echo | ratio |
|---|---:|---:|---:|
| as modelled | 0.9000 | 0.2410 | **11.4 dB** |
| corrected | 0.9000 | 0.0109 | **38.3 dB** |

**26.9 dB understated** — and that is precisely the quantity blast cancellation
(ADR-006) exists to fight. The hardest part of this sensor was being simulated
at a difficulty it does not have.

## It had already cost a wrong fix

While fixing ADR-021, the first implementation ranked blast candidates by
amplitude: take the most recent arrival clearing half the strongest. That is
sound on a phone, where the blast runs tens of dB above any echo.

It broke `two_walls_are_both_found`, because in the compressed dynamic range a
wall at 1.5 m returned **over half** the blast's amplitude and was selected as
"the most recent blast". A design correct for the real device was rejected by a
test measuring an artefact.

The eventual fix anchors on the pulse repetition interval and never compares
amplitudes, which is more robust regardless — but the near-miss is the argument
for this ADR.

## Decision

**The direct path pays spreading and absorption like everything else.**
`direct_amplitude()` computes one-way spherical spreading over
`speaker_mic_sep_m` plus one-way absorption, on the same normalised-at-one-metre
convention `echo_amplitude` uses.

**The extended limit gets its image-source factor.** `echo_amplitude` folds in
`0.5^(2−s)`, which is 0.5 at `s = 1` (fully extended) and 1.0 at `s = 2` (fully
compact). Both endpoints are now physical and the continuous knob between them
still behaves — which matters, because `sampleBeam` sets `spreading` from how
much of the beam a surface fills.

**The whole record is normalised so the blast lands on `direct_path_gain`.**
This is the part that is easy to get wrong. Giving the direct path its real
near-range gain makes it roughly ten times full scale on its own, and a record
that clips is a *different* distortion — one that would quietly destroy what
`saturated` means. The quantity that was wrong is the **ratio**, not the level.
Pinning the blast exactly where it already sat preserves the ADC realism and the
blind-zone geometry while every echo moves to where it belongs relative to it.

`direct_path_gain` therefore changes meaning from a gain to a *target level*,
and its doc comment says so. `direct_path_gain: 0.0` keeps its old meaning —
omit the blast — rather than becoming "scale the record to silence", with the
reference level falling back to `DEFAULT_BLAST_LEVEL` so echo amplitudes do not
silently change scale between the two modes.

## Consequences

**The sensor is honestly worse, and the README now says so.**
`bench_detection_envelope` measures where the link budget actually runs out
against a hard flat surface: reliable to about **3.8 m**, ragged to 4.3, nothing
beyond. The previous claim of "4–5 m" was measured against a simulator giving
away 26 dB.

**A resolution test stopped doubling as a range assertion.**
`two_walls_are_both_found` had its far wall at 4.2 m, which is now inside the
ragged band. It moved to 3.4 m — not to make it pass, but because a test about
telling two surfaces apart should not fail every time the link budget moves.
Range is documented by the probe; resolution by the test.

**The flywheel now promotes the waveform lever, and lands on the hand-designed
operating point.** This is the result worth reading twice.

Before, the `waveform` ladder was the one the frozen gate never promoted, and
that was recorded in `run.ts` as a fact about the waveform. It was a fact about
the simulator. With the link budget 26 dB tighter, far returns are genuinely
marginal and bandwidth and taper start paying for themselves — so the wheel now
walks from the deliberately bad root all the way to **17.5–20.5 kHz, 5 ms, full
Hann taper, amplitude 0.6**.

That is the operating point ADR-003 and ADR-004 argue for from first principles.
An empirical search starting from a deliberately bad policy and a hand argument
from physics now agree, and neither knew about the other. That agreement is
worth more than either result alone — and it was invisible while the physics was
wrong.

```
              before                        after
gen 0  primary 0.0564              gen 0  primary 0.0580
gen 1  primary 0.1437  (mapping)   gen 1  primary 0.1259  (mapping)
gen 2  primary 0.2420  (detector)  gen 2  primary 0.2112  (detector)
                                   gen 3  primary 0.2161  (waveform)  <- new
```

**Everything else that moved**, all committed so the diff shows it:

| | before | after |
|---|---:|---:|
| e2e detections over 45 pings | 70 | 63 |
| e2e occupied voxels | 13,901 | 9,463 |
| DSP compress + detect | 0.99 ms | 0.75 ms |
| one ping, end to end | 1.28 ms | 1.32 ms |
| room-signature separation | 0.1376 | **0.2214** |

The DSP got *faster* because there are fewer detections to process. The room
signature got *better* separated, because with far returns suppressed a room is
described more by its distinctive near geometry.

## What this does not fix

`absorption_db_per_m` defaults to `0.8`. A review suggested ISO 9613-1 gives
~0.52 dB/m at 20 kHz / 20 °C / 50 % RH, which would make the current value about
53 % pessimistic. **That figure has not been verified here and is not asserted.**
It needs someone to compute ISO 9613-1 properly for the band and conditions, and
it is left open in [#4](https://github.com/ruvnet/batvu/issues/4).

And the larger thing is untouched. A corrected model is still a model that agrees
with itself. This narrows the class of error ADR-021 belongs to; it does not
close it. A real-hardware measurement campaign remains the only thing that does.
