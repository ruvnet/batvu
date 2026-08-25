// Bundle the app for the browser.
//
// esbuild rather than a framework: the app is four modules and a canvas, and a
// build step nobody can read is a worse dependency than the 200 lines it saves.
// The bundle is a single ES module, which is what iOS Safari wants anyway.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..');
const root = join(pkg, '..', '..');

const result = await build({
  entryPoints: [join(pkg, 'src', 'main.ts')],
  outfile: join(pkg, 'public', 'app.js'),
  bundle: true,
  format: 'esm',
  // Safari 15 is the oldest iOS release worth targeting for AudioWorklet.
  target: ['safari15', 'chrome100'],
  // The Node filesystem fallback in `@batvu/core`'s wasm loader is unreachable
  // here — the browser always passes a URL — but esbuild still has to RESOLVE
  // the dynamic import to bundle around it, and `node:fs/promises` does not
  // exist on the web. Marking the builtins external leaves the dead branch as an
  // unevaluated import; `resolveBytes` throws a readable error before reaching
  // it if a browser caller ever forgets the URL.
  external: ['node:*'],
  sourcemap: true,
  minify: process.env.BATVU_DEV !== '1',
  metafile: true,
  logLevel: 'info',
});

mkdirSync(join(pkg, 'public', 'wasm'), { recursive: true });
copyFileSync(
  join(root, 'packages', 'batvu-core', 'wasm', 'batvu_dsp.wasm'),
  join(pkg, 'public', 'wasm', 'batvu_dsp.wasm'),
);

const bytes = Object.values(result.metafile.outputs).reduce((a, o) => a + o.bytes, 0);
console.log(`bundled public/app.js (${(bytes / 1024).toFixed(1)} KB total)`);
