export const DEFAULT_SPEED_OF_SOUND = 343.2;

export function makeLinearChirp({ sampleRate, startHz, endHz, durationSec, amplitude = 0.5 }) {
  if (!(sampleRate > 0 && durationSec > 0 && startHz > 0 && endHz > startHz && endHz < sampleRate / 2)) throw new Error('invalid chirp config');
  const n = Math.max(1, Math.round(sampleRate * durationSec));
  const out = new Float64Array(n);
  const k = (endHz - startHz) / durationSec;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, n - 1));
    out[i] = amplitude * w * Math.sin(2 * Math.PI * (startHz * t + 0.5 * k * t * t));
  }
  return out;
}

export function correlate(received, probe) {
  if (!received?.length || !probe?.length) return new Float64Array(0);
  const out = new Float64Array(received.length);
  for (let lag = 0; lag < received.length; lag++) {
    let s = 0;
    const count = Math.min(probe.length, received.length - lag);
    for (let j = 0; j < count; j++) s += received[lag + j] * probe[j];
    out[lag] = s;
  }
  return out;
}

export function cancelDirectPath(correlation, blankSamples) {
  const out = Float64Array.from(correlation);
  const n = Math.min(out.length, Math.max(0, blankSamples | 0));
  for (let i = 0; i < n; i++) out[i] = 0;
  return out;
}

export function robustThreshold(signal, { guard = 8, training = 32, scale = 5 } = {}) {
  const out = new Float64Array(signal.length);
  for (let i = 0; i < signal.length; i++) {
    let sum = 0, count = 0;
    const lo = Math.max(0, i - guard - training);
    const hi = Math.min(signal.length - 1, i + guard + training);
    for (let j = lo; j <= hi; j++) {
      if (Math.abs(j - i) <= guard) continue;
      const v = Math.abs(signal[j]);
      if (Number.isFinite(v)) { sum += v; count++; }
    }
    out[i] = count ? (sum / count) * scale : Infinity;
  }
  return out;
}

export function detectPeaks(signal, threshold, minSeparationSamples = 8) {
  const candidates = [];
  for (let i = 1; i < signal.length - 1; i++) {
    const v = Math.abs(signal[i]);
    if (!Number.isFinite(v)) continue;
    if (v > threshold[i] && v >= Math.abs(signal[i - 1]) && v > Math.abs(signal[i + 1])) candidates.push({ sample: i, amplitude: v });
  }
  candidates.sort((a, b) => b.amplitude - a.amplitude);
  const kept = [];
  for (const c of candidates) {
    if (kept.every(k => Math.abs(k.sample - c.sample) >= minSeparationSamples)) kept.push(c);
  }
  return kept.sort((a, b) => a.sample - b.sample);
}

export function sampleToRange(sample, sampleRate, speedOfSound = DEFAULT_SPEED_OF_SOUND) {
  return sample / sampleRate * speedOfSound / 2;
}

export function rangeToSample(rangeM, sampleRate, speedOfSound = DEFAULT_SPEED_OF_SOUND) {
  return Math.round((rangeM * 2 / speedOfSound) * sampleRate);
}

export function simulateEchoes(probe, { sampleRate, targets, lengthSamples, directAmplitude = 1 }) {
  const out = new Float64Array(lengthSamples);
  for (let i = 0; i < Math.min(probe.length, out.length); i++) out[i] += probe[i] * directAmplitude;
  for (const target of targets) {
    const delay = rangeToSample(target.rangeM, sampleRate);
    const amp = target.amplitude ?? 0.2;
    for (let i = 0; i < probe.length && i + delay < out.length; i++) out[i + delay] += probe[i] * amp;
  }
  return out;
}

export function scan(received, probe, { sampleRate, minRangeM = 0.25, maxRangeM = 8, speedOfSound = DEFAULT_SPEED_OF_SOUND, threshold = {} }) {
  const corr = correlate(received, probe);
  const blank = rangeToSample(minRangeM, sampleRate, speedOfSound);
  const maxSample = Math.min(corr.length, rangeToSample(maxRangeM, sampleRate, speedOfSound) + 1);
  const gated = cancelDirectPath(corr.subarray(0, maxSample), blank);
  const thr = robustThreshold(gated, threshold);
  const peaks = detectPeaks(gated, thr, Math.max(4, Math.round(probe.length / 10)));
  const norm = probe.reduce((s, v) => s + v * v, 0) || 1;
  return peaks.map(p => ({
    sample: p.sample,
    rangeM: sampleToRange(p.sample, sampleRate, speedOfSound),
    confidence: Math.min(1, p.amplitude / norm),
    amplitude: p.amplitude,
  }));
}
