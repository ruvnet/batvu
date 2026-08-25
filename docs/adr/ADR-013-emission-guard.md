# ADR-013: An emission guard, because the flywheel tunes the transmitter

**Status**: Accepted
**Date**: 2026-08-25
**Related**: ADR-012 (why not CommandGuard), ADR-014 (the flywheel)

## Context

`@metaharness/horizon` ships a `CommandGuard` that classifies shell commands.
BatVu runs no shell commands, so adopting it would be decoration.

But the *shape* of that guard — classify every part of a request, take the
maximum severity, default unknown to `gate` rather than `allow` — fits a risk
this project genuinely has, and the reason is the flywheel. `@batvu/flywheel`
mutates the sonar's operating policy, and the levers include `amplitude`, `f0`,
`f1`, `durationS` and the ping rate. Those are not abstract numbers: they are how
loud the speaker is driven, in what band, and for what fraction of the time.

An optimiser rewarded for detection quality will discover that louder and longer
score better. It will keep going until the speaker clips — folding harmonics down
into the audible band and defeating the entire point of an ultrasonic sensor — or
until the band slides down into frequencies children, dogs and cats hear
perfectly well.

## Decision

`classifyEmission(config, pingRateHz, policy)` returns `allow` / `gate` / `deny`,
the maximum across every check, so a dangerous parameter cannot hide behind
several benign ones.

| check | verdict | why |
|---|---|---|
| amplitude > 0.8 | **deny** | clipping folds harmonics into hearing |
| band below 17.5 kHz | **deny** | children and pets hear well above where adults stop |
| sweep at or past Nyquist | **deny** | it aliases |
| duty cycle > 35% | **deny** | see below |
| ping rate > 25 Hz | gate | near-continuous emission |
| pulse > 50 ms | gate | unusually long |
| rectangular transmit window | gate | an audible click on every ping |

**Duty cycle is the check that justifies the whole design.** Every individual
parameter can be within limits while the product is not: a 0.6 amplitude and a
20 ms pulse are each fine, and at 20 Hz they mean the speaker is on 40% of the
time. Amplitude is a property of the config; duty cycle is a property of the
*session*, so a guard that only ever sees the config cannot see the risk. That is
why `pingRateHz` is a separate argument.

A `deny` sets the flywheel's `regressed` flag, which is a hard promotion stop no
measured lift can override.

## Consequences

- The guard runs **before** anything is emitted, including in simulation. A
  policy that would be unsafe on a phone cannot earn a score that argues for
  promoting it.
- Defaults are conservative on purpose: the cost of a false gate is one rejected
  flywheel candidate; the cost of a false allow is a device that hurts to be near.
  `EmissionPolicy` is injectable so a deployment can tighten it.
- This is an **engineering guardrail, not a compliance claim.** The research
  dossier cites ICNIRP 2024's 70 dB SPL at 1 m for public exposure in the 20 kHz
  third-octave band. BatVu cannot measure SPL — a browser has no calibrated
  output level — so the guard constrains the things it *can* see: digital
  amplitude, band, duty cycle and rate. Anyone deploying this at scale needs an
  acoustic measurement, not this file.
- Emission at these levels is inaudible to most adults and **audible to
  children, dogs and cats**. That belongs in the README, not only in a guard.
