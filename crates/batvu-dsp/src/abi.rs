//! The wasm32 ABI.
//!
//! Two surfaces, because sonar has two very different traffic patterns:
//!
//! **1. A JSON control surface** — `bv_eval(json) -> json`, dispatching on `op`,
//! exactly the shape `@metaharness/horizon`'s core uses. Design reports, waveform
//! generation, scene rendering, one-shot processing. Low rate, rich structure,
//! and cheap to keep honest.
//!
//! **2. A raw-float plan surface** for the hot path. Marshalling 24 000 floats
//! through JSON twenty times a second would cost more than the FFT it feeds.
//! Instead a *plan* is created once (it owns the transform, the reference
//! spectrum and its scratch buffers), the host writes samples straight into the
//! plan's input buffer inside wasm memory, and `bv_plan_process` leaves the
//! envelope in wasm memory for the host to view as a `Float32Array` with no copy
//! at all. Only the handful of detections come back as JSON.
//!
//! No `wasm-bindgen`, no host imports, no ambient authority — the module parses
//! bytes, computes, and returns bytes.
//!
//! ## Memory-growth contract (read this before writing a host binding)
//!
//! `bv_alloc` and `bv_plan_create` may grow wasm memory, which **detaches every
//! existing JS typed-array view**. Hosts must therefore re-read `memory.buffer`
//! after any allocating call. `bv_plan_process` allocates nothing, so a view
//! taken after `bv_plan_create` stays valid across every ping of that plan.
//!
//! That contract is why the complex profile (`bv_plan_iq_ptr`) is requested in
//! the plan's config rather than switched on later: turning it on mid-scan would
//! have to allocate, which would detach the envelope view the caller is already
//! holding. Asked for at creation, it costs one more buffer in the same growth
//! and one more view to take at the same moment.
//!
//! The packed return buffer is a single reusable slab: the bytes are valid until
//! the *next* call into the module. Copy them out before calling again.

use std::cell::RefCell;

use crate::cfar::{CfarConfig, CfarKind};
use crate::chirp::{self, ChirpSpec};
use crate::json::{self, Value};
use crate::matched::MatchedFilter;
use crate::pipeline::{self, Pipeline, RangeProfile, SonarConfig};
use crate::sim::{self, Breathing, SceneConfig, Target};
use crate::window::Window;

pub const ABI_VERSION: u32 = 1;

thread_local! {
    /// Scratch for host->module byte transfers.
    static ARENA: RefCell<Vec<Vec<u8>>> = const { RefCell::new(Vec::new()) };
    /// The single reusable packed-return slab.
    static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    /// Live plans. Slots are never compacted so handles stay stable.
    static PLANS: RefCell<Vec<Option<Plan>>> = const { RefCell::new(Vec::new()) };
}

struct Plan {
    pipeline: Pipeline,
    input: Vec<f32>,
    env: Vec<f32>,
    /// Present only when the config asked for `"complexProfile": true`.
    cx: Option<CxProfiler>,
}

/// The coherent sibling of the envelope buffer: the same range bins, carrying
/// `(re, im)` instead of `|.|` (ADR-023 §1).
///
/// Two costs, stated rather than buried. It runs the matched filter a SECOND
/// time over the same record, because `Pipeline` owns its filter privately and
/// the compressed record dies inside `process()`; a plan that asks for phase
/// therefore pays two FFT pairs per ping instead of one. And it recomputes the
/// range gate `process()` has already computed, so that `iq[2*i]` describes the
/// same bin as `env[i]` — arithmetic that now exists in two places and can drift.
///
/// One thing the two buffers do NOT share, and a host must not assume they do:
/// `env` has had the direct-path blast's autocorrelation skirt subtracted from
/// it when `blastCancellation` is on, and `iq` has not, so within the blast's
/// reach `|iq[i]|` is the larger of the two. That subtraction is an
/// envelope-domain approximation — it cannot cancel to zero precisely because it
/// has no phase to work with — and doing it coherently instead is one of the
/// things retaining phase is for. Until that exists, `iq` is the raw compressed
/// record and this comment is the warning label.
///
/// TODO(ADR-023): fold the complex path into `Pipeline::process` — one
/// compression, one gate, one buffer — once there is a consumer for it. It is
/// out here for now so that the magnitude pipeline, which every current caller
/// uses and no current caller needs phase for, pays exactly nothing.
struct CxProfiler {
    mf: MatchedFilter,
    /// Finite-sanitised copy of the record. `Pipeline::process` sanitises into
    /// its own private scratch, which we cannot see, and one non-finite sample
    /// poisons every bin of an FFT — skipping this would hand back a garbage
    /// phase profile beside a perfectly good envelope, on exactly the glitched
    /// frames a caller is least likely to be checking.
    sane: Vec<f32>,
    /// `2 * bins` floats: `(re, im)` per range bin, interleaved.
    iq: Vec<f32>,
}

impl CxProfiler {
    fn new(cfg: &SonarConfig, record_len: usize, bins: usize) -> CxProfiler {
        CxProfiler {
            mf: MatchedFilter::new(&cfg.chirp, record_len, cfg.rx_taper),
            sane: vec![0.0f32; record_len],
            iq: vec![0.0f32; 2 * bins],
        }
    }

    /// Fill `iq` for the profile `process()` just returned. `t0` and `bins` come
    /// from that profile, which is what ties the two buffers to the same lags.
    fn fill(&mut self, cfg: &SonarConfig, x: &[f32], t0: f32, bins: usize) {
        let take = x.len().min(self.sane.len());
        for (slot, &v) in self.sane[..take].iter_mut().zip(&x[..take]) {
            *slot = if v.is_finite() { v } else { 0.0 };
        }
        for v in &mut self.sane[take..] {
            *v = 0.0;
        }
        // The gate `Pipeline::process` applies to the envelope, applied again.
        let lo = (t0 + cfg.lag_for_range(cfg.min_range_m)).floor().max(0.0) as usize;
        let n = (2 * bins).min(self.iq.len());
        self.mf
            .complex_profile(&self.sane[..take], lo, &mut self.iq[..n]);
        // A short profile must not leave the previous ping's phase visible in
        // the tail of a view the host reads in full.
        for v in &mut self.iq[n..] {
            *v = 0.0;
        }
    }
}

// ────────────────────────────────────────────────────── memory management ──

/// Allocate `n` bytes inside wasm memory and return a pointer the host can
/// write into. MAY GROW MEMORY — re-read `memory.buffer` afterwards.
///
/// # Safety
/// The returned pointer is valid until `bv_free` is called with it.
#[no_mangle]
pub extern "C" fn bv_alloc(n: usize) -> *mut u8 {
    ARENA.with(|a| {
        let mut a = a.borrow_mut();
        a.push(vec![0u8; n]);
        a.last_mut()
            .map(|v| v.as_mut_ptr())
            .unwrap_or(std::ptr::null_mut())
    })
}

/// Release a buffer previously handed out by `bv_alloc`.
#[no_mangle]
pub extern "C" fn bv_free(ptr: *mut u8) {
    ARENA.with(|a| {
        let mut a = a.borrow_mut();
        if let Some(i) = a.iter().position(|v| std::ptr::eq(v.as_ptr(), ptr)) {
            a.swap_remove(i);
        }
    });
}

/// Pack a string as `[u32 little-endian length][utf8 bytes]` into the reusable
/// slab and return its pointer.
fn pack(s: &str) -> *const u8 {
    OUT.with(|o| {
        let mut o = o.borrow_mut();
        o.clear();
        o.extend_from_slice(&(s.len() as u32).to_le_bytes());
        o.extend_from_slice(s.as_bytes());
        o.as_ptr()
    })
}

fn read_str(ptr: *const u8, len: usize) -> Result<String, String> {
    if ptr.is_null() {
        return Err("null request pointer".into());
    }
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    std::str::from_utf8(bytes)
        .map(|s| s.to_string())
        .map_err(|_| "request is not utf-8".into())
}

// ──────────────────────────────────────────────────────── config decoding ──

pub fn sonar_config_from_json(v: &Value) -> SonarConfig {
    let d = SonarConfig::default();
    let chirp = ChirpSpec {
        fs: v.f32_or("fs", d.chirp.fs),
        f0: v.f32_or("f0", d.chirp.f0),
        f1: v.f32_or("f1", d.chirp.f1),
        duration_s: v.f32_or("durationS", d.chirp.duration_s),
        tx_window: Window::from_name(v.str_or("txWindow", d.chirp.tx_window.name())),
        tukey_alpha: v.f32_or("tukeyAlpha", d.chirp.tukey_alpha),
        amplitude: v.f32_or("amplitude", d.chirp.amplitude),
    };
    let rx_taper = Window::from_name(v.str_or("rxTaper", d.rx_taper.name()));
    // CFAR windows default to whatever the *requested* waveform needs, not to
    // whatever the default waveform needed — a caller who widens the sweep
    // should not silently inherit a guard band sized for the old one.
    let auto = CfarConfig::sized_for(&chirp, rx_taper);
    let cfar = CfarConfig {
        kind: CfarKind::from_name(v.str_or("cfarKind", auto.kind.name())),
        train: v.usize_or("cfarTrain", auto.train).max(1),
        guard: v.usize_or("cfarGuard", auto.guard),
        pfa: v.f32_or("cfarPfa", auto.pfa),
        os_rank_frac: v.f32_or("cfarOsRankFrac", auto.os_rank_frac),
        min_threshold: v.f32_or("cfarMinThreshold", auto.min_threshold),
        merge_gap: v.usize_or("cfarMergeGap", auto.merge_gap),
        min_prominence_db: v.f32_or("cfarMinProminenceDb", auto.min_prominence_db),
    };
    SonarConfig {
        chirp,
        rx_taper,
        cfar,
        temperature_c: v.f32_or("temperatureC", d.temperature_c),
        speaker_mic_sep_m: v.f32_or("speakerMicSepM", d.speaker_mic_sep_m),
        min_range_m: v.f32_or("minRangeM", d.min_range_m),
        max_range_m: v.f32_or("maxRangeM", d.max_range_m),
        sync_to_direct_path: v.bool_or("syncToDirectPath", d.sync_to_direct_path),
        direct_search_s: v.f32_or("directSearchS", d.direct_search_s),
        min_snr_db: v.f32_or("minSnrDb", d.min_snr_db),
        blast_cancellation: v.bool_or("blastCancellation", d.blast_cancellation),
        pri_samples: v.usize_or("priSamples", d.pri_samples),
    }
}

pub fn scene_config_from_json(v: &Value) -> SceneConfig {
    let d = SceneConfig::default();
    SceneConfig {
        temperature_c: v.f32_or("temperatureC", d.temperature_c),
        absorption_db_per_m: v.f32_or("absorptionDbPerM", d.absorption_db_per_m),
        speaker_mic_sep_m: v.f32_or("speakerMicSepM", d.speaker_mic_sep_m),
        direct_path_gain: v.f32_or("directPathGain", d.direct_path_gain),
        noise_rms: v.f32_or("noiseRms", d.noise_rms),
        latency_samples: v.usize_or("latencySamples", d.latency_samples),
        record_len: v.usize_or("recordLen", d.record_len).clamp(64, 1 << 20),
        seed: v.f32_or("seed", d.seed as f32) as u32,
        clip: v.bool_or("clip", d.clip),
    }
}

fn targets_from_json(v: Option<&Value>) -> Vec<Target> {
    v.and_then(|t| t.as_arr())
        .map(|arr| {
            arr.iter()
                .map(|t| Target {
                    range_m: t.f32_or("rangeM", 1.0),
                    reflectivity: t.f32_or("reflectivity", 0.8),
                    spreading: t.f32_or("spreading", 2.0),
                    // Deliberately not parsed from JSON, and not an oversight.
                    // `Target::breathing` is a unit-test fixture for detector
                    // arithmetic (ADR-023 §4). Reaching it through the scene
                    // API would let the demo render a breathing target, and a
                    // rendered breather is the shortest path to somebody
                    // treating simulator output as evidence about people.
                    // Scenes built here are static; the fixture stays in Rust
                    // tests where its warning label travels with it.
                    breathing: Breathing::STATIC,
                })
                .collect()
        })
        .unwrap_or_default()
}

fn samples_from_json(v: Option<&Value>) -> Vec<f32> {
    v.and_then(|s| s.as_arr())
        .map(|a| a.iter().map(|x| x.as_f32().unwrap_or(0.0)).collect())
        .unwrap_or_default()
}

// ───────────────────────────────────────────────────────── result encoding ──

pub fn profile_to_json(p: &RangeProfile, include_env: bool) -> Value {
    let dets: Vec<Value> = p
        .detections
        .iter()
        .map(|d| {
            Value::obj(vec![
                ("rangeM", Value::num(d.range_m as f64)),
                ("amplitude", Value::num(d.amplitude as f64)),
                ("snrDb", Value::num(d.snr_db as f64)),
                ("widthM", Value::num(d.width_m as f64)),
            ])
        })
        .collect();
    let mut fields = vec![
        ("t0", Value::num(p.t0 as f64)),
        ("blastAmplitude", Value::num(p.blast_amplitude as f64)),
        ("saturated", Value::Bool(p.saturated)),
        ("startRangeM", Value::num(p.start_range_m as f64)),
        ("rangeStepM", Value::num(p.range_step_m as f64)),
        ("noiseFloor", Value::num(p.noise_floor as f64)),
        ("sanitized", Value::num(p.sanitized as f64)),
        ("envLen", Value::num(p.env.len() as f64)),
        ("detections", Value::Arr(dets)),
    ];
    if include_env {
        fields.push(("env", Value::f32_arr(&p.env)));
    }
    Value::obj(fields)
}

fn design_to_json(r: &pipeline::DesignReport) -> Value {
    Value::obj(vec![
        ("speedOfSoundMs", Value::num(r.speed_of_sound_m_s as f64)),
        ("bandwidthHz", Value::num(r.bandwidth_hz as f64)),
        ("timeBandwidth", Value::num(r.time_bandwidth as f64)),
        (
            "compressionGainDb",
            Value::num(r.compression_gain_db as f64),
        ),
        ("rangeResolutionM", Value::num(r.range_resolution_m as f64)),
        ("blindRangeM", Value::num(r.blind_range_m as f64)),
        (
            "maxUnambiguousRangeM",
            Value::num(r.max_unambiguous_range_m as f64),
        ),
        ("rangeStepM", Value::num(r.range_step_m as f64)),
        ("sidelobeDb", Value::num(r.sidelobe_db as f64)),
        ("mainlobeSamples", Value::num(r.mainlobe_samples as f64)),
        ("recommendedGuard", Value::num(r.recommended_guard as f64)),
        ("recommendedTrain", Value::num(r.recommended_train as f64)),
        (
            "recommendedMergeGap",
            Value::num(r.recommended_merge_gap as f64),
        ),
        (
            "warning",
            match &r.warning {
                Some(w) => Value::str(w),
                None => Value::Null,
            },
        ),
    ])
}

fn err(msg: &str) -> Value {
    Value::obj(vec![("error", Value::str(msg))])
}

/// Add one field to an object, so an optional payload can ride alongside
/// `profile_to_json` without a second copy of it.
fn with_field(v: Value, k: &str, extra: Value) -> Value {
    match v {
        Value::Obj(mut o) => {
            o.insert(k.to_string(), extra);
            Value::Obj(o)
        }
        other => other,
    }
}

// ───────────────────────────────────────────────────────── the control op ──

/// Evaluate a JSON request. Pure: no state is retained between calls.
pub fn eval_json(req: &str) -> String {
    let v = match json::parse(req) {
        Ok(v) => v,
        Err(e) => return json::to_string(&err(&format!("bad json: {e}"))),
    };
    let out = dispatch(&v);
    json::to_string(&out)
}

fn dispatch(v: &Value) -> Value {
    let op = v.str_or("op", "");
    let cfg_v = v
        .get("config")
        .cloned()
        .unwrap_or(Value::Obj(Default::default()));
    match op {
        "version" => Value::obj(vec![
            ("name", Value::str("batvu-dsp")),
            ("version", Value::str(env!("CARGO_PKG_VERSION"))),
            ("abi", Value::num(ABI_VERSION as f64)),
        ]),

        "design" => {
            let cfg = sonar_config_from_json(&cfg_v);
            let pri = v.f32_or("priS", 0.050);
            design_to_json(&pipeline::design_report(&cfg, pri))
        }

        "chirp" => {
            let cfg = sonar_config_from_json(&cfg_v);
            if let Some(e) = cfg.chirp.validate() {
                return err(&e);
            }
            let tx = chirp::synth_real(&cfg.chirp);
            Value::obj(vec![
                ("fs", Value::num(cfg.chirp.fs as f64)),
                ("len", Value::num(tx.len() as f64)),
                ("samples", Value::f32_arr(&tx)),
            ])
        }

        "simulate" => {
            let cfg = sonar_config_from_json(&cfg_v);
            if let Some(e) = cfg.chirp.validate() {
                return err(&e);
            }
            let scene_v = v
                .get("scene")
                .cloned()
                .unwrap_or(Value::Obj(Default::default()));
            let scene = scene_config_from_json(&scene_v);
            let targets = targets_from_json(v.get("targets"));
            let rec = sim::render(&cfg.chirp, &targets, &scene);
            Value::obj(vec![
                ("len", Value::num(rec.len() as f64)),
                ("samples", Value::f32_arr(&rec)),
            ])
        }

        "process" => {
            let cfg = sonar_config_from_json(&cfg_v);
            if let Some(e) = cfg.validate() {
                return err(&e);
            }
            let samples = samples_from_json(v.get("samples"));
            if samples.is_empty() {
                return err("samples must be a non-empty array");
            }
            let mut p = Pipeline::new(cfg, samples.len());
            let prof = p.process(&samples);
            let out = profile_to_json(&prof, v.bool_or("includeEnv", false));
            if !v.bool_or("includeIq", false) {
                return out;
            }
            // The control surface's version of `bv_plan_iq_ptr`: same bins, same
            // interleaving, marshalled as JSON because this op is not the hot
            // path and a caller here is inspecting, not scanning.
            let bins = prof.env.len();
            let mut cx = CxProfiler::new(p.config(), samples.len(), bins);
            cx.fill(p.config(), &samples, prof.t0, bins);
            with_field(out, "iq", Value::f32_arr(&cx.iq))
        }

        "scenes" => {
            let enc = |s: &sim::NamedScene| {
                Value::obj(vec![
                    ("name", Value::str(s.name)),
                    (
                        "targets",
                        Value::Arr(
                            s.targets
                                .iter()
                                .map(|t| {
                                    Value::obj(vec![
                                        ("rangeM", Value::num(t.range_m as f64)),
                                        ("reflectivity", Value::num(t.reflectivity as f64)),
                                        ("spreading", Value::num(t.spreading as f64)),
                                    ])
                                })
                                .collect(),
                        ),
                    ),
                ])
            };
            Value::obj(vec![
                (
                    "holdout",
                    Value::Arr(sim::holdout_scenes().iter().map(enc).collect()),
                ),
                (
                    "anchor",
                    Value::Arr(sim::anchor_scenes().iter().map(enc).collect()),
                ),
            ])
        }

        "" => err("missing op"),
        other => err(&format!("unknown op: {other}")),
    }
}

/// wasm entry point for the control surface.
///
/// # Safety
/// `ptr`/`len` must describe a valid UTF-8 buffer inside wasm memory.
#[no_mangle]
pub extern "C" fn bv_eval(ptr: *const u8, len: usize) -> *const u8 {
    match read_str(ptr, len) {
        Ok(s) => pack(&eval_json(&s)),
        Err(e) => pack(&json::to_string(&err(&e))),
    }
}

// ──────────────────────────────────────────────────────── the plan surface ──

/// Create a processing plan. Returns a handle >= 0, or -1 on a bad config.
/// MAY GROW MEMORY.
///
/// # Safety
/// `ptr`/`len` must describe a valid UTF-8 JSON config buffer.
#[no_mangle]
pub extern "C" fn bv_plan_create(ptr: *const u8, len: usize, record_len: usize) -> i32 {
    let Ok(s) = read_str(ptr, len) else { return -1 };
    let Ok(v) = json::parse(&s) else { return -1 };
    let cfg = sonar_config_from_json(&v);
    if cfg.validate().is_some() {
        return -1;
    }
    let record_len = record_len.clamp(64, 1 << 20);
    let env_len = cfg
        .lag_for_range(cfg.max_range_m)
        .max(0.0)
        .ceil()
        .min(record_len as f32) as usize
        + 2;
    let cx = if v.bool_or("complexProfile", false) {
        Some(CxProfiler::new(&cfg, record_len, env_len))
    } else {
        None
    };
    let plan = Plan {
        pipeline: Pipeline::new(cfg, record_len),
        input: vec![0.0f32; record_len],
        env: vec![0.0f32; env_len],
        cx,
    };
    PLANS.with(|p| {
        let mut p = p.borrow_mut();
        p.push(Some(plan));
        (p.len() - 1) as i32
    })
}

fn with_plan<T>(handle: i32, f: impl FnOnce(&mut Plan) -> T, default: T) -> T {
    if handle < 0 {
        return default;
    }
    PLANS.with(|p| {
        let mut p = p.borrow_mut();
        match p.get_mut(handle as usize).and_then(|s| s.as_mut()) {
            Some(plan) => f(plan),
            None => default,
        }
    })
}

/// Pointer to the plan's sample input buffer. Write `record_len` floats here,
/// then call `bv_plan_process`. Stable for the life of the plan.
#[no_mangle]
pub extern "C" fn bv_plan_input_ptr(handle: i32) -> *mut f32 {
    with_plan(handle, |p| p.input.as_mut_ptr(), std::ptr::null_mut())
}

#[no_mangle]
pub extern "C" fn bv_plan_record_len(handle: i32) -> usize {
    with_plan(handle, |p| p.input.len(), 0)
}

/// Pointer to the plan's envelope output buffer — view it as a `Float32Array`
/// of `bv_plan_env_len` elements. Valid until the plan is destroyed.
#[no_mangle]
pub extern "C" fn bv_plan_env_ptr(handle: i32) -> *const f32 {
    with_plan(handle, |p| p.env.as_ptr(), std::ptr::null())
}

#[no_mangle]
pub extern "C" fn bv_plan_env_len(handle: i32) -> usize {
    with_plan(handle, |p| p.env.len(), 0)
}

/// Pointer to the plan's complex profile — `(re, im)` interleaved, two floats
/// per bin, one bin per element of the envelope buffer, so `iq[2*i]` and
/// `iq[2*i + 1]` are the parts whose modulus is `env[i]` wherever blast
/// cancellation has not been applied on top of `env`.
///
/// Null unless the plan's config carried `"complexProfile": true`; see the
/// memory-growth contract at the top of this module for why it is not a runtime
/// switch. Valid until the plan is destroyed.
#[no_mangle]
pub extern "C" fn bv_plan_iq_ptr(handle: i32) -> *const f32 {
    with_plan(
        handle,
        |p| match &p.cx {
            Some(cx) => cx.iq.as_ptr(),
            None => std::ptr::null(),
        },
        std::ptr::null(),
    )
}

/// Length of the complex profile in FLOATS, i.e. twice `bv_plan_env_len`. Zero
/// when the plan was not created with a complex profile.
#[no_mangle]
pub extern "C" fn bv_plan_iq_len(handle: i32) -> usize {
    with_plan(handle, |p| p.cx.as_ref().map_or(0, |cx| cx.iq.len()), 0)
}

/// Process whatever is currently in the plan's input buffer. Allocates nothing;
/// returns packed JSON metadata (detections and profile geometry, no envelope —
/// the envelope is already in wasm memory at `bv_plan_env_ptr`).
#[no_mangle]
pub extern "C" fn bv_plan_process(handle: i32) -> *const u8 {
    let s = with_plan(
        handle,
        |p| {
            // Split the borrow: process() needs &mut pipeline while input is read.
            let prof = {
                let input = std::mem::take(&mut p.input);
                let prof = p.pipeline.process(&input);
                p.input = input;
                prof
            };
            let n = prof.env.len().min(p.env.len());
            p.env[..n].copy_from_slice(&prof.env[..n]);
            for v in &mut p.env[n..] {
                *v = 0.0;
            }
            let out = profile_to_json(&prof, false);
            let Plan {
                pipeline,
                input,
                cx,
                ..
            } = p;
            let out = match cx {
                Some(cx) => {
                    cx.fill(pipeline.config(), input, prof.t0, n);
                    with_field(out, "iqLen", Value::num((2 * n) as f64))
                }
                None => out,
            };
            json::to_string(&out)
        },
        json::to_string(&err("unknown plan handle")),
    );
    pack(&s)
}

/// Destroy a plan and free its buffers. The handle becomes invalid.
#[no_mangle]
pub extern "C" fn bv_plan_destroy(handle: i32) {
    if handle < 0 {
        return;
    }
    PLANS.with(|p| {
        let mut p = p.borrow_mut();
        if let Some(slot) = p.get_mut(handle as usize) {
            *slot = None;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(req: &str) -> Value {
        json::parse(&eval_json(req)).expect("response must be valid json")
    }

    #[test]
    fn version_reports_the_abi() {
        let v = call(r#"{"op":"version"}"#);
        assert_eq!(v.get("name").unwrap().as_str(), Some("batvu-dsp"));
        assert_eq!(v.get("abi").unwrap().as_f64(), Some(ABI_VERSION as f64));
    }

    #[test]
    fn unknown_and_malformed_requests_return_errors_not_panics() {
        assert!(call(r#"{"op":"nope"}"#).get("error").is_some());
        assert!(call(r#"{}"#).get("error").is_some());
        assert!(call("not json at all").get("error").is_some());
        assert!(call(r#"{"op":"process","samples":[]}"#)
            .get("error")
            .is_some());
    }

    #[test]
    fn design_defaults_match_the_rust_defaults() {
        let v = call(r#"{"op":"design","priS":0.05}"#);
        assert!((v.get("bandwidthHz").unwrap().as_f32().unwrap() - 3000.0).abs() < 1.0);
        assert!((v.get("compressionGainDb").unwrap().as_f32().unwrap() - 11.76).abs() < 0.05);
        assert_eq!(v.get("warning").unwrap(), &Value::Null);
    }

    #[test]
    fn config_overrides_are_honoured_by_name() {
        let v = call(
            r#"{"op":"design","config":{"f0":17000,"f1":23000,"durationS":0.02,"rxTaper":"blackman-harris"}}"#,
        );
        assert!((v.get("bandwidthHz").unwrap().as_f32().unwrap() - 6000.0).abs() < 1.0);
        // BT = 6000 * 0.02 = 120 -> 20.8 dB
        assert!((v.get("compressionGainDb").unwrap().as_f32().unwrap() - 20.79).abs() < 0.05);
        assert!((v.get("sidelobeDb").unwrap().as_f32().unwrap() + 92.0).abs() < 0.1);
    }

    #[test]
    fn an_aliasing_config_is_reported_as_a_warning_not_an_error() {
        let v = call(r#"{"op":"design","config":{"f1":30000}}"#);
        let w = v
            .get("warning")
            .unwrap()
            .as_str()
            .expect("a warning string");
        assert!(w.contains("Nyquist"), "{w}");
    }

    #[test]
    fn simulate_then_process_round_trips_a_known_range() {
        let sim_v = call(
            r#"{"op":"simulate","targets":[{"rangeM":2.5,"reflectivity":0.9,"spreading":1}],
                "scene":{"recordLen":24000,"noiseRms":0.0005}}"#,
        );
        let samples = sim_v.get("samples").unwrap();
        let req = format!(
            r#"{{"op":"process","samples":{}}}"#,
            json::to_string(samples)
        );
        let prof = call(&req);
        let dets = prof.get("detections").unwrap().as_arr().unwrap();
        assert!(!dets.is_empty(), "expected a detection");
        let best = dets
            .iter()
            .map(|d| d.f32_or("rangeM", 0.0))
            .min_by(|a, b| (a - 2.5).abs().partial_cmp(&(b - 2.5).abs()).unwrap())
            .unwrap();
        assert!((best - 2.5).abs() < 0.02, "ranged {best} m");
    }

    #[test]
    fn chirp_returns_the_exact_transmit_waveform() {
        let v = call(r#"{"op":"chirp"}"#);
        let n = v.get("len").unwrap().as_usize().unwrap();
        assert_eq!(n, 240, "5 ms at 48 kHz");
        let s = v.get("samples").unwrap().as_arr().unwrap();
        assert_eq!(s.len(), n);
        let peak = s
            .iter()
            .fold(0.0f32, |a, b| a.max(b.as_f32().unwrap().abs()));
        assert!(peak <= 0.601, "peak {peak}");
    }

    #[test]
    fn scenes_exposes_disjoint_holdout_and_anchor_suites() {
        let v = call(r#"{"op":"scenes"}"#);
        let h = v.get("holdout").unwrap().as_arr().unwrap();
        let a = v.get("anchor").unwrap().as_arr().unwrap();
        assert!(h.len() >= 3 && a.len() >= 3);
        for hs in h {
            let hn = hs.get("name").unwrap().as_str().unwrap();
            assert!(a
                .iter()
                .all(|x| x.get("name").unwrap().as_str() != Some(hn)));
        }
    }

    #[test]
    fn env_is_included_only_when_asked_for() {
        let sim_v =
            call(r#"{"op":"simulate","targets":[{"rangeM":2.0}],"scene":{"recordLen":16384}}"#);
        let samples = json::to_string(sim_v.get("samples").unwrap());
        let lean = call(&format!(r#"{{"op":"process","samples":{samples}}}"#));
        assert!(lean.get("env").is_none());
        assert!(lean.get("envLen").unwrap().as_usize().unwrap() > 0);

        let full = call(&format!(
            r#"{{"op":"process","samples":{samples},"includeEnv":true}}"#
        ));
        assert_eq!(
            full.get("env").unwrap().as_arr().unwrap().len(),
            full.get("envLen").unwrap().as_usize().unwrap()
        );
    }

    #[test]
    fn the_plan_surface_matches_the_json_surface() {
        let record_len = 24_000usize;
        let cfg = r#"{"maxRangeM":8}"#;
        let handle = bv_plan_create(cfg.as_ptr(), cfg.len(), record_len);
        assert!(handle >= 0, "plan creation failed");
        assert_eq!(bv_plan_record_len(handle), record_len);

        // Render a scene and copy it into the plan's input buffer.
        let sonar = SonarConfig::default();
        let scene = SceneConfig {
            record_len,
            noise_rms: 5e-4,
            ..Default::default()
        };
        let rec = sim::render(&sonar.chirp, &[Target::wall(3.2, 0.9)], &scene);
        unsafe {
            let dst = std::slice::from_raw_parts_mut(bv_plan_input_ptr(handle), record_len);
            dst.copy_from_slice(&rec);
        }

        let out_ptr = bv_plan_process(handle);
        let out = unsafe {
            let len =
                u32::from_le_bytes([*out_ptr, *out_ptr.add(1), *out_ptr.add(2), *out_ptr.add(3)])
                    as usize;
            std::str::from_utf8(std::slice::from_raw_parts(out_ptr.add(4), len))
                .unwrap()
                .to_string()
        };
        let plan_res = json::parse(&out).unwrap();
        let plan_ranges: Vec<f32> = plan_res
            .get("detections")
            .unwrap()
            .as_arr()
            .unwrap()
            .iter()
            .map(|d| d.f32_or("rangeM", 0.0))
            .collect();
        assert!(
            plan_ranges.iter().any(|r| (r - 3.2).abs() < 0.03),
            "plan ranges {plan_ranges:?}"
        );

        // The envelope is readable straight out of wasm memory.
        let env_len = bv_plan_env_len(handle);
        assert!(env_len > 1000, "env len {env_len}");
        let env = unsafe { std::slice::from_raw_parts(bv_plan_env_ptr(handle), env_len) };
        assert!(
            env.iter().any(|v| *v > 0.0),
            "envelope should not be all zeros"
        );

        // And the JSON surface agrees.
        let json_res = call(&format!(
            r#"{{"op":"process","samples":{}}}"#,
            json::to_string(&Value::f32_arr(&rec))
        ));
        let json_ranges: Vec<f32> = json_res
            .get("detections")
            .unwrap()
            .as_arr()
            .unwrap()
            .iter()
            .map(|d| d.f32_or("rangeM", 0.0))
            .collect();
        assert_eq!(
            plan_ranges.len(),
            json_ranges.len(),
            "the two surfaces disagree: {plan_ranges:?} vs {json_ranges:?}"
        );

        bv_plan_destroy(handle);
        assert_eq!(bv_plan_record_len(handle), 0, "a destroyed plan is inert");
    }

    #[test]
    fn the_complex_profile_is_absent_unless_the_plan_asks_for_it() {
        let plain = r#"{"maxRangeM":6}"#;
        let h = bv_plan_create(plain.as_ptr(), plain.len(), 8_192);
        assert!(h >= 0);
        assert!(
            bv_plan_iq_ptr(h).is_null(),
            "a plan that did not ask for phase must not hand out a buffer"
        );
        assert_eq!(bv_plan_iq_len(h), 0);
        bv_plan_destroy(h);

        let cx = r#"{"maxRangeM":6,"complexProfile":true}"#;
        let h = bv_plan_create(cx.as_ptr(), cx.len(), 8_192);
        assert!(h >= 0);
        assert!(!bv_plan_iq_ptr(h).is_null());
        assert_eq!(
            bv_plan_iq_len(h),
            2 * bv_plan_env_len(h),
            "two floats per range bin"
        );
        bv_plan_destroy(h);
        assert_eq!(bv_plan_iq_len(h), 0, "a destroyed plan is inert");
        assert!(bv_plan_iq_ptr(9999).is_null());
        assert_eq!(bv_plan_iq_len(9999), 0);
    }

    #[test]
    fn the_plan_complex_profile_indexes_the_same_bins_as_the_envelope() {
        // Blast cancellation off, because it edits the ENVELOPE after the
        // matched filter and leaves the complex profile alone — the two agree
        // bin for bin only where nothing has been subtracted from one of them.
        let record_len = 24_000usize;
        let cfg = r#"{"maxRangeM":6,"blastCancellation":false,"complexProfile":true}"#;
        let handle = bv_plan_create(cfg.as_ptr(), cfg.len(), record_len);
        assert!(handle >= 0);

        let sonar = SonarConfig::default();
        let scene = SceneConfig {
            record_len,
            noise_rms: 5e-4,
            ..Default::default()
        };
        let rec = sim::render(&sonar.chirp, &[Target::wall(2.6, 0.9)], &scene);
        unsafe {
            let dst = std::slice::from_raw_parts_mut(bv_plan_input_ptr(handle), record_len);
            dst.copy_from_slice(&rec);
        }
        bv_plan_process(handle);

        let env_len = bv_plan_env_len(handle);
        let env = unsafe { std::slice::from_raw_parts(bv_plan_env_ptr(handle), env_len) };
        let iq = unsafe { std::slice::from_raw_parts(bv_plan_iq_ptr(handle), 2 * env_len) };

        // Bit-for-bit: both buffers must be the same compression of the same
        // record, differing only in whether the last square root was taken.
        let mut checked = 0usize;
        for (i, e) in env.iter().enumerate() {
            if *e == 0.0 {
                continue; // the zero-padded tail past the profile's real length
            }
            let (r, m) = (iq[2 * i], iq[2 * i + 1]);
            assert_eq!(
                (r * r + m * m).sqrt().to_bits(),
                e.to_bits(),
                "bin {i} disagrees"
            );
            checked += 1;
        }
        assert!(checked > 1_000, "only {checked} bins carried a profile");

        // Phase is actually present, not a buffer of zeros with a magnitude
        // that happens to match.
        let turning = iq
            .chunks_exact(2)
            .filter(|p| p[1].abs() > 1e-6 && p[0].abs() > 1e-6)
            .count();
        assert!(turning > 1_000, "only {turning} bins carried a phase");

        bv_plan_destroy(handle);
    }

    #[test]
    fn the_json_surface_reports_the_same_complex_profile_as_the_plan() {
        let record_len = 16_384usize;
        let sonar = SonarConfig::default();
        let scene = SceneConfig {
            record_len,
            noise_rms: 5e-4,
            ..Default::default()
        };
        let rec = sim::render(&sonar.chirp, &[Target::wall(2.0, 0.9)], &scene);
        let samples = json::to_string(&Value::f32_arr(&rec));

        let lean = call(&format!(
            r#"{{"op":"process","samples":{samples},"config":{{"blastCancellation":false}}}}"#
        ));
        assert!(lean.get("iq").is_none(), "phase is opt-in here too");

        let full = call(&format!(
            r#"{{"op":"process","samples":{samples},"includeEnv":true,"includeIq":true,
                 "config":{{"blastCancellation":false}}}}"#
        ));
        let env = full.get("env").unwrap().as_arr().unwrap();
        let iq = full.get("iq").unwrap().as_arr().unwrap();
        assert_eq!(iq.len(), 2 * env.len(), "two floats per range bin");

        // JSON round-trips f32 through f64 decimal, so this comparison is
        // relative rather than bitwise — the bitwise one lives on the plan
        // surface, which is where the floats never leave wasm memory.
        for (i, e) in env.iter().enumerate() {
            let e = e.as_f32().unwrap();
            let r = iq[2 * i].as_f32().unwrap();
            let m = iq[2 * i + 1].as_f32().unwrap();
            let mag = (r * r + m * m).sqrt();
            assert!(
                (mag - e).abs() <= 1e-6 * e.abs().max(1e-6),
                "bin {i}: |{r} + {m}j| = {mag}, env says {e}"
            );
        }
    }

    #[test]
    fn a_bad_plan_config_is_rejected_and_bad_handles_are_inert() {
        let bad = r#"{"f1":30000}"#; // above Nyquist
        assert_eq!(bv_plan_create(bad.as_ptr(), bad.len(), 4096), -1);
        assert_eq!(bv_plan_record_len(-1), 0);
        assert!(bv_plan_input_ptr(9999).is_null());
        assert_eq!(bv_plan_env_len(9999), 0);
        bv_plan_destroy(9999); // must not panic
    }

    #[test]
    fn alloc_and_free_hand_out_usable_memory() {
        let p = bv_alloc(128);
        assert!(!p.is_null());
        unsafe {
            std::ptr::write_bytes(p, 0xAB, 128);
            assert_eq!(*p, 0xAB);
        }
        bv_free(p);
        bv_free(std::ptr::null_mut()); // must not panic
    }
}
