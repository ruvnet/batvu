// Build crates/batvu-dsp for wasm32-unknown-unknown and stage the artifact.
//
// Same shape as @metaharness/horizon's scripts/build-wasm.mjs: a plain cargo
// build to wasm32-unknown-unknown with no wasm-bindgen and no post-processing
// toolchain. The module has one JSON entry point plus a raw-float plan surface,
// so there is nothing for a bindgen pass to generate.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const crate = join(root, 'crates', 'batvu-dsp');

execFileSync('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown'], {
  cwd: crate,
  stdio: 'inherit',
});

const artifact = join(root, 'target', 'wasm32-unknown-unknown', 'release', 'batvu_dsp.wasm');
const targets = [
  join(root, 'packages', 'batvu-core', 'wasm'),
  join(root, 'packages', 'batvu-web', 'public', 'wasm'),
];
for (const dir of targets) {
  mkdirSync(dir, { recursive: true });
  copyFileSync(artifact, join(dir, 'batvu_dsp.wasm'));
}
const kb = (statSync(artifact).size / 1024).toFixed(1);
console.log(`built batvu_dsp.wasm (${kb} KB) -> ${targets.length} destinations`);
