// SPDX-License-Identifier: MIT
//
// BatVu — the app.
//
// Stand still. Sweep the phone across the room like a torch. Each sweep emits an
// ultrasonic chirp fifteen times a second, listens for the room's answer, and
// paints what came back onto a plan-position display.
//
// ## Two modes, and why the second one is not a toy
//
// **Live** uses the speaker and microphone. It needs a real iPhone, a real room,
// and two permission prompts.
//
// **Demo** replaces the microphone with `@batvu/sim`: a 3-D room, ray-cast
// through the beam cone, rendered to a waveform by the same Rust simulator the
// DSP unit tests use. Everything downstream is byte-identical to live — the same
// wasm, the same matched filter, the same CFAR, the same occupancy update. That
// makes demo mode the end-to-end test: a headless browser in CI drives the real
// application and asserts the real map. A mocked pipeline would only prove the
// mock still works.

import {
  BatVuCore,
  DEFAULT_PING_RATE_HZ,
  DEFAULT_SONAR_CONFIG,
  OccupancyGrid,
  angularCoverage,
  beamDirection,
  fromSpherical,
  minPriSeconds,
  recordLenFor,
  type DeviceOrientation,
  type PingResult,
  type SonarConfig,
  type Vec3,
} from '@batvu/core';
import { livingRoom, sampleBeam, type Room } from '@batvu/sim';
import { coneRays, priSamplesFor } from '@batvu/core';
import { AudioSession, checkSupport, fitConfigToRate, heterodyne } from './audio.js';
import {
  BatVuRenderer,
  coverageBin,
  echoesFrom,
  type Echo,
  type RenderState,
} from './render.js';

const COVERAGE_BINS = 48;
const BEAM_HALF_ANGLE_DEG = 30;

interface Elements {
  ppi: HTMLCanvasElement;
  ascope: HTMLCanvasElement;
  coverage: HTMLCanvasElement;
  start: HTMLButtonElement;
  demo: HTMLButtonElement;
  stop: HTMLButtonElement;
  status: HTMLElement;
  stats: HTMLElement;
  warnings: HTMLElement;
}

/** Everything the app knows, in one place so the e2e test can read it. */
export interface AppState {
  running: boolean;
  mode: 'idle' | 'live' | 'demo';
  pings: number;
  detections: number;
  coverage: number;
  occupiedVoxels: number;
  lastResult: PingResult | null;
  warnings: string[];
}

export class BatVuApp {
  private core: BatVuCore | null = null;
  private plan: ReturnType<BatVuCore['createPlan']> | null = null;
  private config: SonarConfig = DEFAULT_SONAR_CONFIG;
  private grid = new OccupancyGrid({ beamHalfAngleDeg: BEAM_HALF_ANGLE_DEG });
  private renderer: BatVuRenderer | null = null;
  private audio: AudioSession | null = null;
  private room: Room = livingRoom();

  private echoes: Echo[] = [];
  private beams: Vec3[] = [];
  private covered = new Set<number>();
  private orientation: DeviceOrientation = { alpha: 0, beta: 0, gamma: 0 };
  private beam: Vec3 = { x: 0, y: -1, z: 0 };
  private pingIndex = 0;
  private detectionCount = 0;
  private rippleStart = 0;
  private frame = 0;
  private demoTimer: ReturnType<typeof setInterval> | null = null;
  private mode: AppState['mode'] = 'idle';
  private warnings: string[] = [];
  private lastResult: PingResult | null = null;
  /** Injected in demo mode so a scan is reproducible; absent in live mode. */
  private demoSweepAngle = -Math.PI;
  /**
   * A COPY of the last ping's envelope, not the live wasm view.
   *
   * The A-scope is redrawn every frame rather than once per ping, because
   * resizing a canvas clears it — so a view drawn only on arrival vanishes the
   * first time the phone rotates and never comes back. And it has to be a copy:
   * the plan's envelope is a window into wasm memory that the next ping
   * overwrites and `destroy()` invalidates.
   */
  private lastEnvelope = new Float32Array(0);

  constructor(private readonly el: Elements) {}

  state(): AppState {
    return {
      running: this.mode !== 'idle',
      mode: this.mode,
      pings: this.pingIndex,
      detections: this.detectionCount,
      coverage: angularCoverage(this.beams),
      occupiedVoxels: this.grid.occupiedCount(),
      lastResult: this.lastResult,
      warnings: [...this.warnings],
    };
  }

  async init(wasmUrl = 'wasm/batvu_dsp.wasm'): Promise<void> {
    const support = checkSupport();
    if (!support.ok) {
      this.warn(`This browser is missing ${support.missing.join(', ')}.`);
    }
    this.core = await BatVuCore.load(wasmUrl);
    this.renderer = new BatVuRenderer(
      ctx2d(this.el.ppi),
      ctx2d(this.el.ascope),
      ctx2d(this.el.coverage),
    );
    this.resize();
    globalThis.addEventListener('resize', () => this.resize());
    this.el.start.addEventListener('click', () => void this.startLive());
    this.el.demo.addEventListener('click', () => void this.startDemo());
    this.el.stop.addEventListener('click', () => void this.stop());
    this.loop();
    this.setStatus('Ready. Stand still and sweep the phone like a torch.');
  }

  private resize(): void {
    const w = this.el.ppi.clientWidth || 320;
    BatVuRenderer.fitCanvas(this.el.ppi, w, w);
    BatVuRenderer.fitCanvas(this.el.ascope, this.el.ascope.clientWidth || w, 120);
    BatVuRenderer.fitCanvas(this.el.coverage, this.el.coverage.clientWidth || w, 18);
  }

  // ── live ──────────────────────────────────────────────────────────────────

  async startLive(): Promise<void> {
    if (this.mode !== 'idle') return;
    try {
      await this.requestOrientation();
      const audio = new AudioSession();
      const { sampleRate, report } = await audio.open();
      this.audio = audio;

      // The context's rate is whatever the audio route decided; the chirp is
      // synthesised to match, and the band capped against the REAL Nyquist.
      // Hard-coding 48 kHz would alias on a 44.1 kHz route.
      this.config = fitConfigToRate(DEFAULT_SONAR_CONFIG, sampleRate);
      if (this.config.f1 !== DEFAULT_SONAR_CONFIG.f1) {
        this.warn(
          `Audio route is ${Math.round(sampleRate)} Hz, so the sweep was moved to ` +
            `${(this.config.f0 / 1000).toFixed(1)}-${(this.config.f1 / 1000).toFixed(1)} kHz.`,
        );
      }
      for (const ignored of report.ignored) {
        // The browser said yes and then did it anyway. Echo cancellation in
        // particular removes the speaker from the microphone — which is the
        // measurement — so this is worth shouting about.
        this.warn(`The browser kept ${ignored} ON. Ranges will be unreliable.`);
      }

      // The live path is the ONLY one that needs this, and it needs it before
      // the plan is built. A continuous microphone ring hands the DSP a record
      // holding several transmit blasts; telling the core the interval is what
      // lets it lock onto the most recent one instead of the loudest, so the
      // echoes it reports belong to the attitude being recorded with them.
      // Demo mode leaves it at 0 — each synthetic record has exactly one blast.
      const pingRateHz = Math.min(DEFAULT_PING_RATE_HZ, 1 / minPriSeconds(this.config));
      this.config = { ...this.config, priSamples: priSamplesFor(this.config, pingRateHz) };

      this.preparePlan();
      const waveform = this.transmitWaveform();
      audio.start(
        {
          waveform,
          config: this.config,
          recordLen: recordLenFor(this.config),
          pingRateHz,
        },
        (ping) => this.onRecord(ping.samples),
      );
      this.mode = 'live';
      this.setStatus('Listening. Sweep slowly — the map sharpens where looks overlap.');
    } catch (err) {
      this.warn(`Could not start: ${(err as Error).message}`);
      this.setStatus('Live mode unavailable. Demo mode still works.');
    }
    this.syncButtons();
  }

  /**
   * iOS 13+ requires an explicit, gesture-initiated grant for motion data, and
   * a page that never asks simply gets silence — no error, no events.
   */
  private async requestOrientation(): Promise<void> {
    const ctor = globalThis.DeviceOrientationEvent as
      | (typeof DeviceOrientationEvent & { requestPermission?: () => Promise<PermissionState> })
      | undefined;
    if (ctor?.requestPermission) {
      const result = await ctor.requestPermission();
      if (result !== 'granted') {
        this.warn('Motion access denied — bearing is unavailable, so the map cannot form.');
        return;
      }
    }
    globalThis.addEventListener('deviceorientation', (e) => {
      this.orientation = { alpha: e.alpha ?? 0, beta: e.beta ?? 0, gamma: e.gamma ?? 0 };
      this.beam = beamDirection(this.orientation);
    });
  }

  // ── demo ──────────────────────────────────────────────────────────────────

  async startDemo(room?: Room): Promise<void> {
    if (this.mode !== 'idle') return;
    if (room) this.room = room;
    this.config = DEFAULT_SONAR_CONFIG;
    this.preparePlan();
    this.mode = 'demo';
    this.demoSweepAngle = -Math.PI;
    const periodMs = 1000 / DEFAULT_PING_RATE_HZ;
    this.demoTimer = setInterval(() => this.demoPing(), periodMs);
    this.setStatus(`Simulating "${this.room.name}" — the same pipeline, a synthetic room.`);
    this.syncButtons();
  }

  /** One simulated ping: point somewhere, ask the room, run the real pipeline. */
  demoPing(): void {
    const core = this.core;
    if (!core) return;
    // A serpentine sweep in azimuth with a slow elevation nod — the motion a
    // person actually makes, rather than a teleporting raster.
    this.demoSweepAngle += 0.14;
    if (this.demoSweepAngle > Math.PI) this.demoSweepAngle = -Math.PI;
    const elevation = 0.35 * Math.sin(this.demoSweepAngle * 0.7);
    this.beam = fromSpherical({ azimuth: this.demoSweepAngle, elevation });

    const halfAngle = (BEAM_HALF_ANGLE_DEG * Math.PI) / 180;
    const rays = coneRays(this.beam, halfAngle, 96);
    const targets = sampleBeam(this.room, { x: 0, y: 0, z: 0 }, this.beam, rays, {
      halfAngleDeg: BEAM_HALF_ANGLE_DEG,
      rays: 96,
      clusterM: 0.08,
      maxRangeM: this.config.maxRangeM,
    });
    const res = core.eval<{ samples: number[] }>({
      op: 'simulate',
      config: this.config,
      targets,
      scene: {
        recordLen: recordLenFor(this.config),
        noiseRms: 8e-4,
        // A different noise realisation per ping, derived from the ping index so
        // the whole demo still replays exactly.
        seed: (0x5eed0000 + this.pingIndex * 2654435761) >>> 0,
      },
    });
    this.onRecord(Float32Array.from(res.samples));
  }

  // ── the shared pipeline ───────────────────────────────────────────────────

  private preparePlan(): void {
    this.plan?.destroy();
    this.plan = this.core!.createPlan(
      this.config as unknown as Record<string, unknown>,
      recordLenFor(this.config),
    );
    this.grid = new OccupancyGrid({ beamHalfAngleDeg: BEAM_HALF_ANGLE_DEG });
    this.echoes = [];
    this.beams = [];
    this.covered.clear();
    this.pingIndex = 0;
    this.detectionCount = 0;
  }

  transmitWaveform(): Float32Array {
    const res = this.core!.eval<{ samples: number[] }>({ op: 'chirp', config: this.config });
    return Float32Array.from(res.samples);
  }

  /** Live and demo converge here. Below this line the two modes are identical. */
  onRecord(samples: Float32Array): void {
    const plan = this.plan;
    if (!plan) return;
    const result = plan.processSamples(samples);
    this.lastResult = result;
    this.pingIndex++;
    this.rippleStart = this.frame;

    if (result.saturated) {
      this.warnOnce('Microphone is clipping — move away from hard surfaces or turn it down.');
    }
    if (result.blastAmplitude <= 0) {
      this.warnOnce('No direct path heard — the speaker may be muted or covered.');
    }

    this.detectionCount += result.detections.length;
    this.echoes.push(
      ...echoesFrom(
        result.detections,
        this.beam,
        (BEAM_HALF_ANGLE_DEG * Math.PI) / 180,
        this.pingIndex,
      ),
    );
    // Bound the persistence buffer: a long scan would otherwise accumulate every
    // echo it ever saw and the frame time would climb until the app stalled.
    if (this.echoes.length > 4000) this.echoes.splice(0, this.echoes.length - 4000);

    this.beams.push(this.beam);
    this.covered.add(coverageBin(Math.atan2(this.beam.x, this.beam.y), COVERAGE_BINS));
    this.grid.integrate(result, {
      beam: this.beam,
      minRangeM: this.config.minRangeM,
      maxRangeM: this.config.maxRangeM,
    });

    const env = plan.envelope.subarray(0, result.envLen);
    if (this.lastEnvelope.length !== env.length) this.lastEnvelope = new Float32Array(env.length);
    this.lastEnvelope.set(env);
  }

  // ── frame loop ────────────────────────────────────────────────────────────

  private loop(): void {
    const tick = (): void => {
      this.frame++;
      this.draw();
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(tick);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(tick);
  }

  draw(): void {
    if (!this.renderer) return;
    const framesPerPing = Math.max(1, Math.round(60 / DEFAULT_PING_RATE_HZ));
    const state: RenderState = {
      echoes: this.echoes,
      beamAzimuth: Math.atan2(this.beam.x, this.beam.y),
      beamElevation: Math.asin(Math.min(1, Math.max(-1, this.beam.z))),
      maxRangeM: this.config.maxRangeM,
      minRangeM: this.config.minRangeM,
      ripple: Math.min(1, (this.frame - this.rippleStart) / framesPerPing),
      covered: this.covered,
      coverageBins: COVERAGE_BINS,
      pingIndex: this.pingIndex,
    };
    this.renderer.drawAll(state);
    if (this.lastResult && this.lastEnvelope.length > 0) {
      this.renderer.drawAScope(
        this.lastEnvelope,
        this.lastResult.startRangeM,
        this.lastResult.rangeStepM,
        this.lastResult.detections,
      );
    }
    this.renderStats();
  }

  private renderStats(): void {
    const s = this.state();
    const bearing = ((Math.atan2(this.beam.x, this.beam.y) * 180) / Math.PI + 360) % 360;
    // BOTH coverage numbers, because they routinely disagree and the difference
    // is the point. Turning on the spot sweeps nearly every bearing while
    // touching one thin band of the sphere; reporting only the bearing figure
    // would call that a finished scan, and reporting only the spherical one
    // would call a perfectly good horizontal sweep a failure.
    const bearings = (this.covered.size / COVERAGE_BINS) * 100;
    this.el.stats.textContent =
      `${s.pings} pings · ${s.detections} echoes · ` +
      `${bearings.toFixed(0)}% of bearings · ${(s.coverage * 100).toFixed(0)}% of the sphere · ` +
      `${s.occupiedVoxels} voxels · bearing ${bearing.toFixed(0)}°`;
  }

  // ── control ───────────────────────────────────────────────────────────────

  async stop(): Promise<void> {
    if (this.demoTimer !== null) clearInterval(this.demoTimer);
    this.demoTimer = null;
    await this.audio?.close();
    this.audio = null;
    this.mode = 'idle';
    this.setStatus('Stopped.');
    this.syncButtons();
  }

  private syncButtons(): void {
    const idle = this.mode === 'idle';
    this.el.start.disabled = !idle;
    this.el.demo.disabled = !idle;
    this.el.stop.disabled = idle;
  }

  private setStatus(text: string): void {
    this.el.status.textContent = text;
  }

  private warn(text: string): void {
    this.warnings.push(text);
    const li = document.createElement('li');
    li.textContent = text;
    this.el.warnings.appendChild(li);
  }

  private warnOnce(text: string): void {
    if (this.warnings.includes(text)) return;
    this.warn(text);
  }

  /** Exposed for the audification control and for tests. */
  audify(samples: Float32Array, sampleRate: number): Float32Array {
    return heterodyne(samples, sampleRate, Math.min(this.config.f0, this.config.f1) - 500);
  }
}

function ctx2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('batvu: 2-D canvas is unavailable');
  return ctx;
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`batvu: missing element #${id}`);
  return node as T;
}

/** Boot. Exposed on `window` so the end-to-end test can drive the real app. */
export async function boot(): Promise<BatVuApp> {
  const app = new BatVuApp({
    ppi: el<HTMLCanvasElement>('ppi'),
    ascope: el<HTMLCanvasElement>('ascope'),
    coverage: el<HTMLCanvasElement>('coverage'),
    start: el<HTMLButtonElement>('start'),
    demo: el<HTMLButtonElement>('demo'),
    stop: el<HTMLButtonElement>('stop'),
    status: el('status'),
    stats: el('stats'),
    warnings: el('warnings'),
  });
  await app.init();
  (globalThis as unknown as { batvu: BatVuApp }).batvu = app;
  return app;
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void boot());
  } else {
    void boot();
  }
}
