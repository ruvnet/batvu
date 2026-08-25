# artifacts/

The evidence. Every number quoted in the README or an ADR was produced by
something, and this is that something — committed, so a reader can check a claim
without installing a Rust toolchain, a wasm target and a headless Chromium, and
so a regression is a diff rather than a memory.

[`MANIFEST.json`](MANIFEST.json) carries, for each file, the command that
produced it, a note on what it is and is not, and a SHA-256 of the bytes as
committed.

| | what it is | produced by |
|---|---|---|
| [`bench/latest.json`](bench/latest.json) | per-stage timings against the 66.7 ms pulse-repetition budget | `npm run bench` |
| [`e2e/e2e-report.json`](e2e/e2e-report.json) | 20 checks of the real app in a real browser, each with its observed value | `npm run e2e` |
| [`e2e/batvu-demo-scan.png`](e2e/batvu-demo-scan.png) | what the plan-position display actually drew | `npm run e2e` |
| [`flywheel/replay-bundle.json`](flywheel/replay-bundle.json) | Ed25519 promotion receipts and the gate fingerprint | `npm run flywheel` |
| [`field/scan.ultrasonic.jsonl`](field/scan.ultrasonic.jsonl) | 72 pings of the living-room scene on the BatVu → RuField wire | `npm run artifacts` |
| [`field/field-event.sample.json`](field/field-event.sample.json) | one ping projected into a `rufield_core::FieldEvent` | `npm run artifacts` |
| [`memory/room-signature.json`](memory/room-signature.json) | the same room at five headings, four other rooms, and the separation between them | `npm run artifacts` |

## Reproducibility

The **generated** files — everything under `field/` and `memory/` — are
byte-reproducible. They use a fixed seed and a fixed start timestamp rather than
a wall clock, precisely so that re-running the script produces identical hashes
and a real change shows up as a diff. Running `npm run artifacts` twice in a row
should leave the working tree clean.

The **collected** files carry the timings and the pixel output of the machine
that produced them, so their hashes will differ on yours. That is what they are
for: `bench/latest.json` from a phone and from a CI runner are different facts,
and averaging them would destroy both.

To rebuild everything:

```bash
npm run build && npm run bench && npm run e2e && npm run flywheel && npm run artifacts
```

## The one that is also a test fixture

`field/scan.ultrasonic.jsonl` is copied verbatim into
[`ruvnet/rufield`](https://github.com/ruvnet/rufield) as
`crates/rufield-adapters/tests/fixtures/batvu_living_room.ultrasonic.jsonl`,
where the Rust adapter parses it and asserts the resulting events validate, sign,
verify, pass trust and clear the privacy guard.

That makes it the integration's only cross-language conformance check. If BatVu's
TypeScript emitter and rufield's Rust parser ever disagree about the schema, a
build fails in one repository or the other — rather than an ingest failing in a
deployment, months later, with the phone gone and the room changed.

## What none of this proves

Every one of these files describes a **simulator**. The room is a set of
axis-aligned boxes, the acoustics agree with the physical model by construction,
and no BatVu measurement has yet been taken with a real phone in a real room.
[ADR-021](../docs/adr/ADR-021-which-blast.md) is what that costs: a correctness
bug that lived, undetected by every artifact here, in the one failure mode the
ground truth does not model.
