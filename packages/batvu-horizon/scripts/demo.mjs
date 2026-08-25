// SPDX-License-Identifier: MIT
//
// A scan session, driven end to end by @metaharness/horizon's halt controller.
//
// Shows the thing that is hard to see from the tests: a scan that decides for
// itself when the room is mapped, checkpoints mid-way, and resumes the SAME run
// rather than a new one that happens to share a map.
//
//   node packages/batvu-horizon/scripts/demo.mjs
import { BatVuCore, ScanSession } from '../../batvu-core/dist/index.js';
import { livingRoom, rasterSweep, simulateScan } from '../../batvu-sim/dist/index.js';
import { ScanDriver, loadHorizonCore, DEFAULT_SCAN_DRIVER_CONFIG } from '../dist/index.js';

const core = await BatVuCore.load();
const hz = await loadHorizonCore();
const room = livingRoom();

console.log(`BatVu scan session — simulating "${room.name}"\n`);

const session = new ScanSession(core, { occupancy: { extentM: 5, voxelM: 0.12 } });
const driver = new ScanDriver(hz, { ...DEFAULT_SCAN_DRIVER_CONFIG, maxTotalPings: 300 });

// A sweep is a continuous pass across the room; the driver's turn boundary is
// where one ends and the next begins.
// Repeating the same raster on purpose: the map keeps changing while log-odds
// accumulate toward their clamp, and stops once every voxel has saturated. That
// settling IS the no-progress signal, and watching it take several sweeps is
// more informative than asserting it.
const sweeps = Array.from({ length: 10 }, () => rasterSweep(24, 2, 40));

let checkpoint = null;
let outcome = { done: false };

for (const [n, poses] of sweeps.entries()) {
  if (outcome.done) break;
  driver.sweepBoundary();
  const pings = simulateScan(core, room, poses, { seed: 1000 + n });

  for (const p of pings) {
    const ping = session.pingWithBeam(p.samples, p.pose.beam);
    driver.observe(session, ping);
    outcome = driver.beforeSweep();
    if (outcome.done) break;
  }

  const s = session.state();
  console.log(
    `  sweep ${n + 1}: ${s.pings} pings · ` +
      `${(s.coverage * 100).toFixed(1)}% of the sphere · ` +
      `${s.occupiedVoxels} occupied · entropy ${s.entropy.toFixed(3)} · ${s.signature}`,
  );

  // Checkpoint after the first sweep, so the resume below has something real to
  // continue from.
  if (n === 0) checkpoint = driver.checkpoint(session.state());
}

console.log();
if (outcome.done) {
  const meaning = {
    complete: 'the room is mapped — nothing new from this vantage point',
    'budget-exhausted': 'the ping budget ran out with the map still changing',
    'capture-failed': 'the capture path is broken',
  }[outcome.interpretation];
  console.log(`  halted: ${outcome.reason} -> ${outcome.interpretation}`);
  console.log(`          ${meaning}`);
} else {
  console.log('  still scanning after every sweep — the room had more to give');
}

// ── the checkpoint round-trip ────────────────────────────────────────────────
console.log('\n  checkpoint');
console.log(`    verified:    ${ScanDriver.verify(checkpoint)}`);
console.log(`    pings:       ${checkpoint.actionCount}`);
console.log(`    map cursor:  ${checkpoint.memoryCursor}`);
console.log(`    state hash:  ${checkpoint.stateHash.slice(0, 26)}…`);

const resumed = ScanDriver.restore(hz, checkpoint);
console.log(`    resumed at:  ${resumed.pingCount} pings (the same run, halt counters intact)`);

const tampered = { ...checkpoint, actionCount: 9999 };
console.log(`    tampered:    ${ScanDriver.verify(tampered)} (hashed with horizon's own canonical hash)`);

session.destroy();
