// SPDX-License-Identifier: MIT
//
// Scan-session control on `@metaharness/horizon`'s halt controller.
//
// A room scan is a long-horizon loop in exactly horizon's sense: point, ping,
// observe, update the map, decide whether to keep going. And it has horizon's
// central problem — knowing when to STOP. Left alone a scan runs until the
// battery dies; stopped too early it hands back a map with a hole in it.
//
// ## The mapping, precisely
//
// | horizon                | BatVu                                                        |
// |------------------------|--------------------------------------------------------------|
// | one "turn"             | one SWEEP — a continuous pass of the phone across the room    |
// | one "step"/observe     | one PING                                                      |
// | `progress` signature   | the occupancy map's state hash + the angular coverage bucket   |
// | `failure` signature    | saturated ADC / non-finite samples / no direct path / silence |
// | `beforeModel()`        | before choosing where to point next                           |
// | `turnBoundary()`       | the user starts a fresh sweep                                  |
// | `iteration-budget`     | the ping budget is spent                                       |
// | `no-progress`          | **the room is mapped** — the SUCCESS case                      |
// | `repeated-failure`     | the capture path is broken — give up and say so                |
//
// The row that matters is `no-progress`. In horizon's original setting a stalled
// agent is a bad outcome. Here it is the good one: when three sweeps in a row
// stop changing the map, there is nothing left to learn from this vantage point,
// and continuing spends battery to redraw the same room. So `ScanDriver`
// distinguishes the halt REASONS rather than treating a halt as failure — the
// one place where a faithful clone of a mechanism needs a different reading of
// its output.
//
// The other half is that a halt is ARMED on observe and CONSUMED at
// `beforeModel`, never mid-observe. That contract, inherited unchanged from ADK
// through horizon, is what keeps a scan from stopping halfway through a sweep
// with the phone still moving — the ping that trips the budget still completes,
// and the decision lands at the natural boundary.

import {
  DEFAULT_HALT_CONFIG,
  HaltController,
  HorizonCore,
  hashCheckpoint,
  verifyCheckpoint,
  type HaltConfig,
  type HaltReason,
  type HaltState,
  type HorizonCheckpoint,
} from '@metaharness/horizon';
import type { ScanPing, ScanSession, ScanState } from '@batvu/core';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where `scripts/build-wasm.mjs` stages the vendored horizon core. */
function defaultCorePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'wasm', 'horizon_core.wasm');
}

/**
 * Load horizon's control core.
 *
 * The published `@metaharness/horizon` package does not ship its `wasm/`
 * directory, so the default path points at the copy BatVu builds from the
 * pinned `vendor/metaharness` submodule. Passing an explicit path overrides it.
 */
export async function loadHorizonCore(wasmPath?: string): Promise<HorizonCore> {
  return HorizonCore.load(wasmPath ?? defaultCorePath());
}

export type ScanOutcome =
  | { done: false }
  | { done: true; reason: HaltReason; interpretation: ScanInterpretation };

/** What a halt MEANS for a scan — the reason a raw `HaltReason` is not enough. */
export type ScanInterpretation =
  /** Three sweeps stopped changing the map: this vantage point is exhausted. */
  | 'complete'
  /** The ping budget ran out with the map still changing. More would have helped. */
  | 'budget-exhausted'
  /** The capture path is broken; the map so far may still be usable. */
  | 'capture-failed';

export function interpret(reason: HaltReason): ScanInterpretation {
  switch (reason) {
    case 'no-progress':
      return 'complete';
    case 'iteration-budget':
      return 'budget-exhausted';
    case 'repeated-failure':
      return 'capture-failed';
  }
}

export interface ScanDriverConfig extends HaltConfig {
  /**
   * Coverage is quantised into this many buckets before entering the progress
   * signature.
   *
   * Without quantisation, `angularCoverage` changes by a hair on almost every
   * ping — a phone in a human hand never points twice at exactly the same
   * bearing — so the progress signature would never repeat and no-progress
   * would never fire. Bucketing asks the question that is actually meant: has
   * the sweep reached anywhere NEW.
   */
  coverageBuckets: number;
  /**
   * Ping budget for the whole SESSION, enforced here rather than by horizon.
   *
   * `HaltConfig.maxIterations` is a per-TURN budget: `turnBoundary()` resets the
   * iteration counter, which is exactly right for an agent (a fresh user turn
   * deserves a fresh budget) and only half of what a scan needs. A sweep is a
   * turn, so `maxIterations` caps one sweep — but the thing that actually runs
   * out during a room scan is the battery, and the battery does not reset when
   * the user starts sweeping again.
   *
   * Discovered by a demo that cheerfully ran 480 pings against a 400-ping
   * `maxIterations`, because each 48-ping sweep started the count over.
   */
  maxTotalPings: number;
}

export const DEFAULT_SCAN_DRIVER_CONFIG: ScanDriverConfig = {
  ...DEFAULT_HALT_CONFIG,
  // Per SWEEP. A sweep that has taken 120 pings without the turn ending is a
  // user waving the phone about rather than scanning.
  maxIterations: 120,
  noProgressLimit: 3,
  repeatedFailureLimit: 4,
  coverageBuckets: 60,
  // Per SESSION. At 15 Hz this is roughly 40 seconds of emission, which is
  // about as long as anyone will stand still.
  maxTotalPings: 600,
};

/** What a scan needs to resume, in horizon's continuity slots. */
export interface ScanContinuity {
  /** Grid signature at checkpoint time — horizon's `memoryCursor`. */
  mapSignature: string;
  pingsUsed: number;
  pingBudget: number;
  coverage: number;
  entropy: number;
  occupiedVoxels: number;
}

export class ScanDriver {
  private readonly halt: HaltController;
  private readonly transcript: { role: 'model' | 'tool' | 'summary'; text: string }[] = [];
  private pings = 0;
  private lastReason: HaltReason | null = null;

  constructor(
    core: HorizonCore,
    readonly config: ScanDriverConfig = DEFAULT_SCAN_DRIVER_CONFIG,
    state?: HaltState,
  ) {
    this.halt = state
      ? HaltController.restore(core, config, state)
      : new HaltController(core, config);
  }

  /**
   * The progress signature for one scan state.
   *
   * Two components, because "progress" for a scan means two different things
   * and either alone is a trap. The map hash alone would call a scan finished
   * the moment it stared long enough at one wall to saturate those voxels; the
   * coverage bucket alone would call it finished the moment the phone had
   * pointed everywhere, however uselessly. Together they mean: something new,
   * or somewhere new.
   */
  progressSignature(state: ScanState): string {
    const bucket = Math.round(state.coverage * this.config.coverageBuckets);
    return `${state.signature}|cov${bucket}`;
  }

  /**
   * Record one ping. Never halts — only arms.
   *
   * A single silent ping is emphatically NOT a failure: pointing at an open
   * doorway is supposed to return nothing, and that silence is the evidence
   * that carves the doorway into the map. `ScanSession.failureSignature` only
   * calls it a failure once it repeats, and getting that wrong would abort
   * every scan of a room with a door in it.
   */
  observe(session: ScanSession, ping: ScanPing): void {
    this.pings++;
    const state = session.state();
    const failure = session.failureSignature(ping);
    this.halt.observe({ progress: this.progressSignature(state), failure });
    this.transcript.push({
      role: 'tool',
      text:
        `ping ${ping.index} beam=(${ping.beam.x.toFixed(2)},${ping.beam.y.toFixed(2)},${ping.beam.z.toFixed(2)}) ` +
        `dets=${ping.result.detections.length} occupied=${state.occupiedVoxels} ` +
        `coverage=${(state.coverage * 100).toFixed(1)}%` +
        (failure ? ` FAILURE=${failure}` : ''),
    });
  }

  /** Consume any armed halt. Call once per sweep, before choosing where to point. */
  beforeSweep(): ScanOutcome {
    // The session budget is checked BEFORE consuming horizon's per-turn halt, so
    // a scan that has spent its whole allowance stops even mid-sweep — the
    // battery does not care where in a sweep it ran out.
    if (this.pings >= this.config.maxTotalPings) {
      this.lastReason = 'iteration-budget';
      this.transcript.push({ role: 'summary', text: 'halt: session ping budget spent' });
      return { done: true, reason: 'iteration-budget', interpretation: 'budget-exhausted' };
    }
    const d = this.halt.beforeModel();
    if (!d.halt || d.reason === null) return { done: false };
    this.lastReason = d.reason;
    const interpretation = interpret(d.reason);
    this.transcript.push({ role: 'summary', text: `halt: ${d.reason} (${interpretation})` });
    return { done: true, reason: d.reason, interpretation };
  }

  /** Reset the counters at a sweep boundary — a fresh pass gets a fresh budget
   *  for no-progress and repeated-failure, exactly as horizon resets between
   *  user turns. */
  sweepBoundary(): void {
    this.halt.turnBoundary();
    this.transcript.push({ role: 'model', text: 'sweep boundary' });
  }

  get pingCount(): number {
    return this.pings;
  }

  get haltReason(): HaltReason | null {
    return this.lastReason;
  }

  /**
   * A tamper-evident checkpoint of the whole session.
   *
   * Built as a real `HorizonCheckpoint` and hashed with horizon's own
   * `hashCheckpoint`, so `verifyCheckpoint` validates it unchanged. The
   * continuity slots carry scan meaning: `memoryCursor` is the map signature (it
   * IS the cursor into what the scan has learned), `budget` is the ping budget,
   * and `evaluationHistory` is the scan-state trail. A scan resumed from this
   * continues the same run, with the same halt counters, rather than starting a
   * new one that happens to share a map.
   */
  checkpoint(state: ScanState): HorizonCheckpoint {
    const continuity: ScanContinuity = {
      mapSignature: state.signature,
      pingsUsed: this.pings,
      pingBudget: this.config.maxTotalPings,
      coverage: state.coverage,
      entropy: state.entropy,
      occupiedVoxels: state.occupiedVoxels,
    };
    const body = {
      schema: 1 as const,
      transcript: this.transcript.map((e) => ({ ...e })),
      halt: this.halt.snapshot(),
      actionCount: this.pings,
      workspaceCommit: null,
      evaluationHistory: [continuity],
      budget: { pingsUsed: this.pings, pingBudget: this.config.maxTotalPings },
      pendingApprovals: [],
      archiveBranch: null,
      memoryCursor: state.signature,
    };
    return { ...body, stateHash: hashCheckpoint(body) };
  }

  /** Restore a driver mid-scan. Throws if the checkpoint has been altered. */
  static restore(
    core: HorizonCore,
    checkpoint: HorizonCheckpoint,
    config: ScanDriverConfig = DEFAULT_SCAN_DRIVER_CONFIG,
  ): ScanDriver {
    if (!verifyCheckpoint(checkpoint)) {
      throw new Error('batvu: scan checkpoint failed its integrity check');
    }
    const driver = new ScanDriver(core, config, checkpoint.halt);
    driver.pings = checkpoint.actionCount;
    driver.transcript.push(
      ...checkpoint.transcript.map((e) => ({ role: e.role, text: e.text })),
    );
    return driver;
  }

  /** Verify a checkpoint without restoring from it. */
  static verify(checkpoint: HorizonCheckpoint): boolean {
    return verifyCheckpoint(checkpoint);
  }
}
