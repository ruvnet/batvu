# ADR-019: Recognise a place instead of localising in one

**Status**: Accepted
**Date**: 2026-08-25
**Related**: ADR-011 (orientation-only pose), ADR-009 (the occupancy grid), ADR-018 (the RuField wire)

## Context

ADR-011 pins the scan origin and integrates orientation only, because
integrating a consumer MEMS accelerometer twice drifts metres within seconds and
the whole map is six metres across. That decision is right and it is permanent
under the current interaction model, and it has a consequence the project had
not confronted: **the map is built in a frame whose azimuth zero is wherever the
phone happened to be pointing when the scan started.**

iOS reports `alpha` relative to an arbitrary origin unless a page uses the
non-standard `webkitCompassHeading`. So scan the same room twice, a quarter turn
apart, and every voxel moves — rigidly, by one unknown rotation.

Geometric localisation is therefore off the table. "I am at (3.2, 1.1) in the
floor plan" is not a sentence this sensor can produce, and no post-processing
puts it back.

Associative recognition is a different question. "I have been here before" needs
no global frame, and for a wearable it is most of what localisation was wanted
for.

## Decision

Reduce the occupancy grid to a 128-number descriptor invariant under rotation
about gravity, and nothing more.

**The symmetry group is exactly SO(2) about `+Z`.** Two of the three axes are
pinned by physics: the accelerometer measures gravity, so `beta` and `gamma` fix
which way is down and elevation is absolute. Only heading is unknown. A
descriptor invariant under more than that would be discarding measurements the
accelerometer already paid for.

**Two of the four blocks are exactly invariant.** A rotation about `+Z`
preserves `z` and preserves `r` for every voxel, so the radial mass histogram
and the elevation-marginal mean range are literally the same numbers before and
after. No approximation anywhere. 32 of the 128 dimensions are exact.

**The other two use the DFT shift theorem.** Bin into 8 elevation bands × 64
azimuth bins. A heading offset of an integer number `m` of bins is a circular
shift of each band's azimuth row, and

```
f'[a] = f[(a − m) mod A]   ⟹   F'[k] = e^{−2πikm/A} · F[k]
```

The prefactor has unit modulus, so `|F'[k]| = |F[k]|` **exactly**, for every
harmonic and every band. That is why the retained quantity is the magnitude
spectrum and the phase is discarded.

**Where that stops working is the reason for K = 6.** A real offset lands
mid-bin. Binning is a box filter, so a sub-bin translation multiplies `F[k]` by
`(1−δ) + δe^{−iω}` with `ω = 2πk/A`, attenuating the retained magnitude by

```
|F'[k]| / |F[k]| = √( 1 − 2δ(1−δ)(1 − cos ω) )
```

At the worst case `δ = ½` and `A = 64` that is 0.9988 at `k = 1`, 0.9699 at
`k = 5`, and **zero** at `k = A/2`. Attenuation grows monotonically in `k` and
reaches total annihilation at Nyquist, so truncating at six harmonics is not
dimension reduction — it is the region where the invariance survives binning.
`harmonicAttenuation` is exported and tested against those values.

## What the first version got wrong

**It bounded the phase error.** v1 argued that a mid-bin offset costs "a phase
error of at most `π·k/A` radians". The descriptor throws the phase away. The
bound was real, correct, and about a quantity that does not appear in the
output.

**Eight dimensions were a copy.** `|F_e[0]|` is by definition the sum of a
band's azimuth row, which *is* the band's occupancy mass — and v1 carried a
separate 8-wide elevation-mass block beside it. The elevation-marginal mean
range replaces it: it is what was actually missing (how far away the floor is,
how far away the ceiling is) and it is exactly invariant.

**Two radial bins could never fill.** The histogram spanned `[0, extentM]` while
the sonar cannot see closer than 0.6 m.

**A threshold cited a test that did not exist.** `DEFAULT_RECALL_THRESHOLD` was
documented as the midpoint of a measured separation, from a file that was never
written. A comment claiming a number was measured, when it was not, is worse
than no comment.

## Consequences

**Judge a match on margin, not level.** Every entry is a magnitude of a
non-negative field, so cosine similarity has a high floor and unrelated rooms
score well above 0.5. `RecallHit` carries the gap to the runner-up and
`recognize` gates on it: a query scoring 0.96 against two stored places has been
confused, not recognised, and the honest answer to "where am I" is nothing.

**The measured separation, on four simulator rooms** (`artifacts/memory/room-signature.json`):

| | |
|---|---:|
| worst same-room, over a full turn of heading | **0.9999** |
| best different-room pair (corridor) | 0.8623 |
| separation | **0.1376** |

Four rooms is not a population. A real home with several similarly-shaped rooms
will narrow that, which is exactly what the margin gate is for.

**It runs at the end of a scan, never per ping.** The descriptor is a full
1.7 M-voxel pass: 8.17 ms on desktop x86, so 25–40 ms on a phone. At fifteen
pings a second that would be the most expensive thing on the main thread — and
there is nothing useful to say about a room from one ping anyway.

**This is not a RuVector client, and the reasons hardened during the build.**
RuVector is a Rust substrate with local ONNX embeddings and a persistent
database; BatVu is a page in iOS Safari. Reading the code found two more:
`@ruvector/wasm`, the only browser surface, has no persistence at all — its
`saveToIndexedDB` returns a resolved promise without saving — and the `ruvector`
npm package silently degrades to a stub whose `search()` returns `[]` while
`getImplementationType()` still reports `wasm`. A stubbed store answers "I have
never been here" to every query, which is indistinguishable from a correct
negative.

So `RoomMemory` holds descriptors locally, and `toFieldEmbedding` emits them in
rufield's `FieldEmbedding` shape at **P3** — an anonymous aggregate of a room's
geometry. P3 is also the ceiling: no arrangement of 128 geometry numbers
describes a person.

## What it will not do

- **Not invariant to translation.** Move two metres and the range profile really
  does change. The recognisable unit is a *standing spot*, not a room.
- **Cannot separate congruent rooms.** Two identical hotel rooms, two identical
  offices, the two ends of a symmetric corridor. Geometry is all this has.
- **The tests prove less than they appear to.** They hold the physical sweep
  fixed and rotate the reported heading, which is exactly what an arbitrary
  `alpha` origin does and exactly what the shift theorem covers. Two physically
  different partial sweeps of the same room are not related by a circular shift,
  and none of the mathematics above applies to them.
