//! The end-to-end ping pipeline: raw microphone samples in, range profile out.
//!
//! ```text
//!   samples ──▶ matched filter ──▶ envelope ──▶ direct-path sync ──▶ CFAR ──▶ detections
//!                (analytic ref)                    (t0)              (local)     (metres)
//! ```
//!
//! The step that is easy to miss is **direct-path synchronisation**, and it is
//! the reason this design works in a browser at all. WebAudio gives no reliable
//! answer to "at what capture sample did my playback actually leave the
//! speaker?" — output latency is device-, route- and buffer-dependent, and it
//! drifts. Absolute timing is therefore unavailable, and absolute timing is
//! what a time-of-flight sensor is made of.
//!
//! The way out is that the loudest thing in every record is the pulse
//! travelling the ~10 cm straight from speaker to mic. Its flight time is known
//! (sub-millisecond) and fixed. So we do not measure time from "when we asked
//! for playback"; we measure it from the blast. Every unknown latency — output
//! buffer, route change, resampling — is common to both arrivals and subtracts
//! out. What starts as the pipeline's biggest nuisance becomes its clock.

use crate::cfar::{self, CfarConfig, Detection};
use crate::chirp::{self, ChirpSpec};
use crate::matched::{self, MatchedFilter};
use crate::window::Window;

#[derive(Debug, Clone)]
pub struct SonarConfig {
    pub chirp: ChirpSpec,
    /// Receive-side spectral taper — the range-sidelobe lever.
    pub rx_taper: Window,
    pub cfar: CfarConfig,
    pub temperature_c: f32,
    pub speaker_mic_sep_m: f32,
    /// Nearest range reported.
    ///
    /// The limit here is NOT the raw pulse length — a 10 ms pulse is 1.7 m of
    /// two-way travel, but pulse compression shrinks its mainlobe to a few
    /// centimetres. What actually sets the floor is the direct-path blast's
    /// range-SIDELOBE skirt: the blast is tens of dB above any echo, so its
    /// -31 dB (hann) sidelobes stay above the CFAR threshold for a couple of
    /// hundred samples. 0.5 m clears that skirt for the default waveform.
    /// Lowering it does not reveal closer objects, it invents them.
    pub min_range_m: f32,
    /// Furthest range computed. Beyond this the link budget has nothing left.
    pub max_range_m: f32,
    /// Use the direct-path blast as the time origin (see the module note).
    pub sync_to_direct_path: bool,
    /// How far into the record to hunt for the blast, in seconds. Must cover
    /// the worst-case output latency; 250 ms is generous for iOS.
    pub direct_search_s: f32,
    /// Detections weaker than this many dB over the local CFAR threshold are
    /// discarded. CFAR already controls the false-alarm RATE, but a bare
    /// threshold crossing is not evidence of an object — near the direct-path
    /// blast, its range sidelobes cross by a decibel or two all the time. This
    /// is the difference between "the room is empty" and "the room contains two
    /// ghosts at 30 cm".
    pub min_snr_db: f32,
    /// Subtract the direct-path blast's known compressed shape from the profile
    /// before detection.
    ///
    /// The blast is the one arrival whose waveform we know exactly — it is the
    /// transmit pulse, undistorted, at a known delay. Its compressed response is
    /// therefore the matched filter's own autocorrelation, scaled by the blast
    /// amplitude. Subtracting that removes the sidelobe skirt that otherwise
    /// masquerades as objects at 0.3-0.6 m, which is precisely the range where a
    /// phone held at arm's length is most interesting.
    pub blast_cancellation: bool,
}

impl Default for SonarConfig {
    fn default() -> Self {
        let chirp = ChirpSpec::default();
        // No receive weighting. With a full Hann TRANSMIT taper the peak sidelobe
        // is already -45 dB at BT = 15 — far below a real room's reverberation
        // floor — so a receive window buys suppression nobody can measure and
        // costs 19% of the range resolution. Measured, not assumed: see
        // `examples/taper_study.rs` and ADR-004.
        let rx_taper = Window::Rect;
        SonarConfig {
            // Sized from the waveform, not guessed: the guard band has to clear
            // the compressed mainlobe or every target masks itself.
            cfar: CfarConfig::sized_for(&chirp, rx_taper),
            chirp,
            rx_taper,
            temperature_c: 20.0,
            speaker_mic_sep_m: 0.10,
            min_range_m: 0.6,
            max_range_m: 6.0,
            sync_to_direct_path: true,
            direct_search_s: 0.25,
            min_snr_db: 6.0,
            blast_cancellation: true,
        }
    }
}

impl SonarConfig {
    /// Build a config around a waveform, with the CFAR windows sized to it.
    ///
    /// Prefer this over `SonarConfig { chirp: ..., ..Default::default() }`:
    /// struct-update syntax silently keeps the CFAR windows sized for the
    /// DEFAULT chirp, and a guard band that no longer clears the compressed
    /// mainlobe makes every target mask itself. `validate()` catches that case,
    /// but not building it wrong in the first place is better.
    pub fn for_chirp(chirp: ChirpSpec, rx_taper: Window) -> SonarConfig {
        SonarConfig {
            cfar: CfarConfig::sized_for(&chirp, rx_taper),
            chirp,
            rx_taper,
            ..SonarConfig::default()
        }
    }

    /// Half-width of the compressed mainlobe, in samples — the quantity the
    /// CFAR guard band has to clear.
    pub fn mainlobe_half_width(&self) -> f32 {
        (self.chirp.fs / self.chirp.bandwidth().max(1.0))
            * self.chirp.effective_widening(self.rx_taper)
    }

    pub fn speed_of_sound(&self) -> f32 {
        chirp::speed_of_sound(self.temperature_c)
    }

    /// Metres of one-way range per lag sample: `c / (2 * fs)`.
    pub fn range_per_sample(&self) -> f32 {
        self.speed_of_sound() / (2.0 * self.chirp.fs)
    }

    /// Range in metres for a (possibly fractional) lag index measured from `t0`.
    pub fn range_at(&self, lag_from_t0: f32) -> f32 {
        (self.speed_of_sound() * lag_from_t0 / self.chirp.fs + self.speaker_mic_sep_m) / 2.0
    }

    /// Lag index from `t0` for a given range — the inverse of `range_at`.
    pub fn lag_for_range(&self, range_m: f32) -> f32 {
        (2.0 * range_m - self.speaker_mic_sep_m) * self.chirp.fs / self.speed_of_sound()
    }

    pub fn validate(&self) -> Option<String> {
        if let Some(e) = self.chirp.validate() {
            return Some(e);
        }
        if !(self.max_range_m > self.min_range_m) {
            return Some("max_range_m must exceed min_range_m".into());
        }
        if self.cfar.train == 0 {
            return Some("cfar.train must be at least 1".into());
        }
        let mainlobe = self.mainlobe_half_width();
        if (self.cfar.guard as f32) < mainlobe {
            return Some(format!(
                "cfar.guard ({}) is narrower than the compressed mainlobe ({:.0} samples) —                  targets will mask themselves; use SonarConfig::for_chirp",
                self.cfar.guard, mainlobe
            ));
        }
        None
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RangeDetection {
    pub range_m: f32,
    pub amplitude: f32,
    pub snr_db: f32,
    /// Extent of the above-threshold run, converted to metres.
    pub width_m: f32,
}

#[derive(Debug, Clone)]
pub struct RangeProfile {
    /// Fractional index of the direct-path blast within the record.
    pub t0: f32,
    /// Peak amplitude of the blast — the transmit-level health check.
    pub blast_amplitude: f32,
    /// True when the ADC clipped: the record is untrustworthy and the caller
    /// should back the output level off rather than believe these ranges.
    pub saturated: bool,
    /// Envelope over `min_range_m..max_range_m`, one bin per lag sample.
    pub env: Vec<f32>,
    /// Range of `env[0]`, and the metres per bin after it.
    pub start_range_m: f32,
    pub range_step_m: f32,
    pub noise_floor: f32,
    /// How many input samples were non-finite and had to be replaced with zero.
    /// Anything above zero means the capture path is misbehaving; the profile is
    /// still usable, but a caller should surface it rather than trust the ranges
    /// blindly.
    pub sanitized: usize,
    pub detections: Vec<RangeDetection>,
}

impl RangeProfile {
    pub fn range_of_bin(&self, i: usize) -> f32 {
        self.start_range_m + i as f32 * self.range_step_m
    }
}

pub struct Pipeline {
    cfg: SonarConfig,
    mf: MatchedFilter,
    record_len: usize,
    /// Full-lag envelope scratch, reused across pings.
    env_full: Vec<f32>,
    /// Sanitised copy of the input, reused across pings so the hot path
    /// allocates nothing.
    scratch: Vec<f32>,
}

impl Pipeline {
    pub fn new(cfg: SonarConfig, record_len: usize) -> Pipeline {
        let mf = MatchedFilter::new(&cfg.chirp, record_len, cfg.rx_taper);
        Pipeline {
            cfg,
            mf,
            record_len,
            env_full: vec![0.0f32; record_len],
            scratch: vec![0.0f32; record_len],
        }
    }

    pub fn config(&self) -> &SonarConfig {
        &self.cfg
    }

    pub fn record_len(&self) -> usize {
        self.record_len
    }

    pub fn fft_size(&self) -> usize {
        self.mf.fft_size()
    }

    /// Compress one record and extract its range profile.
    pub fn process(&mut self, x: &[f32]) -> RangeProfile {
        let n = self.record_len;
        if self.env_full.len() != n {
            self.env_full.resize(n, 0.0);
        }
        if self.scratch.len() != n {
            self.scratch.resize(n, 0.0);
        }
        // Sanitise before transforming. One NaN sample poisons EVERY bin of the
        // FFT — the transform is a sum over all inputs — so a single glitched
        // frame from the capture graph would otherwise destroy the whole ping
        // rather than one sample of it. Zero is the right replacement: it is
        // what silence looks like, and the matched filter ignores it.
        let take = x.len().min(self.scratch.len());
        let mut sanitized = 0usize;
        for (slot, &v) in self.scratch[..take].iter_mut().zip(&x[..take]) {
            if v.is_finite() {
                *slot = v;
            } else {
                *slot = 0.0;
                sanitized += 1;
            }
        }
        for v in &mut self.scratch[take..] {
            *v = 0.0;
        }
        let saturated = self.scratch[..take]
            .iter()
            .filter(|v| v.abs() >= 0.995)
            .count()
            > take / 500;
        {
            let Pipeline {
                mf,
                scratch,
                env_full,
                ..
            } = self;
            mf.envelope(&scratch[..take], env_full);
        }

        // ── time origin ──────────────────────────────────────────────────────
        let search = ((self.cfg.direct_search_s * self.cfg.chirp.fs) as usize)
            .min(n)
            .max(1);
        let mut blast = 0usize;
        for i in 0..search {
            if self.env_full[i] > self.env_full[blast] {
                blast = i;
            }
        }
        let blast_amplitude = self.env_full[blast];
        let t0 = if self.cfg.sync_to_direct_path {
            cfar::parabolic_peak(&self.env_full, blast)
        } else {
            0.0
        };

        // ── blast cancellation ───────────────────────────────────────────────
        // Envelope-domain subtraction of a known shape. It is approximate — the
        // blast and a real echo do not share a phase, so this cannot cancel to
        // zero — but the skirt is deterministic and dominant, and removing most
        // of it is what buys back the 0.3-0.6 m band.
        if self.cfg.blast_cancellation && blast_amplitude > 0.0 {
            let Pipeline { mf, env_full, .. } = self;
            for (k, a) in mf.acf().iter().enumerate() {
                let idx = blast + k;
                if idx >= n {
                    break;
                }
                env_full[idx] = (env_full[idx] - blast_amplitude * a).max(0.0);
            }
        }

        // ── window the profile to the ranges we claim to measure ─────────────
        let lo_lag = (t0 + self.cfg.lag_for_range(self.cfg.min_range_m))
            .floor()
            .max(0.0) as usize;
        let hi_lag = (t0 + self.cfg.lag_for_range(self.cfg.max_range_m))
            .ceil()
            .max(0.0) as usize;
        let lo = lo_lag.min(n);
        let hi = hi_lag.min(n);
        let env: Vec<f32> = if hi > lo {
            self.env_full[lo..hi].to_vec()
        } else {
            Vec::new()
        };

        let step = self.cfg.range_per_sample();
        let start_range_m = self.cfg.range_at(lo as f32 - t0);
        let noise_floor = matched::quantile(&env, 0.5);

        // ── detection ────────────────────────────────────────────────────────
        let raw: Vec<Detection> = cfar::detect(&env, &self.cfg.cfar, 0, None);
        let detections = raw
            .iter()
            .filter(|d| d.snr_db >= self.cfg.min_snr_db)
            .map(|d| RangeDetection {
                range_m: self.cfg.range_at(lo as f32 + d.index - t0),
                amplitude: d.amplitude,
                snr_db: d.snr_db,
                width_m: d.width as f32 * step,
            })
            .collect();

        RangeProfile {
            t0,
            blast_amplitude,
            saturated,
            env,
            start_range_m,
            range_step_m: step,
            noise_floor,
            sanitized,
            detections,
        }
    }
}

/// A static design report for a config — the numbers a caller needs to decide
/// whether a parameter set is worth emitting, without emitting it.
pub struct DesignReport {
    pub speed_of_sound_m_s: f32,
    pub bandwidth_hz: f32,
    pub time_bandwidth: f32,
    pub compression_gain_db: f32,
    pub range_resolution_m: f32,
    pub blind_range_m: f32,
    pub max_unambiguous_range_m: f32,
    pub range_step_m: f32,
    pub sidelobe_db: f32,
    /// Compressed mainlobe width in samples, after BOTH tapers.
    pub mainlobe_samples: f32,
    /// The CFAR windows this waveform needs, so a host computing them itself can
    /// check its arithmetic against the core's rather than drifting silently.
    pub recommended_guard: usize,
    pub recommended_train: usize,
    pub recommended_merge_gap: usize,
    pub warning: Option<String>,
}

pub fn design_report(cfg: &SonarConfig, pri_s: f32) -> DesignReport {
    let c = cfg.speed_of_sound();
    let recommended = CfarConfig::sized_for(&cfg.chirp, cfg.rx_taper);
    DesignReport {
        speed_of_sound_m_s: c,
        bandwidth_hz: cfg.chirp.bandwidth(),
        time_bandwidth: cfg.chirp.time_bandwidth(),
        compression_gain_db: cfg.chirp.compression_gain_db(),
        range_resolution_m: cfg.chirp.range_resolution_m(c, cfg.rx_taper),
        blind_range_m: cfg.chirp.blind_range_m(c),
        max_unambiguous_range_m: c * pri_s.max(0.0) / 2.0,
        range_step_m: cfg.range_per_sample(),
        sidelobe_db: cfg
            .rx_taper
            .first_sidelobe_db()
            .min(cfg.chirp.tx_window.first_sidelobe_db()),
        mainlobe_samples: cfg.mainlobe_half_width(),
        recommended_guard: recommended.guard,
        recommended_train: recommended.train,
        recommended_merge_gap: recommended.merge_gap,
        warning: cfg.validate(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sim::{self, SceneConfig, Target};

    fn scene(targets: &[Target], cfg: &SonarConfig, scene_cfg: &SceneConfig) -> Vec<f32> {
        sim::render(&cfg.chirp, targets, scene_cfg)
    }

    fn nearest(dets: &[RangeDetection], r: f32) -> Option<&RangeDetection> {
        dets.iter().min_by(|a, b| {
            (a.range_m - r)
                .abs()
                .partial_cmp(&(b.range_m - r).abs())
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    }

    #[test]
    fn range_conversion_round_trips() {
        let cfg = SonarConfig::default();
        for r in [0.3f32, 1.0, 2.5, 6.0] {
            let lag = cfg.lag_for_range(r);
            let back = cfg.range_at(lag);
            assert!((back - r).abs() < 1e-3, "{r} -> {lag} -> {back}");
        }
        // c/(2*fs) = 343.2/96000 = 3.575 mm per sample at 48 kHz.
        assert!(
            (cfg.range_per_sample() - 0.003575).abs() < 1e-5,
            "{}",
            cfg.range_per_sample()
        );
    }

    #[test]
    fn a_single_wall_is_ranged_to_within_a_centimetre() {
        let cfg = SonarConfig::default();
        let scene_cfg = SceneConfig::default();
        let rec = scene(&[Target::wall(2.40, 0.9)], &cfg, &scene_cfg);

        let mut p = Pipeline::new(cfg.clone(), scene_cfg.record_len);
        let prof = p.process(&rec);

        assert!(!prof.saturated);
        let d = nearest(&prof.detections, 2.40).expect("a detection");
        assert!(
            (d.range_m - 2.40).abs() < 0.01,
            "ranged {} m, want 2.40 m",
            d.range_m
        );
        assert!(d.snr_db > 10.0, "snr {} dB", d.snr_db);
    }

    #[test]
    fn unknown_capture_latency_does_not_move_the_answer() {
        let cfg = SonarConfig::default();
        let base = SceneConfig::default();

        let mut ranges = Vec::new();
        for latency in [0usize, 137, 2_048, 9_311] {
            let sc = SceneConfig {
                latency_samples: latency,
                record_len: 36_000,
                ..base.clone()
            };
            let rec = scene(&[Target::wall(3.00, 0.9)], &cfg, &sc);
            let mut p = Pipeline::new(cfg.clone(), sc.record_len);
            let prof = p.process(&rec);
            let d = nearest(&prof.detections, 3.0).expect("a detection");
            ranges.push(d.range_m);
        }
        for r in &ranges {
            assert!((r - 3.0).abs() < 0.02, "latency shifted the range to {r}");
        }
        let spread = ranges.iter().fold(0.0f32, |a, b| a.max(*b))
            - ranges.iter().fold(f32::MAX, |a, b| a.min(*b));
        assert!(spread < 0.01, "range spread across latencies: {spread} m");
    }

    #[test]
    fn two_walls_are_both_found() {
        let cfg = SonarConfig::default();
        let sc = SceneConfig {
            record_len: 32_000,
            ..Default::default()
        };
        let rec = scene(&[Target::wall(1.5, 0.9), Target::wall(4.2, 0.8)], &cfg, &sc);
        let mut p = Pipeline::new(cfg.clone(), sc.record_len);
        let prof = p.process(&rec);

        let near = nearest(&prof.detections, 1.5).expect("near wall");
        let far = nearest(&prof.detections, 4.2).expect("far wall");
        assert!((near.range_m - 1.5).abs() < 0.02, "near {}", near.range_m);
        assert!((far.range_m - 4.2).abs() < 0.03, "far {}", far.range_m);
        assert!(
            near.amplitude > far.amplitude,
            "the near wall must be louder"
        );
    }

    #[test]
    fn an_empty_room_yields_no_detections() {
        let cfg = SonarConfig::default();
        let sc = SceneConfig::default();
        let rec = scene(&[], &cfg, &sc);
        let mut p = Pipeline::new(cfg, sc.record_len);
        let prof = p.process(&rec);
        assert!(
            prof.detections.is_empty(),
            "empty room produced {:?}",
            prof.detections
        );
    }

    #[test]
    fn the_blast_is_excluded_from_the_reported_profile() {
        let cfg = SonarConfig::default();
        let sc = SceneConfig::default();
        let rec = scene(&[Target::wall(2.0, 0.9)], &cfg, &sc);
        let mut p = Pipeline::new(cfg.clone(), sc.record_len);
        let prof = p.process(&rec);
        assert!(prof.blast_amplitude > 0.0, "the blast should be measured");
        assert!(
            prof.start_range_m >= cfg.min_range_m - 0.01,
            "profile starts at {} m",
            prof.start_range_m
        );
        assert!(prof
            .detections
            .iter()
            .all(|d| d.range_m >= cfg.min_range_m - 0.02));
    }

    #[test]
    fn clipping_is_reported_rather_than_silently_ranged() {
        let cfg = SonarConfig::default();
        let sc = SceneConfig {
            direct_path_gain: 8.0,
            ..Default::default()
        };
        let rec = scene(&[Target::wall(2.0, 0.9)], &cfg, &sc);
        let mut p = Pipeline::new(cfg, sc.record_len);
        let prof = p.process(&rec);
        assert!(
            prof.saturated,
            "a clipped record must set the saturated flag"
        );
    }

    #[test]
    fn noise_degrades_range_gracefully_rather_than_lying() {
        let cfg = SonarConfig::default();
        let quiet = SceneConfig {
            noise_rms: 1e-4,
            ..Default::default()
        };
        let loud = SceneConfig {
            noise_rms: 5e-2,
            ..Default::default()
        };

        let mut p = Pipeline::new(cfg.clone(), quiet.record_len);
        let q = p.process(&scene(&[Target::point(3.0, 0.7)], &cfg, &quiet));
        let l = p.process(&scene(&[Target::point(3.0, 0.7)], &cfg, &loud));

        assert!(
            q.noise_floor < l.noise_floor,
            "the floor must rise with noise"
        );
        // Under heavy noise we accept losing the target, but never a phantom
        // forest of them.
        assert!(
            l.detections.len() <= q.detections.len() + 2,
            "noise spawned detections"
        );
    }

    #[test]
    fn a_wider_sweep_resolves_two_closer_targets() {
        // Resolution is a property of the ENVELOPE — whether two echoes produce
        // two peaks with a trough between them. Whether CFAR then *reports* both
        // is a separate question about detector masking, tested below.
        let narrow = SonarConfig::for_chirp(
            ChirpSpec {
                f0: 19_000.0,
                f1: 20_000.0,
                ..ChirpSpec::default()
            },
            Window::Hann,
        );
        let wide = SonarConfig::for_chirp(
            ChirpSpec {
                f0: 17_000.0,
                f1: 23_000.0,
                ..ChirpSpec::default()
            },
            Window::Hann,
        );
        let c = narrow.speed_of_sound();
        assert!(
            wide.chirp.range_resolution_m(c, Window::Hann)
                < narrow.chirp.range_resolution_m(c, Window::Hann) / 3.0,
            "6x the bandwidth should be ~6x the resolution"
        );

        // 18 cm apart: comfortably outside the 4.8 cm cell of a 6 kHz sweep and
        // comfortably inside the 28 cm cell of a 1 kHz one.
        let targets = [Target::point(2.00, 0.7), Target::point(2.18, 0.7)];
        let sc = SceneConfig {
            noise_rms: 5e-4,
            ..Default::default()
        };

        // How deep is the trough between the two echoes, as a fraction of the
        // smaller peak? 1.0 = no dip at all (unresolved), 0 = fully separated.
        let trough_ratio = |cfg: &SonarConfig| -> f32 {
            let rec = sim::render(&cfg.chirp, &targets, &sc);
            let mut p = Pipeline::new(cfg.clone(), sc.record_len);
            let prof = p.process(&rec);
            let bin = |r: f32| ((r - prof.start_range_m) / prof.range_step_m).round() as usize;
            let (b1, b2) = (bin(2.00), bin(2.18));
            assert!(b2 < prof.env.len(), "targets must fall inside the profile");
            let p1 = prof.env[b1.saturating_sub(3)..=b1 + 3]
                .iter()
                .fold(0.0f32, |a, b| a.max(*b));
            let p2 = prof.env[b2 - 3..=b2 + 3]
                .iter()
                .fold(0.0f32, |a, b| a.max(*b));
            let trough = prof.env[b1 + 3..b2 - 3]
                .iter()
                .fold(f32::MAX, |a, b| a.min(*b));
            trough / p1.min(p2)
        };

        let wide_t = trough_ratio(&wide);
        let narrow_t = trough_ratio(&narrow);
        assert!(
            wide_t < 0.5,
            "the wide sweep should show a clear trough, got {wide_t}"
        );
        assert!(
            narrow_t > 0.8,
            "the narrow sweep should smear them together, got {narrow_t}"
        );
    }

    #[test]
    fn the_detector_levers_trade_masking_against_false_alarms() {
        // Two targets 18 cm apart — a few resolution cells at 6 kHz of sweep. The matched filter resolves them cleanly (see the test above);
        // whether the DETECTOR reports them is a separate question, and the
        // answer depends entirely on three levers. This test pins down the
        // tradeoff those levers make, because it is the whole reason the
        // flywheel has something to optimise.
        let base = SonarConfig::for_chirp(
            ChirpSpec {
                f0: 17_000.0,
                f1: 23_000.0,
                ..ChirpSpec::default()
            },
            Window::Hann,
        );
        let targets = [Target::point(2.00, 0.7), Target::point(2.18, 0.7)];
        let sc = SceneConfig {
            noise_rms: 5e-4,
            ..Default::default()
        };
        let rec = sim::render(&base.chirp, &targets, &sc);

        let detect_in_band = |cfar: crate::cfar::CfarConfig| -> Vec<RangeDetection> {
            let cfg = SonarConfig {
                cfar,
                ..base.clone()
            };
            let mut p = Pipeline::new(cfg, sc.record_len);
            p.process(&rec)
                .detections
                .into_iter()
                .filter(|d| (1.85..2.30).contains(&d.range_m))
                .collect()
        };
        let real =
            |d: &RangeDetection| (d.range_m - 2.00).abs() < 0.03 || (d.range_m - 2.18).abs() < 0.03;

        // 1. Cell-averaging CFAR at the auto-sized guard band: each target sits
        //    in the other's training window, so the pair masks ITSELF entirely.
        let ca = detect_in_band(base.cfar);
        assert!(
            ca.is_empty(),
            "CA-CFAR is expected to mask the pair, got {ca:?}"
        );

        // 2. Ordered-statistic CFAR sorts the interferer away — but only if the
        //    rank is low enough to discard it. The default 0.75 is not.
        let os_default = detect_in_band(crate::cfar::CfarConfig {
            kind: crate::cfar::CfarKind::OrderedStatistic,
            ..base.cfar
        });
        assert!(
            os_default.is_empty(),
            "rank 0.75 keeps the interferer, got {os_default:?}"
        );

        let os_low = detect_in_band(crate::cfar::CfarConfig {
            kind: crate::cfar::CfarKind::OrderedStatistic,
            os_rank_frac: 0.5,
            ..base.cfar
        });
        assert_eq!(
            os_low.len(),
            2,
            "OS-CFAR at rank 0.5 should find both: {os_low:?}"
        );
        assert!(
            os_low.iter().all(real),
            "and both should be REAL: {os_low:?}"
        );
        assert!(
            os_low.iter().all(|d| d.snr_db > 10.0),
            "with margin: {os_low:?}"
        );

        // 3. Widening the guard band past the neighbour also recovers the pair.
        //
        //    This USED to be a genuine tradeoff: a wide guard pushes the training
        //    cells out onto the matched filter's range sidelobes, and with the
        //    old lightly-tapered transmit pulse (-13 dB sidelobes) those became
        //    false alarms, so sensitivity cost ghosts. Moving to a full Hann
        //    TRANSMIT taper put the sidelobes 45 dB down and the tradeoff
        //    disappeared — a wide guard is now simply better here.
        //
        //    That is worth an assertion rather than a deleted test: it pins down
        //    a real consequence of the waveform decision in ADR-004, and if the
        //    transmit taper is ever weakened the ghosts come back and this fails.
        let wide = detect_in_band(crate::cfar::CfarConfig {
            guard: 80,
            train: 160,
            ..base.cfar
        });
        assert_eq!(
            wide.iter().filter(|d| real(d)).count(),
            2,
            "wide guard finds both: {wide:?}"
        );
        assert!(
            wide.iter().all(real),
            "with a full Hann transmit taper a wide guard should invent NO ghosts, got {wide:?}"
        );
        assert!(
            wide.iter().all(|d| d.snr_db > os_low[0].snr_db),
            "excluding the neighbour from training should also raise the margin"
        );
    }

    #[test]
    fn a_mis_sized_guard_band_is_reported_rather_than_silently_masking() {
        // The struct-update footgun: keep the default CFAR while widening the
        // sweep and the guard band no longer clears the mainlobe.
        let sloppy = SonarConfig {
            chirp: ChirpSpec {
                f0: 19_800.0,
                f1: 20_000.0,
                ..ChirpSpec::default()
            },
            ..SonarConfig::default()
        };
        let complaint = sloppy
            .validate()
            .expect("a narrow sweep needs a wider guard");
        assert!(complaint.contains("cfar.guard"), "{complaint}");

        // for_chirp sizes it correctly and validates clean.
        let careful = SonarConfig::for_chirp(sloppy.chirp, sloppy.rx_taper);
        assert!(careful.validate().is_none(), "{:?}", careful.validate());
        assert!(careful.cfar.guard > sloppy.cfar.guard);
    }

    #[test]
    fn the_design_report_agrees_with_the_formulas() {
        let cfg = SonarConfig::default();
        let r = design_report(&cfg, 0.050);
        assert!((r.speed_of_sound_m_s - 343.2).abs() < 0.5);
        assert!((r.bandwidth_hz - 3000.0).abs() < 1.0);
        assert!((r.compression_gain_db - 11.76).abs() < 0.05);
        // c * PRI / 2 = 343.2 * 0.05 / 2 = 8.58 m
        assert!(
            (r.max_unambiguous_range_m - 8.58).abs() < 0.05,
            "{}",
            r.max_unambiguous_range_m
        );
        // fs/B * 1.67 = 16 * 1.67
        assert!(
            (r.mainlobe_samples - 26.7).abs() < 0.5,
            "{}",
            r.mainlobe_samples
        );
        assert!(r.recommended_guard >= 40, "{}", r.recommended_guard);
        // The reported sidelobe level is the BETTER of the two tapers: the
        // transmit taper alone already achieves it.
        assert!((r.sidelobe_db + 31.5).abs() < 0.1, "{}", r.sidelobe_db);
        assert!(r.warning.is_none(), "{:?}", r.warning);

        let bad = SonarConfig {
            chirp: ChirpSpec {
                f1: 30_000.0,
                ..ChirpSpec::default()
            },
            ..SonarConfig::default()
        };
        assert!(design_report(&bad, 0.05).warning.is_some());
    }

    #[test]
    fn non_finite_samples_are_sanitised_rather_than_poisoning_the_ping() {
        // One NaN sample would otherwise turn every FFT bin into a NaN, losing
        // the whole ping instead of one 20-microsecond sample of it.
        let cfg = SonarConfig::default();
        let sc = SceneConfig::default();
        let clean = sim::render(&cfg.chirp, &[Target::wall(2.4, 0.9)], &sc);

        let mut dirty = clean.clone();
        dirty[100] = f32::NAN;
        dirty[7_000] = f32::INFINITY;
        dirty[7_001] = f32::NEG_INFINITY;

        let mut p = Pipeline::new(cfg, sc.record_len);
        let a = p.process(&clean);
        let b = p.process(&dirty);

        assert_eq!(a.sanitized, 0);
        assert_eq!(b.sanitized, 3, "all three bad samples should be counted");
        assert!(
            b.env.iter().all(|v| v.is_finite()),
            "the envelope must stay finite"
        );
        let wall = b
            .detections
            .iter()
            .find(|d| (d.range_m - 2.4).abs() < 0.05)
            .expect("the wall should survive three bad samples");
        assert!(wall.snr_db > 10.0, "snr {}", wall.snr_db);
    }

    #[test]
    fn processing_is_deterministic_across_repeat_calls() {
        let cfg = SonarConfig::default();
        let sc = SceneConfig::default();
        let rec = scene(
            &[Target::wall(2.4, 0.9), Target::point(1.1, 0.5)],
            &cfg,
            &sc,
        );
        let mut p = Pipeline::new(cfg, sc.record_len);
        let a = p.process(&rec);
        let b = p.process(&rec);
        assert_eq!(
            a.detections, b.detections,
            "the same record must give the same answer"
        );
        assert_eq!(a.env, b.env);
    }
}
