# ADR-016: Vendor ruvnet/ultrasonic and ruvnet/metaharness as git submodules

**Status**: Accepted
**Date**: 2026-08-25
**Related**: ADR-012 (horizon), ADR-014 (flywheel)

## Context

BatVu builds on two sibling projects, and the two relationships are different.

`@metaharness/horizon` and `@metaharness/flywheel` are consumed as **npm
dependencies** — that is what they are for. But `@metaharness/horizon@0.2.0`
ships `dist` and **not** its `wasm/` directory: the package's `files` field lists
`wasm`, but the directory is a build artifact and is absent from the published
tarball. `HorizonCore.load()` from the installed package throws `ENOENT`, so the
halt controller — the whole point of ADR-012 — cannot be constructed.

`ruvnet/ultrasonic` is not a dependency at all. It is prior art in the same band
by the same author, and the useful thing about it is its *parameters*: its
encoder pins the usable ultrasonic band at 18.5/19.5 kHz FSK at 48 kHz sampling,
which is an independent measurement of where a phone's transducers actually work.

## Decision

Both are **git submodules under `vendor/`**, shallow, pinned by commit.

- **`vendor/metaharness` is load-bearing.** `scripts/build-wasm.mjs` builds
  `packages/horizon/crate` for `wasm32-unknown-unknown` from the pinned commit and
  stages it where `@batvu/horizon` looks. `HorizonCore.load(path)` takes an
  explicit path, so the installed npm package supplies the TypeScript and the
  submodule supplies the artifact it forgot. Same version, same code, reproducible
  from the lockfile plus the submodule SHA.
- **`vendor/ultrasonic` is reference.** Nothing imports it. It is checked out so
  its band constants can be cited and compared rather than paraphrased, and so
  the two projects can be shown to agree about the hardware.

The build script degrades gracefully: a missing submodule warns and says exactly
which command fixes it, rather than failing with a path error.

## Consequences

- CI must clone with `submodules: recursive`, and the workflow says why in a
  comment so nobody removes it as boilerplate.
- The horizon wasm is built from source on every CI run — a few seconds, and it
  pulls the toolchain that repo pins. Acceptable for the artifact it produces.
- If a future `@metaharness/horizon` publishes its `wasm/`, the submodule stops
  being load-bearing and `loadHorizonCore()` can fall back to the package
  default. The path parameter already allows it.
- Vendoring a whole repository for reference is heavier than copying six
  constants into a comment. It is also the only version that stays honest when
  the upstream numbers change.
