//! Linear-FM (chirp) synthesis — the emitted "call".
//!
//! An iPhone's usable ultrasonic band is narrow and it ends abruptly: the
//! speaker and the mic both roll off hard above ~21 kHz, and a 48 kHz
//! AudioContext puts Nyquist at 24 kHz. So BatVu sweeps roughly 18-22 kHz and
//! buys its range performance with *pulse compression* rather than with a short
//! loud pulse (which the speaker cannot produce anyway).
//!
//! The governing relations:
//!
//! * range resolution      `dr = c / (2 * B)`         — the 2 is the two-way trip
//! * compression gain      `G  = 10 * log10(B * T)`   — the time-bandwidth product
//! * unambiguous range     `r_max = c * PRI / 2`
//!
//! With `B = 4 kHz` and `c = 343 m/s`, `dr = 4.3 cm` — about a fist. Widening the
//! sweep is the only way to sharpen that, and the hardware says how far you can
//! widen it. Lengthening `T` buys SNR, not resolution.

use crate::window::{self, Window};

/// Speed of sound in dry air at temperature `t_c` degrees Celsius.
/// `c = 331.3 * sqrt(1 + T/273.15)`, i.e. 343.2 m/s at 20 C.
pub fn speed_of_sound(t_c: f32) -> f32 {
    331.3 * (1.0 + t_c / 273.15).max(0.0).sqrt()
}

#[derive(Debug, Clone, Copy)]
pub struct ChirpSpec {
    /// Sample rate in Hz (48000 on iOS).
    pub fs: f32,
    /// Sweep start frequency in Hz.
    pub f0: f32,
    /// Sweep end frequency in Hz.
    pub f1: f32,
    /// Pulse duration in seconds.
    pub duration_s: f32,
    /// Amplitude taper applied to the transmitted waveform.
    pub tx_window: Window,
    /// Tukey shoulder fraction when `tx_window` is `Tukey`.
    pub tukey_alpha: f32,
    /// Peak amplitude in [0, 1] — the emitted level, kept well below clipping
    /// because a clipped ultrasonic chirp folds harmonics into the audible band.
    pub amplitude: f32,
}

impl Default for ChirpSpec {
    fn default() -> Self {
        ChirpSpec {
            fs: 48_000.0,
            f0: 18_000.0,
            f1: 22_000.0,
            duration_s: 0.010,
            tx_window: Window::Tukey,
            tukey_alpha: 0.20,
            amplitude: 0.60,
        }
    }
}

impl ChirpSpec {
    pub fn len_samples(&self) -> usize {
        ((self.duration_s * self.fs).round() as usize).max(2)
    }

    /// Sweep bandwidth in Hz (always positive; a down-sweep is allowed).
    pub fn bandwidth(&self) -> f32 {
        (self.f1 - self.f0).abs()
    }

    /// Time-bandwidth product — the compression gain, linear.
    pub fn time_bandwidth(&self) -> f32 {
        self.bandwidth() * self.duration_s
    }

    /// Pulse-compression processing gain in dB.
    pub fn compression_gain_db(&self) -> f32 {
        let bt = self.time_bandwidth();
        if bt <= 1.0 {
            0.0
        } else {
            10.0 * bt.log10()
        }
    }

    /// Two-way range resolution in metres, including the window's mainlobe
    /// widening — the honest number, not the textbook `c/2B`.
    pub fn range_resolution_m(&self, c: f32, rx_taper: Window) -> f32 {
        let b = self.bandwidth().max(1.0);
        (c / (2.0 * b)) * rx_taper.mainlobe_widening()
    }

    /// The blind zone: nothing can be resolved closer than half a pulse length,
    /// because the transmitter is still talking while the echo arrives.
    /// Pulse compression shrinks the *effective* blind zone to the compressed
    /// pulse width, but the direct-path blast still saturates the first
    /// `duration_s` of the record, so this is the practical floor.
    pub fn blind_range_m(&self, c: f32) -> f32 {
        c * self.duration_s / 2.0
    }

    /// Validate the spec against sampling theory and return a human-readable
    /// complaint. `None` means the spec is realisable.
    pub fn validate(&self) -> Option<String> {
        if !(self.fs > 0.0 && self.fs.is_finite()) {
            return Some("fs must be positive and finite".into());
        }
        let nyquist = self.fs / 2.0;
        let top = self.f0.max(self.f1);
        let bottom = self.f0.min(self.f1);
        if top >= nyquist {
            return Some(format!(
                "sweep reaches {top:.0} Hz but Nyquist is {nyquist:.0} Hz — it would alias"
            ));
        }
        if bottom <= 0.0 {
            return Some("sweep must stay above 0 Hz".into());
        }
        if self.bandwidth() < 1.0 {
            return Some("bandwidth must be at least 1 Hz".into());
        }
        if !(self.duration_s > 0.0) || self.len_samples() < 8 {
            return Some("duration is too short to sample".into());
        }
        if !(0.0..=1.0).contains(&self.amplitude) {
            return Some("amplitude must lie in [0, 1]".into());
        }
        None
    }
}

/// Normalised position of sample `i` within the pulse, in [0, 1).
///
/// The PERIODIC convention (`i / n`, not `i / (n-1)`): the pulse occupies
/// `[0, T)` and sample `i` sits at `t = i/fs`, so `x = t/T`. Using the symmetric
/// convention here would make `synth_real` and [`sample_at`] disagree by one
/// sample's worth of window, and the matched filter would then be very slightly
/// mismatched to its own transmit waveform — a self-inflicted SNR loss that is
/// invisible until you go looking for it.
#[inline]
fn window_pos(spec: &ChirpSpec, i: usize) -> f32 {
    i as f32 / (spec.fs * spec.duration_s).max(1.0)
}

/// The real transmit waveform: `a * w[n] * sin(phase(n))`.
pub fn synth_real(spec: &ChirpSpec) -> Vec<f32> {
    let n = spec.len_samples();
    let mut out = vec![0.0f32; n];
    for (i, slot) in out.iter_mut().enumerate() {
        let w = window::eval(spec.tx_window, window_pos(spec, i), spec.tukey_alpha);
        *slot = spec.amplitude * w * phase_at(spec, i).sin();
    }
    out
}

/// The complex analytic reference `w[n] * exp(j*phase(n))`.
///
/// Correlating a *real* received signal against an *analytic* reference yields
/// the complex envelope directly — the negative-frequency half of the received
/// spectrum is annihilated by the reference's one-sided spectrum. That saves a
/// separate Hilbert transform, which on a phone is a whole extra FFT pair per
/// ping. `|y[n]|` is then the range envelope with no further work.
pub fn synth_analytic(spec: &ChirpSpec) -> (Vec<f32>, Vec<f32>) {
    let n = spec.len_samples();
    let mut re = vec![0.0f32; n];
    let mut im = vec![0.0f32; n];
    for i in 0..n {
        let w = window::eval(spec.tx_window, window_pos(spec, i), spec.tukey_alpha);
        let p = phase_at(spec, i);
        re[i] = w * p.cos();
        im[i] = w * p.sin();
    }
    (re, im)
}

/// Instantaneous phase of the sweep at sample `i`, in radians.
///
/// `phi(t) = 2*pi*(f0*t + (k/2)*t^2)` with `k = (f1 - f0)/T`. Accumulated in
/// f64 because at 22 kHz and 20 ms the total phase is ~2800 rad; in f32 the
/// quadratic term would lose the last bits of the sweep and smear the
/// compressed peak.
#[inline]
fn phase_at(spec: &ChirpSpec, i: usize) -> f32 {
    let t = i as f64 / spec.fs as f64;
    let f0 = spec.f0 as f64;
    let k = (spec.f1 as f64 - f0) / spec.duration_s.max(1e-9) as f64;
    let phi = std::f64::consts::TAU * (f0 * t + 0.5 * k * t * t);
    // Wrap before narrowing so f32 keeps its precision near zero.
    (phi % std::f64::consts::TAU) as f32
}

/// The transmit waveform evaluated at an arbitrary time `t` seconds from the
/// start of the pulse — zero outside `[0, duration_s]`.
///
/// This exists so a delayed echo can be rendered EXACTLY rather than
/// interpolated. Resampling a 20 kHz signal at 48 kHz by linear interpolation
/// attenuates it by up to 11 dB depending on the fractional offset, which would
/// make a simulated echo's amplitude depend on the sub-millimetre part of its
/// range — an artifact indistinguishable from real physics, and one the
/// flywheel would happily optimise against.
#[inline]
pub fn sample_at(spec: &ChirpSpec, t: f32) -> f32 {
    if !(0.0..=spec.duration_s).contains(&t) {
        return 0.0;
    }
    let x = t / spec.duration_s.max(1e-9);
    let env = crate::window::eval(spec.tx_window, x, spec.tukey_alpha);
    let f0 = spec.f0 as f64;
    let k = (spec.f1 as f64 - f0) / spec.duration_s.max(1e-9) as f64;
    let td = t as f64;
    let phi = std::f64::consts::TAU * (f0 * td + 0.5 * k * td * td);
    spec.amplitude * env * ((phi % std::f64::consts::TAU) as f32).sin()
}

/// Instantaneous frequency of the sweep at time `t` seconds — used by tests and
/// by the audification path (the classic bat-detector heterodyne).
pub fn instantaneous_freq(spec: &ChirpSpec, t: f32) -> f32 {
    let k = (spec.f1 - spec.f0) / spec.duration_s.max(1e-9);
    spec.f0 + k * t
}

#[cfg(test)]
mod tests {
    use super::*;

    fn goertzel_power(x: &[f32], fs: f32, f: f32) -> f32 {
        let n = x.len() as f32;
        let k = (0.5 + n * f / fs).floor();
        let w = std::f32::consts::TAU * k / n;
        let (cw, sw) = (w.cos(), w.sin());
        let coeff = 2.0 * cw;
        let (mut s1, mut s2) = (0.0f32, 0.0f32);
        for &v in x {
            let s0 = coeff * s1 - s2 + v;
            s2 = s1;
            s1 = s0;
        }
        let re = s1 - s2 * cw;
        let im = s2 * sw;
        re * re + im * im
    }

    #[test]
    fn speed_of_sound_matches_the_textbook_values() {
        assert!(
            (speed_of_sound(0.0) - 331.3).abs() < 0.1,
            "{}",
            speed_of_sound(0.0)
        );
        assert!(
            (speed_of_sound(20.0) - 343.2).abs() < 0.5,
            "{}",
            speed_of_sound(20.0)
        );
        assert!(speed_of_sound(30.0) > speed_of_sound(20.0));
    }

    #[test]
    fn energy_sits_inside_the_sweep_band_and_not_outside_it() {
        let spec = ChirpSpec::default(); // 18-22 kHz
        let x = synth_real(&spec);
        let inside = goertzel_power(&x, spec.fs, 20_000.0);
        let below = goertzel_power(&x, spec.fs, 8_000.0);
        let above = goertzel_power(&x, spec.fs, 23_500.0);
        assert!(inside > 1000.0 * below, "in-band {inside} vs 8 kHz {below}");
        assert!(
            inside > 1000.0 * above,
            "in-band {inside} vs 23.5 kHz {above}"
        );
    }

    #[test]
    fn the_taper_suppresses_audible_splatter_versus_a_rectangular_pulse() {
        let rect = ChirpSpec {
            tx_window: crate::window::Window::Rect,
            ..ChirpSpec::default()
        };
        let tapered = ChirpSpec::default(); // Tukey 0.2

        // 12 kHz is well inside the audible range; a hard-edged pulse leaks there.
        let leak_rect = goertzel_power(&synth_real(&rect), rect.fs, 12_000.0);
        let leak_taper = goertzel_power(&synth_real(&tapered), tapered.fs, 12_000.0);
        assert!(
            leak_taper < leak_rect,
            "tapering should reduce audible splatter: rect {leak_rect} taper {leak_taper}"
        );
    }

    #[test]
    fn amplitude_is_respected_and_never_clips() {
        let spec = ChirpSpec {
            amplitude: 0.6,
            ..ChirpSpec::default()
        };
        let x = synth_real(&spec);
        let peak = x.iter().fold(0.0f32, |a, b| a.max(b.abs()));
        assert!(peak <= 0.6 + 1e-4, "peak {peak} exceeds amplitude");
        assert!(peak > 0.5, "peak {peak} is suspiciously low");
    }

    #[test]
    fn the_analytic_reference_has_unit_modulus_under_its_window() {
        let spec = ChirpSpec::default();
        let (re, im) = synth_analytic(&spec);
        for i in 0..re.len() {
            let w = crate::window::eval(spec.tx_window, window_pos(&spec, i), spec.tukey_alpha);
            let m = (re[i] * re[i] + im[i] * im[i]).sqrt();
            assert!((m - w).abs() < 1e-4, "modulus at {i}: {m} vs window {w}");
        }
    }

    #[test]
    fn derived_quantities_agree_with_the_formulas() {
        let spec = ChirpSpec::default();
        assert!((spec.bandwidth() - 4000.0).abs() < 1e-3);
        assert!((spec.time_bandwidth() - 40.0).abs() < 1e-3);
        // 10*log10(40) = 16.02 dB
        assert!(
            (spec.compression_gain_db() - 16.02).abs() < 0.05,
            "{}",
            spec.compression_gain_db()
        );

        let c = speed_of_sound(20.0);
        // c/(2B) = 343.2/8000 = 4.29 cm, x1.67 for the hann receive taper.
        let dr = spec.range_resolution_m(c, Window::Hann);
        assert!((dr - 0.0716).abs() < 0.002, "{dr}");
        // Half a 10 ms pulse.
        assert!(
            (spec.blind_range_m(c) - 1.716).abs() < 0.01,
            "{}",
            spec.blind_range_m(c)
        );
    }

    #[test]
    fn validate_rejects_specs_that_would_alias() {
        let mut spec = ChirpSpec::default();
        assert!(spec.validate().is_none());

        spec.f1 = 30_000.0; // above Nyquist at 48 kHz
        let complaint = spec.validate().expect("should be rejected");
        assert!(complaint.contains("Nyquist"), "{complaint}");

        let spec = ChirpSpec {
            amplitude: 1.5,
            ..ChirpSpec::default()
        };
        assert!(spec.validate().unwrap().contains("amplitude"));

        let spec = ChirpSpec {
            duration_s: 0.0,
            ..ChirpSpec::default()
        };
        assert!(spec.validate().is_some());
    }

    #[test]
    fn the_analytic_and_real_references_share_one_waveform_definition() {
        // If these drift apart the matched filter is mismatched to its own
        // transmit pulse and quietly loses SNR.
        let spec = ChirpSpec::default();
        let real = synth_real(&spec);
        let (re, _im) = synth_analytic(&spec);
        for (i, r) in re.iter().enumerate() {
            let w = crate::window::eval(spec.tx_window, window_pos(&spec, i), spec.tukey_alpha);
            assert!((r - w * phase_at(&spec, i).cos()).abs() < 1e-5, "{i}");
        }
        assert_eq!(real.len(), re.len());
    }

    #[test]
    fn sample_at_reproduces_the_sampled_waveform_on_the_grid() {
        let spec = ChirpSpec::default();
        let x = synth_real(&spec);
        // Tolerance is set by the f32 time argument, not by the algorithm: at
        // 20 kHz an f32 second carries ~1e-10 s of rounding, which is ~1e-5 rad
        // of phase. That is far below any acoustic effect and well inside the
        // matched filter's tolerance.
        for (i, v) in x.iter().enumerate() {
            let t = i as f32 / spec.fs;
            assert!((sample_at(&spec, t) - v).abs() < 2e-4, "sample {i}");
        }
        assert_eq!(sample_at(&spec, -0.001), 0.0);
        assert_eq!(sample_at(&spec, spec.duration_s + 0.001), 0.0);
    }

    #[test]
    fn a_fractionally_delayed_pulse_keeps_its_energy() {
        // The property linear interpolation destroys: shifting by half a sample
        // must not change the pulse's energy at 20 kHz.
        let spec = ChirpSpec::default();
        let energy = |frac: f32| -> f32 {
            let n = spec.len_samples() + 2;
            let v: Vec<f32> = (0..n)
                .map(|i| sample_at(&spec, (i as f32 - frac) / spec.fs))
                .collect();
            v.iter().map(|x| x * x).sum::<f32>()
        };
        let e0 = energy(0.0);
        for frac in [0.1f32, 0.25, 0.5, 0.75, 0.9] {
            let e = energy(frac);
            let db = 10.0 * (e / e0).log10();
            assert!(db.abs() < 0.2, "delay {frac} changed energy by {db} dB");
        }
    }

    #[test]
    fn instantaneous_frequency_sweeps_from_f0_to_f1() {
        let spec = ChirpSpec::default();
        assert!((instantaneous_freq(&spec, 0.0) - 18_000.0).abs() < 1.0);
        assert!((instantaneous_freq(&spec, spec.duration_s) - 22_000.0).abs() < 1.0);
        assert!((instantaneous_freq(&spec, spec.duration_s / 2.0) - 20_000.0).abs() < 1.0);
    }
}
