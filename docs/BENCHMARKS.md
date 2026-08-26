# Benchmarks

`npm run bench` — results land in `bench/results/latest.json`, and
`npm run artifacts` copies them to
[`artifacts/bench/latest.json`](../artifacts/bench/latest.json) with a SHA-256,
so a number quoted anywhere in this repository has a file behind it.

## The number that matters

Not "how fast is the FFT". The question is whether one ping's **complete** work —
compress, detect, and fold into the map — finishes inside the pulse repetition
interval, on a phone, while that same phone is drawing at 60 fps and staying cool
enough to hold.

At the shipped 15 Hz that interval is **66.7 ms**. A desktop x86 core runs
scalar wasm roughly 3–5× faster than an iPhone, so the desktop target is a tenth
of the interval — **6.7 ms** — which leaves an order of magnitude for the phone,
the renderer and thermal throttling.

Stages are timed separately, because a total tells you there is a problem and
never which one. Medians, not means: a mean is a measurement of the garbage
collector.

## Where the time went

The first run said something surprising.

| stage | before | after | |
|---|---:|---:|---|
| dsp: compress + detect (wasm) | 1.06 ms | **0.75 ms** | fewer detections to process after ADR-022 |
| map: occupancy integrate (JS) | 8.01 ms | **0.27 ms** | 29× |
| map: state signature (JS) | 7.15 ms | **0.000 ms** | O(n) → O(1) |
| map: occupied count (JS) | 3.90 ms | **0.000 ms** | O(n) → O(1) |
| **END TO END: one ping** | **8.99 ms** | **1.32 ms** | **6.8×** |
| headroom in a 66.7 ms interval | 7× | **51×** | |

The sonar was never the problem. The DSP — a 32k-point FFT pair, a matched
filter and a CFAR pass — cost 1 ms. The occupancy map cost **eight times that**,
and every millisecond of it was bookkeeping: `integrate()` called
`occupiedCount()` twice per ping to report how much had changed, and each call
scanned all 1.7 million voxels. Two full scans, 7.8 of the 8.0 ms, to compute
two integers.

Maintaining the statistics on write instead makes them O(1). The occupied count
and the known count are plain counters updated when a cell crosses a threshold.
The signature is the interesting one: it had to become an **order-independent**
sum of per-cell hashes so a cell's old contribution can be subtracted and its new
one added, where the original sequential FNV-1a had to be recomputed from
scratch. That is a real trade — an order-independent sum collides at roughly
2⁻³², and a collision would read as "no progress" for one sweep — and
`OccupancyGrid.recount()` exists so a test can assert the incremental values
still track the O(n) truth exactly, including across the clamp boundaries where
a naive increment double-counts.

## The integration stages, and where each of them belongs

Two of these are per-ping work and one is emphatically not. Measuring all three
in the same report is what turns that from an assertion into a fact.

| stage | cost | % of a ping | where it runs |
|---|---:|---:|---|
| `field: encode one ping to .ultrasonic.jsonl` | 0.217 ms | 0.3% | per ping, alongside the DSP |
| `field: project one ping to a FieldEvent` | 0.013 ms | 0.0% | per ping |
| `memory: room signature over the whole grid` | **7.666 ms** | **11.5%** | **end of scan only** |

The room signature is a full 1.7 M-voxel pass. On a phone that is 25–40 ms, so
running it per ping would make it the most expensive thing on the main thread by
a wide margin — and there is nothing useful to say about a room from a single
ping anyway. `roomSignature`'s own doc comment says so, and this row is why.

Encoding, by contrast, is cheap enough to run inside the ping loop with two
orders of magnitude to spare, which is what makes recording a live scan to
RuField's wire a real option rather than a batch job.

## What is still slow, and why that is fine

| stage | cost | who pays |
|---|---:|---|
| `map: occupied points` | 4.2 ms | only a point-cloud renderer, never the per-frame path — the app draws arcs from the detection list |
| `sim: render one record` | 4.3 ms | only CI and the flywheel; a phone never runs the simulator |

Both are full-grid or full-scene work with no per-ping caller. Optimising them
would buy nothing a user could feel.

## Reading the output

```
  dsp: compress + detect (wasm)         0.750 ms   p95   0.809 ms     1.1% of a ping
  END TO END: one ping, DSP + map       1.316 ms   p95   1.599 ms     2.0% of a ping
```

`p95` is there because the median says what a typical ping costs and p95 says
what the worst one costs — and the worst one is the frame a user perceives as a
stutter.

The run fails if the end-to-end median exceeds the desktop target, so a
regression is a red build rather than a slow phone six months later.

## Caveats worth stating

- These are **desktop x86** numbers from a CI-class machine. The phone figures
  are extrapolated, not measured, and the extrapolation factor (3–5×) is a rule
  of thumb. Real iPhone measurement is on the list in
  [`docs/research/RESEARCH-DOSSIER.md`](research/RESEARCH-DOSSIER.md) §11.
- The DSP timing is wasm compiled for `wasm32-unknown-unknown` **without SIMD**.
  `+simd128` is available and untried; the headroom means it has not been needed.
- Nothing here measures battery or thermal behaviour, which for a sustained scan
  may bind well before compute does.
- **The detection numbers moved under this file's feet once already.**
  [ADR-022](adr/ADR-022-near-field-dynamic-range.md) corrected a 26.9 dB error in
  the simulator's near-field dynamic range, which shrank the working range from a
  claimed 4–5 m to a measured 3.8 m and made the DSP stage *faster*, because
  there are fewer detections to process. Timings in this file are robust to that
  sort of change; anything about detection quality is not, and
  `bench_detection_envelope` (`npm run bench:rust`) is where the link budget is
  now measured rather than assumed.
- **None of this measures the thing that actually broke.**
  [ADR-021](adr/ADR-021-which-blast.md) documents a correctness bug on the live
  path that every benchmark, every test and the whole end-to-end run were
  structurally incapable of exhibiting, because the simulator renders one
  transmit blast per record and a real microphone ring contains four. A green
  benchmark says the work fits in the budget. It says nothing about whether the
  work is right.
