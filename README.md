# BatVu

**An iPhone that pings the room in ultrasound and draws what comes back.**

Stand still. Sweep the phone across the room like a torch. Fifteen times a
second it emits a 17.5–20.5 kHz chirp you cannot hear, listens for the echo, and
paints the answer onto a plan-position display.

Part of the **ruview** spatial-intelligence effort. Built on
[`ruvnet/ultrasonic`](https://github.com/ruvnet/ultrasonic) for the band, and on
[`@metaharness/horizon`](https://github.com/ruvnet/metaharness/tree/main/packages/horizon)
and `@metaharness/flywheel` for scan control and policy evolution.

---

## What it actually is

A **short-range acoustic scanner**, not a depth camera. The distinction is the
whole design, so it goes first.

Your phone has one speaker and one microphone. That measures **range** — and
nothing else. An echo at 2.4 m is somewhere on a cone tens of degrees wide, and
the only direction information in the system is where the phone happened to be
pointing. Range is accurate to a few centimetres. Bearing at 3 m is blurry by
more than a metre. That is roughly a hundred to one, and it is why every echo is
drawn as an **arc** rather than a dot.

It is also why you have to sweep. One ping locates nothing. The map sharpens
where arcs from different directions cross — which is roughly what a bat gets
from turning its head, and it is the honest version of "seeing like a bat".

**Honest envelope:** about **0.6 m to 3.8 m** against hard flat surfaces —
ragged out to 4.3, nothing beyond — less against soft ones, with a realisable
range resolution of **9.6 cm**. That upper figure used to read "4–5 m"; it was
measured against a simulator giving away 26 dB in the near field
([ADR-022](docs/adr/ADR-022-near-field-dynamic-range.md)), and
`bench_detection_envelope` now measures where the link budget actually runs
out. It will not
see a black cat on a carpet. Below 0.6 m the outgoing pulse drowns everything
out, and the display shows that as a blind disc rather than as empty space.

A bat emits 130–140 dB SPL and hears with two ears and a pinna. A phone under
emission limits manages a fraction of that with one microphone. The gap is about
45 dB and two of the three bearing mechanisms.

> The emitted band is inaudible to most adults. **Children, dogs and cats hear
> it.** See [ADR-013](docs/adr/ADR-013-emission-guard.md).

---

## Try it

```bash
git clone --recurse-submodules https://github.com/ruvnet/batvu
cd batvu
npm install
npm run build          # cargo -> wasm32, tsc, esbuild
npm run web:dev        # http://localhost:8099
```

Open it on an iPhone over HTTPS (Safari will not grant a microphone otherwise),
tap **Listen**, and allow both prompts. Or tap **Demo room** anywhere, including
on a desktop — that runs the identical pipeline against a simulated room and
needs no microphone at all.

```bash
npm run test:rust   # 90 Rust tests, including a never-panics fuzz suite
npm test            # 146 TypeScript tests
npm run e2e         # the real app, in a real browser, against a simulated room
npm run bench       # per-stage timings against the pulse-repetition budget
npm run demo        # a scan session driven by horizon's halt controller
npm run flywheel    # evolve the sonar policy and verify the receipts
npm run artifacts   # rebuild artifacts/ — the evidence behind every number here
```

---

## How it works

```
   chirp ──▶ [speaker] ──▶ room ──▶ [mic] ──▶ matched filter ──▶ envelope
                                                    │
                             direct-path sync ◀─────┤   ADR-005
                             blast cancel     ◀─────┤   ADR-006
                                                    ▼
                                           CFAR ──▶ detections (metres)
                                                    │
                              device attitude ──────┤   ADR-011
                                                    ▼
                                    occupancy map ──▶ arcs on screen
```

Five decisions carry most of the weight:

**Pulse compression, because the speaker cannot be loud.** A 5 ms chirp swept
across 3 kHz compresses to a sharp range spike, buying 11.8 dB the amplitude
could not. ([ADR-003](docs/adr/ADR-003-the-waveform.md))

**The blast is the clock.** WebAudio will not say when the sound left the
speaker — output latency is an estimate, and 10 ms of it is 1.7 m of range. So
time is measured from the direct speaker-to-microphone arrival instead, and every
unknown latency subtracts out. Verified across 0 to 9311 samples of injected
latency: the reported range moves by under a centimetre. The pipeline's biggest
nuisance is its most useful signal.
([ADR-005](docs/adr/ADR-005-direct-path-timing.md))

**Evidence spreads across the cone.** A detection deposits across the whole beam,
and `occupiedThreshold` sits *above* the per-ping hit weight, so one wide-beam
ping can never declare a voxel occupied. Corroboration from a second attitude is
structurally required. ([ADR-010](docs/adr/ADR-010-inverse-sensor-model.md))

**Free space is the strong evidence.** "Nothing came back before 2.4 m" is
confident and direction-specific, and it is what carves away the false parts of
other pings' arcs. A silent ping is not a failure — it is how a scan proves a
doorway is a doorway.

**The scan stops for a reason.** `@metaharness/horizon`'s halt controller drives
it, with one inversion: `no-progress` is the *success* case. Three sweeps that
stop changing the map mean this vantage point is exhausted.
([ADR-012](docs/adr/ADR-012-halt-control.md))

---

## The packages

| | |
|---|---|
| `crates/batvu-dsp` | Rust → `wasm32-unknown-unknown`. Chirp synthesis, matched filter, CFAR, room simulator. No `wasm-bindgen`, no host imports — horizon's build shape |
| `@batvu/core` | wasm binding for browser and Node, pose fusion, inverse sensor model, occupancy grid, scoring |
| `@batvu/sim` | 3-D rooms, beam-cone ray casting, end-to-end scan synthesis — the ground truth |
| `@batvu/horizon` | Scan-session halt control, checkpoints, and the emission guard |
| `@batvu/flywheel` | Policy evolution with signed, replayable promotion receipts |
| `@batvu/field` | The scan on RuField MFS's wire — `.ultrasonic.jsonl`, and the `FieldEvent` it projects to |
| `@batvu/memory` | A heading-invariant room signature, and the store that answers "have I been here before?" |
| `@batvu/web` | The iPhone app. 28 KB of JavaScript, no framework |

Everything but the transducer runs on a Linux CI box, which is the point of
choosing a browser over a native app
([ADR-002](docs/adr/ADR-002-browser-and-wasm.md)).

---

## Freeze the physics, evolve the policy

The sonar's parameters are not obvious — whether a wider sweep beats a longer
pulse, whether ordered-statistic CFAR earns its sort in a cluttered room, where
the occupied threshold belongs. `@metaharness/flywheel` answers them empirically:
run, measure, mutate, verify, promote, with a frozen gate, a never-optimised
anchor suite, Ed25519 receipts and offline replay verification.

Picking the four score axes well is most of the work, and two of them were wrong
before they were right:

- `primary` was occupied IoU, and the deliberately **bad** policy beat the tuned
  one by smearing occupancy across a 120° arc in a room where everything at
  wall-range is wall. It is now free-space IoU plus dilated occupied F1, decided
  at fixed thresholds so a policy cannot lower its own bar.
- `noopRate` took three attempts. As a count of silent pings it punishes correct
  silence; as a **miss rate** it fights `primary` head-on, because a stricter
  detector maps better and misses more — measured, the gate rejected a change
  that raised `primary` by 90% and cut cost by two thirds. A miss is an *error*
  and belongs to `primary`; a no-op is an *abstention*, which for a scan means
  map volume left undecided.

Both times the gate refused to promote anything, and both times the honest fix
was the projection rather than the gate. With the axes right, the wheel climbs:

```
gen 0  primary 0.0580            anchor 0.0939
gen 1  primary 0.1259  +0.0679   anchor 0.1187   mapping
gen 2  primary 0.2112  +0.0853   anchor 0.2694   detector
gen 3  primary 0.2161  +0.0049   anchor 0.2741   waveform   <- never moved before
```

That last row is the interesting one. The `waveform` lever used to be the one the
frozen gate never promoted, and that was written down as a fact about the
waveform. It was a fact about the simulator: with the near-field link budget
corrected ([ADR-022](docs/adr/ADR-022-near-field-dynamic-range.md)) far returns
are genuinely marginal, bandwidth and taper start paying for themselves, and the
wheel now walks from a deliberately bad root to **17.5–20.5 kHz, 5 ms, full Hann**
— the operating point [ADR-003](docs/adr/ADR-003-the-waveform.md) and
[ADR-004](docs/adr/ADR-004-tapers.md) argue for by hand. An empirical search and
a physics argument arrived at the same place without either knowing about the
other.

([ADR-014](docs/adr/ADR-014-flywheel.md))

---

## Where it plugs in

BatVu is part of the **ruview** spatial-intelligence effort, which means the
interesting question is not what it measures but what else can read it.

**[RuField MFS](https://github.com/ruvnet/rufield)** is the schema several
ruvnet projects use for camera-free sensing. Its modality registry has had
`Ultrasonic` at code 7 since v0.1 with nothing implementing it. `@batvu/field`
writes `.ultrasonic.jsonl`; `UltrasonicReplayAdapter`
([rufield#11](https://github.com/ruvnet/rufield/pull/11)) parses it, signs it,
and hands `FieldEvent`s to a fusion engine. The same recording is a test fixture
in both repositories, so drift between the two fails a build rather than an
ingest.

Three decisions in that seam are worth stating, because each looked different
before the other side's source was read
([ADR-018](docs/adr/ADR-018-rufield-wire.md)):

- **The tensor is `[Range]`, not `[Angle, Range]`.** `FieldAxis::Angle` means
  angle-of-arrival bins — the output of an array that measured direction. One
  microphone measures none. The beam is a *pose*, and it rides in the sensor
  descriptor where a pose belongs.
- **BatVu writes a file; it does not POST.** RuView's `/api/field` and
  `/ws/field` are both GET — it produces field events, it does not ingest them.
  There was no endpoint to build a client for.
- **BatVu does not sign.** The signature is over serde's byte-exact rendering of
  a Rust struct. Reproducing that from JavaScript is the one part of this
  integration that could pass every test and still fail on a phone.

And an honest negative result, asserted in a test rather than papered over:
**with RuField's shipped rules, a BatVu scan produces no inferences at all.**
The adapter could set `presence` and light up the `person_present` rule. It does
not, because an echo at 2.4 m is a surface and one transducer pair cannot tell a
person from a coat on the back of a chair. RuField v0.1 has no predicate for
static geometry, and saying so is worth more than a demo that works for a reason
that is not true.

---

## Recognising a room, since it cannot localise in one

Orientation-only pose ([ADR-011](docs/adr/ADR-011-orientation-only-pose.md))
means the map is built in a frame whose azimuth zero is wherever the phone
happened to be pointing when the scan started. "I am at (3.2, 1.1) on the floor
plan" is not a sentence this sensor can produce, ever.

"I have been here before" is a different question, and it needs no global frame.
The unknown is *exactly* SO(2) about gravity — the accelerometer pins the other
two axes — so a descriptor invariant under that and nothing more discards no
measurement the phone already paid for. Bin the map into 8 elevation bands × 64
azimuth bins; a heading offset is a circular shift; the DFT shift theorem says a
circular shift multiplies each coefficient by a unit complex number, so the
**magnitude** spectrum is unchanged. Exactly.

```
worst same-room similarity, over a full turn of heading   0.9998
best different-room pair (corridor vs living room)        0.7784
                                              separation  0.2214
```

Measured on four simulator rooms
([`artifacts/memory/room-signature.json`](artifacts/memory/room-signature.json)).
Four rooms is not a population, which is why `recognize` gates on the *margin*
over the runner-up rather than on the similarity: every entry is non-negative,
so cosine has a high floor and unrelated rooms score well above 0.5. A query
that scores 0.96 against two stored places has been confused, not recognised.

([ADR-019](docs/adr/ADR-019-room-memory.md) has the maths, and the list of
things it cannot do — starting with the fact that it is not invariant to
translation, so the recognisable unit is a *standing spot*, not a room.)

---

## Performance

One ping — compress, detect, and fold into the map — costs **1.32 ms** of a
66.7 ms budget. The interesting part is where it started: 8.99 ms, of which the
DSP was 1.06 ms and the *map bookkeeping* was 7.8 ms, because reporting how much
had changed rescanned 1.7 million voxels twice per ping.

| | before | after |
|---|---:|---:|
| occupancy integrate | 8.01 ms | 0.23 ms |
| map signature | 7.15 ms | 0.000 ms |
| **one ping, end to end** | **8.99 ms** | **1.32 ms** |
| headroom in a 66.7 ms interval | 7× | **51×** |

The two integration stages are measured in the same report, and they answer
opposite questions:

| | | |
|---|---:|---|
| encode one ping to `.ultrasonic.jsonl` | 0.21 ms | fits alongside the DSP |
| project one ping to a `FieldEvent` | 0.01 ms | negligible |
| room signature over the whole grid | **7.67 ms** | **12% of a ping — end of scan only** |

That last row is why the room signature runs when a scan finishes and never
inside `pingWithBeam`. At fifteen pings a second on a phone it would be the most
expensive thing on the main thread — and there is nothing useful to say about a
room from a single ping anyway. Measuring it makes that a fact rather than an
assertion.

[BENCHMARKS.md](docs/BENCHMARKS.md) has the method and the caveats — these are
desktop x86 numbers and the phone figures are extrapolated.
[`artifacts/bench/latest.json`](artifacts/bench/latest.json) is the file they
come from.

---

## Documentation

- **[Architecture decisions](docs/adr/)** — 22 records. The nine that were
  reversed mid-build are listed first, because in each case the first version
  looked right.
- **[Security](docs/SECURITY.md)** — the threat model, and the three real defects
  an adversarial review found: an emission guard that was not on the transmit
  path, four NaN inputs that deleted checks rather than failing them, and a
  time-origin search that let noise choose the pose tag.
- **[Research dossier](docs/research/RESEARCH-DOSSIER.md)** — a seven-lens
  research swarm with an adversarial verification pass: 167 claims, 56 refuted or
  corrected before they reached the design. Where the dossier and the ADRs
  disagree, the ADR says which measurement settled it.
- **[Benchmarks](docs/BENCHMARKS.md)**
- **[`artifacts/`](artifacts/)** — the evidence. Every number quoted above has a
  file that produced it, the command that wrote it, and a SHA-256 in
  [`MANIFEST.json`](artifacts/MANIFEST.json). It is committed, so a regression is
  a diff rather than a memory.

---

## What would make this substantially better

All three require leaving the browser, and all three are out of scope
([ADR-001](docs/adr/ADR-001-what-batvu-is.md)):

- **96/192 kHz capture** — four times the bandwidth, so centimetre range cells.
- **The iPhone's real microphone array** — three or four elements means actual
  bearing instead of inferred bearing, which is the single biggest limitation
  here.
- **ARKit visual-inertial pose** — six degrees of freedom, so you could walk
  around the room instead of standing still.

Nearer-term, inside the browser, and reordered by an adversarial review that
disagreed with the previous ranking:

1. **Keep the complex compressed profile.** It is computed and then thrown away
   at the last line of the hot path — every stage downstream sees magnitudes
   only. That one discard forecloses Doppler, moving-target indication, coherent
   blast cancellation and micro-motion sensing, which is where every
   high-performance phone-acoustic system of the last decade lives. Retaining it
   costs no extra transform; the data is already in the buffers.
2. **Shorten the record.** 284 ms of capture for a 29 ms analysis window exists
   because of a 250 ms latency headroom that made sense for a one-shot
   acquisition. A record just longer than one pulse repetition interval bounds
   the blast ambiguity ([ADR-021](docs/adr/ADR-021-which-blast.md)) to two
   candidates *and* cuts the FFT cost.
3. ~~**Fix the simulator's near-field dynamic range.**~~ Done —
   [ADR-022](docs/adr/ADR-022-near-field-dynamic-range.md). It understated the
   blast-to-echo ratio by 26.9 dB. The remaining open question there is whether
   `absorption_db_per_m` should be ~0.52 rather than 0.8, which needs ISO 9613-1
   computed properly for the band.

And still, above all of them: **a real-hardware measurement campaign.** Every
number here is from a simulator that agrees with the physical model by
construction, and [ADR-021](docs/adr/ADR-021-which-blast.md) is what that costs —
a correctness bug that lived in the one failure mode the ground truth does not
model.

---

## License

MIT © rUv
