# ADR-011: Orientation only. Never integrate the accelerometer

**Status**: Accepted
**Date**: 2026-08-25
**Related**: ADR-001 (what BatVu is), ADR-009 (bounded grid)

## Context

The map needs pose. A browser on iOS offers:

| source | gives | usable |
|---|---|---|
| `DeviceOrientationEvent` | 3-DoF attitude, ~1° | **Yes** — with an explicit permission prompt |
| `DeviceMotionEvent` acceleration | linear acceleration | For *detecting* motion. Not for position |
| WebXR / ARKit visual-inertial | full 6-DoF | Not exposed to a page on iOS Safari |

The tempting move is to integrate acceleration twice and get translation. It does
not work, and not marginally: consumer MEMS accelerometer bias integrates as t²,
which is metres of drift within seconds. In a map 6 m across, that is worse than
useless — it is confidently wrong, and the wrongness grows.

## Decision

**Integrate orientation only. Pin the origin.** The user stands still and sweeps;
the reconstruction is a spherical shell of the room seen from one point.

- `DeviceOrientationEvent` supplies bearing, via the W3C intrinsic Z-X'-Y''
  composition. The order is not a detail — any other gives a rotation that looks
  plausible while tilting the map.
- Azimuth is **relative to wherever the scan started**. `webkitCompassHeading` is
  non-standard and unreliable, so BatVu does not claim a true bearing. That is
  fine for mapping a room's shape and useless for placing it on a floor plan, and
  pretending otherwise would be the easiest way to ship a lie.
- `origin` remains a parameter through `OccupancyGrid`, `ScanSession` and the
  simulator, so a real pose source drops in without reshaping anything.

The transducer axis in the device frame is a **named constant**
(`TRANSDUCER_AXIS_DEVICE`) with its own test, because a sign error there mirrors
the entire map front-to-back and nothing else would catch it.

## Consequences

- The product instruction is "stand still and sweep", and the UI says so.
- Walking during a scan corrupts it silently, because the map assumes an origin
  that moved. Detecting that with `DeviceMotionEvent` and invalidating the scan is
  the obvious next step; it is not built, and it is named in
  [the dossier](../research/RESEARCH-DOSSIER.md) §11.
- The grid's bound (ADR-009) is honest rather than arbitrary: without translation
  there is no justification for mapping beyond a few metres of the origin.
- Coverage is reported **twice** — bearings swept and fraction of the sphere —
  because turning on the spot fills 85% of bearings while touching 5% of the
  sphere, and either number alone tells a comfortable lie about a finished scan.
