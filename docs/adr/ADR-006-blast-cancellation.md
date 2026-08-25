# ADR-006: Cancel the direct blast by subtracting the filter's own autocorrelation

**Status**: Accepted
**Date**: 2026-08-25
**Related**: ADR-003 (blind range), ADR-005 (timing)

## Context

With a 5 ms pulse the raw blind range is `cT/2` = 0.86 m, but pulse compression
shrinks the *effective* blind zone to the compressed pulse width — a few
centimetres. What actually sets the floor is not the pulse length at all: it is
the blast's **range-sidelobe skirt**. The direct arrival is tens of dB above any
echo, so even at −45 dB its sidelobes stay above the CFAR threshold for hundreds
of samples, and they look exactly like objects.

Measured before the fix: an empty room — no reflectors at all — reported
detections at 0.32 m and 0.50 m with 8 dB of margin. Confident, repeatable, and
entirely fictional. That is the range band where a phone held at arm's length is
most interesting.

## Decision

**Subtract the blast's known compressed shape from the envelope before
detection.**

The blast is the one arrival whose waveform is known exactly — it is the transmit
pulse, undistorted, at a known delay — so its compressed response is the matched
filter's own autocorrelation, scaled by the measured blast amplitude.
`MatchedFilter` computes that autocorrelation once at plan time (one FFT pair,
never per ping) and `Pipeline::process` subtracts it, clamped at zero.

Order matters and is enforced by the code's structure: **`t0` is measured first,
then the blast is cancelled.** Cancelling first would remove the timing reference
that ADR-005 depends on.

## Consequences

- The ghosts are gone, and the empty-room test asserts it.
- `minRangeM` drops to 0.6 m instead of the 1.5 m the skirt would otherwise
  force — most of the useful near field, recovered.
- The subtraction is in the **envelope** domain, so it is approximate: the blast
  and an echo do not share a phase, and it cannot cancel to zero. It removes most
  of a dominant, deterministic artifact, which is enough.
- A better version exists and is not built: per-ping sub-sample fractional-delay
  alignment with a complex gain, which the research dossier puts at 20–35 dB of
  suppression against this method's rough 10–20 dB. It is listed in
  [the dossier](../research/RESEARCH-DOSSIER.md) §11 as future work, and it needs
  real-hardware recordings to tune against rather than a simulator that already
  agrees with the model.
- `blastCancellation` is a config flag so a test can measure what it is worth.
