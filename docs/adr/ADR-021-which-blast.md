# ADR-021: Which blast — time from the most recent one, not the loudest

**Status**: Accepted
**Date**: 2026-08-25
**Related**: ADR-005 (time from the blast), ADR-010 (corroboration), ADR-011 (orientation-only pose), ADR-015 (the simulator is the ground truth)

## Context

ADR-005 is the decision this project is proudest of: WebAudio will not say when
a sound left the speaker, so time every echo from the direct-path arrival
instead and every unknown latency subtracts out. It was verified across 0 to
9311 injected samples of latency, with under a centimetre of spread.

It answers *where is the blast*. It does not answer *which blast*, and on a
continuous capture that is a different question with a different answer.

A live microphone is a ring buffer. `readRecent(recordLen)` hands the DSP the
last 284 ms of it — 13919 samples at the shipping defaults, sized by
`recordLenFor` to cover 6 m of range plus 250 ms of latency headroom. At 15
pings a second the pulse repetition interval is 66.7 ms, so that span holds
**about four transmit blasts**. They are the same sound, at the same level,
one interval apart.

The old search took the global maximum over the first 250 ms. Which of the four
won was therefore decided by noise, and it changed from ping to ping.

## Why this was not caught

`sim::render` places exactly one direct path per record. Every unit test, every
benchmark, every flywheel score and the entire end-to-end browser run feed the
pipeline records that **structurally cannot contain the bug**.

ADR-015 makes the simulator the sole ground truth and argues for it. This is the
cost of that decision arriving in the one place it could do real damage: not a
number that was slightly wrong, but a failure mode the ground truth does not
model at all.

## Why it matters, and why it is not a range error

The analysis window is 29 ms — shorter than one interval — so whichever blast
wins, the echoes measured after it belong to *that* ping and their ranges are
correct. Nothing about the ranging is wrong.

What is wrong is the **pose tag**. The attitude the caller attaches is the
attitude *now*; the echoes may be from three pings ago. At a natural sweep rate
that is up to about 16° of bearing error, randomly, every ping.

And that is the specific error ADR-010's design cannot absorb. Corroboration
averages noise *on* a measurement: two pings from different attitudes intersect,
and where they agree the map sharpens. This is a measurement filed in the wrong
place. Two pings that "agree" because one of them was mis-attributed produce a
confident wall that is not there — and more pings make it more confident.

## Decision

**Blasts repeat on an exact schedule and echoes do not.** Anchor on the
strongest arrival in the search span, then step forward by whole pulse
repetition intervals to the most recent blast that still has a full analysis
window behind it.

The anchor is safe by physics: the direct path travels the ten centimetres
between speaker and microphone, every echo travels metres, so the strongest
arrival in a 250 ms span is always a blast. What it does not say is *which*, and
the interval says that without comparing amplitudes at all.

`SonarConfig.priSamples` carries the interval. **0 means "unknown"**, and
restores the single-shot rule exactly — which is right for a one-shot capture
and for every scene the simulator renders. `main.ts` sets it from the real ping
rate before building the live plan; demo mode leaves it at zero.

## The version that was wrong first

The first implementation ranked candidates by amplitude: take the most recent
arrival clearing half the strongest. On a phone that is sound, because the blast
runs tens of dB above any echo.

It broke `two_walls_are_both_found`. The simulator gives the direct path a
**flat gain with no spreading applied**, so a wall at 1.5 m comes back at over
half the blast's amplitude and was selected as "the most recent blast".

The lesson is not that the simulator is wrong (though it is, by about 27 dB, and
that is worth fixing separately). It is that **either** ratio would have been
depending on an artefact: the simulator's, or a real device's that nobody here
has measured. The interval is a fact about the transmit schedule and about
nothing else.

A second thing was wrong for a subtler reason. Refining a candidate to its local
peak over the matched filter's autocorrelation length is the obvious choice —
the ACF is, after all, the compressed blast's shape. It spans 3840 samples at
the shipping waveform, which is more than a full pulse repetition interval in
each direction, so the refinement reached into the neighbouring blast and undid
the selection it was supposed to sharpen. Four compressed mainlobes — about a
hundred samples, 0.36 m of range — is wide enough to climb from a trailing skirt
to its own peak and structurally too narrow to reach the next arrival.

## Consequences

**The regression test carries its own negative control.**
`t0_locks_onto_the_most_recent_blast_in_a_continuous_record` builds the record a
phone actually produces — four pings one interval apart, each looking at a
different wall, with the *oldest* blast made deliberately louder, which is what
a little noise does. Then it runs the same record with `pri_samples` at 0 and
asserts the old rule reports the oldest ping's wall at 1.2 m while the new one
reports the newest ping's wall at 4.0 m. Without that control the test could
pass for the wrong reason and nobody would know the rule had stopped working.

**The record is longer than it needs to be, and that is still true.** 250 ms of
latency headroom made sense for a one-shot acquisition. A shorter record would
both bound the number of blasts to two and cut the FFT cost, and it is the
obvious next change — but it is a change to the capture layer, and this decision
holds regardless of how long the record is.

**A class of bug is now named.** Anywhere the simulator's structure differs from
a device's, a passing test proves less than it appears to. The simulator renders
one blast per record, models no reverberation, applies no spreading to the
direct path, and correlates against the synthesised chirp rather than a measured
loopback. Each of those is a place where the tests are describing the model.
