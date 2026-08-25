// SPDX-License-Identifier: MIT
//
// The audio path: getting an ultrasonic chirp out of an iPhone's speaker and
// the room's answer back off its microphone.
//
// Almost everything hard about BatVu on a phone lives in this file, and none of
// it is signal processing.
//
// ## The three-way fight with the platform
//
// 1. **The browser wants to help you make a phone call.** `getUserMedia`
//    defaults to echo cancellation, noise suppression and automatic gain
//    control — three algorithms whose entire purpose is to destroy exactly the
//    signal a sonar needs. Echo cancellation is the worst: it is built to
//    remove the speaker's output from the microphone's input, which is the
//    measurement. All three are requested off, and the result is VERIFIED
//    rather than trusted, because a browser may ignore a constraint silently.
//
// 2. **Nobody will tell you when the sound left the speaker.** WebAudio's
//    `outputLatency` is an estimate, absent on some versions, and it drifts with
//    route changes. Time-of-flight needs absolute timing and the platform simply
//    has none. BatVu does not ask for it: the DSP core times every echo from the
//    direct-path blast instead, so the unknown latency subtracts out. This file
//    only has to make sure the record is long enough to contain the blast.
//
// 3. **Audio does not start without a gesture.** iOS will not run an
//    `AudioContext` until a user interaction resumes it, so the whole graph is
//    built inside a tap handler and not a moment earlier.
//
// ## Sample rate
//
// You cannot ask an iOS `AudioContext` for a sample rate — the option is
// ignored, and the context comes up at whatever the current audio route runs
// at. That is 48 kHz on the speaker path and 44.1 kHz on some routes, so the
// chirp is synthesised at the rate the context reports and the band is capped
// against the real Nyquist. A hard-coded 48 kHz would alias on the other route.

import type { SonarConfig } from '@batvu/core';

export interface CaptureConstraintReport {
  requested: MediaTrackConstraints;
  /** What the browser says it actually applied. */
  applied: MediaTrackSettings;
  /** Constraints we asked to be off that the browser left ON. */
  ignored: string[];
}

export interface AudioSessionOptions {
  /** The transmit waveform, synthesised at the context's real sample rate. */
  waveform: Float32Array;
  /** Samples to capture per ping. */
  recordLen: number;
  /** Pings per second. */
  pingRateHz: number;
}

export interface Ping {
  /** The captured record, ready for a `SonarPlan`. */
  samples: Float32Array;
  /** Context time the ping was scheduled for — for ordering, NOT for ranging. */
  scheduledAt: number;
}

/**
 * Is this browser going to be able to do any of this?
 *
 * Checked up front so the failure is a sentence the user can act on rather than
 * an exception three layers down.
 */
export function checkSupport(): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (typeof AudioContext === 'undefined' && typeof (globalThis as { webkitAudioContext?: unknown }).webkitAudioContext === 'undefined') {
    missing.push('Web Audio');
  }
  if (!globalThis.navigator?.mediaDevices?.getUserMedia) missing.push('microphone access');
  if (typeof WebAssembly === 'undefined') missing.push('WebAssembly');
  return { ok: missing.length === 0, missing };
}

/**
 * The capture constraints, and why each one is here.
 *
 * `echoCancellation` must be off or the browser removes the speaker's output
 * from the microphone's input — which is the entire measurement. `autoGainControl`
 * must be off or the record's amplitude stops meaning anything, and the
 * direct-path blast (the timing reference) gets pumped up and down between
 * pings. `noiseSuppression` must be off because a 19 kHz chirp is, to a
 * speech-tuned suppressor, exactly what noise looks like.
 */
export function captureConstraints(): MediaTrackConstraints {
  return {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
  };
}

/** Ask for the microphone and report which constraints the browser honoured. */
export async function openMicrophone(): Promise<{
  stream: MediaStream;
  report: CaptureConstraintReport;
}> {
  const requested = captureConstraints();
  const stream = await navigator.mediaDevices.getUserMedia({ audio: requested, video: false });
  const track = stream.getAudioTracks()[0];
  const applied = track?.getSettings() ?? {};

  // A browser may accept a constraint and then not apply it. `getSettings()`
  // catching that is the cheap check and NOT proof — the settings object reports
  // what was requested at least as often as what was applied. The honest
  // verification is acoustic: the app watches `blastAmplitude` on every ping, and
  // a direct path that fades or pumps between pings means echo cancellation or
  // AGC is running whatever this said.
  const ignored: string[] = [];
  for (const key of ['echoCancellation', 'noiseSuppression', 'autoGainControl'] as const) {
    if (applied[key] === true) ignored.push(key);
  }
  return { stream, report: { requested, applied, ignored } };
}

/**
 * A running sonar session: emits chirps on a schedule and hands back records.
 *
 * The capture is a plain `ScriptProcessor`-free design: a `MediaStreamSource`
 * feeds an `AudioWorklet` when one is available, and the worklet copies frames
 * into a ring buffer that this class slices into per-ping records. Recording is
 * CONTINUOUS and the slicing is nominal — because the exact alignment does not
 * matter. The DSP finds the blast and times from there.
 */
export class AudioSession {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private ring: Float32Array = new Float32Array(0);
  private writePos = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private buffer: AudioBuffer | null = null;
  private onPing: ((ping: Ping) => void) | null = null;
  private lastEmitAt = 0;

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 0;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /**
   * Build the graph. MUST be called from inside a user-gesture handler.
   *
   * Returns the context's ACTUAL sample rate, which the caller uses to
   * re-synthesise the chirp — see the module note on why it cannot be requested.
   */
  async open(): Promise<{ sampleRate: number; report: CaptureConstraintReport }> {
    const Ctor =
      (globalThis as { AudioContext?: typeof AudioContext }).AudioContext ??
      (globalThis as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctor();
    // iOS starts contexts suspended; only a gesture may resume one.
    if (ctx.state === 'suspended') await ctx.resume();
    this.ctx = ctx;

    const { stream, report } = await openMicrophone();
    this.stream = stream;
    this.source = ctx.createMediaStreamSource(stream);

    await this.attachCapture(ctx);
    return { sampleRate: ctx.sampleRate, report };
  }

  private async attachCapture(ctx: AudioContext): Promise<void> {
    // Ten seconds of ring is plenty: records are slices of a fraction of a
    // second, and the surplus absorbs a scheduling hiccup without wrapping.
    this.ring = new Float32Array(Math.ceil(ctx.sampleRate * 10));
    this.writePos = 0;

    const workletSource = `
      class BatVuCapture extends AudioWorkletProcessor {
        process(inputs) {
          const ch = inputs[0] && inputs[0][0];
          if (ch) this.port.postMessage(ch.slice(0));
          return true;
        }
      }
      registerProcessor('batvu-capture', BatVuCapture);
    `;
    const url = URL.createObjectURL(new Blob([workletSource], { type: 'application/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
      const node = new AudioWorkletNode(ctx, 'batvu-capture');
      node.port.onmessage = (e: MessageEvent<Float32Array>) => this.writeRing(e.data);
      this.source?.connect(node);
      // A worklet with no output still needs a destination to be pulled.
      node.connect(ctx.destination);
      this.worklet = node;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  private writeRing(frame: Float32Array): void {
    const n = this.ring.length;
    if (n === 0) return;
    for (let i = 0; i < frame.length; i++) {
      this.ring[this.writePos] = frame[i]!;
      this.writePos = (this.writePos + 1) % n;
    }
  }

  /** Copy the most recent `count` samples out of the ring, oldest first. */
  private readRecent(count: number): Float32Array {
    const n = this.ring.length;
    const out = new Float32Array(count);
    if (n === 0) return out;
    let read = (this.writePos - count + n * 2) % n;
    for (let i = 0; i < count; i++) {
      out[i] = this.ring[read]!;
      read = (read + 1) % n;
    }
    return out;
  }

  /** Start emitting and delivering records. */
  start(options: AudioSessionOptions, onPing: (ping: Ping) => void): void {
    const ctx = this.ctx;
    if (!ctx) throw new Error('batvu: open() the audio session first');
    this.onPing = onPing;

    const buffer = ctx.createBuffer(1, options.waveform.length, ctx.sampleRate);
    // Copy into the buffer's OWN channel rather than handing WebAudio a
    // caller-owned array: the waveform may be a view into wasm memory, which the
    // next allocation can detach, and an AudioBuffer holding a detached view
    // plays silence with no error anywhere.
    buffer.getChannelData(0).set(options.waveform);
    this.buffer = buffer;

    const periodMs = 1000 / Math.max(1, options.pingRateHz);
    // A record is only useful once the ring holds a full ping's worth of
    // history, so the first slice is taken one period after the first emission.
    this.timer = setInterval(() => {
      this.emit();
      if (this.lastEmitAt > 0) {
        this.onPing?.({
          samples: this.readRecent(options.recordLen),
          scheduledAt: this.lastEmitAt,
        });
      }
      this.lastEmitAt = ctx.currentTime;
    }, periodMs);
  }

  private emit(): void {
    const ctx = this.ctx;
    const buffer = this.buffer;
    if (!ctx || !buffer) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.start();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  async close(): Promise<void> {
    this.stop();
    this.worklet?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close();
    this.ctx = null;
  }
}

/**
 * Clamp a sonar config to what a given sample rate can actually carry.
 *
 * The band is capped at 0.45 of the sample rate rather than the full Nyquist:
 * the anti-alias filters in the capture path are not brick walls, and a sweep
 * that runs right up to Nyquist loses its top end to the filter's roll-off — so
 * the bandwidth appears in the design report and not in the data.
 */
export function fitConfigToRate(config: SonarConfig, sampleRate: number): SonarConfig {
  const ceiling = sampleRate * 0.45;
  if (config.f1 <= ceiling && config.fs === sampleRate) return { ...config, fs: sampleRate };
  const bandwidth = Math.abs(config.f1 - config.f0);
  const f1 = Math.min(config.f1, ceiling);
  const f0 = Math.max(1000, f1 - bandwidth);
  return { ...config, fs: sampleRate, f0, f1 };
}

/**
 * Heterodyne the ultrasonic band down into hearing — the bat-detector trick,
 * and the oldest one in the field.
 *
 * Multiplying by a local oscillator just below the sweep shifts 17.5-20.5 kHz to
 * 500-3500 Hz, which is right in the ear's most sensitive region. It is not a
 * gimmick: a person can hear the difference between a hard wall and a curtain
 * long before they can read it off a plot, and it is the only channel that works
 * with the phone held up and the screen out of view.
 */
export function heterodyne(
  samples: Float32Array,
  sampleRate: number,
  loFreqHz: number,
  out: Float32Array = new Float32Array(samples.length),
): Float32Array {
  const w = (2 * Math.PI * loFreqHz) / sampleRate;
  // A one-pole lowpass at ~4 kHz removes the sum-frequency image the
  // multiplication creates; without it the result is the original ultrasound
  // plus a copy, and the ultrasound is still inaudible but still clipping.
  const cutoff = Math.min(4000, sampleRate / 4);
  const alpha = 1 - Math.exp((-2 * Math.PI * cutoff) / sampleRate);
  let state = 0;
  for (let i = 0; i < samples.length; i++) {
    const mixed = samples[i]! * Math.cos(w * i);
    state += alpha * (mixed - state);
    out[i] = state;
  }
  return out;
}
