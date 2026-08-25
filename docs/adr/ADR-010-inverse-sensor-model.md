# ADR-010: Evidence spreads across the cone; only corroboration makes it occupied

**Status**: Accepted
**Date**: 2026-08-25
**Related**: ADR-001 (range-only), ADR-009 (grid), ADR-017 (render)

## Context

The mapper's input is "something reflected at 2.4 m". Its output has to be a
statement about locations. The gap between those is the whole problem: a phone's
transmit pattern at 19 kHz is tens of degrees wide, so 2.4 m describes a
spherical cap, not a point.

Writing a voxel at 2.4 m along the pointing axis would produce a clean, confident
map. It would also be a fabrication, and it would look better than the honest
version — which is exactly why the temptation is worth naming.

## Decision

The classical sonar inverse sensor model (Elfes/Moravec), with three asymmetries
that all follow from what the sensor actually knows:

**1. Free space is the strong evidence.** "Nothing returned before 2.4 m along
any of these directions" is confident and direction-specific. It is what carves
away the false parts of other pings' arcs. Silence — a ping with no detections at
all — carves the whole cone to maximum range, and that is how a scan proves a
doorway is a doorway.

**2. Occupied is the weak evidence.** It smears across the entire cap.
`occupiedThreshold` (1.4) is deliberately set **above** `logOddsHit` (0.85), so a
single wide-beam ping can never declare a voxel occupied. Corroboration from a
second attitude is structurally required. The map sharpens only where cones
cross, which is a true account of how it is formed.

**3. Behind a detection is unknown**, not free. The first reflector shadows
everything past it, and carving through it would delete real furniture.

### Traversal: by voxel, not by ray

The natural implementation casts N rays through the cone. It is wrong at range:
N rays diverge, and past `r = voxel / angular_spacing` consecutive rays are more
than a voxel apart, so the deposited shell becomes a sparse dotting with holes —
including, for most N, a hole **exactly on the beam axis**, because a Fibonacci
spiral never samples its own pole. Raising N does not fix it; the count needed
grows as r² without bound.

Sampling the shell in spherical coordinates at voxel-sized steps is hole-free but
oversamples near the apex by the same r² factor: measured at 500k trig-heavy
point evaluations to update 60k voxels, 11 ms per ping.

So the traversal is inverted: **iterate the voxels of the cone's exact bounding
box and test membership with two dot products.** Every voxel is visited exactly
once, holes are impossible by construction, and the inner loop is arithmetic
instead of trigonometry. 1.6 ms per ping, and later 0.27 ms
([BENCHMARKS](../BENCHMARKS.md)).

The bounding box is the *truncated cone's*, not the enclosing sphere's. The
extreme along a direction `e` is `r_max · cos(max(0, angle(e,axis) − halfAngle))`
when that cosine is positive and `r_min · cos(…)` when it is negative — and
getting that second case wrong (using `r_max` throughout) pushes the lower bound
past the entire cone, so the walk updates nothing at all. It did, briefly.

## Consequences

- One ping produces a shell of ambiguity. Twenty produce a room. The behaviour
  the user sees matches the physics rather than hiding it.
- The shell is at least a voxel **diagonal** thick, not a voxel edge: membership
  is tested at voxel centres, and a voxel straddling the true range can have its
  centre up to 0.87 voxels away. An edge-thick shell silently deposits nothing
  for targets landing near a voxel corner.
- A saturated ping is dropped entirely — a clipped record's ranges are fiction —
  but still carves free space, because absence of a *valid* detection is silence.
- `beamHalfAngleDeg` is the most consequential mapping lever and a flywheel
  target: too narrow draws a confident wrong map, too wide smears every wall into
  fog.
