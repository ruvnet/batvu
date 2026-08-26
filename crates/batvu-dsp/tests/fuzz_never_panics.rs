//! Adversarial-input fuzzing for the wasm surface.
//!
//! The ABI is the module's only contact with the outside world, and in the
//! browser that world includes a microphone stream which can hand us NaNs (a
//! glitched buffer), infinities (a broken resampler), all-zeros (a muted mic) or
//! full-scale garbage (an overdriven ADC). Nothing there may panic: a Rust panic
//! under `wasm32` with `panic = "abort"` traps the module, and the only recovery
//! is reloading the page — mid-scan.
//!
//! Modelled on `@metaharness/horizon`'s 20k-iteration never-panics fuzz over its
//! command classifier: same contract, different attack surface.

use batvu_dsp::abi::eval_json;
use batvu_dsp::cfar::{self, CfarConfig, CfarKind};
use batvu_dsp::chirp::ChirpSpec;
use batvu_dsp::pipeline::{Pipeline, SonarConfig};
use batvu_dsp::window::Window;

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        // splitmix64
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    /// Deliberately includes NaN, infinities, signed zeros, subnormals and
    /// magnitudes far outside anything an ADC could produce.
    fn f32_wild(&mut self) -> f32 {
        match self.next() % 16 {
            0 => f32::NAN,
            1 => f32::INFINITY,
            2 => f32::NEG_INFINITY,
            3 => 0.0,
            4 => -0.0,
            5 => f32::MIN_POSITIVE / 4.0,
            6 => 1e30,
            7 => -1e30,
            _ => (self.next() as i32 as f32) / (i32::MAX as f32),
        }
    }
    fn range(&mut self, lo: usize, hi: usize) -> usize {
        lo + (self.next() as usize) % (hi - lo).max(1)
    }
}

#[test]
fn the_pipeline_never_panics_on_hostile_samples() {
    let mut rng = Rng(0xBA7_1234_5678);
    for iter in 0..2_000 {
        let record_len = rng.range(64, 8_192);
        let spec = ChirpSpec {
            fs: 48_000.0,
            f0: 15_000.0 + (rng.next() % 5_000) as f32,
            f1: 20_500.0 + (rng.next() % 3_000) as f32,
            duration_s: 0.001 + (rng.next() % 20) as f32 * 0.001,
            tx_window: Window::Tukey,
            tukey_alpha: (rng.next() % 100) as f32 / 100.0,
            amplitude: (rng.next() % 100) as f32 / 100.0,
        };
        if spec.validate().is_some() {
            continue;
        }
        let cfg = SonarConfig::for_chirp(spec, Window::Hann);
        if cfg.validate().is_some() {
            continue;
        }
        let samples: Vec<f32> = (0..record_len).map(|_| rng.f32_wild()).collect();
        let mut p = Pipeline::new(cfg, record_len);
        let prof = p.process(&samples);
        // The contract is "does not panic". NaN inputs may legitimately produce
        // NaN envelope bins, but the STRUCTURE must stay sane.
        assert!(
            prof.env.len() <= record_len,
            "iter {iter}: oversized envelope"
        );
        assert!(prof.range_step_m > 0.0, "iter {iter}: bad range step");
        for d in &prof.detections {
            assert!(d.width_m >= 0.0, "iter {iter}: negative width");
        }
    }
}

#[test]
fn cfar_never_panics_on_hostile_envelopes() {
    let mut rng = Rng(0xC0FFEE);
    for _ in 0..4_000 {
        let n = rng.range(0, 512);
        let env: Vec<f32> = (0..n).map(|_| rng.f32_wild()).collect();
        let cfg = CfarConfig {
            kind: if rng.next() % 2 == 0 {
                CfarKind::CellAveraging
            } else {
                CfarKind::OrderedStatistic
            },
            train: rng.range(0, 200),
            guard: rng.range(0, 200),
            pfa: [0.0f32, 1e-12, 1e-4, 0.5, 1.0, f32::NAN][(rng.next() % 6) as usize],
            os_rank_frac: [-1.0f32, 0.0, 0.5, 1.0, 2.0, f32::NAN][(rng.next() % 6) as usize],
            min_threshold: [0.0f32, 1e-9, 1.0][(rng.next() % 3) as usize],
            merge_gap: rng.range(0, 64),
            min_prominence_db: [-10.0f32, 0.0, 6.0, 200.0][(rng.next() % 4) as usize],
        };
        let start = rng.range(0, n + 8);
        let dets = cfar::detect(&env, &cfg, start, None);
        for d in &dets {
            assert!(d.index >= 0.0, "negative detection index");
            assert!(d.end >= d.start, "inverted run");
        }
    }
}

#[test]
fn the_json_abi_never_panics_on_hostile_requests() {
    let corpus = [
        "",
        "{",
        "[]",
        "null",
        "0",
        r#""op""#,
        r#"{"op":null}"#,
        r#"{"op":"process"}"#,
        r#"{"op":"process","samples":null}"#,
        r#"{"op":"process","samples":[null,"x",{},[]]}"#,
        r#"{"op":"design","config":{"fs":0}}"#,
        r#"{"op":"design","config":{"fs":-1,"f0":-5,"f1":1e40}}"#,
        r#"{"op":"design","config":{"durationS":1e30}}"#,
        r#"{"op":"chirp","config":{"amplitude":99}}"#,
        r#"{"op":"simulate","scene":{"recordLen":999999999999}}"#,
        r#"{"op":"simulate","targets":[{"rangeM":-5},{"rangeM":1e30},{}]}"#,
        r#"{"op":"simulate","targets":"not an array"}"#,
        r#"{"op":"scenes","config":[]}"#,
        r#"{"op":"design","config":{"cfarTrain":0,"cfarGuard":999999}}"#,
        r#"{"op":"design","config":{"rxTaper":"no-such-window","cfarKind":"nope"}}"#,
    ];
    for src in corpus {
        let out = eval_json(src);
        assert!(!out.is_empty(), "empty response for {src:?}");
        // Every response must itself be parseable — a caller that trusts the
        // module should never have to guard against malformed JSON coming back.
        batvu_dsp::json::parse(&out)
            .unwrap_or_else(|e| panic!("bad response {out:?} for {src:?}: {e}"));
    }

    // ...and randomly mutated JSON, which is what a truncated fetch looks like.
    let mut rng = Rng(7);
    let seed = r#"{"op":"process","config":{"f0":18000,"f1":22000},"samples":[0.1,0.2,0.3]}"#;
    for _ in 0..2_000 {
        let mut bytes = seed.as_bytes().to_vec();
        for _ in 0..(rng.next() % 6 + 1) {
            let i = (rng.next() as usize) % bytes.len();
            bytes[i] = (rng.next() % 128) as u8;
        }
        if let Ok(src) = std::str::from_utf8(&bytes) {
            let out = eval_json(src);
            assert!(
                batvu_dsp::json::parse(&out).is_ok(),
                "unparseable response to {src:?}"
            );
        }
    }
}

#[test]
fn the_plan_abi_never_panics_on_hostile_handles() {
    use batvu_dsp::abi::{
        bv_plan_create, bv_plan_destroy, bv_plan_env_len, bv_plan_env_ptr, bv_plan_input_ptr,
        bv_plan_iq_len, bv_plan_iq_ptr, bv_plan_process, bv_plan_record_len,
    };
    for h in [-999i32, -1, 0, 1, 7, i32::MAX, i32::MIN] {
        let _ = bv_plan_record_len(h);
        let _ = bv_plan_env_len(h);
        let _ = bv_plan_input_ptr(h);
        let _ = bv_plan_env_ptr(h);
        let _ = bv_plan_iq_ptr(h);
        let _ = bv_plan_iq_len(h);
        let _ = bv_plan_process(h);
        bv_plan_destroy(h);
    }
    // Create, destroy twice, then keep using it.
    let cfg = r#"{"maxRangeM":4}"#;
    let h = bv_plan_create(cfg.as_ptr(), cfg.len(), 4096);
    assert!(h >= 0);
    bv_plan_destroy(h);
    bv_plan_destroy(h);
    assert_eq!(bv_plan_record_len(h), 0);
    let _ = bv_plan_process(h);
    assert!(bv_plan_iq_ptr(h).is_null());
    assert_eq!(bv_plan_iq_len(h), 0);
}

#[test]
fn the_complex_profile_never_panics_on_a_hostile_record() {
    // `CxProfiler::fill` recomputes the range gate and indexes the iq buffer
    // with arithmetic that is not the same arithmetic `Pipeline::process` ran.
    // Nothing else in the fuzz suite creates a plan that asks for phase, so
    // without this the whole second buffer is unreachable from here.
    use batvu_dsp::abi::{
        bv_plan_create, bv_plan_destroy, bv_plan_input_ptr, bv_plan_iq_len, bv_plan_iq_ptr,
        bv_plan_process,
    };
    let mut rng = Rng(0xC0FFEE);
    let configs = [
        r#"{"complexProfile":true}"#,
        r#"{"complexProfile":true,"minRangeM":0,"maxRangeM":50}"#,
        r#"{"complexProfile":true,"minRangeM":40,"maxRangeM":50}"#,
        r#"{"complexProfile":true,"blastCancellation":false,"minRangeM":0.01,"maxRangeM":0.05}"#,
    ];
    for cfg in configs {
        for record_len in [64usize, 1_000, 24_000] {
            let h = bv_plan_create(cfg.as_ptr(), cfg.len(), record_len);
            assert!(h >= 0, "{cfg} at {record_len}");
            let n = batvu_dsp::abi::bv_plan_record_len(h);
            for fill in 0..4 {
                unsafe {
                    let dst = std::slice::from_raw_parts_mut(bv_plan_input_ptr(h), n);
                    for (i, v) in dst.iter_mut().enumerate() {
                        *v = match fill {
                            0 => 0.0,
                            1 => f32::NAN,
                            2 => {
                                if i % 3 == 0 {
                                    f32::INFINITY
                                } else {
                                    1e30
                                }
                            }
                            _ => (rng.next() as f32 / u32::MAX as f32) * 2.0 - 1.0,
                        };
                    }
                }
                let _ = bv_plan_process(h);
                let len = bv_plan_iq_len(h);
                assert!(len > 0, "a plan that asked for phase must publish a buffer");
                let iq = unsafe { std::slice::from_raw_parts(bv_plan_iq_ptr(h), len) };
                // Non-finite samples are zeroed on the way in, so a non-finite
                // float here is the transform having been fed one anyway.
                assert!(
                    iq.iter().all(|v| v.is_finite()),
                    "{cfg} at {record_len}, fill {fill}: non-finite phase"
                );
            }
            bv_plan_destroy(h);
        }
    }
}
