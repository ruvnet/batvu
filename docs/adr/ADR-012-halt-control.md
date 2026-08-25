# ADR-012: horizon's halt controller drives the scan, and `no-progress` means SUCCESS

**Status**: Accepted
**Date**: 2026-08-25
**Related**: ADR-016 (submodule), `@metaharness/horizon`

## Context

A scan has to stop. Left alone it runs until the battery dies; stopped early it
returns a map with a hole in it. A fixed timer is the obvious answer and the
wrong one — a small room is finished in seconds and a large one is not finished
in a minute.

`@metaharness/horizon` already solves this shape of problem for long-horizon
agents: a `HaltController` that arms a stop reason as it observes each step
(iteration budget, no progress, repeated failure) and consumes it at the next
turn boundary. A room scan is the same loop — point, ping, observe, update,
decide — with the same central question.

## Decision

Use horizon's `HaltController` unmodified, with sonar-shaped signals:

| horizon | BatVu |
|---|---|
| one turn | one **sweep** — a continuous pass across the room |
| one observe | one **ping** |
| `progress` signature | occupancy state hash **+** angular coverage bucket |
| `failure` signature | saturated ADC / non-finite samples / no direct path / repeated silence |
| `beforeModel()` | before choosing where to point next |
| `iteration-budget` | the ping budget is spent |
| **`no-progress`** | **the room is mapped — the SUCCESS case** |
| `repeated-failure` | the capture path is broken; give up and say why |

Three details carry weight:

**`no-progress` is inverted.** For an agent, a stalled loop is a bad outcome. For
a scan it is the good one: three sweeps that stop changing the map mean this
vantage point is exhausted, and continuing spends battery redrawing the same
room. `ScanInterpretation` maps the raw reason onto `complete` /
`budget-exhausted` / `capture-failed` so callers cannot treat a finished scan as
a failure.

**Progress needs two components.** The map hash alone would call a scan finished
the moment it stared long enough at one wall to saturate those voxels. The
coverage bucket alone would call it finished once the phone had pointed
everywhere, however uselessly. Together: *something new, or somewhere new*.
Coverage is **quantised** first — a hand-held phone never points twice at exactly
the same bearing, so an unquantised signature never repeats and no-progress could
never fire.

**One silent ping is not a failure.** Pointing at an open doorway is *supposed*
to return nothing, and that silence is the evidence that carves the doorway
(ADR-010). Only a repeated silence means the microphone died. Getting this wrong
would abort every scan of a room with a door in it.

**`maxIterations` is per SWEEP, and a scan also needs a session budget.**
`turnBoundary()` resets horizon's iteration counter — right for an agent, where a
fresh user turn deserves a fresh budget, and only half of what a scan needs. The
thing that actually runs out during a room scan is the battery, and the battery
does not reset when the user starts sweeping again. `ScanDriver` therefore
enforces `maxTotalPings` itself, checked before consuming horizon's per-turn
halt. Found by a demo that cheerfully ran 480 pings against a 400-ping
`maxIterations`, because each 48-ping sweep started the count over.

## Consequences

- Scans are resumable. `ScanDriver.checkpoint()` builds a real
  `HorizonCheckpoint`, hashed with horizon's own `hashCheckpoint`, so
  `verifyCheckpoint` validates it unchanged and tampering is detected. The
  continuity slots carry scan meaning: `memoryCursor` is the map signature — it
  *is* the cursor into what the scan has learned.
- A resumed scan continues the same run, halt counters and all, rather than
  starting a new one that happens to share a map.
- The map signature must be cheap, because the driver reads it every ping. That
  requirement drove the O(1) rewrite in [BENCHMARKS](../BENCHMARKS.md).
- horizon's `CommandGuard` is **not** used. BatVu runs no shell commands, and
  wiring it in to look integrated would be a veneer. The real risk surface gets
  its own guard instead (ADR-013).
