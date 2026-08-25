# Architecture decision records

Each record states the context, the decision, and what it cost. Where a decision
was reversed during development, the record says what the first version was and
what evidence overturned it — those are usually the useful part.

| # | Decision |
|---|---|
| [001](ADR-001-what-batvu-is.md) | BatVu is an orientation-only swept range scanner, not a depth sensor |
| [002](ADR-002-browser-and-wasm.md) | A browser app with a Rust/WASM core, not a native app |
| [003](ADR-003-the-waveform.md) | LFM 17.5–20.5 kHz, 5 ms, 15 Hz — and why not 18–22 kHz |
| [004](ADR-004-tapers.md) | A full Hann transmit taper, and no receive weighting |
| [005](ADR-005-direct-path-timing.md) | Time every echo from the direct-path blast, never from a clock |
| [006](ADR-006-blast-cancellation.md) | Cancel the blast by subtracting the filter's own autocorrelation |
| [007](ADR-007-cfar-sizing.md) | CFAR windows are derived from the waveform, never set by hand |
| [008](ADR-008-peak-splitting.md) | Split above-threshold runs at prominent peaks |
| [009](ADR-009-occupancy-grid.md) | A bounded Cartesian log-odds voxel grid |
| [010](ADR-010-inverse-sensor-model.md) | Evidence spreads across the cone; only corroboration makes it occupied |
| [011](ADR-011-orientation-only-pose.md) | Orientation only. Never integrate the accelerometer |
| [012](ADR-012-halt-control.md) | horizon's halt controller drives the scan, and `no-progress` means success |
| [013](ADR-013-emission-guard.md) | An emission guard, because the flywheel tunes the transmitter |
| [014](ADR-014-flywheel.md) | Evolve the operating policy; freeze the physics |
| [015](ADR-015-simulator-as-ground-truth.md) | The simulator is the ground truth, and there is exactly one of it |
| [016](ADR-016-submodules.md) | Vendor ruvnet/ultrasonic and ruvnet/metaharness as git submodules |
| [017](ADR-017-render-arcs.md) | Draw arcs, never points |

## The ones that changed during the build

Five decisions were made, implemented, measured, and then reversed. They are the
records worth reading first, because in each case the first version looked right.

| ADR | First version | What overturned it |
|---|---|---|
| [003](ADR-003-the-waveform.md) | 18–22 kHz, 4 kHz of bandwidth | An iPhone's transducers fall off a cliff at 19–20 kHz. The extra bandwidth existed only in the design report |
| [004](ADR-004-tapers.md) | Hann receive window, per the textbook | With a full Hann *transmit* taper the sidelobes are already 45 dB down — 15 dB below a room's reverberation floor. The window bought nothing measurable and cost 19% of the resolution |
| [010](ADR-010-inverse-sensor-model.md) | Cast N rays through the beam cone | Rays diverge past voxel spacing at range, leaving holes — including on the axis, since a Fibonacci spiral never samples its own pole |
| [014](ADR-014-flywheel.md) | `primary` = occupied IoU | The deliberately *bad* policy beat the tuned one, by smearing occupancy across a 120° arc in a room where everything at wall-range is wall |
| [014](ADR-014-flywheel.md) | `noopRate` = fraction of silent pings | It saturates at exactly 0, and the flywheel's strict promotion clause then freezes forever |

## Relationship to the research dossier

[`docs/research/RESEARCH-DOSSIER.md`](../research/RESEARCH-DOSSIER.md) is the
output of a seven-lens research swarm with an adversarial verification pass — 167
claims, 56 of them refuted or corrected before they reached the design. It is
evidence, not a specification: these ADRs are what was actually decided and
built.

Where the two differ, the ADR says so and says why. The largest divergences:

- **ADR-004** reaches the dossier's conclusion (no receive weighting) by a
  different and more precise route, and the difference matters — the dossier's
  stated reason ("receive windows do not work at low BT") is not what the
  measurement shows.
- **ADR-009** rejects the dossier's spherical grid for a Cartesian one, accepting
  7× the memory to keep `origin` a parameter rather than an assumption baked into
  the data structure.
