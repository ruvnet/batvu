//! An in-place iterative radix-2 complex FFT with precomputed twiddles.
//!
//! Dependency-free on purpose: the whole crate compiles to a small
//! `wasm32-unknown-unknown` module with no `wasm-bindgen`, mirroring the build
//! shape of `@metaharness/horizon`'s control core. `f32` throughout — the range
//! estimate is limited by echo SNR (tens of dB), never by 24-bit mantissa
//! rounding, and `f32` halves the memory traffic that dominates on a phone.

/// A plan for one transform size. Build once, reuse for every ping.
pub struct Fft {
    n: usize,
    /// Twiddles laid out per stage: for stage length `m`, the `m/2` factors
    /// `exp(-2*pi*i*k/m)`. Flattened so a stage is one contiguous slice.
    tw_re: Vec<f32>,
    tw_im: Vec<f32>,
    /// Bit-reversal permutation.
    rev: Vec<u32>,
}

impl Fft {
    /// `n` must be a power of two and at least 2.
    pub fn new(n: usize) -> Self {
        assert!(
            n >= 2 && n.is_power_of_two(),
            "fft size must be a power of two >= 2"
        );
        let bits = n.trailing_zeros();
        let mut rev = vec![0u32; n];
        for (i, slot) in rev.iter_mut().enumerate() {
            *slot = (i as u32).reverse_bits() >> (32 - bits);
        }

        let mut tw_re = Vec::with_capacity(n);
        let mut tw_im = Vec::with_capacity(n);
        let mut m = 2usize;
        while m <= n {
            let half = m / 2;
            for k in 0..half {
                let ang = -2.0 * std::f64::consts::PI * (k as f64) / (m as f64);
                tw_re.push(ang.cos() as f32);
                tw_im.push(ang.sin() as f32);
            }
            m <<= 1;
        }
        Fft {
            n,
            tw_re,
            tw_im,
            rev,
        }
    }

    pub fn len(&self) -> usize {
        self.n
    }

    pub fn is_empty(&self) -> bool {
        self.n == 0
    }

    /// Forward transform, in place. No scaling (the inverse carries the 1/N).
    pub fn forward(&self, re: &mut [f32], im: &mut [f32]) {
        self.run(re, im, false);
    }

    /// Inverse transform, in place, scaled by 1/N.
    pub fn inverse(&self, re: &mut [f32], im: &mut [f32]) {
        self.run(re, im, true);
        let s = 1.0 / self.n as f32;
        for k in 0..self.n {
            re[k] *= s;
            im[k] *= s;
        }
    }

    fn run(&self, re: &mut [f32], im: &mut [f32], conj: bool) {
        assert_eq!(re.len(), self.n);
        assert_eq!(im.len(), self.n);

        // Bit-reversal permutation (swap each pair exactly once).
        for i in 0..self.n {
            let j = self.rev[i] as usize;
            if j > i {
                re.swap(i, j);
                im.swap(i, j);
            }
        }

        let sign = if conj { -1.0f32 } else { 1.0f32 };
        let mut m = 2usize;
        let mut tw_off = 0usize;
        while m <= self.n {
            let half = m / 2;
            let tw_re = &self.tw_re[tw_off..tw_off + half];
            let tw_im = &self.tw_im[tw_off..tw_off + half];
            let mut base = 0usize;
            while base < self.n {
                for k in 0..half {
                    let wr = tw_re[k];
                    let wi = tw_im[k] * sign;
                    let i0 = base + k;
                    let i1 = i0 + half;
                    let xr = re[i1] * wr - im[i1] * wi;
                    let xi = re[i1] * wi + im[i1] * wr;
                    re[i1] = re[i0] - xr;
                    im[i1] = im[i0] - xi;
                    re[i0] += xr;
                    im[i0] += xi;
                }
                base += m;
            }
            tw_off += half;
            m <<= 1;
        }
    }
}

/// Smallest power of two `>= n` (with a floor of 2).
pub fn next_pow2(n: usize) -> usize {
    let mut p = 2usize;
    while p < n {
        p <<= 1;
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    fn naive_dft(re: &[f32], im: &[f32]) -> (Vec<f32>, Vec<f32>) {
        let n = re.len();
        let mut or = vec![0.0f32; n];
        let mut oi = vec![0.0f32; n];
        for k in 0..n {
            let (mut sr, mut si) = (0.0f64, 0.0f64);
            for t in 0..n {
                let a = -2.0 * std::f64::consts::PI * (k as f64) * (t as f64) / n as f64;
                let (c, s) = (a.cos(), a.sin());
                sr += re[t] as f64 * c - im[t] as f64 * s;
                si += re[t] as f64 * s + im[t] as f64 * c;
            }
            or[k] = sr as f32;
            oi[k] = si as f32;
        }
        (or, oi)
    }

    fn lcg(state: &mut u32) -> f32 {
        *state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        ((*state >> 8) as f32 / 8_388_608.0) - 1.0
    }

    #[test]
    fn matches_a_naive_dft() {
        for &n in &[2usize, 8, 64, 256] {
            let mut seed = 12345u32 + n as u32;
            let re0: Vec<f32> = (0..n).map(|_| lcg(&mut seed)).collect();
            let im0: Vec<f32> = (0..n).map(|_| lcg(&mut seed)).collect();
            let (er, ei) = naive_dft(&re0, &im0);

            let fft = Fft::new(n);
            let (mut re, mut im) = (re0.clone(), im0.clone());
            fft.forward(&mut re, &mut im);
            for k in 0..n {
                assert!(
                    (re[k] - er[k]).abs() < 1e-2 && (im[k] - ei[k]).abs() < 1e-2,
                    "n={n} k={k}: got ({},{}) want ({},{})",
                    re[k],
                    im[k],
                    er[k],
                    ei[k]
                );
            }
        }
    }

    #[test]
    fn forward_then_inverse_is_identity() {
        let n = 1024;
        let mut seed = 99u32;
        let re0: Vec<f32> = (0..n).map(|_| lcg(&mut seed)).collect();
        let im0: Vec<f32> = (0..n).map(|_| lcg(&mut seed)).collect();
        let fft = Fft::new(n);
        let (mut re, mut im) = (re0.clone(), im0.clone());
        fft.forward(&mut re, &mut im);
        fft.inverse(&mut re, &mut im);
        for k in 0..n {
            assert!((re[k] - re0[k]).abs() < 1e-4, "re[{k}]");
            assert!((im[k] - im0[k]).abs() < 1e-4, "im[{k}]");
        }
    }

    #[test]
    fn a_pure_tone_lands_in_one_bin() {
        let n = 256;
        let bin = 17usize;
        let mut re: Vec<f32> = (0..n)
            .map(|t| (2.0 * std::f32::consts::PI * bin as f32 * t as f32 / n as f32).cos())
            .collect();
        let mut im = vec![0.0f32; n];
        Fft::new(n).forward(&mut re, &mut im);
        let mag: Vec<f32> = (0..n)
            .map(|k| (re[k] * re[k] + im[k] * im[k]).sqrt())
            .collect();
        // A real cosine splits energy between +bin and n-bin.
        assert!(mag[bin] > 0.4 * n as f32, "peak at bin {bin}: {}", mag[bin]);
        assert!(mag[n - bin] > 0.4 * n as f32);
        for (k, m) in mag.iter().enumerate() {
            if k != bin && k != n - bin {
                assert!(*m < 0.01 * n as f32, "leakage at {k}: {m}");
            }
        }
    }

    #[test]
    fn next_pow2_rounds_up() {
        assert_eq!(next_pow2(1), 2);
        assert_eq!(next_pow2(2), 2);
        assert_eq!(next_pow2(3), 4);
        assert_eq!(next_pow2(1000), 1024);
        assert_eq!(next_pow2(1024), 1024);
    }
}
