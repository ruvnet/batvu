//! Matched filtering (pulse compression) — the step that turns a long, quiet,
//! speaker-friendly chirp into a short, sharp range spike.
//!
//! Three decisions worth stating, because each one saves real work on a phone:
//!
//! 1. **Correlate against an ANALYTIC reference.** The received signal is real;
//!    the reference is `w[n]*exp(j*phi(n))`, one-sided in frequency. The product
//!    `X * conj(R)` therefore keeps only the positive-frequency half of the
//!    received spectrum, so the inverse transform is already the complex
//!    envelope and `|y|` is the range profile. No separate Hilbert transform —
//!    that is one whole FFT pair per ping we do not pay for.
//!
//! 2. **Taper the reference SPECTRUM, not the reference waveform.** For an LFM
//!    sweep, frequency maps monotonically to time, so weighting the band is the
//!    textbook way to trade mainlobe width for range sidelobes. Zeroing bins
//!    outside the sweep makes the same operation a free matched bandpass, which
//!    is where most of the out-of-band room noise dies.
//!
//! 3. **Frequency-domain correlation.** Direct correlation of a 480-sample
//!    reference over a 24000-sample record is ~11.5M multiply-adds per ping; one
//!    forward FFT (the reference spectrum is precomputed once), a complex
//!    multiply and one inverse FFT over 32768 points is ~2 x 32768 x 15 ~ 1M.
//!    At 20 pings/s that is the difference between comfortable and hot.

use crate::chirp::ChirpSpec;
use crate::fft::{next_pow2, Fft};
use crate::window::{self, Window};

pub struct MatchedFilter {
    fft: Fft,
    n: usize,
    pulse_len: usize,
    /// Conjugated, band-tapered reference spectrum.
    href_re: Vec<f32>,
    href_im: Vec<f32>,
    /// Scratch transform buffers, owned so the hot path allocates nothing.
    buf_re: Vec<f32>,
    buf_im: Vec<f32>,
    /// This filter's own autocorrelation envelope, peak-normalised to 1.0 and
    /// truncated where it stops mattering. It is the exact shape the direct-path
    /// blast will take in every record, which is what makes blast cancellation
    /// possible (see `Pipeline::process`).
    acf: Vec<f32>,
}

impl MatchedFilter {
    /// Build a plan for one (chirp, record length, receive taper) combination.
    pub fn new(spec: &ChirpSpec, record_len: usize, rx_taper: Window) -> MatchedFilter {
        let pulse_len = spec.len_samples();
        let n = next_pow2(record_len + pulse_len);
        let fft = Fft::new(n);

        let (rre, rim) = crate::chirp::synth_analytic(spec);
        let mut href_re = vec![0.0f32; n];
        let mut href_im = vec![0.0f32; n];
        href_re[..pulse_len].copy_from_slice(&rre);
        href_im[..pulse_len].copy_from_slice(&rim);
        fft.forward(&mut href_re, &mut href_im);

        // Band taper + matched bandpass, applied across the sweep's bins only.
        let f_lo = spec.f0.min(spec.f1);
        let f_hi = spec.f0.max(spec.f1);
        let bin_hz = spec.fs / n as f32;
        let taper = window::make(TAPER_LUT, rx_taper, 1.0);
        for k in 0..n {
            let f = k as f32 * bin_hz;
            // The analytic reference has no negative-frequency content; zero the
            // upper half outright so numerical crumbs cannot leak back in.
            let keep = k < n / 2 && f >= f_lo && f <= f_hi;
            let g = if keep {
                let u = ((f - f_lo) / (f_hi - f_lo)).clamp(0.0, 1.0);
                let idx = (u * (TAPER_LUT - 1) as f32).round() as usize;
                taper[idx.min(TAPER_LUT - 1)]
            } else {
                0.0
            };
            // Conjugate here so the hot path is a plain complex multiply.
            href_re[k] *= g;
            href_im[k] *= -g;
        }

        // Normalise so a noiseless, unit-amplitude echo compresses to ~1.0.
        let energy: f32 = (0..n)
            .map(|k| href_re[k] * href_re[k] + href_im[k] * href_im[k])
            .sum::<f32>()
            / n as f32;
        if energy > 0.0 {
            let s = 1.0 / energy;
            for k in 0..n {
                href_re[k] *= s;
                href_im[k] *= s;
            }
        }

        let mut mf = MatchedFilter {
            fft,
            n,
            pulse_len,
            href_re,
            href_im,
            buf_re: vec![0.0f32; n],
            buf_im: vec![0.0f32; n],
            acf: Vec::new(),
        };

        // Push the transmit waveform through the filter to learn its own
        // compressed shape. Doing it here, once, costs one FFT pair at plan
        // time and nothing per ping.
        let tx = crate::chirp::synth_real(spec);
        let acf_len = (16 * pulse_len).min(record_len).max(pulse_len);
        let mut acf = vec![0.0f32; acf_len];
        mf.envelope(&tx, &mut acf);
        let peak = acf.iter().fold(0.0f32, |a, b| a.max(*b)).max(1e-20);
        for v in acf.iter_mut() {
            *v /= peak;
        }
        mf.acf = acf;
        mf
    }

    /// The filter's peak-normalised autocorrelation envelope: `acf[k]` is the
    /// relative response `k` samples after a perfectly matched arrival.
    pub fn acf(&self) -> &[f32] {
        &self.acf
    }

    pub fn fft_size(&self) -> usize {
        self.n
    }

    pub fn pulse_len(&self) -> usize {
        self.pulse_len
    }

    /// Compress `x` and write the magnitude envelope into `out`.
    ///
    /// `out[m]` is the response at lag `m` samples, i.e. an echo whose round
    /// trip took `m/fs` seconds relative to the moment the pulse left the
    /// speaker. `out` is truncated to its own length; callers size it to the
    /// maximum range they care about.
    pub fn envelope(&mut self, x: &[f32], out: &mut [f32]) {
        let n = self.n;
        let take = x.len().min(n);
        self.buf_re[..take].copy_from_slice(&x[..take]);
        for v in &mut self.buf_re[take..] {
            *v = 0.0;
        }
        for v in &mut self.buf_im[..] {
            *v = 0.0;
        }

        self.fft.forward(&mut self.buf_re, &mut self.buf_im);
        for k in 0..n {
            let (ar, ai) = (self.buf_re[k], self.buf_im[k]);
            let (br, bi) = (self.href_re[k], self.href_im[k]);
            self.buf_re[k] = ar * br - ai * bi;
            self.buf_im[k] = ar * bi + ai * br;
        }
        self.fft.inverse(&mut self.buf_re, &mut self.buf_im);

        let lags = out.len().min(n);
        for (m, slot) in out[..lags].iter_mut().enumerate() {
            let (r, i) = (self.buf_re[m], self.buf_im[m]);
            *slot = (r * r + i * i).sqrt();
        }
        for v in &mut out[lags..] {
            *v = 0.0;
        }
    }
}

const TAPER_LUT: usize = 512;

/// Convert a linear envelope to dB relative to its own peak, floored at
/// `floor_db` so a silent bin does not become -inf and poison the renderer.
pub fn to_db_rel_peak(env: &[f32], out: &mut [f32], floor_db: f32) {
    let peak = env.iter().fold(0.0f32, |a, b| a.max(*b)).max(1e-20);
    for (i, slot) in out.iter_mut().enumerate() {
        let v = env.get(i).copied().unwrap_or(0.0);
        *slot = if v <= 0.0 {
            floor_db
        } else {
            (20.0 * (v / peak).log10()).max(floor_db)
        };
    }
}

/// Robust noise-floor estimate: the `q`-quantile of the envelope (q ~ 0.5).
/// A mean would be dragged up by the direct-path blast and the wall echoes,
/// which is exactly the thing we are trying to measure *around*.
pub fn quantile(env: &[f32], q: f32) -> f32 {
    if env.is_empty() {
        return 0.0;
    }
    let mut v: Vec<f32> = env.to_vec();
    v.sort_by(|a, b| a.total_cmp(b));
    let idx = ((v.len() - 1) as f32 * q.clamp(0.0, 1.0)).round() as usize;
    v[idx]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chirp::{self, ChirpSpec};

    /// Place a scaled, delayed copy of the transmit waveform into a record.
    fn echo_at(record: &mut [f32], tx: &[f32], delay: usize, gain: f32) {
        for (i, s) in tx.iter().enumerate() {
            if let Some(slot) = record.get_mut(delay + i) {
                *slot += gain * s;
            }
        }
    }

    fn argmax(v: &[f32]) -> usize {
        let mut best = 0usize;
        for (i, x) in v.iter().enumerate() {
            if *x > v[best] {
                best = i;
            }
        }
        best
    }

    #[test]
    fn a_single_echo_compresses_to_a_peak_at_its_delay() {
        let spec = ChirpSpec::default();
        let tx = chirp::synth_real(&spec);
        let record_len = 24_000;
        let delay = 5_000usize;

        let mut rec = vec![0.0f32; record_len];
        echo_at(&mut rec, &tx, delay, 0.5);

        let mut mf = MatchedFilter::new(&spec, record_len, Window::Hann);
        let mut env = vec![0.0f32; record_len];
        mf.envelope(&rec, &mut env);

        assert_eq!(
            argmax(&env),
            delay,
            "compressed peak should land on the echo delay"
        );
    }

    #[test]
    fn the_compressed_peak_is_far_narrower_than_the_pulse() {
        let spec = ChirpSpec::default();
        let tx = chirp::synth_real(&spec);
        let record_len = 24_000;
        let delay = 8_000usize;

        let mut rec = vec![0.0f32; record_len];
        echo_at(&mut rec, &tx, delay, 1.0);

        let mut mf = MatchedFilter::new(&spec, record_len, Window::Hann);
        let mut env = vec![0.0f32; record_len];
        mf.envelope(&rec, &mut env);

        let peak = env[delay];
        // Width at -6 dB (half amplitude).
        let mut lo = delay;
        while lo > 0 && env[lo] > peak * 0.5 {
            lo -= 1;
        }
        let mut hi = delay;
        while hi + 1 < env.len() && env[hi] > peak * 0.5 {
            hi += 1;
        }
        let width = hi - lo;
        // 480-sample pulse compressed by BT=40; a hann taper widens the ~12
        // sample mainlobe to roughly 20. Anything under 40 proves compression.
        assert!(
            width < 40,
            "compressed width {width} samples (pulse is {})",
            tx.len()
        );
    }

    #[test]
    fn two_echoes_separated_by_more_than_the_resolution_stay_separate() {
        let spec = ChirpSpec::default();
        let c = chirp::speed_of_sound(20.0);
        let tx = chirp::synth_real(&spec);
        let record_len = 24_000;

        // dr ~ 7.2 cm with a hann taper -> 0.42 ms -> ~20 samples. Use 60.
        let (d1, d2) = (6_000usize, 6_060usize);
        let mut rec = vec![0.0f32; record_len];
        echo_at(&mut rec, &tx, d1, 0.8);
        echo_at(&mut rec, &tx, d2, 0.8);

        let mut mf = MatchedFilter::new(&spec, record_len, Window::Hann);
        let mut env = vec![0.0f32; record_len];
        mf.envelope(&rec, &mut env);

        let trough = env[d1 + 1..d2].iter().fold(f32::MAX, |a, b| a.min(*b));
        let p1 = env[d1 - 2..=d1 + 2].iter().fold(0.0f32, |a, b| a.max(*b));
        let p2 = env[d2 - 2..=d2 + 2].iter().fold(0.0f32, |a, b| a.max(*b));
        assert!(p1 > 0.3 && p2 > 0.3, "both peaks present: {p1} {p2}");
        assert!(
            trough < 0.5 * p1.min(p2),
            "peaks should be resolved, trough {trough}"
        );

        let dr = spec.range_resolution_m(c, Window::Hann);
        let sep_m = (d2 - d1) as f32 / spec.fs * c / 2.0;
        assert!(
            sep_m > dr,
            "test separation {sep_m} m must exceed resolution {dr} m"
        );
    }

    #[test]
    fn tapering_the_band_suppresses_range_sidelobes() {
        let spec = ChirpSpec::default();
        let tx = chirp::synth_real(&spec);
        let record_len = 16_384;
        let delay = 4_000usize;
        let mut rec = vec![0.0f32; record_len];
        echo_at(&mut rec, &tx, delay, 1.0);

        // The search must start OUTSIDE the mainlobe, and the mainlobe widens
        // with the taper — that is the whole tradeoff. A fixed offset measures
        // rect's first sidelobe but blackman-harris's mainlobe skirt, and makes
        // the better window look worse. Scale the start with the widening.
        let sidelobe = |taper: Window| -> f32 {
            let mut mf = MatchedFilter::new(&spec, record_len, taper);
            let mut env = vec![0.0f32; record_len];
            mf.envelope(&rec, &mut env);
            let peak = env[delay];
            let mainlobe = (spec.fs / spec.bandwidth()) * taper.mainlobe_widening();
            let start = delay + (1.5 * mainlobe).ceil() as usize;
            let worst = env[start..(start + 400).min(env.len())]
                .iter()
                .fold(0.0f32, |a, b| a.max(*b));
            20.0 * (worst / peak).log10()
        };

        let rect_db = sidelobe(Window::Rect);
        let hann_db = sidelobe(Window::Hann);
        let bh_db = sidelobe(Window::BlackmanHarris);

        // Rect lands on the textbook -13.3 dB first sidelobe for an LFM.
        assert!(
            (-16.0..-10.0).contains(&rect_db),
            "rect first sidelobe {rect_db} dB should be near the textbook -13.3 dB"
        );
        // Hann's textbook -31.5 dB.
        assert!(
            hann_db < rect_db - 12.0,
            "hann {hann_db} dB vs rect {rect_db} dB"
        );
        assert!(hann_db > -40.0, "hann {hann_db} dB is suspiciously good");
        assert!(
            bh_db < hann_db - 3.0,
            "blackman-harris {bh_db} dB vs hann {hann_db} dB"
        );

        // But the improvement does NOT continue forever: a finite record and
        // f32 arithmetic put a floor around -47 dB, so windows past
        // blackman-harris buy nothing measurable here. Worth knowing before
        // spending mainlobe width on one.
        assert!(
            bh_db > -50.0,
            "an unrealistically low floor ({bh_db} dB) means the test is wrong"
        );
    }

    #[test]
    fn out_of_band_noise_is_rejected_by_the_matched_bandpass() {
        let spec = ChirpSpec::default();
        let record_len = 8_192;
        // A loud 2 kHz tone — a voice, a fan, a door. Nothing like the sweep.
        let rec: Vec<f32> = (0..record_len)
            .map(|i| 2.0 * (std::f32::consts::TAU * 2_000.0 * i as f32 / spec.fs).sin())
            .collect();

        let mut mf = MatchedFilter::new(&spec, record_len, Window::Hann);
        let mut env = vec![0.0f32; record_len];
        mf.envelope(&rec, &mut env);

        let peak = env.iter().fold(0.0f32, |a, b| a.max(*b));
        assert!(peak < 0.05, "out-of-band tone leaked through: peak {peak}");
    }

    #[test]
    fn db_conversion_is_relative_to_the_peak_and_floored() {
        let env = vec![1.0f32, 0.1, 0.0, 0.5];
        let mut db = vec![0.0f32; 4];
        to_db_rel_peak(&env, &mut db, -80.0);
        assert!((db[0] - 0.0).abs() < 1e-4);
        assert!((db[1] + 20.0).abs() < 1e-3, "{}", db[1]);
        assert_eq!(db[2], -80.0, "a zero bin is floored, not -inf");
        assert!((db[3] + 6.02).abs() < 0.01, "{}", db[3]);
    }

    #[test]
    fn quantile_ignores_a_few_huge_outliers() {
        let mut env = vec![0.01f32; 200];
        env[7] = 50.0;
        env[9] = 90.0;
        let q = quantile(&env, 0.5);
        assert!(
            (q - 0.01).abs() < 1e-6,
            "median {q} should ignore the blast"
        );
    }

    #[test]
    fn an_empty_or_short_record_does_not_panic() {
        let spec = ChirpSpec::default();
        let mut mf = MatchedFilter::new(&spec, 4096, Window::Hann);
        let mut env = vec![0.0f32; 4096];
        mf.envelope(&[], &mut env);
        assert!(env.iter().all(|v| *v == 0.0));
        mf.envelope(&[0.1, -0.2, 0.3], &mut env);
        assert!(env.iter().all(|v| v.is_finite()));
    }
}
