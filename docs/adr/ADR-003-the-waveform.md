# ADR-003: LFM 17.5–20.5 kHz, 5 ms, 15 Hz — and why not 18–22 kHz

**Status**: Accepted
**Date**: 2026-08-25
**Related**: ADR-004 (tapers), ADR-005 (timing), ADR-014 (the flywheel tunes this)

## Context

Range resolution is `c / 2B`, so bandwidth is the only lever that sharpens it,
and the obvious move is to take as much as Nyquist allows. At a 48 kHz
`AudioContext` that is 24 kHz, which makes an 18–22 kHz sweep look free — 4 kHz
of bandwidth, comfortably below the limit, comfortably above adult hearing.

The first implementation used exactly that. The research swarm's platform lens
disagreed, and the reason is not sampling theory: **an iPhone's speaker and
microphone both fall off a cliff between 19 and 20 kHz.** Bandwidth claimed above
roughly 20.5 kHz is bandwidth that appears in the design report and not in the
data. The link budget is also capped from the top by emission limits (ADR-013),
not by the transducer.

## Decision

| Parameter | Value | Why |
|---|---|---|
| Waveform | Linear FM chirp | Pulse compression buys SNR from a speaker that cannot be loud |
| Band | **17.5–20.5 kHz**, B = 3 kHz | Below the measured transducer cliff; above adult hearing |
| Duration | **5 ms** | BT = 15 → 11.8 dB compression gain; blind range `cT/2` = 0.86 m |
| Ping rate | **15 Hz** | PRI 66.7 ms; unambiguous to 11.4 m; **7.5% duty cycle** |
| Sample rate | Whatever the route reports | It cannot be requested on iOS; the band is capped at 0.45·fs |

Derived and asserted in `packages/batvu-core/__tests__/wasm.test.ts`:

- realisable range resolution **9.6 cm** (not the nominal 5.7 cm — see ADR-004)
- range quantisation 3.6 mm per lag sample
- blind range 0.86 m, so `minRangeM` is 0.6 m and below that the display shows a
  blind disc rather than pretending

**Widening to 4 kHz is allowed only after an on-device loopback proves the top
end is there.** The wider rung exists in the flywheel's waveform ladder; it is
not the default.

## Consequences

- Resolution is worse than the first design claimed, and the claim was fiction.
  9.6 cm is a fist; two chair legs 5 cm apart are one object.
- The duty cycle is the number that governs exposure and battery, and it is
  checked as a duty cycle rather than as a per-ping level (ADR-013). Every
  individual parameter can be reasonable while the product is not.
- 44.1 kHz routes are supported by moving the band down, not by failing.
  `fitConfigToRate` does this and warns.
- The pulse length is a genuine trade and both ends bind: longer buys SNR and
  costs blind range, and at 5 ms the blind range is already 0.86 m in a sensor
  whose useful maximum is 4–5 m.
