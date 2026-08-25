// SPDX-License-Identifier: MIT
//
// Scoring a sonar against ground truth.
//
// These functions are the contract between the DSP and the flywheel: a promotion
// is only meaningful if the number it promotes on measures something real. Two
// choices here are deliberate and worth defending:
//
// 1. **Matching is greedy by range error, strongest-detection first.** A naive
//    "is there a detection within tolerance of each target" double-counts: one
//    strong echo can claim two nearby targets and the score rewards a detector
//    that reports fewer, blurrier objects.
//
// 2. **F1, not recall.** Recall alone is trivially maximised by lowering the
//    threshold until everything is a detection. A sonar that reports forty
//    ghosts and both walls has not mapped the room.

export interface RangeScore {
  /** Targets correctly found. */
  truePositives: number;
  /** Detections that matched no target — ghosts. */
  falsePositives: number;
  /** Targets nothing matched — misses. */
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
  /** RMS range error over matched pairs, in metres. NaN when nothing matched. */
  rangeRmseM: number;
  /** Worst single matched range error, in metres. */
  maxErrorM: number;
}

export interface RangeLike {
  rangeM: number;
  snrDb?: number;
}

/**
 * Score detections against known target ranges.
 *
 * `toleranceM` should be about one resolution cell: closer than that and the
 * sensor genuinely cannot tell two targets apart, so demanding better is
 * scoring the test rather than the system.
 */
export function scoreRanges(
  detections: readonly RangeLike[],
  truthRangesM: readonly number[],
  toleranceM: number,
): RangeScore {
  // Strongest first, so a confident detection gets first claim on a target
  // rather than losing it to a marginal one that happened to be listed earlier.
  const dets = [...detections].sort((a, b) => (b.snrDb ?? 0) - (a.snrDb ?? 0));
  const unclaimed = truthRangesM.map((r, i) => ({ r, i }));
  const claimed = new Set<number>();
  const errors: number[] = [];
  let falsePositives = 0;

  for (const det of dets) {
    let best: { i: number; err: number } | null = null;
    for (const t of unclaimed) {
      if (claimed.has(t.i)) continue;
      const err = Math.abs(det.rangeM - t.r);
      if (err <= toleranceM && (best === null || err < best.err)) best = { i: t.i, err };
    }
    if (best === null) {
      falsePositives++;
    } else {
      claimed.add(best.i);
      errors.push(best.err);
    }
  }

  const truePositives = claimed.size;
  const falseNegatives = truthRangesM.length - truePositives;
  const precision = dets.length === 0 ? (truthRangesM.length === 0 ? 1 : 0) : truePositives / dets.length;
  const recall = truthRangesM.length === 0 ? 1 : truePositives / truthRangesM.length;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return {
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1,
    rangeRmseM: errors.length === 0 ? NaN : Math.sqrt(errors.reduce((a, e) => a + e * e, 0) / errors.length),
    maxErrorM: errors.length === 0 ? NaN : Math.max(...errors),
  };
}

/**
 * Symmetric Chamfer distance between two point sets, in metres.
 *
 * Used for reconstruction quality where IoU is too coarse — IoU is blind to HOW
 * wrong a misplaced voxel is, and a map off by one voxel everywhere should not
 * score the same as one off by a metre.
 */
export function chamferDistance(
  a: readonly { x: number; y: number; z: number }[],
  b: readonly { x: number; y: number; z: number }[],
): number {
  if (a.length === 0 || b.length === 0) return Infinity;
  const oneWay = (
    from: readonly { x: number; y: number; z: number }[],
    to: readonly { x: number; y: number; z: number }[],
  ): number => {
    let sum = 0;
    for (const p of from) {
      let best = Infinity;
      for (const q of to) {
        const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2 + (p.z - q.z) ** 2;
        if (d < best) best = d;
      }
      sum += Math.sqrt(best);
    }
    return sum / from.length;
  };
  return (oneWay(a, b) + oneWay(b, a)) / 2;
}
