# ADR-014: Evolve the operating policy; freeze the physics

**Status**: Accepted
**Date**: 2026-08-25
**Related**: ADR-007 (ratios), ADR-013 (safety stop), ADR-015 (ground truth)

## Context

The sonar's parameters are not obvious. Whether a wider sweep beats a longer
pulse, whether ordered-statistic CFAR earns its sort in a cluttered room, where
the occupied threshold belongs — these are empirical questions whose answers
differ by room. Hand-tuning produces a configuration nobody can justify six
months later.

`@metaharness/flywheel` formalises run → measure → mutate → verify → promote,
with a frozen conjunctive gate, an anti-Goodhart anchor suite, Ed25519 receipts
and replay verification. It is used **unmodified, with its default gate.**

## Decision

Three levers, chosen to touch disjoint parameters so lift is attributable:
`waveform` (what is emitted), `detector` (what counts as an echo), `mapping` (how
an echo becomes occupancy).

The proposer is deterministic and model-free — a step up a lever's ladder — so a
run reproduces in CI and its replay bundle verifies offline. The ladders encode a
physics hypothesis; the gate decides whether the hypothesis held on this suite,
and on the stock suite it rejects the `waveform` ladder's second rung outright.

**The stride is not always one.** A strictly-ordered ladder dead-ends: if rung
N+1 is worse, the gate rejects it, the base does not move, and a stride-1
proposer offers the identical rejected candidate every generation from then on —
the lever is stuck forever on one bad rung. Advancing the stride after a
rejection lets the wheel step over it. This was not hypothetical; the `waveform`
lever never moved for a whole run. The counter is stateful and still fully
deterministic, and replay verification re-runs the **gate** over sealed scores,
never the proposer, so the audit trail does not depend on the proposer being
stateless.

### The four axes, and the two that were wrong first

| axis | BatVu |
|---|---|
| `primary` | ½ free-space IoU + ½ dilated occupied F1 |
| `noopRate` | mean fraction of in-beam surfaces a ping failed to report |
| `costPerWin` | milliseconds of compute per IoU point |
| `regressed` | emission guard denies, **or** the map carves through a wall |

**`primary` was plain occupied IoU, and it was gameable.** Measured: on an empty
rectangular room the deliberately *bad* root policy — a 120° beam assumption and
an occupied threshold below its own per-ping hit weight, so one ping declares a
whole arc solid — scored **higher** than the tuned default (0.100 vs 0.067). It
was not mapping better. In a bare box almost everything at wall-range really is
wall, so smearing occupancy across the arc lands on it by luck, and IoU cannot
tell luck from skill.

Two halves fix it and each covers the other's blind spot. Free-space IoU is the
anti-painting term: a policy that declares everything occupied has no free space
left. Occupied F1 — **F1, not recall**, because recall alone is what made
painting free — is the anti-timidity term: a policy that finds nothing would
otherwise ace free-space IoU. Gaming either costs the other, and the remaining
degenerate strategy (carve everything, find nothing) is caught by `regressed`.
Both classes are decided at **fixed** probability thresholds (0.7 / 0.3), not at
the policy's own `occupiedThreshold`, so a candidate cannot lower its own bar and
be graded against it. After the change the tuned policy wins on every room and
every component.

**`noopRate` took three attempts.** The gate demands a *strict* improvement,
because "a policy earns a promotion by making the executor COMMIT more, not just
score higher". Twice the wheel promoted nothing, and both times the honest fix
was the projection rather than the gate.

*Attempt 1 — fraction of pings with no detections.* Backwards. Pointing at an
open doorway **should** return nothing, and rewarding less silence drives
straight to a trigger-happy detector that fills empty rooms with ghosts.

*Attempt 2 — the miss rate.* Sounds right, and it fights `primary` head-on.
Measured: tightening the detector improved `primary` from 0.056 to 0.107 and cut
`costPerWin` by two thirds, and the gate rejected it, because a stricter detector
misses more. The single most useful class of change was structurally
unpromotable. A metric that opposes the thing you are optimising is not strict,
it is broken.

*Attempt 3 — abstention.* A miss is an **error**, already priced into `primary`.
A no-op is an **abstention**. For a scan the output is map evidence, so the scan
"ends empty" to the extent that the volume it looked at is still undecided:

> `noopRate` = fraction of KNOWN voxels whose |log-odds| is below the decision
> threshold, plus the share of pings the capture path ruined.

Committing correctly improves both axes; committing *wrongly* improves this one
and costs `primary` — exactly the tension a conjunctive gate is for. And it
approaches zero asymptotically rather than landing on it, so the strict clause
stays satisfiable while any real improvement remains.

With that axis, the wheel climbs: **primary 0.056 → 0.144 → 0.242** over two
promotions, with the never-optimised anchor rising 0.052 → 0.340.

### Suites

`holdoutRooms()` is optimised against; `anchorRooms()` never is. They are
physically different rooms, not different seeds, so they stress different failure
modes.

**The safety room is in the HOLDOUT, deliberately.** `regressed` is read from the
candidate's holdout score only — the anchor contributes just its `primary` — so a
safety-critical room in the anchor could regress catastrophically without the
gate ever seeing it. A suite's job is decided by what the gate reads from it, not
by how important it feels.

## Consequences

- CFAR windows are levers as **ratios of the mainlobe**, never absolute cells: the
  core rejects a guard narrower than the mainlobe (ADR-007) and the mainlobe
  depends on the waveform, so absolute counts produce lever combinations that
  cannot run at all. A test walks every rung of every ladder and builds a plan
  from each.
- The `regressed` axis measures `falseFreeRate` — the fraction of solid
  ground-truth voxels the map confidently declared **free**. Not the complement of
  IoU: a map that fails to find a wall is unhelpful, and one that asserts the wall
  is open space is dangerous, and only this number distinguishes them.
- No wall clock anywhere in the engine or the evaluator, so two runs of the same
  configuration produce identical lineage — which is what makes a replay bundle
  proof rather than a recording. A test asserts it.
- The default gate is kept even though its strict-`noopRate` clause is the
  harshest thing in it. A domain that cannot honestly satisfy it has mapped its
  axes badly, and the temptation is to relax the gate rather than fix the mapping.
