# ADR-002: A browser app with a Rust/WASM core, not a native app

**Status**: Accepted
**Date**: 2026-08-25
**Related**: ADR-015 (simulator), ADR-016 (submodules), ADR-018 (wasm ABI)

## Context

A native iOS app would be a better sonar. It gets 96 or 192 kHz capture (four
times the bandwidth), the iPhone's three-to-four element microphone array (actual
bearing, not inferred), ARKit visual-inertial pose (six degrees of freedom
instead of three), and an audio session it can configure precisely.

It also cannot be built, tested, or reviewed on a Linux CI runner, cannot be
opened from a link, and needs a developer account and a review cycle to reach
anyone.

## Decision

Ship a **web app for iOS Safari**, with the signal processing in **Rust compiled
to `wasm32-unknown-unknown`**.

The split follows one rule: anything that must be fast or must be exactly
reproducible goes in Rust; everything else is TypeScript.

- **Rust/WASM** (`crates/batvu-dsp`): chirp synthesis, matched filtering, CFAR,
  the room simulator. One implementation runs in three hosts — the browser, Node,
  and `cargo test` — so "the mobile build rounds differently" is not a class of
  bug that can exist here.
- **TypeScript** (`packages/*`): occupancy mapping, pose fusion, session control,
  the renderer, the flywheel. All of it Linux-testable.

The build shape is copied from `@metaharness/horizon`: no `wasm-bindgen`, no host
imports, a self-contained JSON codec, one entry point.

## Consequences

- **Everything but the transducer is CI-testable.** The end-to-end test drives
  the real app in headless Chromium against a simulated room (ADR-015), and the
  only substituted component is the microphone.
- **The performance ceiling is lower and it does not bind.** Scalar wasm on a
  phone runs one ping in a small fraction of the pulse interval — 49× headroom
  measured on desktop, an extrapolated 10–16× on a phone
  ([BENCHMARKS](../BENCHMARKS.md)). SIMD is available and has not been needed.
- **The platform fights back, and that cost is real.** `getUserMedia` defaults
  destroy the signal, `AudioContext` sample rate cannot be requested, and nothing
  will say when playback actually started (ADR-005). Those are documented in
  `packages/batvu-web/src/audio.ts` rather than discovered.
- **The wasm loader cannot assume Node.** `@metaharness/horizon`'s own loader
  reads `node:fs` at module scope, which makes it unbundleable for a browser;
  BatVu's takes bytes or a URL and guards the Node fallback behind a runtime
  check. The end-to-end test caught this exact failure during bring-up.
