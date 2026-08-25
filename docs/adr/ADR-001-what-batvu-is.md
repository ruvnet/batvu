# ADR-001: BatVu is an orientation-only swept range scanner, not a depth sensor

**Status**: Accepted
**Date**: 2026-08-25
**Project**: `ruvnet/batvu` (part of the ruview spatial-intelligence effort)
**Related**: ADR-002 (browser), ADR-009 (map), ADR-011 (pose), ADR-017 (render)

## Context

The name invites an expectation the hardware cannot meet. "See the room like a
bat" suggests a device that looks and knows — a snapshot of the space, the way a
depth camera produces one. An iPhone cannot do that, and no amount of signal
processing changes it, because the limits are structural rather than
computational:

| Limit | Consequence |
|---|---|
| One microphone channel in iOS Safari | No interaural time or level difference. No beamforming. Every degree of bearing comes from where the phone is pointing |
| Radiating aperture of a few millimetres at λ ≈ 18 mm | There is no transmit beam. Each ping insonifies a cone tens of degrees wide |
| Usable band ≈ 17.5–20.5 kHz (ADR-003) | Range resolution of about 9.6 cm |
| Speaker output capped well below a bat's | A bat emits 130–140 dB SPL at 10 cm; a phone under emission limits manages a fraction of that |

A bat solves the bearing problem with two ears, a pinna that filters by
elevation, and a head it can turn. The phone has none of the first two. It has
the third.

## Decision

**BatVu is a short-range, sweep-to-fill acoustic scanner.** The user stands
still and sweeps the phone across the room like a torch. Each ping yields a 1-D
range profile, which is painted into an occupancy map through a wide cone, and
the map sharpens where cones from different attitudes intersect.

Specifically, BatVu **is**:

- A range-only sensor. Range is the measurement; direction is metadata.
- Fixed-origin. The scan is built from one standing position (ADR-011).
- Incremental. One ping locates nothing; a sweep locates things.
- Honest in its display. Echoes are drawn as arcs, never as points (ADR-017).

And BatVu **is not**:

- A depth camera, or anything that produces a map from a single look.
- A SLAM system. There is no localisation, and no attempt at one.
- A navigation aid, an accessibility device, or anything whose failure would
  hurt someone. The false-free-space failure mode is real (ADR-014) and mitigated
  but not eliminated.

## Consequences

- The README leads with the limits rather than burying them. A user who expects
  a depth camera will conclude the app is broken; a user who expects a swept
  scanner will find it works.
- Every ambition that requires abandoning the browser — 96/192 kHz capture, the
  iPhone's real multi-element microphone array, ARKit visual-inertial pose — is
  named as out of scope rather than left as an implied roadmap.
- The architecture is shaped by the sweep. `angularCoverage` is a first-class
  signal, the halt controller stops on coverage saturation (ADR-012), and the
  renderer shows where the user has NOT looked.
- Accepting "range-only" up front is what makes the inverse sensor model
  (ADR-010) honest instead of a workaround.
