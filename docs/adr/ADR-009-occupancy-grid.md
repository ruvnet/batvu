# ADR-009: A bounded Cartesian log-odds voxel grid

**Status**: Accepted
**Date**: 2026-08-25
**Related**: ADR-010 (inverse sensor model), ADR-011 (pose)
**Diverges from**: the research dossier, which recommends a spherical grid

## Context

The map has to hold "how sure am I that something is here" over a room, be
updatable at 15 Hz on a phone, and be renderable. Three shapes were considered:

| representation | for | against |
|---|---|---|
| **Spherical** (az × el × range) | Matches the sensor exactly; ~2 MB as int8; each ping updates one column | Fixed to one origin forever; awkward to render in plan; resolution varies with range |
| **Cartesian voxels** | Origin-independent; trivially renderable; standard | Larger; wastes cells the sensor never reaches |
| **Point cloud** | Cheapest | No free space, and free space is the strong evidence (ADR-010) |

The research dossier recommends spherical, and for v1 as specified it is the
better fit — the scan *is* fixed-origin (ADR-011), and 2 MB against 14 MB is a
real difference on a phone.

## Decision

Use a **bounded Cartesian grid** of `float32` log-odds: 6 m half-extent, 10 cm
voxels, 120³ cells, 6.9 MB plus 6.9 MB of per-ping touch stamps.

Bounded rather than hashed or growing, because with orientation-only pose there
is no honest way to place anything beyond a few metres of the origin. The cube is
the claim: this is the region we are willing to say something about.

Cartesian rather than spherical, accepting the extra memory, for one reason that
outweighs the fit: **`origin` is a parameter throughout.** A spherical grid bakes
the fixed-origin assumption into the data structure, and ADR-011's restriction to
one standing position is a limitation of today's browser pose sources, not of the
approach. When WebXR or an external tracker makes translation available, a
Cartesian grid takes it without a rewrite.

Log-odds with symmetric clamps at ±4, so a saturated voxel can still be revised —
without the clamp, the map cannot learn that the chair moved.

## Consequences

- 14 MB is affordable on a phone and the resolution ladder is steep: 5 cm voxels
  would be 110 MB and 2 cm would be 7 GB. `byteLength` is exposed and asserted so
  the cliff is visible before someone walks off it.
- Cells the sensor cannot reach are allocated and never touched. Wasteful, and
  the waste is bounded and known.
- The renderer does not read the grid per frame — it draws arcs from the
  detection list (ADR-017) — so the grid's shape does not constrain the display.
- Revisit if a phone-side memory problem appears, or if fixed-origin proves
  permanent rather than temporary. The dossier's spherical design is the sketch
  to start from.
