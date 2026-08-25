# ADR-015: The simulator is the ground truth, and there is exactly one of it

**Status**: Accepted
**Date**: 2026-08-25
**Related**: ADR-002 (browser), ADR-014 (flywheel)

## Context

Every claim BatVu makes about accuracy needs something to be checked against, and
a real room is not it. You cannot hold a tape measure against a sonar a thousand
times a second, a CI runner cannot hold a phone, and the flywheel needs thousands
of scored scans per run.

## Decision

A **deterministic simulator**, split across the two layers that each own half the
problem:

- **`crates/batvu-dsp/src/sim.rs`** owns the acoustics: a 1-D scene of ranges and
  amplitudes rendered to a waveform. Direct-path blast, two-way spreading (`1/r²`
  for a compact object, `1/r` for a wall), atmospheric absorption paid twice, a
  seeded noise floor, ADC clipping, and injectable capture latency.
- **`packages/batvu-sim`** owns the geometry: 3-D rooms, ray-cast through the
  beam cone, clustered by range into the 1-D target list the Rust simulator takes.

**There is exactly one model of the physics.** Two would drift, and the day they
disagreed every test would still pass.

Determinism is a hard requirement, not a nicety: `@metaharness/flywheel` promotes
a policy only if a *replayable* receipt says it beat the incumbent, and that
promise is empty if re-running gives different numbers. The PRNG is xorshift32
with no transcendentals, seeded per ping from a base seed.

## Consequences

- The simulator is the unit under test's counterparty everywhere: Rust DSP tests,
  TypeScript integration tests, the flywheel's suites, the benchmark's records,
  and the browser end-to-end test.
- Because demo mode substitutes only the microphone, the e2e test exercises the
  real app: same wasm, same matched filter, same CFAR, same occupancy update.
- **A simulator bug found during bring-up is worth recording.** Delayed echoes
  were placed by linear interpolation between samples, which at 20 kHz on a
  48 kHz grid attenuates by up to 11 dB depending on the sub-sample offset. Echo
  amplitude therefore depended on the sub-millimetre part of a target's range: a
  target at 2.00 m came back 3× weaker than one at 2.12 m, purely as an artifact.
  The flywheel would have optimised against it. The fix is to evaluate the chirp
  in closed form at shifted time — exact, since we have the analytic waveform —
  and `echo_amplitude_does_not_depend_on_sub_sample_range` keeps it fixed.
- **The simulator agrees with the model by construction, which is its limit.**
  It cannot discover that a real speaker's response has a notch, that a real room
  reverberates for 400 ms, or that a real microphone's AGC pumps. Those need a
  device, and they are named in
  [the dossier](../research/RESEARCH-DOSSIER.md) §11.
