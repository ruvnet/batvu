# ADR-008: Split above-threshold runs at prominent peaks

**Status**: Accepted
**Date**: 2026-08-25
**Related**: ADR-007 (CFAR sizing)

## Context

A CFAR detector produces a run of cells above threshold, and the obvious
grouping — one detection per run, at the run's peak — is right for the case it
was designed for: a wall crossing the threshold, dipping through a sidelobe null,
and crossing again is one object, not three.

It is wrong for the case that matters. Two echoes the matched filter resolves
cleanly still share a single run whenever the trough between them stays above the
threshold. Measured: two targets 18 cm apart, clearly two peaks in the envelope
with a 34 dB trough between them, reported as **one** object at 48 dB SNR. The
sensor had resolved them; the detector threw it away.

Fixing this by raising the threshold is worse — it discards real targets to make
the grouping simpler.

## Decision

Within each above-threshold span, emit one detection per local maximum that is
both:

- **prominent** — the trough between it and the nearest stronger peak drops at
  least `minProminenceDb` (default 6 dB) below it, and
- **resolvable** — at least `mergeGap` cells from any stronger peak already kept,
  because two peaks closer than a resolution cell cannot be distinct targets.

Peaks are considered strongest-first, so "a stronger peak already kept" is exact.

**The order of operations is load-bearing: merge runs first, then split.** The
first implementation split then merged, and the merge immediately re-joined the
sub-peaks — their sub-runs are adjacent by construction, so any gap tolerance
swallows them. The bug presented as "splitting does nothing".

Prominence is checked against only the nearest kept peak on each side rather than
all of them. That is exactly equivalent — the trough to a nearer peak is never
lower than to a farther one — and turns `O(k²·span)` into `O(span)`, which the
fuzz suite found by hanging.

## Consequences

- Two resolved echoes are two detections. `min_prominence_db` is the knob that
  trades this against sidelobes becoming objects, and it is a flywheel lever.
- Extended targets still collapse to one detection when they should: a plateau
  narrower than the guard band is one object with a width, and the test says so.
- A documented, deliberate limit stays: a target *wider* than its own guard band
  self-masks and disappears from the middle outward. That is CFAR working as
  designed, not a bug, and `an_extended_target_wider_than_the_guard_band_self_masks`
  keeps the tradeoff visible instead of surprising.
