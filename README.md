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

**Honest envelope:** about **0.6 m to 4–5 m** against hard flat surfaces, less
against soft ones, with a realisable range resolution of **9.6 cm**. It will not
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
npm run test:rust   # 88 Rust tests, including a never-panics fuzz suite
npm test            # 106 TypeScript tests
npm run e2e         # the real app, in a real browser, against a simulated room
npm run bench       # per-stage timings against the pulse-repetition budget
npm run demo        # a scan session driven by horizon's halt controller
npm run flywheel    # evolve the sonar policy and verify the receipts
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
| `@batvu/web` | The iPhone app. 25 KB of JavaScript, no framework |

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
gen 0  primary 0.0564            anchor 0.0522
gen 1  primary 0.1437  +0.0873   anchor 0.1742
gen 2  primary 0.2420  +0.0983   anchor 0.3398   <- never optimised against
```

([ADR-014](docs/adr/ADR-014-flywheel.md))

---

## Performance

One ping — compress, detect, and fold into the map — costs **1.35 ms** of a
66.7 ms budget. The interesting part is where it started: 8.99 ms, of which the
DSP was 1.06 ms and the *map bookkeeping* was 7.8 ms, because reporting how much
had changed rescanned 1.7 million voxels twice per ping.

| | before | after |
|---|---:|---:|
| occupancy integrate | 8.01 ms | 0.27 ms |
| map signature | 7.15 ms | 0.000 ms |
| **one ping, end to end** | **8.99 ms** | **1.35 ms** |
| headroom in a 66.7 ms interval | 7× | **49×** |

[BENCHMARKS.md](docs/BENCHMARKS.md) has the method and the caveats — these are
desktop x86 numbers and the phone figures are extrapolated.

---

## Documentation

- **[Architecture decisions](docs/adr/)** — 17 records. The five that were
  reversed mid-build are listed first, because in each case the first version
  looked right.
- **[Research dossier](docs/research/RESEARCH-DOSSIER.md)** — a seven-lens
  research swarm with an adversarial verification pass: 167 claims, 56 refuted or
  corrected before they reached the design. Where the dossier and the ADRs
  disagree, the ADR says which measurement settled it.
- **[Benchmarks](docs/BENCHMARKS.md)**

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

Nearer-term, inside the browser: sub-sample fractional-delay blast cancellation
(20–35 dB instead of the current ~10–20), walk detection that invalidates a scan
rather than silently corrupting it, and a real-hardware measurement campaign to
replace the extrapolated numbers.

---

## License

MIT © rUv
