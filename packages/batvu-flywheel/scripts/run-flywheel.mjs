// SPDX-License-Identifier: MIT
//
// Evolve the sonar's operating policy, then verify the receipts.
//
// Freeze the physics. Evolve the policy. Promote only what proves lift.
//
//   node packages/batvu-flywheel/scripts/run-flywheel.mjs [generations]
//
// Starts from a deliberately bad root — a 1 kHz sweep, a rectangular transmit
// window, Pfa 1e-2, a 120-degree beam assumption — and climbs under
// @metaharness/flywheel's default frozen gate, which requires a candidate to
// beat the incumbent on a holdout AND not regress a never-optimised anchor.
import { BatVuCore } from '../../batvu-core/dist/index.js';
import { anchorRooms, holdoutRooms } from '../../batvu-sim/dist/index.js';
import { verifyReplayBundle } from '@metaharness/flywheel';
import { badRootPolicy, resolvePolicy, runSonarFlywheel } from '../dist/index.js';

const generations = Number(process.argv[2] ?? 5);
const core = await BatVuCore.load();

const holdout = holdoutRooms();
const anchor = anchorRooms();

console.log('BatVu flywheel — freeze the physics, evolve the policy\n');
console.log(`  holdout (optimised against):  ${holdout.map((r) => r.name).join(', ')}`);
console.log(`  anchor  (never optimised):    ${anchor.map((r) => r.name).join(', ')}`);
console.log(`  generations:                  ${generations}\n`);

const started = Date.now();
const report = await runSonarFlywheel({
  core,
  holdout,
  anchor,
  maxGenerations: generations,
  // Small enough to finish in a demo; the CI suite uses more.
  azSteps: 16,
  elSteps: 2,
});
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

console.log('  lift curve');
for (const p of report.result.liftCurve) {
  const delta = p.delta >= 0 ? `+${p.delta.toFixed(4)}` : p.delta.toFixed(4);
  const anchorNote = p.anchor === null ? '' : `  anchor ${p.anchor.toFixed(4)}`;
  console.log(`    gen ${String(p.generation).padStart(2)}  primary ${p.primary.toFixed(4)}  ${delta}${anchorNote}`);
}

console.log(`\n  promotions (${report.promotionNotes.length})`);
if (report.promotionNotes.length === 0) {
  console.log('    none — no candidate cleared the frozen gate on this suite');
} else {
  for (const note of report.promotionNotes) console.log(`    ${note}`);
}

console.log('\n  what changed, root -> final');
const before = resolvePolicy(badRootPolicy()).sonar;
const after = resolvePolicy(report.finalPolicy).sonar;
const show = (label, a, b, unit = '') => {
  const mark = String(a) === String(b) ? ' ' : '*';
  console.log(`   ${mark} ${label.padEnd(22)} ${String(a).padStart(10)}${unit} -> ${String(b).padStart(10)}${unit}`);
};
show('band', `${before.f0}-${before.f1}`, `${after.f0}-${after.f1}`, ' Hz');
show('pulse', before.durationS * 1000, after.durationS * 1000, ' ms');
show('transmit window', before.txWindow, after.txWindow);
show('cfar kind', before.cfarKind, after.cfarKind);
show('cfar guard', before.cfarGuard, after.cfarGuard, ' cells');
show('cfar Pfa', before.cfarPfa, after.cfarPfa);
show('min SNR', before.minSnrDb, after.minSnrDb, ' dB');

console.log('\n  receipts — trust the signature, not the producer');
console.log(`    gate fingerprint:  ${report.gateFingerprint.slice(0, 32)}…`);
console.log(`    replay verified:   ${report.replayVerified}`);
console.log(`    chain:             ${report.replaySummary}`);
console.log(`    milestone:         ${report.result.milestoneReached}`);

// Verify independently, exactly as an outside reviewer would.
const independent = verifyReplayBundle(report.result.replayBundle);
console.log(`    re-verified:       ${independent.pass}  (${independent.chainSummary})`);
console.log(`\n  ${report.result.generationsRun} generations in ${elapsed}s`);
