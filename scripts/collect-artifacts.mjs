// SPDX-License-Identifier: MIT
//
// Build `artifacts/` — the evidence bundle.
//
// Every number in this project's README is produced by something, and the
// distance between "the README says 1.35 ms" and "here is the file that says
// 1.35 ms, and the command that wrote it, and its hash" is the whole difference
// between a claim and a measurement.
//
// So `artifacts/` is committed, not gitignored. It is what a reader can check
// without installing a Rust toolchain, a wasm target, and a headless Chromium —
// and it is what a future change has to move, visibly, in a diff, if it
// regresses anything.
//
// ## What is in here and what is not
//
// IN: the outputs of the four things that measure something — the benchmark,
// the end-to-end browser run, the flywheel's signed replay bundle, and a real
// `.ultrasonic.jsonl` recording with the `FieldEvent` it projects to.
//
// NOT IN: anything this script could compute rather than collect. A MANIFEST
// entry says which command produced a file and what its SHA-256 is; it does not
// summarise the file, because a summary is a place for the two to disagree.
//
// ## The one artifact that is also a test fixture
//
// `field/scan.ultrasonic.jsonl` is generated here and consumed by
// `rufield-adapters`' own test suite in the other repository. That makes it the
// only cross-language conformance check in the integration: if BatVu's emitter
// and rufield's parser drift apart, a build fails in one repo or the other
// rather than an ingest failing in a deployment.

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BatVuCore, ScanSession, angularCoverage } from '../packages/batvu-core/dist/index.js';
import {
  clutteredOffice,
  corridor,
  emptyHall,
  livingRoom,
  rasterSweep,
  simulateScan,
  smallBathroom,
} from '../packages/batvu-sim/dist/index.js';
import { UltrasonicRecorder, toFieldEvent } from '../packages/batvu-field/dist/index.js';
import { roomSignature, signatureSimilarity } from '../packages/batvu-memory/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(root, 'artifacts');

/** Every scan here uses this seed, so the bundle is reproducible: run the
 *  script twice and the hashes match. A bundle whose hashes move on every run
 *  cannot be diffed, and a bundle that cannot be diffed is decoration. */
const SEED = 0x0bacf00d;

const manifest = [];

function record(relPath, producedBy, note) {
  const abs = join(out, relPath);
  if (!existsSync(abs)) {
    manifest.push({ path: relPath, producedBy, note, status: 'missing' });
    return;
  }
  const bytes = readFileSync(abs);
  manifest.push({
    path: relPath,
    producedBy,
    note,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    status: 'present',
  });
}

function collect(relPath, from, producedBy, note) {
  const src = join(root, from);
  if (!existsSync(src)) {
    console.log(`  - ${relPath}: source missing (${from}) — run \`${producedBy}\` first`);
    manifest.push({ path: relPath, producedBy, note, status: 'missing' });
    return;
  }
  const dst = join(out, relPath);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  record(relPath, producedBy, note);
  console.log(`  ✓ ${relPath}`);
}

function write(relPath, text, producedBy, note) {
  const dst = join(out, relPath);
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, text);
  record(relPath, producedBy, note);
  console.log(`  ✓ ${relPath}`);
}

console.log('\nartifacts/\n');

// ── collected from the tools that measure ────────────────────────────────────
collect(
  'bench/latest.json',
  'bench/results/latest.json',
  'npm run bench',
  'Per-stage timings against the 66.7 ms pulse-repetition budget. Desktop x86; the phone figures in the README are extrapolated from these, not measured.',
);
collect(
  'e2e/e2e-report.json',
  'e2e/artifacts/e2e-report.json',
  'npm run e2e',
  'The real app in a real headless Chromium against a simulated room. Every check is a pass/fail with the observed value.',
);
collect(
  'e2e/batvu-demo-scan.png',
  'e2e/artifacts/batvu-demo-scan.png',
  'npm run e2e',
  'What the plan-position display actually drew at the end of that run.',
);

// ── generated here: a real recording on RuField's wire ───────────────────────
const core = await BatVuCore.load();

const room = livingRoom();
const poses = rasterSweep(24, 3, 50);
const simulated = simulateScan(core, room, poses, { seed: SEED });
const session = new ScanSession(core);
const recorder = new UltrasonicRecorder({
  deviceId: 'batvu-reference-01',
  source: 'simulated',
});

// A fixed start time rather than `Date.now()`: the bundle has to be
// byte-reproducible, and a wall clock in a recording is the one field
// guaranteed to differ between two otherwise identical runs.
let stamp = 1_756_162_800;
const beams = [];
for (const ping of simulated) {
  const result = session.plan.processSamples(ping.samples);
  session.grid.integrate(result, {
    beam: ping.pose.beam,
    origin: ping.pose.origin,
    minRangeM: session.sonar.minRangeM,
    maxRangeM: session.sonar.maxRangeM,
  });
  recorder.record(result, session.plan.envelope, ping.pose.beam, stamp);
  beams.push(ping.pose.beam);
  stamp += 1 / 15;
}

write(
  'field/scan.ultrasonic.jsonl',
  recorder.toJsonl(),
  'npm run artifacts',
  `${recorder.length} pings of the "${room.name}" scene on the BatVu -> RuField wire. This exact file is a test fixture in ruvnet/rufield: rufield-adapters parses it and asserts the events validate, which is the integration's only cross-language conformance check.`,
);

const sampleEvent = toFieldEvent(recorder.pings[12], {
  sequence: 12,
  zoneId: 'living_room',
});
write(
  'field/field-event.sample.json',
  `${JSON.stringify(sampleEvent, null, 2)}\n`,
  'npm run artifacts',
  'One ping projected into a rufield_core::FieldEvent. Unsigned on purpose — the signature is over serde\'s byte-exact rendering of a Rust struct, so rufield mints it. The tensor is the 32-bin P1 reduction, which is what the stock privacy policy allows onto a network; the full profile is P0 and edge-local.',
);

// ── generated here: what the room signature actually separates ───────────────
//
// The README quotes a similarity floor. This is the file it comes from.
const signature = roomSignature(session.grid, {
  coverage: angularCoverage(beams),
});
const rotations = [0, 23, 90, 187, 301];
const rotated = rotations.map((deg) => {
  const radians = (deg * Math.PI) / 180;
  const rotate = (v) => ({
    x: v.x * Math.cos(radians) - v.y * Math.sin(radians),
    y: v.x * Math.sin(radians) + v.y * Math.cos(radians),
    z: v.z,
  });
  const s = new ScanSession(core);
  for (const ping of simulated) {
    s.pingWithBeam(ping.samples, rotate(ping.pose.beam), ping.pose.origin);
  }
  const sig = roomSignature(s.grid);
  s.destroy();
  return { headingDeg: deg, similarity: signatureSimilarity(signature.vector, sig.vector) };
});

// The separation, which is the number that decides whether any of this works.
// A descriptor can be perfectly rotation-invariant and useless: a constant is.
// What matters is the GAP between the worst same-room-rotated similarity and
// the best different-room one, because that gap is the only place a threshold
// can live.
const others = [corridor(), clutteredOffice(), smallBathroom(), emptyHall()];
const otherSignatures = others.map((other) => {
  const pings = simulateScan(core, other, poses, { seed: SEED });
  const s = new ScanSession(core);
  for (const ping of pings) s.pingWithBeam(ping.samples, ping.pose.beam, ping.pose.origin);
  const sig = roomSignature(s.grid);
  s.destroy();
  return { room: other.name, similarity: signatureSimilarity(signature.vector, sig.vector) };
});
const worstSame = Math.min(...rotated.map((r) => r.similarity));
const bestDifferent = Math.max(...otherSignatures.map((r) => r.similarity));

write(
  'memory/room-signature.json',
  `${JSON.stringify(
    {
      room: room.name,
      seed: SEED,
      pings: recorder.length,
      dimensions: signature.vector.length,
      version: signature.version,
      coverage: signature.coverage,
      azimuthSupport: signature.azimuthSupport,
      occupiedVoxels: signature.occupiedVoxels,
      knownVoxels: signature.knownVoxels,
      meanRangeM: signature.meanRangeM,
      headingSweep: rotated,
      differentRooms: otherSignatures,
      worstSameRoom: worstSame,
      bestDifferentRoom: bestDifferent,
      separation: worstSame - bestDifferent,
    },
    null,
    2,
  )}\n`,
  'npm run artifacts',
  'The same room re-scanned at five headings, and four different rooms, with the cosine similarity of the descriptor at each. `separation` is the gap between the worst same-room pair and the best different-room one — the only interval a threshold can live in. A measurement on four simulator rooms, not a validated recognition rate: four rooms is not a population, and a real home with several similarly-shaped rooms will narrow it.',
);

session.destroy();

// ── collected: the flywheel's signed receipt chain ───────────────────────────
collect(
  'flywheel/replay-bundle.json',
  'artifacts/flywheel/replay-bundle.json',
  'npm run flywheel',
  'Ed25519-signed promotion receipts plus the gate fingerprint. `verifyReplayBundle` re-runs the frozen gate over sealed scores offline, so a reader can check the promotions without trusting this repository.',
);

// ── the manifest ─────────────────────────────────────────────────────────────
const present = manifest.filter((m) => m.status === 'present').length;
writeFileSync(
  join(out, 'MANIFEST.json'),
  `${JSON.stringify(
    {
      generatedBy: 'npm run artifacts',
      seed: SEED,
      note: 'Hashes are of the files as committed. Re-running `npm run artifacts` reproduces them exactly for the generated files; collected files carry the timings of the machine that produced them and will differ.',
      artifacts: manifest,
    },
    null,
    2,
  )}\n`,
);

console.log(`\n  ${present}/${manifest.length} artifacts present.`);
if (present < manifest.length) {
  console.log('  Missing ones need their producing command run first — see MANIFEST.json.\n');
} else {
  console.log('');
}
console.log(`  ${relative(root, join(out, 'MANIFEST.json'))}\n`);
