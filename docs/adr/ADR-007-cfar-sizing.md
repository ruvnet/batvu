# ADR-007: CFAR windows are derived from the waveform, never set by hand

**Status**: Accepted
**Date**: 2026-08-25
**Related**: ADR-004 (effective widening), ADR-014 (levers as ratios)

## Context

CFAR sets a detection threshold from the cells around the one under test, so the
false-alarm rate holds as the background moves. Between the test cell and the
training cells sits a **guard band**, whose job is to keep a target's own energy
out of its own noise estimate.

The first implementation guessed: 24 guard cells, 48 training. It looked
reasonable. Every target then reported a near-zero SNR, and a clean simulated
wall at 2.4 m came back with 0.6 dB of margin — the pipeline apparently barely
working at all.

The compressed mainlobe is `fs/B` samples wide, widened by the taper. For the
default waveform that is about 27 samples. A 24-cell guard band does not clear
it, so the training cells sat **on the target's own mainlobe** and every target
was quietly raising its own threshold.

## Decision

**Derive the windows from the waveform**, in `CfarConfig::sized_for`:

```
mainlobe = (fs / B) × effective_widening      // ADR-004: MAX of tx and rx tapers
guard    = ceil(1.5 × mainlobe)               // clears the mainlobe and near sidelobes
train    = 2 × guard
mergeGap = ceil(mainlobe)
```

Three things enforce it:

1. `SonarConfig::for_chirp(chirp, taper)` sizes them correctly by construction.
2. `SonarConfig::validate()` **rejects** any config whose guard is narrower than
   the mainlobe, and the core refuses to build a plan from it. The error names
   the numbers and the fix.
3. The flywheel expresses the windows as **ratios of the mainlobe**, so no
   combination of policy levers can produce an invalid detector (ADR-014).

Point 2 exists because of a specific footgun:
`SonarConfig { chirp: wider, ..Default::default() }` keeps the CFAR windows sized
for the *default* chirp. Struct-update syntax silently produces a mis-sized
detector, and a test asserts that `validate()` catches it.

## Consequences

- Detections carry real margin: the same 2.4 m wall now reports 20+ dB.
- The Rust and TypeScript implementations of this formula are cross-checked
  against each other in `wasm.test.ts`, over four waveform/taper combinations.
  They are two implementations of one formula, and a drift would have the
  flywheel promote a detector it never actually evaluated.
- The design report exposes `mainlobeSamples`, `recommendedGuard`,
  `recommendedTrain` and `recommendedMergeGap`, so any host can check its own
  arithmetic against the core's.
- A config can still be *wrong* (a silly Pfa, a hopeless SNR gate). It can no
  longer be **self-defeating** in this particular, invisible way.
