// Build crates/batvu-dsp for wasm32-unknown-unknown and stage the artifact.
//
// Same shape as @metaharness/horizon's scripts/build-wasm.mjs: a plain cargo
// build to wasm32-unknown-unknown with no wasm-bindgen and no post-processing
// toolchain. The module has one JSON entry point plus a raw-float plan surface,
// so there is nothing for a bindgen pass to generate.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
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

// ── @metaharness/horizon's control core ──────────────────────────────────────
//
// This is why `vendor/metaharness` is a submodule rather than a link in the
// README. The published npm package ships only `dist`: its `files` field lists
// `wasm`, but the directory is a build artifact and is absent from the tarball,
// so `HorizonCore.load()` from the installed package throws ENOENT. The crate
// source IS in the repository, and `HorizonCore.load(path)` takes an explicit
// path — so BatVu builds the core from the pinned submodule commit and points
// the loader at it. Same code, same version, reproducible from the lockfile plus
// the submodule SHA.
const horizonCrate = join(root, 'vendor', 'metaharness', 'packages', 'horizon', 'crate');
if (existsSync(join(horizonCrate, 'Cargo.toml'))) {
  execFileSync('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown'], {
    cwd: horizonCrate,
    stdio: 'inherit',
  });
  const horizonArtifact = join(
    horizonCrate,
    'target',
    'wasm32-unknown-unknown',
    'release',
    'horizon_core.wasm',
  );
  const dest = join(root, 'packages', 'batvu-horizon', 'wasm');
  mkdirSync(dest, { recursive: true });
  copyFileSync(horizonArtifact, join(dest, 'horizon_core.wasm'));
  const hkb = (statSync(horizonArtifact).size / 1024).toFixed(1);
  console.log(`built horizon_core.wasm (${hkb} KB) from the vendored submodule`);
} else {
  console.warn(
    'vendor/metaharness is not checked out — run `git submodule update --init --depth 1`.\n' +
      'Scan-session halt control will be unavailable until it is.',
  );
}
