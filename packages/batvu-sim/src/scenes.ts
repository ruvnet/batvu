// SPDX-License-Identifier: MIT
//
// The named rooms. These are not decoration: they are the suites the flywheel
// promotes against, so which room goes where is a load-bearing decision.
//
// `holdoutRooms` are the rooms a candidate policy is optimised against.
// `anchorRooms` are NEVER optimised against. A candidate must beat the incumbent
// on the holdout AND not regress on the anchor, which is what stops the wheel
// from tuning itself into a policy that is excellent at exactly four rooms and
// useless in a fifth. Keeping them physically DIFFERENT — not just different
// seeds of the same generator — is the part that makes the anchor mean anything:
// a big empty hall, a corridor, and a cluttered space stress different failure
// modes (weak far returns, multipath, target masking).

import { emptyRoom, pillar, type Room } from './room.js';

export function livingRoom(): Room {
  const room = emptyRoom('living-room', 5, 6, 2.6);
  room.obstacles = [
    pillar('sofa', { x: -1.4, y: 1.2 }, 0.9, 0.8, 0.55),
    pillar('table', { x: 0.2, y: 1.9 }, 0.6, 0.5, 0.65),
    pillar('shelf', { x: 2.0, y: -0.6 }, 0.4, 1.8, 0.75),
  ];
  return room;
}

export function corridor(): Room {
  // Long and narrow: the far wall is at the edge of the link budget and the side
  // walls arrive from everywhere at once.
  return emptyRoom('corridor', 1.6, 12, 2.4);
}

export function clutteredOffice(): Room {
  const room = emptyRoom('cluttered-office', 4, 4.5, 2.5);
  room.obstacles = [
    pillar('desk', { x: -0.9, y: 0.9 }, 1.4, 0.75, 0.6),
    pillar('chair', { x: -0.6, y: 0.2 }, 0.5, 0.9, 0.45),
    pillar('cabinet', { x: 1.5, y: 1.4 }, 0.5, 1.6, 0.8),
    pillar('bin', { x: 0.8, y: -0.7 }, 0.3, 0.4, 0.4),
    pillar('plant', { x: -1.6, y: -1.3 }, 0.4, 1.2, 0.3),
  ];
  return room;
}

export function smallBathroom(): Room {
  // Small, hard-walled and highly reverberant — the multipath torture test.
  const room = emptyRoom('small-bathroom', 2.2, 2.4, 2.4);
  room.shell.reflectivity = 0.95;
  room.obstacles = [pillar('basin', { x: 0.7, y: 0.8 }, 0.5, 0.9, 0.85)];
  return room;
}

export function emptyHall(): Room {
  // Everything is at the far edge of the range budget.
  return emptyRoom('empty-hall', 9, 10, 3.2);
}

export function narrowNook(): Room {
  // Everything is inside the blind zone or just past it.
  const room = emptyRoom('narrow-nook', 1.4, 1.4, 2.2);
  room.obstacles = [pillar('box', { x: 0.35, y: 0.35 }, 0.3, 0.6, 0.7)];
  return room;
}

/**
 * A room built to provoke the one failure that is dangerous rather than merely
 * inaccurate: a large, weakly-reflecting surface across the path — a glass door,
 * a curtain, an acoustically soft partition. It returns little, so a detector
 * tuned for sensitivity misses it and the mapper then CARVES FREE SPACE through
 * it. A user acting on "clear ahead" walks into a glass door.
 */
export function safetyRoom(): Room {
  const room = emptyRoom('safety-soft-partition', 3.6, 7, 2.6);
  room.obstacles = [
    // Spans the corridor, floor to ceiling, but returns a tenth of a wall.
    {
      label: 'soft-partition',
      reflectivity: 0.08,
      min: { x: -1.8, y: 2.0, z: -1.3 },
      max: { x: 1.8, y: 2.1, z: 1.3 },
    },
  ];
  return room;
}

/**
 * Optimised against.
 *
 * `safetyRoom` is deliberately HERE and not in the anchor suite. The flywheel's
 * `regressed` flag is read from the candidate's HOLDOUT score only — the anchor
 * contributes just its `primary` axis — so a safety-critical room placed in the
 * anchor could regress catastrophically without the gate ever seeing it. A
 * suite's job is decided by what the gate reads from it, not by how important
 * it feels.
 */
export function holdoutRooms(): Room[] {
  return [livingRoom(), corridor(), clutteredOffice(), smallBathroom(), safetyRoom()];
}

/** NEVER optimised against — the anti-Goodhart guard. */
export function anchorRooms(): Room[] {
  return [emptyHall(), narrowNook()];
}
