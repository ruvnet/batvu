//! Window functions, in two distinct roles that are easy to confuse.
//!
//!  * **Transmit shaping** (`Window::Tukey`) tapers the chirp's *amplitude*
//!    envelope so the speaker is not slammed with a step. A rectangular pulse
//!    splatters energy far outside 18-22 kHz, and the part that lands below
//!    ~17 kHz is audible — a click on every ping, dozens of times a second.
//!
//!  * **Range-sidelobe control** applies a window to the matched filter's
//!    *reference spectrum* across the chirp band. An unwindowed LFM matched
//!    filter has a sinc-like response whose first sidelobe sits ~13.3 dB below
//!    the peak; a 3 m wall echo would then bury anything within a couple of
//!    range bins at -13 dB. Tapering trades mainlobe width (range resolution)
//!    for sidelobe suppression. This is the single most consequential DSP knob
//!    in the whole pipeline, which is why it is a flywheel lever.
//!
//! | window          | first sidelobe | mainlobe widening vs rect |
//! |-----------------|----------------|---------------------------|
//! | rectangular     | -13.3 dB       | 1.00x                     |
//! | hann            | -31.5 dB       | 1.67x                     |
//! | hamming         | -42.7 dB       | 1.50x                     |
//! | blackman        | -58.1 dB       | 2.00x                     |
//! | blackman-harris | -92.0 dB       | 2.66x                     |

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Window {
    Rect,
    Hann,
    Hamming,
    Blackman,
    BlackmanHarris,
    /// Tapered-cosine; `alpha` is carried separately (0 = rect, 1 = hann).
    Tukey,
}

impl Window {
    pub fn from_name(name: &str) -> Window {
        match name {
            "rect" | "rectangular" | "none" => Window::Rect,
            "hamming" => Window::Hamming,
            "blackman" => Window::Blackman,
            "blackman-harris" | "blackmanharris" | "bh" => Window::BlackmanHarris,
            "tukey" => Window::Tukey,
            _ => Window::Hann,
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            Window::Rect => "rect",
            Window::Hann => "hann",
            Window::Hamming => "hamming",
            Window::Blackman => "blackman",
            Window::BlackmanHarris => "blackman-harris",
            Window::Tukey => "tukey",
        }
    }

    /// Nominal first-sidelobe level in dB — used by the design report so a
    /// caller can see the tradeoff a lever is buying without running a sweep.
    pub fn first_sidelobe_db(&self) -> f32 {
        match self {
            Window::Rect => -13.3,
            Window::Hann => -31.5,
            Window::Hamming => -42.7,
            Window::Blackman => -58.1,
            Window::BlackmanHarris => -92.0,
            Window::Tukey => -21.0,
        }
    }

    /// Mainlobe widening factor relative to a rectangular window — the range
    /// resolution you give up for that sidelobe suppression.
    pub fn mainlobe_widening(&self) -> f32 {
        match self {
            Window::Rect => 1.00,
            Window::Hann => 1.67,
            Window::Hamming => 1.50,
            Window::Blackman => 2.00,
            Window::BlackmanHarris => 2.66,
            Window::Tukey => 1.35,
        }
    }
}

/// Evaluate a window at a normalised position `x` in [0, 1]. Outside that
/// interval the window is zero — which is what makes it safe to use for
/// rendering a pulse at an arbitrary fractional delay.
pub fn eval(w: Window, x: f32, alpha: f32) -> f32 {
    if !(0.0..=1.0).contains(&x) {
        return 0.0;
    }
    let tau = std::f32::consts::TAU;
    match w {
        Window::Rect => 1.0,
        Window::Hann => 0.5 - 0.5 * (tau * x).cos(),
        Window::Hamming => 0.54 - 0.46 * (tau * x).cos(),
        Window::Blackman => 0.42 - 0.5 * (tau * x).cos() + 0.08 * (2.0 * tau * x).cos(),
        Window::BlackmanHarris => {
            0.35875 - 0.48829 * (tau * x).cos() + 0.14128 * (2.0 * tau * x).cos()
                - 0.01168 * (3.0 * tau * x).cos()
        }
        Window::Tukey => tukey_at(x, alpha),
    }
}

/// Sample a window of length `n` into `out` (symmetric, endpoints included).
pub fn fill(out: &mut [f32], w: Window, alpha: f32) {
    let n = out.len();
    if n == 0 {
        return;
    }
    if n == 1 {
        out[0] = 1.0;
        return;
    }
    let denom = (n - 1) as f32;
    let tau = 0.0f32;
    for (i, slot) in out.iter_mut().enumerate() {
        *slot = eval(w, i as f32 / denom, alpha);
    }
    let _ = tau;
}

fn tukey_at(x: f32, alpha: f32) -> f32 {
    let a = alpha.clamp(0.0, 1.0);
    if a <= f32::EPSILON {
        return 1.0;
    }
    let half = a / 2.0;
    if x < half {
        0.5 * (1.0 + (std::f32::consts::PI * (x / half - 1.0)).cos())
    } else if x > 1.0 - half {
        0.5 * (1.0 + (std::f32::consts::PI * ((x - 1.0) / half + 1.0)).cos())
    } else {
        1.0
    }
}

/// Allocate and fill in one call.
pub fn make(n: usize, w: Window, alpha: f32) -> Vec<f32> {
    let mut v = vec![0.0f32; n];
    fill(&mut v, w, alpha);
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_peak_at_the_centre_and_taper_at_the_edges() {
        for w in [
            Window::Hann,
            Window::Hamming,
            Window::Blackman,
            Window::BlackmanHarris,
        ] {
            let v = make(65, w, 0.0);
            let mid = v[32];
            assert!(mid > 0.9, "{:?} centre {mid}", w);
            assert!(v[0] < 0.1, "{:?} left edge {}", w, v[0]);
            assert!(v[64] < 0.1, "{:?} right edge {}", w, v[64]);
            // Symmetry.
            for i in 0..32 {
                assert!((v[i] - v[64 - i]).abs() < 1e-5, "{:?} asymmetric at {i}", w);
            }
        }
    }

    #[test]
    fn rect_is_flat() {
        let v = make(16, Window::Rect, 0.0);
        assert!(v.iter().all(|x| (*x - 1.0).abs() < 1e-6));
    }

    #[test]
    fn tukey_interpolates_between_rect_and_hann() {
        let rect = make(64, Window::Tukey, 0.0);
        assert!(rect.iter().all(|x| (*x - 1.0).abs() < 1e-6));

        let hannish = make(64, Window::Tukey, 1.0);
        let hann = make(64, Window::Hann, 0.0);
        for i in 0..64 {
            assert!(
                (hannish[i] - hann[i]).abs() < 1e-4,
                "tukey(1) != hann at {i}"
            );
        }

        // A mid alpha keeps a flat top and tapers only the shoulders.
        let mid = make(101, Window::Tukey, 0.25);
        assert!((mid[50] - 1.0).abs() < 1e-6, "flat top");
        assert!(mid[0] < 0.01, "tapered edge");
    }

    #[test]
    fn degenerate_lengths_do_not_panic() {
        assert!(make(0, Window::Hann, 0.0).is_empty());
        assert_eq!(make(1, Window::Blackman, 0.0), vec![1.0]);
    }

    #[test]
    fn eval_agrees_with_the_sampled_window() {
        for w in [
            Window::Hann,
            Window::Blackman,
            Window::BlackmanHarris,
            Window::Tukey,
        ] {
            let v = make(129, w, 0.25);
            for (i, sampled) in v.iter().enumerate() {
                let x = i as f32 / 128.0;
                assert!((eval(w, x, 0.25) - sampled).abs() < 1e-6, "{:?} at {i}", w);
            }
        }
        // Outside [0,1] a window is zero, so a pulse rendered at a fractional
        // delay simply stops rather than wrapping.
        assert_eq!(eval(Window::Hann, -0.01, 0.0), 0.0);
        assert_eq!(eval(Window::Hann, 1.01, 0.0), 0.0);
    }

    #[test]
    fn names_round_trip() {
        for w in [
            Window::Rect,
            Window::Hann,
            Window::Hamming,
            Window::Blackman,
            Window::BlackmanHarris,
            Window::Tukey,
        ] {
            assert_eq!(Window::from_name(w.name()), w);
        }
        assert_eq!(
            Window::from_name("nonsense"),
            Window::Hann,
            "unknown falls back to hann"
        );
    }
}
