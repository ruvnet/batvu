# ADR-020: The emission guard belongs at the speaker, not at the config

**Status**: Accepted
**Date**: 2026-08-25
**Related**: ADR-013 (the emission guard), ADR-014 (the flywheel)
**Supersedes in part**: ADR-013's implicit assumption that the guard was on the transmit path

## Context

ADR-013 built `classifyEmission` and argued for it well. It has been tested
since it was written and every one of those tests passed.

An adversarial review of the integration work went looking for its call sites
and found exactly one: `packages/batvu-flywheel/src/evaluator.ts`, the simulated
scorer. `AudioSession.start()` copied a waveform into an `AudioBuffer` and
played it on a timer, and nothing in between asked whether it should.

The guard was real, well tested, and guarding a simulation.

This is a specific kind of failure worth naming. The guard was not weak or
wrong. It was correct, comprehensive, and disconnected — and every test of the
guard confirmed the part that worked while saying nothing about the part that
did not exist.

## Decision

**`AudioSession.start()` classifies before it does anything else**, including
before it checks whether an audio session is open.

The ordering is deliberate. "You have not opened an audio session" is a
programming mistake; "this config would be audible" is a safety one, and the
safety answer must not be reachable only after the programming one has been
satisfied. There is no sequence of calls that reaches `ctx.destination` without
passing the guard.

**`AudioSessionOptions` carries the `SonarConfig`, not a pre-computed verdict.**
A verdict argument can be computed once and reused after the config changes —
and the config *does* change at runtime: `fitConfigToRate` moves the sweep when
the audio route comes up at 44.1 kHz instead of 48. A gate that accepts a stale
answer is a gate you can walk around.

**`deny` throws.** The caller turns a throw into a visible "could not start" and
the phone stays silent, which is the correct outcome for a config that would be
audible, clipped, aliased, or transmitting for more than a third of every
second.

**The guard stays off `ScanSession`.** This is the part that looks like an
omission and is not. A config is not an emission, and BatVu deliberately
*evaluates* configs it would never transmit: the flywheel's safety scoring must
be able to run a candidate that would be denied, in order to score it as
regressed. Gating construction would make the safety mechanism unable to do its
job. `ScanSession` processes recorded samples and never opens a speaker.

## The four holes in the classifier itself

The same review found that a NaN did not *fail* a check — it **deleted** one.
Every comparison against NaN is false, including the negated ones, so the guard
would return `allow` having examined nothing.

| input | what happened | why |
|---|---|---|
| `f0: NaN` | no band check at all | `Math.min(NaN, f1)` is NaN, and `NaN < 17500` is false |
| `fs: NaN` | no aliasing check | Nyquist is NaN, and `hi >= NaN` is false |
| `tukeyAlpha: NaN` | no taper gate | `NaN < 0.05` is false |
| `durationS: Infinity` | **`gate`, not `deny`** | `!(Infinity > 0)` is false, and the duty-cycle check *skipped itself* on a non-finite duty |

The last one is the worst: a transmitter that never stops, classified as worth
gating.

A leading finiteness sweep now denies before any comparison runs, and a
non-finite duty cycle denies rather than being skipped — "we could not compute
it" is the worst possible reason to allow an unbounded transmitter.

These are not exotic inputs. The flywheel mutates exactly these fields, and a
division inside a proposer is all it takes.

## Consequences

- `@batvu/web` gains a dependency on `@batvu/horizon`, taken through a
  `./emission` subpath export so the app does not pull in the halt controller
  and `@metaharness/horizon` with it. The bundle went from 28.2 KB to 28.4 KB.
- `packages/batvu-web/__tests__/emission-gate.test.ts` tests the *wire*, not the
  classifier: that a denied config throws before the session-open error, and
  that the shipping config passes the guard and then fails for the ordinary
  reason. The second half matters — without it the gate could be a blanket
  refusal and every test would still be green.
- The flywheel keeps its own call. It needs the verdict as data, to set
  `regressed`, not as an exception.
