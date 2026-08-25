// SPDX-License-Identifier: MIT
//
// Accumulating a scan into a recording rufield can ingest.
//
// The recorder is thin on purpose. Everything that decides what a valid ping
// looks like lives in `wire.ts`, and everything that decides what a valid
// *stream* looks like lives here, because they fail differently: a bad ping is
// a bad ping, but a bad stream is a ping that was individually fine and arrived
// in the wrong order.
//
// ## Why the timestamps are policed here and not left to the consumer
//
// `TrustVerifier::check_replay` keys a watermark on `sensor.device_id` and
// requires `timestamp_ns` to strictly increase and `event_id` to be new. It
// enforces that in EVERY trust mode, simulation included. So a recording with
// two pings on the same nanosecond is not merely untidy — its second ping is
// dropped at ingest with `NonMonotonicReplay`, silently as far as the phone is
// concerned, and the map the operator reviews later is missing evidence nobody
// can account for.
//
// Worse, the watermark only ever advances. One ping carrying a timestamp far in
// the future permanently blocks every honest ping from that device afterwards.
// Fifteen pings a second is 66.7 ms apart, which is millions of nanoseconds of
// headroom — so this is not a hard problem, it is only a problem if nobody
// checks. The recorder checks.

import type { PingResult, Vec3 } from '@batvu/core';
import {
  MAX_PINGS,
  encodeLine,
  encodePing,
  type EncodeOptions,
  type UltrasonicLine,
  type UltrasonicSource,
} from './wire.js';

export interface RecorderOptions {
  /** Stable sensor identity for the whole recording. A recording is one
   *  sensor: the Rust parser rejects a file whose `device_id` changes midway,
   *  because the replay watermark and the key binding are both keyed on it. */
  deviceId: string;
  /** Where these samples came from. */
  source: UltrasonicSource;
  /** Profile bins per ping. */
  profileBins?: number;
  /** Near edge of the written profile, metres. */
  minRangeM?: number;
  /** Far edge of the written profile, metres. */
  maxRangeM?: number;
  /** Cap on pings held. Defaults to `MAX_PINGS`, the Rust parser's own bound.
   *  A recorder that outgrows what its consumer will read has produced a file
   *  that fails wholesale rather than one that is merely long. */
  maxPings?: number;
}

/**
 * Collects processed pings into `.ultrasonic.jsonl` lines.
 *
 * Nothing here touches the microphone or the network. It takes what
 * `SonarPlan.process()` already produced and writes it down.
 */
export class UltrasonicRecorder {
  private readonly lines: UltrasonicLine[] = [];
  private lastTimestamp = Number.NEGATIVE_INFINITY;
  private readonly maxPings: number;

  constructor(private readonly options: RecorderOptions) {
    this.maxPings = Math.max(1, Math.floor(options.maxPings ?? MAX_PINGS));
    if (this.maxPings > MAX_PINGS) {
      throw new Error(`batvu: maxPings ${this.maxPings} exceeds the ${MAX_PINGS} wire cap`);
    }
  }

  get length(): number {
    return this.lines.length;
  }

  /** The recorded lines, for inspection. */
  get pings(): readonly UltrasonicLine[] {
    return this.lines;
  }

  /**
   * Record one ping.
   *
   * `timestamp` is seconds since the epoch and must strictly increase. Passing
   * a wall clock straight through is fine at fifteen pings a second; passing a
   * value derived from `AudioContext.currentTime` is not, because that clock
   * starts at zero and says nothing about the epoch.
   */
  record(
    result: PingResult,
    envelope: Float32Array,
    beam: Vec3,
    timestamp: number,
  ): UltrasonicLine {
    if (this.lines.length >= this.maxPings) {
      throw new Error(
        `batvu: recording is full at ${this.maxPings} pings; write it out and start another`,
      );
    }
    if (!(timestamp > this.lastTimestamp)) {
      throw new Error(
        `batvu: ping timestamp ${timestamp} does not exceed the previous ${this.lastTimestamp}; ` +
          'rufield drops a non-advancing event and never tells the sender',
      );
    }

    const encodeOptions: EncodeOptions = {
      deviceId: this.options.deviceId,
      source: this.options.source,
      timestamp,
      beam,
    };
    if (this.options.profileBins !== undefined) {
      encodeOptions.profileBins = this.options.profileBins;
    }
    if (this.options.minRangeM !== undefined) encodeOptions.minRangeM = this.options.minRangeM;
    if (this.options.maxRangeM !== undefined) encodeOptions.maxRangeM = this.options.maxRangeM;

    const line = encodePing(result, envelope, encodeOptions);
    // Serialise now rather than at the end. `encodeLine` is where every wire
    // bound is checked, and finding out that ping 400 is unencodable while
    // ping 400 is still in hand is worth more than finding out at flush time
    // with nothing but the array to look at.
    encodeLine(line);
    this.lines.push(line);
    this.lastTimestamp = timestamp;
    return line;
  }

  /**
   * The whole recording as `.ultrasonic.jsonl` text.
   *
   * A trailing newline, so appending another recording cannot glue two JSON
   * objects onto one line — a malformed line the Rust parser reports as a parse
   * error on a line number that no longer means anything.
   */
  toJsonl(): string {
    if (this.lines.length === 0) return '';
    return `${this.lines.map(encodeLine).join('\n')}\n`;
  }

  /** Approximate byte size of the recording, for a UI or a disk budget. */
  byteLength(): number {
    return new TextEncoder().encode(this.toJsonl()).length;
  }

  reset(): void {
    this.lines.length = 0;
    this.lastTimestamp = Number.NEGATIVE_INFINITY;
  }
}
