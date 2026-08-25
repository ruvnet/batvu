//! Does a receive-side spectral taper still buy sidelobe suppression at the low
//! time-bandwidth products a phone speaker allows? Measured, not assumed.
use batvu_dsp::chirp::{self, ChirpSpec};
use batvu_dsp::matched::MatchedFilter;
use batvu_dsp::window::Window;

fn main() {
    println!(
        "{:>6} {:>5} {:>16} {:>10} {:>10} {:>12}",
        "B(Hz)", "T(ms)", "taper", "BT", "PSL(dB)", "-6dB width"
    );
    for (b, t_ms) in [
        (3000.0f32, 5.0f32),
        (3000.0, 10.0),
        (4000.0, 10.0),
        (6000.0, 20.0),
    ] {
        for taper in [
            Window::Rect,
            Window::Hamming,
            Window::Hann,
            Window::BlackmanHarris,
        ] {
            let spec = ChirpSpec {
                fs: 48_000.0,
                f0: 19_000.0 - b / 2.0,
                f1: 19_000.0 + b / 2.0,
                duration_s: t_ms / 1000.0,
                tx_window: Window::Hann,
                tukey_alpha: 1.0,
                amplitude: 0.6,
            };
            let tx = chirp::synth_real(&spec);
            let record_len = 16_384usize;
            let delay = 4_000usize;
            let mut rec = vec![0.0f32; record_len];
            for (i, s) in tx.iter().enumerate() {
                rec[delay + i] += *s;
            }
            let mut mf = MatchedFilter::new(&spec, record_len, taper);
            let mut env = vec![0.0f32; record_len];
            mf.envelope(&rec, &mut env);

            let (mut pk, mut pi) = (0.0f32, 0usize);
            for (i, v) in env.iter().enumerate() {
                if *v > pk {
                    pk = *v;
                    pi = i;
                }
            }
            // -6 dB mainlobe width
            let mut lo = pi;
            while lo > 0 && env[lo] > pk * 0.5 {
                lo -= 1;
            }
            let mut hi = pi;
            while hi + 1 < record_len && env[hi] > pk * 0.5 {
                hi += 1;
            }
            let width = hi - lo;
            // Peak sidelobe: worst value outside the mainlobe, out to 800 samples.
            let start = pi + (width as f32 * 1.5).ceil() as usize;
            let worst = env[start..(start + 800).min(record_len)]
                .iter()
                .fold(0.0f32, |a, x| a.max(*x));
            let psl = 20.0 * (worst / pk).log10();
            println!(
                "{:>6.0} {:>5.0} {:>16} {:>10.0} {:>10.1} {:>12}",
                b,
                t_ms,
                taper.name(),
                b * t_ms / 1000.0,
                psl,
                width
            );
        }
        println!();
    }
}
