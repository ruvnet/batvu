# ADR-004: A full Hann transmit taper, and no receive weighting

**Status**: Accepted
**Date**: 2026-08-25
**Related**: ADR-003 (waveform), ADR-007 (CFAR sizing)
**Evidence**: `crates/batvu-dsp/examples/taper_study.rs`

## Context

The textbook says an unwindowed LFM matched filter has −13.3 dB first range
sidelobes, and that you fix this by windowing the **receiver**: Hann for −31.5 dB,
Blackman-Harris for −92 dB, paying mainlobe width for each. BatVu's first
implementation did exactly that — a light Tukey shoulder on transmit and a Hann
taper on receive — and measured the textbook numbers.

The research swarm claimed the opposite: no receive weighting, on the grounds
that "receive windows do not work at BT ≤ 40". That is a strong claim against a
strong textbook, so it was measured rather than adopted or dismissed.

## The measurement

`taper_study.rs`, peak sidelobe level and −6 dB mainlobe width, **with a full
Hann transmit taper in place**:

| B, T | BT | rect RX | hann RX | rect width | hann width |
|---|---:|---:|---:|---:|---:|
| 3 kHz, 5 ms | 15 | **−45.6 dB** | −53.4 dB | 42 | 50 |
| 3 kHz, 10 ms | 30 | −55.3 dB | −70.2 dB | 42 | 50 |
| 4 kHz, 10 ms | 40 | −57.3 dB | −70.1 dB | 32 | 38 |
| 6 kHz, 20 ms | 120 | −59.9 dB | −77.0 dB | 22 | 26 |

Both the swarm and the textbook were partly right, and neither for the stated
reason. A receive window *does* still work at BT = 15 — it buys 8 dB. But it is
buying it on top of a floor the **transmit** taper already put at −45.6 dB, and a
real room's reverberation tail sits roughly 30 dB above the microphone's noise
floor. Suppression 15 dB below the reverberation floor is suppression nobody can
measure. The 19% of mainlobe width it costs is measurable.

The earlier −13.3 dB reading was correct and irrelevant: it was taken with a
Tukey(0.2) transmit pulse. The transmit taper was always doing the work.

## Decision

- **Transmit: a full Hann amplitude taper** (Tukey α = 1.0). Costs 4.5 dB of
  radiated energy, buys −45 dB peak sidelobes, and suppresses the audible click
  that a hard-edged pulse produces on every ping.
- **Receive: none.** `rxTaper: 'rect'` — a plain matched filter.
- Both remain flywheel levers. The wheel can overturn this on evidence; it starts
  from the measurement.

## Consequences

- Range resolution is `c/2B` widened by **1.67×** — the transmit taper's factor —
  giving 9.6 cm rather than 5.7 cm. `ChirpSpec::effective_widening` takes the
  *maximum* of the two tapers, and this is load-bearing: computed from the
  receive taper alone, the mainlobe reads 16 samples where it measures 42, and
  every CFAR guard band derived from it comes out less than half as wide as it
  needs to be (ADR-007).
- The change removed a tradeoff that had been locked into a test. With
  −13 dB sidelobes, widening the CFAR guard band recovered masked targets *and*
  invented sidelobe ghosts. At −45 dB it recovers them and invents nothing. The
  test now asserts the absence of ghosts, so weakening the transmit taper fails
  the build.
- The general lesson, recorded because it will recur: **a receive-side
  optimisation measured against an unwindowed transmit pulse is measuring the
  wrong system.**
