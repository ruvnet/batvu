# Benchmarks

`npm run bench` — results land in `bench/results/latest.json`.

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
| dsp: compress + detect (wasm) | 1.06 ms | 1.06 ms | unchanged |
| map: occupancy integrate (JS) | 8.01 ms | **0.27 ms** | 29× |
| map: state signature (JS) | 7.15 ms | **0.000 ms** | O(n) → O(1) |
| map: occupied count (JS) | 3.90 ms | **0.000 ms** | O(n) → O(1) |
| **END TO END: one ping** | **8.99 ms** | **1.35 ms** | **6.7×** |
| headroom in a 66.7 ms interval | 7× | **49×** | |

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

## What is still slow, and why that is fine

| stage | cost | who pays |
|---|---:|---|
| `map: occupied points` | 5.4 ms | only a point-cloud renderer, never the per-frame path — the app draws arcs from the detection list |
| `sim: render one record` | 5.0 ms | only CI and the flywheel; a phone never runs the simulator |

Both are full-grid or full-scene work with no per-ping caller. Optimising them
would buy nothing a user could feel.

## Reading the output

```
  dsp: compress + detect (wasm)         1.056 ms   p95   1.263 ms     1.6% of a ping
  END TO END: one ping, DSP + map       1.352 ms   p95   1.629 ms     2.0% of a ping
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
