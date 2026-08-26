# ADR-023: The teacher rides along

**Status**: Accepted
**Date**: 2026-08-26
**Related**: ADR-015 (the simulator is the ground truth), ADR-018 (the RuField wire), ADR-022 (near-field dynamic range), RuView ADR-262 (RuField integration)
**Supersedes nothing.** It does not lift the refusal in
[`ultrasonic_gates.rs`](https://github.com/ruvnet/RuView/blob/main/v2/crates/wifi-densepose-rufield/tests/ultrasonic_gates.rs).

## Context

BatVu declines to say a person is present. The refusal is asserted, not implied:
`gate_no_event_claims_a_person` forbids the `presence` feature key, and
`gate_no_inferences_and_that_is_the_correct_outcome` pins the consequence — a
BatVu scan produces zero fused inferences.

The reason given was physical: **one transducer pair cannot distinguish a person
from a coat over the back of a chair.** That is true of the sensor as built. It
is not a law of nature, and this ADR is about exactly what would have to become
true before the refusal could be lifted — and where it would be lifted, which is
not at the sensor.

Three things stand in the way. They are not equally hard, and the order matters.

## 1. The discriminant is phase, and phase is deleted

`crates/batvu-dsp/src/matched.rs`, in `envelope()`:

```rust
*slot = (r * r + i * i).sqrt();
```

Every stage downstream of that line sees magnitudes. A coat and a chest at the
same range, with the same reflectivity, produce **identical** magnitude
profiles. There is nothing in the recorded data to separate them, so no
classifier can separate them either. A model trained on this tensor would be
learning the wrong quantity — it would find room-specific clutter correlates and
report them as personhood.

What separates them is motion of millimetres. Two-way phase for a radial
displacement `d` is

```
Δφ = 4πd / λ
```

and at 20 kHz in 343 m/s air, `λ ≈ 17.15 mm`. So **1 mm of radial motion is
≈ 0.73 rad, about 42°.** Breathing chest-wall excursion is millimetre-scale.
This is not a marginal signal being teased out of noise; it is an enormous phase
swing that the pipeline is throwing away on its last line.

The exact excursion figure needs a citation this repository does not have and
**is not asserted here**. The wavelength and the phase relation are arithmetic
and are.

## 2. There is no data, and the simulator must not be allowed to supply it

BatVu has measured **zero real rooms**. The simulator models spreading,
absorption and specular reflection. It does not model breathing, micro-motion,
clutter statistics, multipath from soft furnishings, or the acoustic difference
between wool and skin.

Training a presence classifier against it would produce a model that has learned
the simulator. That is [ADR-022](ADR-022-near-field-dynamic-range.md)'s defect —
*a measurement error propagated into every number the project publishes* —
escalated from "a range figure is optimistic" to "**a model confidently reports
a person who is not there.**" It is the worst available version of the failure
mode this project has spent its whole history eliminating.

So the simulator is barred from this problem as a source of truth. It keeps one
much smaller job, stated in §Decision 4.

## 3. Two practical blockers that can kill it cheaply

**Dwell against sweep.** A periodicity test over a breathing band needs a dwell
of tens of seconds on one bearing. BatVu's entire design is *turning on the
spot* at 15 pings a second. These are mutually exclusive modes. Micro-motion
sensing is not a feature added to the scanner; it is a second instrument sharing
a transducer.

**Handheld motion swamps the target.** If 1 mm of target motion is 42° of phase,
then a few millimetres of hand tremor is *hundreds* of degrees — the operator's
own body is a far louder micro-motion source than the subject. Either the phone
rests on a surface, or motion compensation has to be good to well under a
millimetre.

This one is cheap to test and can end the enquiry, so it is tested first.

## Decision

### 1. Keep the complex compressed profile

Already the README's first near-term item, on its own merits: the same discard
forecloses Doppler, moving-target indication and coherent blast cancellation.
`envelope()` gains a sibling that writes `(re, im)` pairs; the magnitude path
stays exactly as it is, so nothing downstream changes until something asks for
phase.

### 2. The label comes from the same phone, in the same second

This is the part that makes the corpus possible, and it is why this ADR exists
now rather than after a hardware campaign.

RuView already ships an iPhone capture app that streams
`ruview.lidar.depth.v1` — ARKit scene depth in metres with per-pixel confidence,
camera intrinsics, the full 4×4 camera transform, and a provenance block
carrying sensor, source, privacy class, sequence and a nanosecond timestamp
(`integrations/iphone-lidar/native/RuViewLiDAR/RuViewFrame.swift`).

That is a **geometric teacher riding along with the student**. One device. One
clock. One pose. For any bearing the sonar was pointed down, LiDAR gives the
true range to the nearest surface, and ARKit gives whether a body is in the
scene and where. The labels are not hand-annotated, not crowd-sourced, and not
guessed from the sonar itself — they are measured by a different physical
principle on the same chassis.

The pairing is the contribution. Neither sensor alone can produce this corpus:
LiDAR cannot hear breathing, and the sonar cannot see a person.

### 3. A classical detector first. The flywheel evolves it. No learned model yet

Breathing is a narrowband periodic phase modulation in a known band. The first
detector is slow-time phase per range bin over a dwell, band-limited, with a
periodicity statistic and a **stated false-alarm rate**. That is signal
processing, and it yields a calibrated number rather than a score nobody can
interrogate.

`@metaharness/flywheel` is reused **unmodified, gate included**. Nothing about
the promotion machinery needs to change: `meetsPromotionRule` stays frozen and
conjunctive, `verifyReplayBundle` still signs the lineage, holdout and anchor
still split the corpus. The only thing that changes is what the evaluator reads
— simulated rooms become real captures.

This is the honest form of "self-improvement". The wheel does not learn what a
person is; it searches detector parameters against measurements it did not
produce, and the frozen gate refuses anything that does not show lift on a
holdout without regressing the anchor. [ADR-022](ADR-022-near-field-dynamic-range.md)
showed what happens when the wheel is scored against a model that agrees with
itself. Here it is scored against a room.

A learned classifier is deferred to the multi-way problem — person against pet
against fan against curtain in a draught — where the feature space is genuinely
higher-dimensional than a periodogram. It is not needed for the binary, and
reaching for it first would forfeit the calibrated false-alarm rate for nothing.

### 4. The simulator gets one narrow job, and a warning label

`Target::breathing` is added, and it exists **to test that the detector's
machinery works** — that a periodic radial displacement produces the expected
phase modulation and that the statistic fires on it. It is a unit-test fixture
for arithmetic.

It is **not** evidence that the detector works on people, it is **not** training
data, and it must never be scored by the flywheel. The corpus is real captures
or it is nothing. Any test asserting detection performance against a simulated
breather is asserting that the code agrees with the code.

### 5. The sensor still never claims a person

BatVu populates `range_m` and, once §1 lands, a new `micromotion_band` feature.
It does **not** populate `presence`. The gates stay exactly as they are.

The inference happens where RuField already puts it. The shipped rule is a list:

```toml
[rule.person_present]
inputs = ["wifi_csi", "mmwave_radar", "infrared_thermal"]
method = "weighted_bayes"
feature = "presence"
threshold = 0.40
privacy_max = "P2"
```

`inputs` takes another entry and `weighted_bayes` combines per-modality
evidence. The two modalities are complementary in precisely the useful way:
ultrasonic has centimetre range and no vitals; WiFi CSI has vitals — there is
already a `breathing` rule keyed on it — and poor spatial precision. Neither
alone should be allowed to say *a person is at 2.4 m on that bearing*.
Corroborating, they can.

Keeping the arbitration in the fusion engine is not bureaucracy. It means the
sensor-level refusal survives the feature being added, and a deployment that
declines to run the fusion rule gets a range sensor rather than a people
detector.

### 6. The corpus is the most sensitive thing this project has ever held

A recording of a named person breathing in their own home, with LiDAR geometry
of that home attached, is not a range profile. RuField already prices this:
`breathing` is `privacy_max = "P4"` and `requires_consent = true`.

Three consequences, all structural:

- **The corpus never leaves the device underived.** Captures stay edge-local.
  What may cross a network is a detector's *parameters* and its *scores*, never
  a frame.
- **The egress profile cannot carry it anyway, and that is deliberate.** The
  coarse profile RuView egresses is 32 max-pooled bins — it structurally cannot
  represent breathing phase. The egress-safe representation and the
  presence-detecting representation are in direct tension by construction. That
  tension is the safety property, not an obstacle to route around.
- **Consent is per-capture and recorded in the capture.** Not a checkbox in an
  app's settings, not an assumption inherited from the room. A frame without a
  consent receipt is refused by the parser, in both directions, the same way
  `UltrasonicScan::load` refuses a trust-tier mismatch.

## Consequences

**The order of work is fixed by what can disprove the idea fastest.** Retaining
phase is unconditionally useful, so it goes first. Then the cheapest possible
experiment: a phone flat on a table, a person seated at two metres, and a
question — does a breathing line appear in that range bin? One afternoon,
go or no-go, before any corpus, any detector search, any fusion wiring.

**Most of this ADR describes a system that cannot be validated in this
repository.** The code can be written and unit-tested; the claim it exists to
support cannot be checked without hardware. So every artefact this ADR
authorises ships with the same label the rest of the project uses: measured
against a simulator, and therefore a prediction.

**The refusal does not move today.** No gate is relaxed, no `presence` key is
populated, and `gate_no_inferences_and_that_is_the_correct_outcome` continues to
pass. If this work succeeds, the gate that changes is a fusion rule's `inputs`
list — and it changes with a consent flag and a P4 ceiling attached.

## What this does not answer

- **Whether ARKit body anchors are available and accurate enough** to label
  "a person is in this scene at this bearing" without a human in the loop.
  Scene depth alone gives geometry, not personhood. Assumed, not verified.
- **Whether the phone's own transmit path is coherent enough** across a dwell.
  Output latency was shown to cancel for *ranging* (ADR-007) because it happens
  to the blast too. Phase coherence across tens of seconds is a stronger
  requirement and has not been demonstrated.
- **Whether a handheld operator can be compensated for at all**, or whether this
  is permanently a phone-on-a-table instrument.
- **The false-alarm rate against the honest adversary**, which is not a coat. It
  is a curtain over a radiator, an oscillating fan, a cat, and a washing machine
  two rooms away.
