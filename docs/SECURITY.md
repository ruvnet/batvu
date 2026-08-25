# Security

BatVu is a page that drives a speaker and reads a microphone, and it now writes
files another system parses and trusts. Those are three different kinds of risk
and they are treated separately here.

Everything below came out of an adversarial review run against the integration
work: a reader whose brief was to find inputs that break things, given the
source of both sides. It found real defects, and they are recorded with what was
done about them rather than summarised as "hardening".

---

## 1. The thing that is physically dangerous

The only irreversible harm this project can do is **make a sound**. Not a data
breach — a speaker driven into the audible band, or driven hard, next to a child
or an animal that hears where an adult does not.

`classifyEmission` (ADR-013) is the guard. Two findings about it:

**It was not on the transmit path.** It was called in exactly one place: the
flywheel's simulated scorer. `AudioSession.start()` played whatever waveform it
was handed. Fixed in ADR-020 — the classification is now the first thing
`start()` does, before it even checks whether an audio session is open, so no
ordering of calls reaches the speaker without passing it.

**Four NaN inputs deleted checks rather than failing them.** Every comparison
against NaN is false, so `f0: NaN` erased both band checks, `fs: NaN` erased the
aliasing check, `tukeyAlpha: NaN` erased the taper gate, and `durationS:
Infinity` — a transmitter that never stops — came back `gate` because the
duty-cycle check skipped a non-finite duty. A leading finiteness sweep now
denies before any comparison runs. The full table is in ADR-020.

These are not exotic inputs. `@batvu/flywheel` mutates exactly these fields and
a division inside a proposer is all it takes.

**Still open, and stated rather than fixed:** the Rust core's
`ChirpSpec::validate` is a strictly weaker gate — it checks `fs > 0`, band
inside Nyquist, positive duration and amplitude in `[0, 1]`, and has **no
audible-band floor**. A config of `f0: 100, f1: 4000, amplitude: 1.0` builds a
plan and synthesises a full-scale 4 kHz siren. Nothing in this repository routes
such a config to a speaker — the wasm core never touches one — but any future
path that can influence `f0`, `f1` or `amplitude` must go through
`classifyEmission` first and must not rely on the core to refuse.

---

## 2. The parser, which reads files it did not write

`rufield-adapters::ultrasonic` parses `.ultrasonic.jsonl`. That file may arrive
from anywhere. The defences, each with a test naming the input it stops:

| attack | defence |
|---|---|
| A single line holding 100 M profile values | Line length capped at 256 KiB **before** `serde_json` sees the bytes. A cap applied after parsing has already allowed the allocation it was meant to prevent. |
| An unknown key wrapping 128 levels of nesting | `#[serde(deny_unknown_fields)]`. Combined with the pre-parse cap, nesting costs O(cap) rather than O(file). |
| `NaN` / `Infinity` in a profile bin | Rejected at parse. serde_json writes non-finite floats as JSON `null`, and `FieldTensor::validate` checks only shape and axis rank — so a NaN signs fine, verifies fine, and then fails to deserialize on the far side of the wire. The worst possible place to find it. |
| A negative amplitude | Rejected. A magnitude cannot be negative; that is corruption, not a quiet echo. |
| `"timestamp": 1e30` | Rejected. A float-to-int cast saturates in Rust, and `TrustVerifier`'s watermark only ever advances — one poisoned event permanently blocks every honest event from that device. |
| A repeated or decreasing timestamp | Rejected. Also enforced by the watermark downstream, but silently there. |
| A 10 M-line file | Capped at 100 000 pings, checked on every iteration. |
| Control characters in `device_id` | Rejected. Identifiers reach logs, filenames, a viewer UI, and a trust registry's map keys. |
| A `device_id` that changes midway | Rejected. One recording is one sensor; both the key binding and the replay watermark are keyed on it. |
| A detection at 40 m in a profile that ends at 5 m | Rejected as incoherent, rather than admitted into a fused map with no measurement behind it. |
| A file the emitter should never have written | The BatVu side restates every one of these bounds in `wire.ts` and checks them before writing. |

**A caller-side limit that is not the parser's job:** both this parser and
`csi_replay` take `text: &str`, so the whole file is in memory before parsing
begins. Any binary that reads a path must `metadata(path).len()` and refuse
above a hard cap before reading.

---

## 3. Provenance, and a weakness that is upstream's

`rufield_provenance::is_fusable` returns `true` for any event with
`synthetic: true`, with no signature required, and `TrustVerifier` delegates to
it in `TrustMode::Simulation`. An attacker who intercepts a signed event can
delete the signature, set `synthetic: true`, rewrite the tensor freely, and pass
simulation-mode verification.

This is documented upstream as a legacy compatibility helper, explicitly
superseded by `verify_and_record_at`, and it is not BatVu's to change. What
follows for anyone building on this:

- **Simulation trust authenticates nothing.** It is for simulator output and for
  nothing else.
- `CapturedReplay` and `Production` close it — `synthetic: true` is rejected
  outright, before any key lookup — which is exactly why choosing the mode is
  the whole defence.
- The refutation pass on this claim is worth reading: even in simulation mode
  the verifier is not *only* `is_fusable`. `validate_event_identity` and
  `check_replay` run around it in every mode, so a blank `device_id`, a repeated
  `event_id` or a non-advancing timestamp is still refused.

**Related, also upstream:** `verify_event` calls `VerifyingKey::from_bytes`
directly and never calls `is_weak()`, so it accepts small-order Ed25519 keys.
The crate has the correct check, in `verifying_key_from_hex`, which
`verify_event` does not use. Any code that treats a carried key as an authority
should normalise it through `normalize_verifying_key_hex` first.

---

## 4. Privacy, which here is a question about what leaves the room

A range profile is not a recording. It is the matched filter's output in a 3 kHz
band centred at 19 kHz; speech occupies 0.3–3.4 kHz and is rejected by the band
separation plus the full pulse-compression gain. It cannot carry intelligible
voice.

It is still the rawest thing the sensor produces, and RuField classifies the
analogous per-subcarrier CSI frame **P0**. Calling ours something gentler would
be special pleading, so:

| output | class | `Destination::Network` under the stock policy |
|---|---|---|
| full per-bin profile | P0 | **Deny** — edge-local only |
| 32-bin max-pooled reduction *(default)* | P1 | Allow |
| room signature (`@batvu/memory`) | P3 | anonymous aggregate of geometry |

The decision is expressed as a **data shape**, not a label. A consumer cannot
un-coarsen a coarse profile; it can ignore a label.

**P4 and P5 are structurally unreachable.** P5 requires
`observation.identity_evidence`, which `validate_evidence_at` restricts to
`Modality::BleAdvertisementRssi` — an ultrasonic event carrying it is a hard
validation failure. Nothing in the descriptor or the profile describes a person,
and the adapter deliberately never writes `breathing_band`, `posture_height`,
`transient` or `presence`.

**A trap to avoid:** `DefaultPrivacyGuard::authorize` returns `Allow` for P4/P5
on a network as soon as consent passes, overriding the P2 ceiling. There is no
consent story for a room scan, so any BatVu publisher must hard-code `consent =
false` and `identity_bound = false` and must never plumb a user- or
wire-supplied flag into them. A boolean reachable from outside is an
exfiltration switch.

**And a real leak elsewhere in the stack:** `rufield-viewer`'s privacy check
reads only `observation.privacy_class` and ignores `tensor.privacy_class` —
exactly the failure `DefaultPrivacyGuard::authorize_event`'s own doc comment
names. Always gate with `authorize_event`, which is conjunctive over both.

---

## 5. Browser-side resource limits

`RoomMemory.fromJSON` is a trust boundary: `localStorage` is writable by any
script on the origin, and a synced store is writable by whatever synced it. It
re-validates the version, the dimension, the entry count, every vector length
and every element's finiteness. A store that trusted its own serialised form
would accept a 40-million-element vector and hang the tab on the first recall.

`MAX_ENTRIES` (4096) bounds the linear scan. The scan is the right structure at
a person's scale — tens of standing spots, not millions — and the cap is what
stops that assumption from silently becoming false.

---

## Reporting

Open an issue at <https://github.com/ruvnet/batvu/issues>. There is no user data
to breach and no server to compromise; the interesting reports are about the
speaker, the parser, and anywhere a claim in this document is wrong.
