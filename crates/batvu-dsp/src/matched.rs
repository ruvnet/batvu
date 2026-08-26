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

    /// Compress `x`, leaving the complex profile in `buf_re`/`buf_im`.
    ///
    /// Both public outputs read this one result rather than each running their
    /// own transform, so `|complex_profile|` and `envelope` cannot drift apart:
    /// they are the same floats with a different last step.
    fn compress(&mut self, x: &[f32]) {
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
    }

    /// Compress `x` and write the magnitude envelope into `out`.
    ///
    /// `out[m]` is the response at lag `m` samples, i.e. an echo whose round
    /// trip took `m/fs` seconds relative to the moment the pulse left the
    /// speaker. `out` is truncated to its own length; callers size it to the
    /// maximum range they care about.
    pub fn envelope(&mut self, x: &[f32], out: &mut [f32]) {
        self.compress(x);
        let lags = out.len().min(self.n);
        for (m, slot) in out[..lags].iter_mut().enumerate() {
            let (r, i) = (self.buf_re[m], self.buf_im[m]);
            *slot = (r * r + i * i).sqrt();
        }
        for v in &mut out[lags..] {
            *v = 0.0;
        }
    }

    /// Compress `x` and write the COMPLEX profile into `out`: two floats per
    /// lag, `(re, im)` interleaved, starting at lag `lag0`.
    ///
    /// This is [`Self::envelope`] with its last line left off, and that line is
    /// expensive in what it destroys rather than in what it costs.
    /// `(r*r + i*i).sqrt()` is where Doppler, moving-target
    /// indication, coherent blast cancellation and micro-motion sensing go: a
    /// radial displacement `d` moves the two-way phase by `4*pi*d/lambda`, so
    /// with `lambda = c/f` around 18 mm in this band, a millimetre is most of a
    /// radian while the magnitude does not move at all (ADR-023). A coat and a
    /// chest at the same range have the same envelope; they do not have the same
    /// phase history.
    ///
    /// **Interleaved rather than split `re`/`im`**, for two reasons that point
    /// the same way. Consumers work a bin at a time — magnitude and phase of bin
    /// `m`, or bin `m`'s phase across a dwell of pings — so the two halves of a
    /// bin want to be adjacent rather than a whole range profile apart. And the
    /// zero-copy wasm boundary can express one contiguous run of floats as one
    /// `Float32Array` with one pointer and one length; split arrays would need a
    /// second allocation or a second pointer/length pair, and every extra view
    /// is another one a host can forget to re-take after memory growth detaches
    /// it (see `abi`'s memory-growth contract).
    ///
    /// `lag0` is here because the caller is always range-gating anyway: it wants
    /// the lags around its targets, not the lags from zero. Without it the only
    /// way to read a gated window is to write the whole record's worth of
    /// complex profile somewhere first, which is an allocation the magnitude
    /// path never had to make.
    pub fn complex_profile(&mut self, x: &[f32], lag0: usize, out: &mut [f32]) {
        self.compress(x);
        let lag0 = lag0.min(self.n);
        let lags = (out.len() / 2).min(self.n - lag0);
        for (m, pair) in out[..2 * lags].chunks_exact_mut(2).enumerate() {
            pair[0] = self.buf_re[lag0 + m];
            pair[1] = self.buf_im[lag0 + m];
        }
        for v in &mut out[2 * lags..] {
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

    /// Place a delayed copy of the transmit waveform at a FRACTIONAL delay.
    ///
    /// Evaluated rather than interpolated: `chirp::sample_at` exists because
    /// linear interpolation of a 20 kHz signal loses up to 11 dB depending on
    /// the fractional offset, which would move the compressed magnitude around
    /// and swamp the sub-sample effect the phase tests are measuring.
    fn echo_at_frac(record: &mut [f32], spec: &ChirpSpec, delay: f32, gain: f32) {
        let start = delay.floor().max(0.0) as usize;
        let frac = delay - start as f32;
        for i in 0..spec.len_samples() + 2 {
            if let Some(slot) = record.get_mut(start + i) {
                *slot += gain * chirp::sample_at(spec, (i as f32 - frac) / spec.fs);
            }
        }
    }

    /// Phase of bin `m` of an interleaved complex profile.
    fn arg_at(iq: &[f32], m: usize) -> f32 {
        iq[2 * m + 1].atan2(iq[2 * m])
    }

    /// Wrap to (-pi, pi], so a phase DIFFERENCE can be compared with a
    /// prediction without either side having to agree on a branch cut.
    fn wrap(phi: f32) -> f32 {
        let tau = std::f32::consts::TAU;
        let mut p = phi % tau;
        if p > std::f32::consts::PI {
            p -= tau;
        }
        if p < -std::f32::consts::PI {
            p += tau;
        }
        p
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
        // A 240-sample pulse compressed by BT=15. The nominal mainlobe is
        // fs/B = 16 samples, widened to ~27 by the full Hann transmit taper.
        assert!(
            width < 80,
            "compressed width {width} samples (pulse is {})",
            tx.len()
        );
        assert!(width * 3 < tx.len(), "compression should be at least 3x");
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
        // The full Hann transmit taper costs 4.5 dB of transmitted energy, so
        // the absolute peaks sit lower than an untapered pulse would give.
        assert!(p1 > 0.2 && p2 > 0.2, "both peaks present: {p1} {p2}");
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
    fn the_transmit_taper_does_the_sidelobe_work_and_a_receive_window_adds_little() {
        // The measurement behind the default `rx_taper: Rect` (ADR-004).
        //
        // The textbook says an unwindowed LFM matched filter has -13.3 dB first
        // sidelobes and that you window the RECEIVER to fix it. That holds only
        // when the TRANSMITTED pulse is unwindowed. With a full Hann transmit
        // taper the band is already shaped: an unwindowed receiver measures about
        // -45 dB, and a receive window on top buys single-digit dB while widening
        // the mainlobe by a fifth. A real room's reverberation floor sits far
        // above -45 dB, so that suppression is unobservable and the resolution it
        // costs is not.
        let spec = ChirpSpec::default(); // full Hann transmit taper
        let tx = chirp::synth_real(&spec);
        let record_len = 16_384;
        let delay = 4_000usize;
        let mut rec = vec![0.0f32; record_len];
        echo_at(&mut rec, &tx, delay, 1.0);

        let measure = |taper: Window| -> (f32, usize) {
            let mut mf = MatchedFilter::new(&spec, record_len, taper);
            let mut env = vec![0.0f32; record_len];
            mf.envelope(&rec, &mut env);
            let peak = env[delay];
            let mut lo = delay;
            while lo > 0 && env[lo] > peak * 0.5 {
                lo -= 1;
            }
            let mut hi = delay;
            while hi + 1 < record_len && env[hi] > peak * 0.5 {
                hi += 1;
            }
            let width = hi - lo;
            let from = delay + (width as f32 * 1.5).ceil() as usize;
            let worst = env[from..(from + 800).min(record_len)]
                .iter()
                .fold(0.0f32, |a, b| a.max(*b));
            (20.0 * (worst / peak).log10(), width)
        };

        let (rect_db, rect_w) = measure(Window::Rect);
        let (hann_db, hann_w) = measure(Window::Hann);

        // An unwindowed RECEIVER is already far below the textbook -13.3 dB,
        // because the transmit taper did the work.
        assert!(
            rect_db < -40.0,
            "rect PSL {rect_db} dB with a Hann transmit taper"
        );
        // The receive window still helps, but only by single-digit dB...
        assert!(
            hann_db < rect_db,
            "hann {hann_db} should still beat rect {rect_db}"
        );
        assert!(
            hann_db > rect_db - 20.0,
            "the receive window appears to buy {} dB, far more than measured",
            rect_db - hann_db
        );
        // ...and it costs real mainlobe width, which IS observable.
        assert!(
            hann_w > rect_w,
            "a receive window must widen the mainlobe: {rect_w} -> {hann_w}"
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
    fn the_complex_profile_is_the_envelope_with_its_last_step_left_off() {
        let spec = ChirpSpec::default();
        let tx = chirp::synth_real(&spec);
        let record_len = 16_384;
        let mut rec = vec![0.0f32; record_len];
        echo_at(&mut rec, &tx, 1_200, 1.0);
        echo_at(&mut rec, &tx, 4_400, 0.3);

        let mut mf = MatchedFilter::new(&spec, record_len, Window::Hann);
        let mut env = vec![0.0f32; record_len];
        mf.envelope(&rec, &mut env);
        let mut iq = vec![0.0f32; 2 * record_len];
        mf.complex_profile(&rec, 0, &mut iq);

        // Bit-for-bit rather than within a tolerance. An epsilon here would pass
        // just as happily if the complex path ran a SECOND transform of its own,
        // and the whole point is that there is only one.
        for (m, e) in env.iter().enumerate() {
            let (r, i) = (iq[2 * m], iq[2 * m + 1]);
            let mag = (r * r + i * i).sqrt();
            assert_eq!(mag.to_bits(), e.to_bits(), "bin {m}: {mag} vs {e}");
        }
        assert!(env.iter().any(|v| *v > 0.1), "the record should compress");
        assert!(
            iq.chunks_exact(2).any(|p| p[1].abs() > 0.1),
            "an all-real profile means the imaginary part is being dropped"
        );
    }

    #[test]
    fn a_lag_offset_selects_a_window_of_the_same_profile() {
        let spec = ChirpSpec::default();
        let tx = chirp::synth_real(&spec);
        let record_len = 8_192;
        let delay = 3_000usize;
        let mut rec = vec![0.0f32; record_len];
        echo_at(&mut rec, &tx, delay, 0.7);

        let mut mf = MatchedFilter::new(&spec, record_len, Window::Rect);
        let mut full = vec![0.0f32; 2 * record_len];
        mf.complex_profile(&rec, 0, &mut full);

        let lag0 = 2_900usize;
        let mut gated = vec![0.0f32; 2 * 400];
        mf.complex_profile(&rec, lag0, &mut gated);
        for (i, v) in gated.iter().enumerate() {
            assert_eq!(v.to_bits(), full[2 * lag0 + i].to_bits(), "float {i}");
        }

        // Past the end of the transform there is nothing to report, and the
        // caller must not be handed the previous ping's phase instead.
        let mut past = vec![1.0f32; 8];
        mf.complex_profile(&rec, mf.fft_size() + 10, &mut past);
        assert!(past.iter().all(|v| *v == 0.0), "{past:?}");
    }

    #[test]
    fn a_matched_arrival_lands_in_quadrature_with_the_analytic_reference() {
        // Derived, not observed. The transmit waveform is `a*w*sin(phi)` and the
        // reference is `w*exp(j*phi)`; `sin(phi) = (e^{j phi} - e^{-j phi})/2j`
        // and the one-sided reference annihilates the second term, so a
        // perfectly aligned echo compresses to `(a/2j) * chi(0)` with `chi(0)`
        // real and positive. Dividing by `j` is a quarter turn clockwise, so the
        // peak sits at -pi/2 — at every delay, because at zero lag error the
        // sweep's own quadratic phase cancels exactly.
        let spec = ChirpSpec::default();
        let tx = chirp::synth_real(&spec);
        let record_len = 16_384;
        let mut mf = MatchedFilter::new(&spec, record_len, Window::Rect);
        let expected = -std::f32::consts::FRAC_PI_2;

        for delay in [2_000usize, 6_133] {
            let mut rec = vec![0.0f32; record_len];
            echo_at(&mut rec, &tx, delay, 0.5);
            let mut iq = vec![0.0f32; 2 * record_len];
            mf.complex_profile(&rec, 0, &mut iq);

            let mags: Vec<f32> = iq
                .chunks_exact(2)
                .map(|p| (p[0] * p[0] + p[1] * p[1]).sqrt())
                .collect();
            assert_eq!(argmax(&mags), delay, "peak should land on the delay");

            let err = wrap(arg_at(&iq, delay) - expected);
            // A tolerance of f32 rounding, not of modelling error. The term the
            // derivation drops — the `e^{-j phi}` image, which lands around
            // `2*f_c` — is not merely small here, it is annihilated: the matched
            // bandpass keeps `[f0, f1]` and nothing else, so the real part of the
            // peak is zero to the last bit rather than approximately.
            assert!(
                err.abs() < 1e-5,
                "delay {delay}: phase {} rad, expected {expected} rad",
                arg_at(&iq, delay)
            );
        }
    }

    #[test]
    fn a_millimetre_of_range_moves_the_phase_by_four_pi_d_over_lambda() {
        // ADR-023's discriminant, on the bench. Two identical targets a
        // millimetre apart in range are indistinguishable in the envelope and
        // separated by tens of degrees in phase.
        //
        // Two-way phase for a radial displacement `d` is `4*pi*d/lambda` with
        // `lambda = c/f`. Both come out of arithmetic already in this crate: the
        // test renders the echo with the same `c` it predicts with, so nothing
        // physical is being asserted — only that the pipeline reports the phase
        // its own geometry implies.
        let spec = ChirpSpec::default();
        let c = chirp::speed_of_sound(20.0);
        let record_len = 16_384;
        let bin = 5_000usize;

        // The sweep's centre frequency: the compressed peak's phase advances at
        // the band centre, not at either edge, because the matched filter's
        // envelope is symmetric about it.
        let f_c = 0.5 * (spec.f0 + spec.f1);
        let lambda = c / f_c;
        let d = 0.001f32; // one millimetre, well under lambda/4 so it cannot wrap
        let expected = -4.0 * std::f32::consts::PI * d / lambda;
        assert!(
            expected.abs() < std::f32::consts::PI,
            "the test displacement must not wrap: {expected} rad"
        );

        // Round trip is 2*d of extra path, hence 2*d/c seconds of extra delay.
        let extra_lag = 2.0 * d / c * spec.fs;
        let mut mf = MatchedFilter::new(&spec, record_len, Window::Rect);

        let measure = |mf: &mut MatchedFilter, lag: f32| -> (f32, f32) {
            let mut rec = vec![0.0f32; record_len];
            echo_at_frac(&mut rec, &spec, lag, 1.0);
            let mut iq = vec![0.0f32; 2 * record_len];
            mf.complex_profile(&rec, 0, &mut iq);
            let (r, i) = (iq[2 * bin], iq[2 * bin + 1]);
            ((r * r + i * i).sqrt(), i.atan2(r))
        };

        let (mag_near, phi_near) = measure(&mut mf, bin as f32);
        let (mag_far, phi_far) = measure(&mut mf, bin as f32 + extra_lag);

        let moved = wrap(phi_far - phi_near);
        assert!(
            (moved - expected).abs() < 0.01,
            "phase moved {moved} rad, wavelength says {expected} rad"
        );

        // And the reason ADR-023 was written: the magnitude path saw nothing.
        // A millimetre of range is 0.28 of a sample against a mainlobe tens of
        // samples wide, so the envelope cannot represent it even in principle,
        // while the phase has turned by `4*pi*d/lambda` — about 40 degrees.
        let rel = (mag_far - mag_near).abs() / mag_near;
        assert!(
            rel < 1e-3,
            "the envelope moved by {rel} — a displacement this large is being \
             measured as range, not as phase"
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

        // An odd-length complex buffer is a caller bug, not a panic: the last
        // float has no partner, so it is left as the zero fill.
        let mut iq = vec![1.0f32; 9];
        mf.complex_profile(&[], 0, &mut iq);
        assert!(iq.iter().all(|v| *v == 0.0), "{iq:?}");
        mf.complex_profile(&[0.1, -0.2, 0.3], 4_000, &mut iq);
        assert!(iq.iter().all(|v| v.is_finite()));
    }
}
