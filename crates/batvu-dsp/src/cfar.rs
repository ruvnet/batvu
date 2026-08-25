//! Constant-false-alarm-rate detection.
//!
//! A fixed threshold on the range envelope is useless in a real room: the noise
//! floor near the direct-path blast is 40 dB above the floor at 5 m, so any one
//! threshold either drowns in false alarms up close or goes blind far away.
//! CFAR sets the threshold *locally*, from the cells around the one under test,
//! so the false-alarm rate stays put as the background moves.
//!
//! Two flavours, and the choice matters:
//!
//! * **CA-CFAR** (cell-averaging) is optimal for homogeneous noise and is the
//!   cheap default. Its weakness is exactly our situation: a second strong
//!   target sitting in the training window inflates the estimate and masks the
//!   first ("target masking").
//! * **OS-CFAR** (ordered-statistic) takes the k-th smallest training cell
//!   instead of the mean, so a handful of interfering targets simply sort to
//!   the top and are ignored. It costs a sort per cell; with the small windows
//!   used here that is affordable, and in a cluttered room it finds objects
//!   CA-CFAR misses.
//!
//! Both are exposed as flywheel levers, because which one wins depends on the
//! room and that is an empirical question, not an architectural one.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CfarKind {
    CellAveraging,
    OrderedStatistic,
}

impl CfarKind {
    pub fn from_name(name: &str) -> CfarKind {
        match name {
            "os" | "os-cfar" | "ordered" | "ordered-statistic" => CfarKind::OrderedStatistic,
            _ => CfarKind::CellAveraging,
        }
    }
    pub fn name(&self) -> &'static str {
        match self {
            CfarKind::CellAveraging => "ca",
            CfarKind::OrderedStatistic => "os",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct CfarConfig {
    pub kind: CfarKind,
    /// Training cells on EACH side of the cell under test.
    pub train: usize,
    /// Guard cells on each side — they keep a target's own mainlobe and its
    /// near sidelobes out of its own noise estimate.
    pub guard: usize,
    /// Design probability of false alarm, per cell.
    pub pfa: f32,
    /// Rank for OS-CFAR as a fraction of the training population (0.75 is the
    /// usual robust choice: high enough to track the noise, low enough to
    /// discard interferers).
    pub os_rank_frac: f32,
    /// An absolute floor on the threshold, as a linear envelope amplitude.
    /// Without it, a perfectly silent stretch of record produces a zero noise
    /// estimate and every numerical crumb becomes a detection.
    pub min_threshold: f32,
    /// Merge two above-threshold runs separated by fewer than this many cells.
    /// A strong wall does not produce one clean run: its mainlobe crosses the
    /// threshold, dips through a sidelobe null, and crosses again. Without
    /// merging, one wall is reported as three objects sitting 2 cm apart.
    pub merge_gap: usize,
    /// Minimum peak prominence, in dB, for a local maximum inside one
    /// above-threshold run to count as its own object.
    ///
    /// Grouping a run by its single global peak loses real targets: two echoes
    /// that the matched filter resolves cleanly still share one continuous
    /// above-threshold run whenever the trough between them stays over the
    /// threshold, and the detector then reports one object where the envelope
    /// plainly shows two. Splitting on prominent internal maxima recovers them.
    /// Too low a value and matched-filter sidelobes become objects; this is the
    /// knob that trades those two failures against each other.
    pub min_prominence_db: f32,
}

impl Default for CfarConfig {
    fn default() -> Self {
        CfarConfig {
            kind: CfarKind::CellAveraging,
            train: 48,
            guard: 24,
            pfa: 1e-4,
            os_rank_frac: 0.75,
            min_threshold: 1e-6,
            merge_gap: 8,
            min_prominence_db: 6.0,
        }
    }
}

impl CfarConfig {
    /// Guard and training cells sized from the waveform rather than guessed.
    ///
    /// This is the single most consequential CFAR setting and the easiest to get
    /// wrong. The guard band exists to keep a target's OWN energy out of its own
    /// noise estimate — so it must be at least as wide as the compressed
    /// mainlobe, or every target quietly raises its own threshold and reports a
    /// near-zero SNR. The compressed mainlobe is `fs/B` samples wide, widened by
    /// the receive taper; we take 1.5x that on each side so the first sidelobes
    /// are excluded too, and twice the guard for training.
    pub fn sized_for(spec: &crate::chirp::ChirpSpec, taper: crate::window::Window) -> CfarConfig {
        let mainlobe = (spec.fs / spec.bandwidth().max(1.0)) * taper.mainlobe_widening();
        let guard = (1.5 * mainlobe).ceil().max(4.0) as usize;
        CfarConfig {
            guard,
            train: (2 * guard).max(16),
            merge_gap: (mainlobe.ceil() as usize).max(2),
            ..CfarConfig::default()
        }
    }

    /// CA-CFAR scale factor: `alpha = N * (Pfa^(-1/N) - 1)` for `N` training
    /// cells, in POWER. Applied to the mean training power.
    pub fn alpha(&self) -> f32 {
        let n = (2 * self.train).max(1) as f32;
        let pfa = self.pfa.clamp(1e-12, 0.5);
        n * (pfa.powf(-1.0 / n) - 1.0)
    }
}

/// One detection, in envelope-index space.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Detection {
    /// Peak index, refined to sub-sample precision by parabolic interpolation.
    pub index: f32,
    /// Envelope amplitude at the peak (linear).
    pub amplitude: f32,
    /// Peak amplitude over the local CFAR threshold, in dB. This is the honest
    /// "how sure are we" number, and it is what the occupancy update weights by.
    pub snr_db: f32,
    /// Width of the run of cells that exceeded the threshold.
    pub width: usize,
    /// First and last-plus-one cell of the above-threshold run. Carried
    /// explicitly so `merge_close` can measure the gap BETWEEN runs; using the
    /// peak-to-peak distance instead lets one wide run swallow a genuinely
    /// separate neighbour.
    pub start: usize,
    pub end: usize,
}

/// Run CFAR over `env` (a linear amplitude envelope) and write the per-cell
/// threshold into `threshold_out` if provided. Returns grouped detections.
///
/// `start` lets the caller skip the direct-path blast entirely; detections are
/// only reported for indices in `start..env.len()`.
pub fn detect(
    env: &[f32],
    cfg: &CfarConfig,
    start: usize,
    threshold_out: Option<&mut [f32]>,
) -> Vec<Detection> {
    let n = env.len();
    let mut thr = vec![0.0f32; n];
    if n == 0 {
        return Vec::new();
    }

    // Work in power; CFAR's statistics are defined on the squared envelope.
    let pw: Vec<f32> = env.iter().map(|v| v * v).collect();
    let span = cfg.train + cfg.guard;
    let alpha = cfg.alpha();
    let mut scratch: Vec<f32> = Vec::with_capacity(2 * cfg.train);

    // Prefix sums make the CA-CFAR pass O(n) instead of O(n * span). That is not
    // a micro-optimisation: `span` scales with the compressed mainlobe, so a
    // narrow sweep pushes it past a thousand cells and the naive form costs
    // millions of adds per ping — more than the FFT that produced the envelope.
    // f64 accumulation because the squared envelope spans a huge dynamic range
    // (the direct-path blast against the far-field noise floor) and an f32
    // running sum loses the small terms entirely.
    let mut prefix = vec![0.0f64; n + 1];
    for i in 0..n {
        prefix[i + 1] = prefix[i] + pw[i] as f64;
    }
    let window_sum = |a: usize, b: usize| -> (f64, usize) {
        if b <= a {
            (0.0, 0)
        } else {
            (prefix[b] - prefix[a], b - a)
        }
    };

    for (i, thr_i) in thr.iter_mut().enumerate() {
        let lo_a = i.saturating_sub(span);
        let lo_b = i.saturating_sub(cfg.guard);
        let hi_a = (i + cfg.guard + 1).min(n);
        let hi_b = (i + span + 1).min(n);

        let noise_pw = match cfg.kind {
            CfarKind::CellAveraging => {
                let (s_lo, c_lo) = window_sum(lo_a, lo_b);
                let (s_hi, c_hi) = window_sum(hi_a, hi_b);
                let cnt = c_lo + c_hi;
                if cnt == 0 {
                    0.0
                } else {
                    ((s_lo + s_hi) / cnt as f64) as f32
                }
            }
            CfarKind::OrderedStatistic => {
                scratch.clear();
                scratch.extend_from_slice(&pw[lo_a..lo_b]);
                scratch.extend_from_slice(&pw[hi_a..hi_b]);
                if scratch.is_empty() {
                    0.0
                } else {
                    // total_cmp, not partial_cmp: a NaN training cell makes
                    // partial_cmp a non-total order, which Rust's sort DETECTS
                    // and panics on. One glitched mic frame is enough.
                    scratch.sort_by(|a, b| a.total_cmp(b));
                    let k = ((scratch.len() - 1) as f32 * cfg.os_rank_frac.clamp(0.0, 1.0)).round()
                        as usize;
                    scratch[k.min(scratch.len() - 1)]
                }
            }
        };

        let t_pw = alpha * noise_pw;
        *thr_i = t_pw.max(0.0).sqrt().max(cfg.min_threshold);
    }

    // ORDER MATTERS: merge first, split second. Splitting first and merging
    // after would immediately re-join the sub-peaks — their sub-runs are
    // adjacent by construction, so any gap tolerance swallows them.
    let dets = group_runs(env, &thr, start, cfg);
    if let Some(out) = threshold_out {
        let m = out.len().min(n);
        out[..m].copy_from_slice(&thr[..m]);
        for v in &mut out[m..] {
            *v = 0.0;
        }
    }
    dets
}

/// Turn each contiguous above-threshold run into one detection per prominent
/// peak inside it. Without the run grouping a wall produces 20 "objects" in a
/// row; without the intra-run splitting, two cleanly resolved echoes that share
/// one run collapse into one.
fn group_runs(env: &[f32], thr: &[f32], start: usize, cfg: &CfarConfig) -> Vec<Detection> {
    let n = env.len();
    let mut out = Vec::new();
    for (span_start, span_end) in merge_spans(find_runs(env, thr, start.min(n)), cfg.merge_gap) {
        for (peak, sub_start, sub_end) in split_run(
            env,
            span_start,
            span_end,
            cfg.min_prominence_db,
            cfg.merge_gap,
        ) {
            let amplitude = env[peak];
            let snr_db = if thr[peak] > 0.0 {
                20.0 * (amplitude / thr[peak]).log10()
            } else {
                0.0
            };
            out.push(Detection {
                index: parabolic_peak(env, peak),
                amplitude,
                snr_db,
                width: sub_end - sub_start,
                start: sub_start,
                end: sub_end,
            });
        }
    }
    out
}

/// Contiguous stretches where the envelope exceeds its local threshold.
///
/// The `!(a > b)` spelling is load-bearing, not a style choice. With a NaN in
/// the envelope — which one glitched microphone buffer is enough to produce,
/// since a single NaN sample turns every FFT bin into a NaN — both `env <= thr`
/// and `env > thr` are FALSE. Written as `env[i] <= thr[i]` the outer loop skips
/// the increment, the inner loop refuses to advance, and the scan spins forever
/// pushing empty runs until the process dies. In a browser that is a hung tab
/// mid-scan with no recovery but a reload. Found by the fuzz suite.
fn find_runs(env: &[f32], thr: &[f32], start: usize) -> Vec<(usize, usize)> {
    let n = env.len();
    let mut runs = Vec::new();
    let mut i = start;
    while i < n {
        if !(env[i] > thr[i]) {
            i += 1;
            continue;
        }
        let s = i;
        while i < n && env[i] > thr[i] {
            i += 1;
        }
        runs.push((s, i));
    }
    runs
}

/// Join runs separated by fewer than `gap` cells. A strong wall does not
/// produce one clean run: its mainlobe crosses the threshold, dips through a
/// sidelobe null and crosses again. Joining them first means the prominence
/// test that follows sees the whole object at once.
fn merge_spans(runs: Vec<(usize, usize)>, gap: usize) -> Vec<(usize, usize)> {
    let mut out: Vec<(usize, usize)> = Vec::with_capacity(runs.len());
    for (s, e) in runs {
        match out.last_mut() {
            Some(prev) if s.saturating_sub(prev.1) <= gap => prev.1 = e.max(prev.1),
            _ => out.push((s, e)),
        }
    }
    out
}

/// Split `env[s..e]` into `(peak, sub_start, sub_end)` for every local maximum
/// that is both PROMINENT (the trough between it and the nearest stronger peak
/// drops at least `min_prom_db` below it) and RESOLVABLE (at least `min_sep`
/// cells from any stronger peak already kept). Peaks are considered
/// strongest-first, so "a stronger peak already kept" is exact, not approximate.
fn split_run(
    env: &[f32],
    s: usize,
    e: usize,
    min_prom_db: f32,
    min_sep: usize,
) -> Vec<(usize, usize, usize)> {
    if e <= s {
        return Vec::new();
    }
    if e - s == 1 {
        return vec![(s, s, e)];
    }

    let mut maxima: Vec<usize> = Vec::new();
    for i in s..e {
        let left_ok = i == s || env[i] >= env[i - 1];
        let right_ok = i + 1 >= e || env[i] > env[i + 1];
        if left_ok && right_ok {
            maxima.push(i);
        }
    }
    if maxima.is_empty() {
        let mut best = s;
        for i in s..e {
            if env[i] > env[best] {
                best = i;
            }
        }
        maxima.push(best);
    }

    let mut order = maxima;
    order.sort_by(|a, b| env[*b].total_cmp(&env[*a]));

    let ratio = 10f32.powf(-min_prom_db.max(0.0) / 20.0);
    let sep = min_sep.max(1);

    // `kept` stays SORTED BY POSITION so the two tests below are cheap. Every
    // peak already in it is stronger than the candidate (we walk
    // strongest-first), and the trough to a nearer peak is never lower than the
    // trough to a farther one — so examining only the immediate left and right
    // neighbours is exactly equivalent to examining all of them, at O(span)
    // instead of O(kept * span). On a noisy run with hundreds of maxima that is
    // the difference between microseconds and seconds.
    let mut kept: Vec<usize> = Vec::new();
    for m in order {
        let pos = kept.partition_point(|&k| k < m);
        let left = pos.checked_sub(1).map(|i| kept[i]);
        let right = kept.get(pos).copied();

        if left.is_some_and(|k| m - k < sep) || right.is_some_and(|k| k - m < sep) {
            continue;
        }
        let saddle_ok = |a: usize, b: usize| -> bool {
            env[a..=b].iter().fold(f32::MAX, |x, y| x.min(*y)) <= env[m] * ratio
        };
        let prominent =
            left.is_none_or(|k| saddle_ok(k, m)) && right.is_none_or(|k| saddle_ok(m, k));
        if prominent {
            kept.insert(pos, m);
        }
    }

    // Boundaries fall at the deepest point between consecutive kept peaks.
    let mut out = Vec::with_capacity(kept.len());
    for (idx, &peak) in kept.iter().enumerate() {
        let sub_start = if idx == 0 {
            s
        } else {
            let prev = kept[idx - 1];
            let mut lo = prev;
            for j in prev..=peak {
                if env[j] < env[lo] {
                    lo = j;
                }
            }
            lo
        };
        let sub_end = if idx + 1 == kept.len() {
            e
        } else {
            let next = kept[idx + 1];
            let mut lo = peak;
            for j in peak..=next {
                if env[j] < env[lo] {
                    lo = j;
                }
            }
            lo
        };
        out.push((peak, sub_start, sub_end.max(sub_start + 1)));
    }
    out
}

/// Sub-sample peak location by fitting a parabola through the peak and its two
/// neighbours. At 48 kHz one sample is 3.6 mm of two-way range, so this is the
/// difference between centimetre and millimetre range quantisation — cheap, and
/// it visibly steadies the reconstructed surfaces.
pub fn parabolic_peak(env: &[f32], i: usize) -> f32 {
    if i == 0 || i + 1 >= env.len() {
        return i as f32;
    }
    let (a, b, c) = (env[i - 1], env[i], env[i + 1]);
    if !a.is_finite() || !b.is_finite() || !c.is_finite() {
        return i as f32;
    }
    let denom = a - 2.0 * b + c;
    if denom.abs() < 1e-12 {
        return i as f32;
    }
    let delta = 0.5 * (a - c) / denom;
    // Written as `!(x <= 1.0)` so a NaN delta — which two equal infinities in
    // the envelope will produce — falls back to the integer index instead of
    // propagating a NaN range out through the whole detection.
    if !(delta.abs() <= 1.0) {
        i as f32
    } else {
        i as f32 + delta
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn noise_floor(n: usize, seed: u32, level: f32) -> Vec<f32> {
        let mut s = seed;
        (0..n)
            .map(|_| {
                s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let u = (s >> 8) as f32 / 16_777_216.0; // 0..1
                level * (0.5 + u)
            })
            .collect()
    }

    #[test]
    fn alpha_follows_the_textbook_formula() {
        let cfg = CfarConfig {
            train: 16,
            pfa: 1e-4,
            ..Default::default()
        };
        let n = 32.0f32;
        let expect = n * (1e-4f32.powf(-1.0 / n) - 1.0);
        assert!(
            (cfg.alpha() - expect).abs() < 1e-4,
            "{} vs {expect}",
            cfg.alpha()
        );
        // A stricter Pfa must raise the threshold.
        let strict = CfarConfig { pfa: 1e-8, ..cfg };
        assert!(strict.alpha() > cfg.alpha());
    }

    #[test]
    fn finds_a_target_and_ignores_the_floor() {
        let mut env = noise_floor(2000, 7, 0.01);
        env[900] = 1.0;
        env[899] = 0.4;
        env[901] = 0.4;

        let dets = detect(&env, &CfarConfig::default(), 100, None);
        assert_eq!(
            dets.len(),
            1,
            "expected exactly one detection, got {dets:?}"
        );
        assert!(
            (dets[0].index - 900.0).abs() < 1.0,
            "index {}",
            dets[0].index
        );
        assert!(dets[0].snr_db > 20.0, "snr {}", dets[0].snr_db);
    }

    #[test]
    fn a_pure_noise_record_produces_few_or_no_false_alarms() {
        let env = noise_floor(20_000, 4242, 0.02);
        let dets = detect(
            &env,
            &CfarConfig {
                pfa: 1e-4,
                ..Default::default()
            },
            100,
            None,
        );
        // 20k cells at Pfa 1e-4 predicts ~2 expected; allow generous slack for
        // the non-Rayleigh test noise, but this must not be hundreds.
        assert!(dets.len() < 40, "{} false alarms is too many", dets.len());
    }

    #[test]
    fn the_threshold_tracks_a_rising_noise_floor() {
        // A ramp: quiet at the start, loud at the end — like a record dominated
        // by the direct-path blast decaying into room noise.
        let n = 4000;
        let env: Vec<f32> = (0..n)
            .map(|i| 0.001 + 0.5 * (i as f32 / n as f32))
            .collect();
        let mut thr = vec![0.0f32; n];
        let _ = detect(&env, &CfarConfig::default(), 0, Some(&mut thr));
        assert!(
            thr[3500] > thr[500] * 5.0,
            "threshold must follow the floor: {} vs {}",
            thr[500],
            thr[3500]
        );
    }

    #[test]
    fn os_cfar_survives_an_interferer_that_masks_ca_cfar() {
        // Two targets close enough that each sits in the other's training window.
        let mut env = noise_floor(2000, 11, 0.01);
        let cfg_base = CfarConfig {
            train: 24,
            guard: 6,
            pfa: 1e-3,
            ..Default::default()
        };
        env[1000] = 1.0;
        env[1020] = 0.30; // the weaker neighbour, inside the training window

        let ca = detect(
            &env,
            &CfarConfig {
                kind: CfarKind::CellAveraging,
                ..cfg_base
            },
            100,
            None,
        );
        let os = detect(
            &env,
            &CfarConfig {
                kind: CfarKind::OrderedStatistic,
                ..cfg_base
            },
            100,
            None,
        );

        let found_weak = |d: &Vec<Detection>| d.iter().any(|x| (x.index - 1020.0).abs() < 2.0);
        assert!(
            found_weak(&os),
            "OS-CFAR should find the masked target: {os:?}"
        );
        assert!(
            !found_weak(&ca) || os.len() >= ca.len(),
            "OS should be at least as sensitive as CA here"
        );
    }

    #[test]
    fn a_wide_target_collapses_to_one_detection() {
        // A target wide enough to span several cells but still inside the guard
        // band — which is exactly what the guard band is for.
        let mut env = noise_floor(2000, 3, 0.01);
        env[900..916].fill(0.8);
        env[908] = 1.0;
        let dets = detect(&env, &CfarConfig::default(), 100, None);
        assert_eq!(
            dets.len(),
            1,
            "a plateau is one object, not sixteen: {dets:?}"
        );
        assert!(dets[0].width >= 12, "width {}", dets[0].width);
        assert!(
            (dets[0].index - 908.0).abs() < 2.0,
            "index {}",
            dets[0].index
        );
    }

    #[test]
    fn an_extended_target_wider_than_the_guard_band_self_masks() {
        // Documented, deliberate behaviour rather than a lurking surprise: CFAR
        // estimates noise from the neighbourhood, so a target that fills its own
        // training window raises its own threshold and disappears from the
        // middle outward. The fix is a wider guard band (see `sized_for`), not a
        // lower Pfa — this test exists so the tradeoff stays visible.
        let mut env = noise_floor(2000, 3, 0.01);
        env[900..1100].fill(0.8);
        let tight = CfarConfig {
            train: 24,
            guard: 8,
            ..Default::default()
        };
        let dets = detect(&env, &tight, 100, None);
        assert!(dets.len() <= 2, "the interior should mask itself: {dets:?}");

        // Widen the guard past the target and it comes back as one object.
        let wide = CfarConfig {
            train: 60,
            guard: 110,
            ..Default::default()
        };
        let dets = detect(&env, &wide, 100, None);
        assert_eq!(
            dets.len(),
            1,
            "a guard band wider than the target recovers it: {dets:?}"
        );
    }

    #[test]
    fn sized_for_puts_the_guard_band_past_the_compressed_mainlobe() {
        use crate::chirp::ChirpSpec;
        use crate::window::Window;
        let spec = ChirpSpec::default(); // 4 kHz sweep at 48 kHz -> 12-sample mainlobe
        let cfg = CfarConfig::sized_for(&spec, Window::Hann);
        // 12 * 1.67 = 20 samples, x1.5 = 30.
        assert!(
            cfg.guard >= 20,
            "guard {} must cover the mainlobe",
            cfg.guard
        );
        assert!(cfg.train >= 2 * cfg.guard - 1, "train {}", cfg.train);
        assert!(cfg.merge_gap >= 12, "merge_gap {}", cfg.merge_gap);

        // A wider sweep compresses harder, so it needs a narrower guard.
        let wide = ChirpSpec {
            f0: 16_000.0,
            f1: 23_000.0,
            ..ChirpSpec::default()
        };
        assert!(CfarConfig::sized_for(&wide, Window::Hann).guard < cfg.guard);
    }

    #[test]
    fn a_nan_in_the_envelope_terminates_instead_of_spinning() {
        // Regression: NaN compares false against BOTH `<=` and `>`, which made
        // the run scanner loop forever. This test must simply return.
        let mut env = noise_floor(500, 3, 0.01);
        env[100] = f32::NAN;
        env[101] = f32::INFINITY;
        env[102] = f32::NEG_INFINITY;
        env[300] = 1.0;
        let dets = detect(&env, &CfarConfig::default(), 0, None);
        assert!(dets.iter().all(|d| d.end >= d.start));
        // An all-NaN envelope is degenerate but must still terminate.
        let all_nan = vec![f32::NAN; 500];
        assert!(detect(&all_nan, &CfarConfig::default(), 0, None).is_empty());

        // OS-CFAR sorts its training cells; with NaNs present that sort must use
        // a TOTAL order or Rust detects the broken comparator and panics.
        let mut mixed = noise_floor(500, 9, 0.01);
        for (i, v) in mixed.iter_mut().enumerate() {
            if i % 7 == 0 {
                *v = f32::NAN;
            }
        }
        let os = CfarConfig {
            kind: CfarKind::OrderedStatistic,
            ..Default::default()
        };
        let _ = detect(&mixed, &os, 0, None);
    }

    #[test]
    fn two_resolved_peaks_sharing_one_run_are_reported_separately() {
        // The failure this splitting exists to fix: both echoes stay above the
        // threshold with a deep trough between them, so a purely run-grouped
        // detector sees one long run and reports one object.
        // Two overlapping mainlobes, resolved but not separated: the dip
        // between them never returns to the noise floor.
        let mut env = noise_floor(3000, 17, 0.002);
        for (i, slot) in env.iter_mut().enumerate() {
            let g = |c: f32, a: f32| {
                let x = (i as f32 - c) / 12.0;
                a * (-x * x).exp()
            };
            *slot += g(1000.0, 1.0) + g(1040.0, 0.85);
        }
        let cfg = CfarConfig {
            train: 60,
            guard: 80,
            ..Default::default()
        };
        let mut thr = vec![0.0f32; env.len()];
        let dets = detect(&env, &cfg, 100, Some(&mut thr));
        assert!(
            env[1020] > thr[1020],
            "test setup: the trough must stay above threshold"
        );
        assert_eq!(dets.len(), 2, "both peaks should be reported: {dets:?}");
        assert!((dets[0].index - 1000.0).abs() < 2.0, "{:?}", dets[0]);
        assert!((dets[1].index - 1040.0).abs() < 2.0, "{:?}", dets[1]);

        // Demand more prominence than the pair has and they collapse to one.
        let strict = CfarConfig {
            min_prominence_db: 40.0,
            ..cfg
        };
        assert_eq!(detect(&env, &strict, 100, None).len(), 1);
    }

    #[test]
    fn a_bump_closer_than_the_resolution_cell_is_not_a_second_object() {
        // Prominent, but unresolvable: inside merge_gap of a stronger peak.
        let mut env = noise_floor(2000, 23, 0.002);
        env[900] = 1.0;
        env[901] = 0.5;
        env[903] = 0.9;
        let cfg = CfarConfig {
            merge_gap: 10,
            min_prominence_db: 3.0,
            ..Default::default()
        };
        let dets = detect(&env, &cfg, 100, None);
        assert_eq!(
            dets.len(),
            1,
            "sub-resolution bumps are one object: {dets:?}"
        );
    }

    #[test]
    fn merging_folds_sidelobe_shoulders_into_their_target() {
        // A mainlobe that dips below threshold and comes back — one wall, not three.
        let mut env = noise_floor(4000, 21, 0.005);
        for (offset, amp) in [(0usize, 0.5f32), (6, 1.0), (12, 0.45)] {
            for i in 0..3 {
                env[1000 + offset + i] = amp;
            }
        }
        let merged = detect(
            &env,
            &CfarConfig {
                merge_gap: 12,
                ..Default::default()
            },
            100,
            None,
        );
        let split = detect(
            &env,
            &CfarConfig {
                merge_gap: 0,
                ..Default::default()
            },
            100,
            None,
        );
        assert_eq!(
            merged.len(),
            1,
            "merging should give one object: {merged:?}"
        );
        assert!(
            split.len() > merged.len(),
            "without merging they stay separate"
        );
        assert!(
            (merged[0].index - 1006.0).abs() < 2.0,
            "kept the strongest peak"
        );
    }

    #[test]
    fn detections_before_start_are_suppressed() {
        let mut env = noise_floor(2000, 5, 0.01);
        env[50] = 5.0; // the direct-path blast
        env[900] = 1.0;
        let dets = detect(&env, &CfarConfig::default(), 400, None);
        assert!(
            dets.iter().all(|d| d.index >= 400.0),
            "blast leaked through: {dets:?}"
        );
        assert_eq!(dets.len(), 1);
    }

    #[test]
    fn parabolic_interpolation_recovers_a_sub_sample_peak() {
        // A symmetric triple peaks exactly on the centre sample.
        let sym = [0.5f32, 1.0, 0.5];
        assert!((parabolic_peak(&sym, 1) - 1.0).abs() < 1e-6);
        // Skewed right -> the true peak is right of centre.
        let right = [0.4f32, 1.0, 0.8];
        let p = parabolic_peak(&right, 1);
        assert!(p > 1.0 && p < 1.5, "{p}");
        // Edges are returned unmodified rather than panicking.
        assert_eq!(parabolic_peak(&sym, 0), 0.0);
        assert_eq!(parabolic_peak(&sym, 2), 2.0);

        // Non-finite neighbours fall back to the integer index rather than
        // emitting a NaN range that would poison every downstream consumer.
        assert_eq!(parabolic_peak(&[f32::NAN, 1.0, 0.5], 1), 1.0);
        assert_eq!(parabolic_peak(&[f32::INFINITY, 1.0, f32::INFINITY], 1), 1.0);
        assert_eq!(parabolic_peak(&[1.0, f32::NAN, 1.0], 1), 1.0);
    }

    #[test]
    fn empty_and_degenerate_inputs_do_not_panic() {
        assert!(detect(&[], &CfarConfig::default(), 0, None).is_empty());
        assert!(detect(&[0.0; 3], &CfarConfig::default(), 10, None).is_empty());
        let flat = vec![0.0f32; 500];
        assert!(detect(&flat, &CfarConfig::default(), 0, None).is_empty());
    }
}
