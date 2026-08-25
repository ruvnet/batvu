//! # batvu-dsp — the sonar core of BatVu
//!
//! BatVu turns an iPhone into a crude bat: the speaker emits an ultrasonic
//! chirp, the microphone hears the room answer, and this crate turns that
//! answer into ranges. Everything above it — occupancy mapping, the bat-vision
//! renderer, the scan-session controller — is TypeScript. Everything that has
//! to be fast or has to be exactly reproducible lives here.
//!
//! ## Why Rust/WASM for this layer
//!
//! Same reasoning `@metaharness/horizon` gives for putting its halt reducer and
//! command classifier in Rust, applied to a different hot spot:
//!
//! * **It is the hot path.** A ping is an FFT pair over 32768 points plus a
//!   CFAR pass, twenty times a second, on a phone that is also driving a WebGL
//!   view. JavaScript can do it; it cannot do it while staying cool.
//! * **It must be bit-for-bit reproducible.** `@metaharness/flywheel` promotes a
//!   policy only if a *replayable* receipt says it beat the incumbent on a
//!   holdout and did not regress on a frozen anchor. That promise is empty if
//!   re-running the evaluation gives different numbers. A pure reducer over
//!   explicit state, with a seeded simulator and no wall clock, makes replay
//!   real rather than aspirational.
//! * **The same code must run in three places** — the browser (wasm), Node (wasm,
//!   for the flywheel and CI), and `cargo test` (native). One implementation,
//!   three hosts, no "the mobile version rounds differently" class of bug.
//!
//! Built the same way horizon's core is: `wasm32-unknown-unknown`, no
//! `wasm-bindgen`, no host imports, its own tiny JSON codec. The module parses
//! bytes, computes, and returns bytes.
//!
//! ## The pipeline
//!
//! ```text
//!   chirp ──▶ [speaker] ──▶ room ──▶ [mic] ──▶ matched filter ──▶ envelope
//!                                                   │
//!                            direct-path sync ◀─────┤
//!                                                   ▼
//!                                          CFAR ──▶ detections (metres)
//! ```
//!
//! ## Modules
//!
//! | module     | job |
//! |------------|-----|
//! | [`chirp`]  | LFM sweep synthesis, real and analytic; speed of sound; the design formulas |
//! | [`window`] | window functions in their two roles: transmit taper and range-sidelobe control |
//! | [`fft`]    | in-place radix-2 complex FFT with precomputed twiddles |
//! | [`matched`]| pulse compression against an analytic, band-tapered reference |
//! | [`cfar`]   | CA-/OS-CFAR detection with sub-sample peak interpolation |
//! | [`pipeline`]| the composed ping: samples in, ranges out, latency cancelled |
//! | [`sim`]    | a deterministic room-echo simulator — the ground truth for tests, benches and the flywheel |
//! | [`abi`]    | the wasm surface: a JSON control op and a raw-float plan for the hot path |
//! | [`json`]   | a dependency-free JSON codec so the module stays self-contained |
//!
//! ## Honest bounds
//!
//! One speaker and one microphone give **range only**. There is no beam and no
//! bearing: an echo at 2.4 m lies somewhere on a spherical cap, and nothing in
//! this crate pretends otherwise. Direction comes from *pointing the phone* and
//! fusing many range-only looks with device orientation, one layer up. Anything
//! that reads like a depth camera is the renderer's doing, not this crate's.

// `!(a > b)` instead of `a <= b` is DELIBERATE and load-bearing throughout this
// crate: with a NaN operand both comparisons are false, and the negated form is
// the one that stays correct. The fuzz suite found an infinite loop caused by
// writing it the way clippy prefers (see `cfar::find_runs`), so the lint is off
// crate-wide rather than silenced case by case and forgotten.
#![allow(clippy::neg_cmp_op_on_partial_ord)]

pub mod abi;
pub mod cfar;
pub mod chirp;
pub mod fft;
pub mod json;
pub mod matched;
pub mod pipeline;
pub mod sim;
pub mod window;

pub use cfar::{CfarConfig, CfarKind, Detection};
pub use chirp::{speed_of_sound, ChirpSpec};
pub use matched::MatchedFilter;
pub use pipeline::{
    design_report, DesignReport, Pipeline, RangeDetection, RangeProfile, SonarConfig,
};
pub use sim::{SceneConfig, Target};
pub use window::Window;

/// Crate version, surfaced through the ABI so a host can assert compatibility.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
