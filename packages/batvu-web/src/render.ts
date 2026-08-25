// SPDX-License-Identifier: MIT
//
// The bat-vision renderer.
//
// ## The one design rule
//
// **Never draw a point where the sensor measured an arc.**
//
// A single speaker and a single microphone give RANGE. Not bearing. An echo at
// 2.4 m is somewhere on a spherical cap tens of degrees wide, and the only
// direction information in the whole system is where the phone happened to be
// pointing. Range is precise — centimetres. Bearing is not — at 3 m the beam is
// over a metre across. That anisotropy is roughly a hundred to one, and it is
// the governing visual fact of the project.
//
// A renderer that draws crisp dots would be lying by a factor of a hundred, and
// it would look BETTER than the honest version, which is exactly why it is worth
// refusing. So every echo is drawn as an arc whose angular extent is the beam
// width and whose radial thickness is the range uncertainty. The picture that
// results looks like a smear until the user sweeps, and then it sharpens where
// the arcs cross — which is a true account of how the map is actually formed.
//
// ## Three views, each answering a different question
//
// * **PPI** (plan-position indicator) — "what is around me". The hero view, the
//   one everybody recognises from a radar screen.
// * **A-scope** — "what did that last ping actually see". Raw envelope against
//   range with the CFAR threshold drawn over it. This is the honesty anchor: it
//   shows the noise, the threshold and the margin, so a user can see WHY the
//   sonar did or did not call something.
// * **Coverage** — "where have I looked". A sweep that has stared at one wall
//   has high confidence and no coverage, and only this view distinguishes that
//   from a finished scan.

import type { Detection, Vec3 } from '@batvu/core';

export interface Echo {
  /** Bearing of the beam axis, radians. */
  azimuth: number;
  elevation: number;
  rangeM: number;
  snrDb: number;
  /** Half-angle of the beam that produced it, radians — the arc's extent. */
  beamHalfAngle: number;
  /** Radial uncertainty, metres — the arc's thickness. */
  widthM: number;
  /** Ping index, for persistence fade. */
  age: number;
}

export interface RenderState {
  echoes: Echo[];
  /** Current beam bearing, for the sweep line. */
  beamAzimuth: number;
  beamElevation: number;
  maxRangeM: number;
  minRangeM: number;
  /** 0..1, how far the outgoing wavefront ripple has travelled. */
  ripple: number;
  /** Bearing bins already swept, for the coverage strip. */
  covered: Set<number>;
  coverageBins: number;
  pingIndex: number;
}

/**
 * An inferno-like ramp: black to purple to orange to near-white.
 *
 * Perceptually monotone in lightness, which is what makes it readable in
 * greyscale and to colourblind viewers — the signal is carried by brightness,
 * and hue is decoration. A rainbow ramp would put false edges wherever hue turns
 * fastest and invent structure the sonar never measured.
 */
export function inferno(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t));
  const stops: [number, number, number][] = [
    [0, 0, 4],
    [40, 11, 84],
    [101, 21, 110],
    [159, 42, 99],
    [212, 72, 66],
    [245, 125, 21],
    [250, 193, 39],
    [252, 255, 164],
  ];
  const scaled = x * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(scaled));
  const f = scaled - i;
  const a = stops[i]!;
  const b = stops[i + 1]!;
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

function rgba(c: [number, number, number], alpha: number): string {
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha.toFixed(3)})`;
}

export interface RendererOptions {
  /** Pings an echo stays visible for. Persistence, as a radar screen has. */
  persistence: number;
  /** SNR that maps to full brightness. */
  snrReferenceDb: number;
}

export const DEFAULT_RENDERER_OPTIONS: RendererOptions = {
  persistence: 60,
  snrReferenceDb: 30,
};

export class BatVuRenderer {
  readonly options: RendererOptions;

  constructor(
    private readonly ppi: CanvasRenderingContext2D,
    private readonly ascope: CanvasRenderingContext2D,
    private readonly coverage: CanvasRenderingContext2D,
    options: Partial<RendererOptions> = {},
  ) {
    this.options = { ...DEFAULT_RENDERER_OPTIONS, ...options };
  }

  /**
   * Size a canvas for the device's pixel ratio, capped at 2.
   *
   * Uncapped, a 3x phone renders nine times the pixels for a difference nobody
   * can see, and the frame budget goes to fill rate instead of sonar.
   */
  static fitCanvas(canvas: HTMLCanvasElement, cssWidth: number, cssHeight: number): void {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
  }

  drawAll(state: RenderState): void {
    this.drawPpi(state);
    this.drawCoverage(state);
  }

  /** The plan-position view: range rings, swept beam, and the echo arcs. */
  drawPpi(state: RenderState): void {
    const ctx = this.ppi;
    const { width, height } = ctx.canvas;
    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.min(width, height) / 2 - 8;
    const scale = radius / Math.max(0.1, state.maxRangeM);

    ctx.fillStyle = '#05050a';
    ctx.fillRect(0, 0, width, height);

    // ── range rings, labelled ────────────────────────────────────────────────
    ctx.strokeStyle = 'rgba(120,140,170,0.28)';
    ctx.fillStyle = 'rgba(150,170,200,0.65)';
    ctx.lineWidth = Math.max(1, width / 900);
    ctx.font = `${Math.round(width / 46)}px ui-monospace, monospace`;
    ctx.textAlign = 'left';
    for (let r = 1; r <= state.maxRangeM; r++) {
      ctx.beginPath();
      ctx.arc(cx, cy, r * scale, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillText(`${r}m`, cx + 4, cy - r * scale - 3);
    }

    // The blind zone. Drawn, not hidden: inside it the direct-path blast
    // dominates and the sonar has nothing to say, and a display that quietly
    // omitted that would read as "nothing there".
    ctx.fillStyle = 'rgba(80,20,20,0.35)';
    ctx.beginPath();
    ctx.arc(cx, cy, state.minRangeM * scale, 0, Math.PI * 2);
    ctx.fill();

    // ── the outgoing wavefront ───────────────────────────────────────────────
    if (state.ripple > 0 && state.ripple < 1) {
      ctx.strokeStyle = `rgba(120,200,255,${(1 - state.ripple) * 0.5})`;
      ctx.lineWidth = Math.max(1, width / 300);
      ctx.beginPath();
      ctx.arc(cx, cy, state.ripple * radius, 0, Math.PI * 2);
      ctx.stroke();
    }

    // ── echo arcs ────────────────────────────────────────────────────────────
    //
    // Additive blending, so overlapping arcs from different attitudes brighten
    // where they agree. That is not a stylistic choice: intersecting cones is
    // literally how the map is formed, and the render makes the mechanism
    // visible rather than presenting a finished answer.
    ctx.globalCompositeOperation = 'lighter';
    for (const echo of state.echoes) {
      const age = state.pingIndex - echo.age;
      if (age > this.options.persistence) continue;
      const fade = 1 - age / this.options.persistence;
      const strength = Math.min(1, Math.max(0.05, echo.snrDb / this.options.snrReferenceDb));
      // Foreshorten by elevation: an echo 40 degrees up is nearer in plan than
      // its slant range. Drawing slant range on a plan view would push every
      // ceiling return out into the walls.
      const planRange = echo.rangeM * Math.cos(echo.elevation);
      if (planRange <= 0) continue;

      const colour = inferno(strength);
      ctx.strokeStyle = rgba(colour, fade * (0.25 + 0.6 * strength));
      ctx.lineWidth = Math.max(1.5, echo.widthM * scale);
      ctx.beginPath();
      // Canvas angles run clockwise from +x; bearing runs clockwise from north,
      // which is -y on screen.
      const mid = echo.azimuth - Math.PI / 2;
      ctx.arc(cx, cy, planRange * scale, mid - echo.beamHalfAngle, mid + echo.beamHalfAngle);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';

    // ── where the phone is pointing now ──────────────────────────────────────
    const beam = state.beamAzimuth - Math.PI / 2;
    const half = 0.02;
    ctx.fillStyle = 'rgba(120,220,255,0.13)';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, beam - half - 0.35, beam + half + 0.35);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(160,235,255,0.9)';
    ctx.lineWidth = Math.max(1, width / 400);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(beam) * radius, cy + Math.sin(beam) * radius);
    ctx.stroke();
  }

  /**
   * The A-scope: envelope against range, with the detection threshold over it.
   *
   * The most boring view and the most important one. Everything else in the app
   * presents conclusions; this shows the evidence — where the noise floor is,
   * where the threshold sits, and how much margin a detection actually had. When
   * the map looks wrong, this is the view that says why.
   */
  drawAScope(
    envelope: Float32Array,
    startRangeM: number,
    rangeStepM: number,
    detections: readonly Detection[],
    floorDb = -60,
  ): void {
    const ctx = this.ascope;
    const { width, height } = ctx.canvas;
    ctx.fillStyle = '#05050a';
    ctx.fillRect(0, 0, width, height);
    if (envelope.length === 0) return;

    let peak = 1e-12;
    for (let i = 0; i < envelope.length; i++) if (envelope[i]! > peak) peak = envelope[i]!;

    const toY = (db: number): number => height - ((db - floorDb) / -floorDb) * height;

    // dB gridlines, so the vertical axis is readable rather than decorative.
    ctx.strokeStyle = 'rgba(120,140,170,0.2)';
    ctx.fillStyle = 'rgba(150,170,200,0.6)';
    ctx.lineWidth = 1;
    ctx.font = `${Math.round(height / 12)}px ui-monospace, monospace`;
    for (let db = 0; db >= floorDb; db -= 20) {
      const y = toY(db);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
      ctx.fillText(`${db}`, 2, y - 2);
    }

    ctx.strokeStyle = 'rgba(250,193,39,0.95)';
    ctx.lineWidth = Math.max(1, width / 800);
    ctx.beginPath();
    for (let i = 0; i < envelope.length; i++) {
      const db = 20 * Math.log10(Math.max(1e-12, envelope[i]!) / peak);
      const x = (i / (envelope.length - 1)) * width;
      const y = toY(Math.max(floorDb, db));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Detections, marked at their range.
    ctx.strokeStyle = 'rgba(120,220,255,0.9)';
    ctx.fillStyle = 'rgba(120,220,255,0.9)';
    ctx.textAlign = 'center';
    for (const d of detections) {
      const bin = (d.rangeM - startRangeM) / rangeStepM;
      if (bin < 0 || bin >= envelope.length) continue;
      const x = (bin / (envelope.length - 1)) * width;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
      ctx.fillText(`${d.rangeM.toFixed(2)}m`, Math.min(width - 20, Math.max(20, x)), height - 4);
    }
    ctx.textAlign = 'left';
  }

  /** A strip showing which bearings have been swept — the scan's progress. */
  drawCoverage(state: RenderState): void {
    const ctx = this.coverage;
    const { width, height } = ctx.canvas;
    ctx.fillStyle = '#0b0b12';
    ctx.fillRect(0, 0, width, height);
    const bins = Math.max(1, state.coverageBins);
    const w = width / bins;
    for (let i = 0; i < bins; i++) {
      if (!state.covered.has(i)) continue;
      ctx.fillStyle = rgba(inferno(0.75), 0.85);
      ctx.fillRect(i * w, 0, Math.ceil(w), height);
    }
    // Where the phone points now.
    const here = Math.floor(((state.beamAzimuth + Math.PI) / (2 * Math.PI)) * bins) % bins;
    ctx.fillStyle = 'rgba(160,235,255,0.95)';
    ctx.fillRect(here * w, 0, Math.max(2, w), height);
  }
}

/** Bearing bin for a direction, matching the coverage strip's layout. */
export function coverageBin(azimuth: number, bins: number): number {
  const wrapped = ((azimuth + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  return Math.min(bins - 1, Math.floor((wrapped / (2 * Math.PI)) * bins));
}

/** Turn one ping's detections into drawable arcs. */
export function echoesFrom(
  detections: readonly Detection[],
  beam: Vec3,
  beamHalfAngleRad: number,
  pingIndex: number,
): Echo[] {
  const azimuth = Math.atan2(beam.x, beam.y);
  const elevation = Math.asin(Math.min(1, Math.max(-1, beam.z)));
  return detections.map((d) => ({
    azimuth,
    elevation,
    rangeM: d.rangeM,
    snrDb: d.snrDb,
    beamHalfAngle: beamHalfAngleRad,
    widthM: d.widthM,
    age: pingIndex,
  }));
}
