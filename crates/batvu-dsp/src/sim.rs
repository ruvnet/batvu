//! A deterministic room-echo simulator — BatVu's ground truth.
//!
//! Everything above this line has to be measured against *something*, and a
//! real room is not something: you cannot check a range estimate against a
//! tape measure a thousand times a second, and you cannot run a flywheel
//! generation in CI against a hallway. So the simulator is load-bearing, not a
//! toy. It is what the tests assert against, what the benchmarks time, what the
//! flywheel's holdout and anchor suites are made of, and what lets the web app
//! demo itself in a headless browser with no microphone.
//!
//! It models the parts that change the answer:
//!
//! * **The direct-path blast.** The speaker is ~10 cm from the mic, so every
//!   record opens with a copy of the transmit pulse tens of dB above any echo.
//!   It sets the blind zone, and — because it is the one arrival whose timing we
//!   know exactly — it is also the synchronisation reference that cancels the
//!   browser's unknown output/input latency.
//! * **Two-way spreading loss.** `1/r^2` for a compact object, `1/(2r)` for a
//!   large flat surface — the returning wavefront curves as if from the phone's
//!   mirror image, which is `2r` away. Getting this wrong makes far targets look
//!   far too easy.
//! * **A blast that pays for its own short path.** The direct arrival used to be
//!   a bare constant while every echo paid spreading and absorption, which left
//!   it ~11 dB above a wall at 2.4 m where the physics says ~38. That is the
//!   exact quantity blast cancellation exists to fight, so the near field — the
//!   hardest part of this sensor — was being simulated at a difficulty it does
//!   not have. See `direct_amplitude`.
//! * **Atmospheric absorption**, which at 20 kHz is the term people forget:
//!   roughly 0.6-1.0 dB/m in ordinary indoor air, paid twice on a round trip.
//!   At 6 m that is another ~10 dB gone.
//! * **A seeded noise floor**, so a run replays bit-for-bit — a hard requirement
//!   for `@metaharness/flywheel` replay bundles.

use crate::chirp::{self, ChirpSpec};

/// One reflector in the simulated scene.
#[derive(Debug, Clone, Copy)]
pub struct Target {
    /// One-way range from the phone, in metres.
    pub range_m: f32,
    /// Reflection coefficient at 1 m, linear (1.0 = a perfect mirror).
    pub reflectivity: f32,
    /// Spreading exponent: 2.0 for a compact object, 1.0 for a large flat
    /// surface (a wall returns far more energy than a chair at the same range).
    pub spreading: f32,
}

impl Target {
    pub fn point(range_m: f32, reflectivity: f32) -> Target {
        Target {
            range_m,
            reflectivity,
            spreading: 2.0,
        }
    }
    pub fn wall(range_m: f32, reflectivity: f32) -> Target {
        Target {
            range_m,
            reflectivity,
            spreading: 1.0,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SceneConfig {
    /// Air temperature, which sets the speed of sound.
    pub temperature_c: f32,
    /// Two-way atmospheric absorption, dB per metre of one-way path.
    pub absorption_db_per_m: f32,
    /// Speaker-to-microphone separation, metres.
    pub speaker_mic_sep_m: f32,
    /// TARGET amplitude of the direct-path blast, linear full-scale.
    ///
    /// Not a gain any more: the whole record is scaled so the blast lands here.
    /// Echo amplitudes follow from the geometry relative to it, which is the
    /// only way the blast-to-echo ratio can be right and the record can still
    /// fit inside an ADC. See `render`.
    pub direct_path_gain: f32,
    /// RMS of the additive noise floor, linear full-scale.
    pub noise_rms: f32,
    /// Extra samples of unknown capture latency to prepend — the thing the
    /// direct-path synchronisation has to cancel.
    pub latency_samples: usize,
    /// Total record length in samples.
    pub record_len: usize,
    /// Deterministic PRNG seed.
    pub seed: u32,
    /// Clip the record to +/-1.0 like a real ADC would.
    pub clip: bool,
}

impl Default for SceneConfig {
    fn default() -> Self {
        SceneConfig {
            temperature_c: 20.0,
            absorption_db_per_m: 0.8,
            speaker_mic_sep_m: 0.10,
            direct_path_gain: DEFAULT_BLAST_LEVEL,
            noise_rms: 2e-3,
            latency_samples: 0,
            record_len: 24_000,
            seed: 0x5EED_1234,
            clip: true,
        }
    }
}

/// Two-way echo amplitude for one target, before the transmit level is applied.
///
/// The two limits have genuinely different geometry, and the exponent alone does
/// not capture it:
///
/// * A **compact** scatterer spreads spherically on the way out and again on the
///   way back — `1/r` twice, so `1/r^2`.
/// * An **extended specular** surface does not scatter. It reflects, and the
///   returning wavefront has the curvature of a source at the MIRROR IMAGE of
///   the phone, which sits `2r` away — so `1/(2r)`, not `1/r`.
///
/// That factor of two is 6 dB, and it was missing. It is folded in through
/// `image_source`, which is 0.5 in the extended limit and 1.0 in the compact
/// one, so both endpoints are now right and the continuous knob between them
/// still behaves.
pub fn echo_amplitude(t: &Target, cfg: &SceneConfig) -> f32 {
    let r = t.range_m.max(0.01);
    let s = t.spreading.clamp(0.5, 3.0);
    // 1.0 at s = 1 (fully extended), 0.0 at s = 2 (fully compact).
    let extended = (2.0 - s).clamp(0.0, 1.0);
    let image_source = 0.5f32.powf(extended);
    let spread = image_source / r.powf(s);
    // Absorption is paid on the way out and on the way back.
    let absorb_db = -2.0 * cfg.absorption_db_per_m * r;
    let absorb = 10.0f32.powf(absorb_db / 20.0);
    t.reflectivity * spread * absorb
}

/// Default target level for the direct-path blast, linear full-scale.
///
/// Also the reference used when a caller omits the blast entirely, so echo
/// amplitudes do not silently change scale between the two modes.
pub const DEFAULT_BLAST_LEVEL: f32 = 0.9;

/// Amplitude of the direct speaker-to-microphone leak, before normalisation.
///
/// This is the arrival that used to be a bare constant, and the bare constant is
/// what made the whole simulator wrong about the near field. The blast travels
/// the speaker-mic baseline — about ten centimetres — ONE way, and so earns the
/// enormous near-range gain that short path implies. Every echo paid spreading
/// and absorption; the one arrival that should have been loudest paid nothing,
/// and came out only ~11 dB above a wall at 2.4 m instead of the ~38 dB physics
/// gives. This module's own opening paragraph said "tens of dB above any echo".
/// The documentation was right and the code never implemented it.
pub fn direct_amplitude(cfg: &SceneConfig) -> f32 {
    let d = cfg.speaker_mic_sep_m.max(1e-3);
    // One-way spherical spreading and one-way absorption, on the same
    // normalised-at-one-metre convention `echo_amplitude` uses.
    let absorb = 10.0f32.powf(-cfg.absorption_db_per_m * d / 20.0);
    absorb / d
}

/// Sample index at which a target's echo arrives, given the direct-path offset.
pub fn echo_index(t: &Target, spec: &ChirpSpec, cfg: &SceneConfig) -> f32 {
    let c = chirp::speed_of_sound(cfg.temperature_c);
    // Speaker -> target -> mic, with `range_m` measured from the phone's
    // acoustic centre (the midpoint of the speaker-mic baseline). The bistatic
    // correction for a 10 cm baseline is second order — under 1 mm beyond 0.5 m
    // — so the path is 2r, and the ONE place the baseline matters is the direct
    // blast, which travels it exactly. Keeping those two facts separate is what
    // makes `SonarConfig::range_at` the exact inverse of this function.
    let path = 2.0 * t.range_m;
    cfg.latency_samples as f32 + path.max(0.0) / c * spec.fs
}

/// Sample index of the direct-path blast.
pub fn direct_index(spec: &ChirpSpec, cfg: &SceneConfig) -> f32 {
    let c = chirp::speed_of_sound(cfg.temperature_c);
    cfg.latency_samples as f32 + cfg.speaker_mic_sep_m / c * spec.fs
}

/// Render a scene to a received record.
pub fn render(spec: &ChirpSpec, targets: &[Target], cfg: &SceneConfig) -> Vec<f32> {
    let mut rec = vec![0.0f32; cfg.record_len];

    // Scale every arrival by one factor, chosen so the blast lands exactly on
    // `direct_path_gain`.
    //
    // The quantity that was wrong is the RATIO, not the level. Giving the direct
    // path its real near-range gain makes it ~10x full scale on its own, and a
    // record that clips is a different distortion — one that would break what
    // `saturated` means. Pinning the blast where it already sat keeps the ADC
    // realism and the blind-zone geometry unchanged while every echo moves to
    // where it belongs relative to it.
    //
    // `direct_path_gain: 0.0` keeps its old meaning — OMIT the blast — rather
    // than becoming "scale the whole record to silence". Tests that isolate
    // echo behaviour set it, and they need echoes at the same absolute scale
    // they would have had with the blast present, so the reference level falls
    // back to the default instead of to zero.
    let draw_blast = cfg.direct_path_gain > 0.0;
    let target = if draw_blast {
        cfg.direct_path_gain
    } else {
        DEFAULT_BLAST_LEVEL
    };
    let level = target / direct_amplitude(cfg).max(1e-9);

    if draw_blast {
        add_delayed(
            &mut rec,
            spec,
            direct_index(spec, cfg),
            direct_amplitude(cfg) * level,
        );
    }
    for t in targets {
        add_delayed(
            &mut rec,
            spec,
            echo_index(t, spec, cfg),
            echo_amplitude(t, cfg) * level,
        );
    }

    let mut rng = Rng::new(cfg.seed);
    for v in rec.iter_mut() {
        *v += cfg.noise_rms * rng.gaussian();
        if cfg.clip {
            *v = v.clamp(-1.0, 1.0);
        }
    }
    rec
}

/// Add a scaled copy of the transmit pulse into `dst` at a FRACTIONAL delay,
/// evaluated analytically rather than interpolated.
///
/// Fractional placement matters — quantising every echo to a whole sample would
/// hand the range estimator a 3.6 mm grid for free and hide real interpolation
/// bugs. But it must be done exactly. Linear interpolation between two samples
/// is a comb filter with response `|(1-f) + f*e^(-jw)|`; at 20 kHz with a 48 kHz
/// rate that is `w = 2.6 rad`, so a half-sample offset costs about 11 dB. Echo
/// amplitude would then swing by an order of magnitude with the sub-millimetre
/// part of a target's range, and every downstream measurement — link budget,
/// CFAR threshold, flywheel score — would be measuring the interpolator.
/// Evaluating the closed-form chirp at shifted time has none of that error.
fn add_delayed(dst: &mut [f32], spec: &ChirpSpec, delay: f32, gain: f32) {
    if gain == 0.0 || !delay.is_finite() || delay < 0.0 {
        return;
    }
    let start = delay.floor().max(0.0) as usize;
    let n = spec.len_samples() + 2;
    for i in 0..n {
        let j = start + i;
        if j >= dst.len() {
            break;
        }
        let t = (j as f32 - delay) / spec.fs;
        dst[j] += gain * chirp::sample_at(spec, t);
    }
}

/// xorshift32 with an Irwin-Hall Gaussian. Deterministic across platforms —
/// no floating-point transcendentals in the generator, so a replay on another
/// machine produces the identical record.
pub struct Rng(u32);

impl Rng {
    pub fn new(seed: u32) -> Rng {
        Rng(if seed == 0 { 0x1234_5678 } else { seed })
    }
    #[inline]
    pub fn next_u32(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }
    /// Uniform in [-1, 1).
    #[inline]
    pub fn uniform(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 / 8_388_608.0 - 1.0
    }
    /// Approximately N(0, 1): the sum of 6 uniforms on [-1,1) has variance 2,
    /// so scale by 1/sqrt(2).
    #[inline]
    pub fn gaussian(&mut self) -> f32 {
        let s: f32 = (0..6).map(|_| self.uniform()).sum();
        s * std::f32::consts::FRAC_1_SQRT_2
    }
}

/// A named scene, so suites can be described declaratively and cited in ADRs.
pub struct NamedScene {
    pub name: &'static str,
    pub targets: Vec<Target>,
}

/// The stock scenes. `holdout_scenes` are what the flywheel optimises against;
/// `anchor_scenes` are never optimised against and exist only to catch Goodhart.
pub fn holdout_scenes() -> Vec<NamedScene> {
    vec![
        NamedScene {
            name: "corridor",
            targets: vec![Target::wall(1.5, 0.9), Target::wall(6.0, 0.8)],
        },
        NamedScene {
            name: "small-room",
            targets: vec![
                Target::wall(2.2, 0.85),
                Target::wall(3.1, 0.85),
                Target::point(0.9, 0.6),
            ],
        },
        NamedScene {
            name: "cluttered-desk",
            targets: vec![
                Target::point(0.45, 0.5),
                Target::point(0.62, 0.35),
                Target::point(1.1, 0.4),
                Target::wall(2.6, 0.8),
            ],
        },
        NamedScene {
            name: "far-wall-only",
            targets: vec![Target::wall(5.2, 0.75)],
        },
    ]
}

pub fn anchor_scenes() -> Vec<NamedScene> {
    vec![
        NamedScene {
            name: "anchor-empty",
            targets: vec![],
        },
        NamedScene {
            name: "anchor-two-close",
            targets: vec![Target::point(1.80, 0.6), Target::point(1.95, 0.55)],
        },
        NamedScene {
            name: "anchor-deep-hall",
            targets: vec![Target::wall(3.0, 0.5), Target::wall(7.5, 0.85)],
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chirp::ChirpSpec;

    #[test]
    fn echo_amplitude_does_not_depend_on_sub_sample_range() {
        // The regression this file's `add_delayed` exists to prevent: with
        // linear interpolation, a target at 2.00 m came back ~9 dB weaker than
        // one at 2.12 m purely because of where its echo landed between samples.
        let spec = ChirpSpec::default();
        let cfg = SceneConfig {
            noise_rms: 0.0,
            direct_path_gain: 0.0,
            ..Default::default()
        };
        let mut peaks = Vec::new();
        for i in 0..12 {
            // Step by a fraction of a sample: 3.575 mm per sample of range.
            let r = 2.0 + i as f32 * 0.0009;
            let rec = render(&spec, &[Target::point(r, 0.7)], &cfg);
            peaks.push(rec.iter().fold(0.0f32, |a, b| a.max(b.abs())));
        }
        let max = peaks.iter().fold(0.0f32, |a, b| a.max(*b));
        let min = peaks.iter().fold(f32::MAX, |a, b| a.min(*b));
        let spread_db = 20.0 * (max / min).log10();
        assert!(
            spread_db < 0.5,
            "sub-sample range changed amplitude by {spread_db} dB: {peaks:?}"
        );
    }

    #[test]
    fn rendering_is_bit_for_bit_deterministic() {
        let spec = ChirpSpec::default();
        let cfg = SceneConfig::default();
        let t = vec![Target::point(2.0, 0.5)];
        let a = render(&spec, &t, &cfg);
        let b = render(&spec, &t, &cfg);
        assert_eq!(a, b, "same seed must reproduce the identical record");

        let c = render(
            &spec,
            &t,
            &SceneConfig {
                seed: 999,
                ..cfg.clone()
            },
        );
        assert_ne!(a, c, "a different seed must produce a different record");
    }

    #[test]
    fn echo_delay_follows_two_way_time_of_flight() {
        let spec = ChirpSpec::default();
        let cfg = SceneConfig::default();
        let c = chirp::speed_of_sound(cfg.temperature_c);
        let t = Target::point(3.0, 1.0);
        let idx = echo_index(&t, &spec, &cfg);
        let expect = (2.0 * 3.0) / c * spec.fs;
        assert!((idx - expect).abs() < 0.01, "{idx} vs {expect}");

        // Doubling the range must roughly double the delay past the blast.
        let far = echo_index(&Target::point(6.0, 1.0), &spec, &cfg);
        assert!((far / idx - 2.0).abs() < 0.02, "ratio {}", far / idx);
    }

    #[test]
    fn amplitude_falls_with_range_and_a_wall_beats_a_point_target() {
        let cfg = SceneConfig::default();
        let near = echo_amplitude(&Target::point(1.0, 1.0), &cfg);
        let far = echo_amplitude(&Target::point(4.0, 1.0), &cfg);
        assert!(near > far, "{near} vs {far}");

        // 1/r^2 = 1/16 (-24 dB) plus 2*0.8*3 = 4.8 dB extra absorption over
        // the extra 3 m, so a shade under 1/16.
        let ratio = far / near;
        assert!(ratio < 1.0 / 16.0 && ratio > 1.0 / 40.0, "ratio {ratio}");

        // A wall still beats a compact target at the same range, but by exactly
        // 2x rather than the 4x the old model gave. Both terms are now the
        // physics: the compact one spreads spherically twice (`1/r^2`), and the
        // extended one reflects, so its wavefront curves as if from the phone's
        // mirror image at `2r` (`1/(2r)`). At r = 4 that is 0.125 against
        // 0.0625. The old `1/r` omitted the image-source factor of two, which
        // is 6 dB of wall return this simulator was inventing.
        let wall = echo_amplitude(&Target::wall(4.0, 1.0), &cfg);
        let advantage = wall / far;
        assert!(
            (advantage - 2.0).abs() < 1e-4,
            "an extended surface should beat a compact one by exactly 2x at this range, got {advantage}x ({wall} vs {far})"
        );
    }

    #[test]
    fn absorption_costs_the_expected_decibels() {
        let cfg = SceneConfig {
            absorption_db_per_m: 1.0,
            ..Default::default()
        };
        let no_absorb = SceneConfig {
            absorption_db_per_m: 0.0,
            ..cfg.clone()
        };
        let with = echo_amplitude(&Target::point(5.0, 1.0), &cfg);
        let without = echo_amplitude(&Target::point(5.0, 1.0), &no_absorb);
        let db = 20.0 * (with / without).log10();
        // 2 (round trip) x 1.0 dB/m x 5 m = 10 dB.
        assert!((db + 10.0).abs() < 0.1, "{db} dB");
    }

    #[test]
    fn the_direct_path_dominates_the_opening_of_the_record() {
        let spec = ChirpSpec::default();
        let cfg = SceneConfig::default();
        let rec = render(&spec, &[Target::point(3.0, 0.8)], &cfg);
        let blast = rec[..1000].iter().fold(0.0f32, |a, b| a.max(b.abs()));
        let later = rec[2000..].iter().fold(0.0f32, |a, b| a.max(b.abs()));
        assert!(blast > 10.0 * later, "blast {blast} vs later {later}");
    }

    #[test]
    fn latency_shifts_everything_together() {
        let spec = ChirpSpec::default();
        let base = SceneConfig {
            noise_rms: 0.0,
            ..Default::default()
        };
        let shifted = SceneConfig {
            latency_samples: 777,
            ..base.clone()
        };
        let d0 = direct_index(&spec, &base);
        let d1 = direct_index(&spec, &shifted);
        let e0 = echo_index(&Target::point(2.0, 1.0), &spec, &base);
        let e1 = echo_index(&Target::point(2.0, 1.0), &spec, &shifted);
        assert!((d1 - d0 - 777.0).abs() < 1e-3);
        assert!((e1 - e0 - 777.0).abs() < 1e-3);
        // The DIFFERENCE is what the pipeline uses, and it is latency-invariant.
        assert!(((e1 - d1) - (e0 - d0)).abs() < 1e-3);
    }

    #[test]
    fn clipping_keeps_the_record_inside_full_scale() {
        let spec = ChirpSpec::default();
        let cfg = SceneConfig {
            direct_path_gain: 5.0,
            clip: true,
            ..Default::default()
        };
        let rec = render(&spec, &[], &cfg);
        assert!(rec.iter().all(|v| v.abs() <= 1.0 + 1e-6));
        let unclipped = render(&spec, &[], &SceneConfig { clip: false, ..cfg });
        assert!(unclipped.iter().any(|v| v.abs() > 1.0));
    }

    #[test]
    fn the_noise_generator_has_roughly_unit_variance() {
        let mut rng = Rng::new(1);
        let n = 200_000;
        let mut sum = 0.0f64;
        let mut sq = 0.0f64;
        for _ in 0..n {
            let g = rng.gaussian() as f64;
            sum += g;
            sq += g * g;
        }
        let mean = sum / n as f64;
        let var = sq / n as f64 - mean * mean;
        assert!(mean.abs() < 0.02, "mean {mean}");
        assert!((var - 1.0).abs() < 0.05, "variance {var}");
    }

    #[test]
    fn stock_suites_are_disjoint_and_non_empty() {
        let h = holdout_scenes();
        let a = anchor_scenes();
        assert!(h.len() >= 3 && a.len() >= 3);
        for hs in &h {
            assert!(
                a.iter().all(|as_| as_.name != hs.name),
                "suites must not overlap"
            );
        }
    }
}
