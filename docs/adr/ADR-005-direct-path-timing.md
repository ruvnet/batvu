# ADR-005: Time every echo from the direct-path blast, never from a clock

**Status**: Accepted
**Date**: 2026-08-25
**Related**: ADR-002 (browser), ADR-006 (blast cancellation)

## Context

A time-of-flight sensor needs to know when the pulse left the transmitter. In a
browser, nothing does.

`AudioContext.outputLatency` is an estimate, is absent on some versions, and
drifts when the audio route changes. Between asking WebAudio to play a buffer and
sound leaving the speaker there is a scheduling delay, an output buffer, possibly
a resampler, and the hardware path — tens of milliseconds, unknown and not
constant. At 343 m/s, 10 ms of unknown latency is 1.7 m of unknown range, which
is most of the sensor's useful span.

Meanwhile every record opens with a problem: the speaker is about 10 cm from the
microphone, so the pulse arrives directly, tens of dB above any echo, saturating
the start of the capture.

## Decision

**The blast is the clock.** Time is measured from the direct-path arrival, not
from any scheduling timestamp.

Its flight time is known and fixed — the speaker-to-microphone distance divided
by the speed of sound, well under a millisecond — so:

```
range = (c · (t_echo − t_blast) / fs + d_speaker_mic) / 2
```

Every unknown latency is common to both arrivals and subtracts out. The blast
peak is located by the same matched filter that finds the echoes, and refined to
sub-sample precision by parabolic interpolation, so the reference is as accurate
as the measurement.

The record must be long enough to contain the blast wherever it lands, which is
what `directSearchS` (250 ms) and the headroom in `recordLenFor` are for.

## Consequences

- **The pipeline's biggest nuisance became its most useful signal.** Verified
  directly: injecting 0, 137, 2048 and 9311 samples of capture latency moves the
  reported range by under 1 cm.
- The app never needs `outputLatency`, so it does not care that iOS reports it
  inconsistently.
- `blastAmplitude` doubles as a health check. It should be steady between pings;
  if it fades or pumps, the browser is running echo cancellation or automatic
  gain control regardless of what `getSettings()` claimed, and the app says so.
- A ping with no blast means the speaker is muted or covered — a distinct,
  diagnosable failure rather than "no echoes found".
- The blast must be timestamped **before** it is cancelled (ADR-006). The order
  is not incidental.
