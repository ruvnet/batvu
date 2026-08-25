// SPDX-License-Identifier: MIT
//
// @batvu/horizon — knowing when to stop scanning, and what may be transmitted.
//
// Two things a long-horizon sonar sweep needs that the DSP cannot supply:
//
// 1. **`ScanDriver`** wraps `@metaharness/horizon`'s `HaltController` with
//    sonar-shaped progress and failure signatures, so a scan stops for a
//    principled reason and can be checkpointed and resumed mid-room. The
//    interesting part is that `no-progress` — a failure state for an agent — is
//    the SUCCESS state for a scan: the room is mapped.
//
// 2. **`classifyEmission`** is the guard on what the phone is allowed to emit.
//    It is not horizon's `CommandGuard` renamed; BatVu runs no shell commands.
//    It borrows that guard's SHAPE — classify everything, take the maximum
//    severity, default unknown to `gate` — and applies it to the risk this
//    project actually carries: a flywheel that mutates transmit amplitude, band
//    and duty cycle while being scored on detection quality.

export {
  ScanDriver,
  loadHorizonCore,
  interpret,
  DEFAULT_SCAN_DRIVER_CONFIG,
} from './driver.js';
export type {
  ScanDriverConfig,
  ScanOutcome,
  ScanInterpretation,
  ScanContinuity,
} from './driver.js';

export {
  classifyEmission,
  isEmissionAllowed,
  DEFAULT_EMISSION_POLICY,
} from './emission.js';
export type {
  EmissionVerdict,
  EmissionFinding,
  EmissionClassification,
  EmissionPolicy,
} from './emission.js';
