// SPDX-License-Identifier: MIT
//
// The loader for the Rust wasm32 sonar core (crates/batvu-dsp).
//
// This is where BatVu deliberately diverges from `@metaharness/horizon`'s
// `core.ts`, which we otherwise follow closely. Horizon's loader opens the wasm
// with `readFileSync` from `node:fs` at module scope — correct for a package
// that only ever runs in Node, and fatal here: a static `node:fs` import makes
// the module unbundleable for iOS Safari, which is BatVu's primary target.
//
// So the contract is inverted. `BatVuCore.load()` takes BYTES or a URL; only if
// given nothing at all does it try a Node filesystem read, through a dynamic
// import that a browser bundler can tree-shake and never evaluates in a browser.
// Browser callers pass `fetch('/wasm/batvu_dsp.wasm')` and never touch the
// Node path.
//
// ## Two surfaces
//
// `eval()` is the JSON control op — design reports, waveform generation, scene
// rendering. Low rate, rich structure.
//
// `createPlan()` is the hot path. It hands back a `SonarPlan` whose sample input
// and envelope output live INSIDE wasm memory, so a ping costs no marshalling
// at all: write floats into a view, call process, read floats out of a view.

export type WasmSource = ArrayBuffer | Uint8Array | Response | Promise<Response> | URL | string;

interface CoreExports {
  memory: WebAssembly.Memory;
  bv_alloc(n: number): number;
  bv_free(ptr: number): void;
  bv_eval(ptr: number, len: number): number;
  bv_plan_create(ptr: number, len: number, recordLen: number): number;
  bv_plan_input_ptr(handle: number): number;
  bv_plan_record_len(handle: number): number;
  bv_plan_env_ptr(handle: number): number;
  bv_plan_env_len(handle: number): number;
  bv_plan_process(handle: number): number;
  bv_plan_destroy(handle: number): void;
}

const ENC = new TextEncoder();
const DEC = new TextDecoder();

/** Default location the build script stages the module at, relative to `dist/`. */
const NODE_WASM_PATH = '../wasm/batvu_dsp.wasm';

export class BatVuCore {
  private instance!: WebAssembly.Instance;
  private memBuf: ArrayBuffer | null = null;
  private memU8: Uint8Array | null = null;

  private get exports(): CoreExports {
    return this.instance.exports as unknown as CoreExports;
  }

  /**
   * `memory.buffer` is replaced — not resized — whenever wasm memory grows, and
   * every typed-array view over the old buffer is detached at that moment.
   * Re-deriving the view whenever the buffer identity changes is the only safe
   * way to hold one; caching on identity keeps it nearly free.
   */
  private u8(): Uint8Array {
    const buf = this.exports.memory.buffer;
    if (buf !== this.memBuf || this.memU8 === null) {
      this.memBuf = buf;
      this.memU8 = new Uint8Array(buf);
    }
    return this.memU8;
  }

  /**
   * Instantiate the core.
   *
   * - Browser: pass bytes, a `Response` (or the promise from `fetch`), or a URL.
   * - Node: pass nothing and the module is read from disk beside the package.
   */
  static async load(source?: WasmSource): Promise<BatVuCore> {
    const core = new BatVuCore();
    const raw = await resolveBytes(source);
    // `slice()` rather than `.buffer`: Node hands back a Buffer that is a VIEW
    // into a pooled ArrayBuffer, so passing its `.buffer` would hand the
    // compiler whatever else the pool happens to hold. The copy is one-time at
    // load, and it also settles the `ArrayBufferLike` vs `ArrayBuffer` overload
    // ambiguity that makes `instantiate` resolve to the wrong signature.
    const bytes: ArrayBuffer =
      raw instanceof Uint8Array ? raw.slice().buffer : raw;
    const { instance } = await WebAssembly.instantiate(bytes, {});
    core.instance = instance;
    return core;
  }

  /** Evaluate a JSON control request. Pure — no state is kept between calls. */
  eval<T = unknown>(request: unknown): T {
    const src = ENC.encode(JSON.stringify(request));
    const ptr = this.exports.bv_alloc(src.length); // may grow (and detach) memory
    this.u8().set(src, ptr);
    const out = this.exports.bv_eval(ptr, src.length);
    const result = this.readPacked(out);
    this.exports.bv_free(ptr);
    return JSON.parse(result) as T;
  }

  /**
   * Create a processing plan for one (config, record length) pair.
   *
   * The plan owns its FFT, its reference spectrum and its scratch buffers, so
   * per-ping work allocates nothing. Build one per scan session, not per ping.
   */
  createPlan(config: Record<string, unknown>, recordLen: number): SonarPlan {
    const src = ENC.encode(JSON.stringify(config));
    const ptr = this.exports.bv_alloc(src.length);
    this.u8().set(src, ptr);
    const handle = this.exports.bv_plan_create(ptr, src.length, recordLen);
    this.exports.bv_free(ptr);
    if (handle < 0) {
      throw new Error(
        `batvu: the core rejected this sonar config. ${describeConfigProblem(this, config)}`,
      );
    }
    return new SonarPlan(this, handle);
  }

  /** @internal */
  readPacked(ptr: number): string {
    const mem = this.u8();
    const len = mem[ptr]! | (mem[ptr + 1]! << 8) | (mem[ptr + 2]! << 16) | (mem[ptr + 3]! << 24);
    return DEC.decode(mem.subarray(ptr + 4, ptr + 4 + len));
  }

  /** @internal */
  get raw(): CoreExports {
    return this.exports;
  }

  /** @internal — a Float32 view over wasm memory, re-derived if it grew. */
  f32(ptr: number, len: number): Float32Array {
    return new Float32Array(this.exports.memory.buffer, ptr, len);
  }
}

/** Ask the core WHY a config was rejected, so the thrown error is actionable. */
function describeConfigProblem(core: BatVuCore, config: Record<string, unknown>): string {
  try {
    const report = core.eval<{ warning?: string | null }>({ op: 'design', config });
    return report.warning ?? 'No specific complaint was reported.';
  } catch {
    return 'The core could not explain why.';
  }
}

async function resolveBytes(source?: WasmSource): Promise<ArrayBuffer | Uint8Array> {
  if (source === undefined) {
    // Node-only fallback.
    //
    // Checked BEFORE the import so a browser caller who forgot the URL gets a
    // sentence instead of a module-resolution failure three frames down. The
    // import itself is dynamic so a bundler can leave it unevaluated (the web
    // build marks `node:*` external); this guard is what makes that safe rather
    // than merely quiet.
    const isNode =
      typeof process !== 'undefined' &&
      (process as { versions?: { node?: string } }).versions?.node !== undefined;
    if (!isNode) {
      throw new Error(
        'batvu: BatVuCore.load() needs the wasm bytes or a URL in a browser — ' +
          'the Node filesystem fallback is not available here. ' +
          "Try BatVuCore.load('wasm/batvu_dsp.wasm').",
      );
    }
    const [{ readFile }, { fileURLToPath }, { dirname, join }] = await Promise.all([
      import('node:fs/promises'),
      import('node:url'),
      import('node:path'),
    ]);
    const here = dirname(fileURLToPath(import.meta.url));
    return readFile(join(here, NODE_WASM_PATH));
  }
  if (source instanceof Uint8Array || source instanceof ArrayBuffer) return source;
  if (typeof source === 'string' || source instanceof URL) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`batvu: failed to fetch wasm from ${String(source)}: ${res.status}`);
    return res.arrayBuffer();
  }
  const res = await source;
  if (!res.ok) throw new Error(`batvu: wasm fetch failed: ${res.status}`);
  return res.arrayBuffer();
}

/** One detection from a ping, in metres. */
export interface Detection {
  rangeM: number;
  amplitude: number;
  snrDb: number;
  widthM: number;
}

/** The metadata half of a ping result; the envelope stays in wasm memory. */
export interface PingResult {
  /** Fractional sample index of the direct-path blast within the record. */
  t0: number;
  /** Peak amplitude of the blast — the transmit-level health check. */
  blastAmplitude: number;
  /** The ADC clipped; these ranges should not be trusted. */
  saturated: boolean;
  /** Count of non-finite input samples that had to be zeroed. */
  sanitized: number;
  startRangeM: number;
  rangeStepM: number;
  noiseFloor: number;
  envLen: number;
  detections: Detection[];
}

/**
 * A live processing plan. The input and envelope buffers are views straight into
 * wasm memory — no copies on either side of a ping.
 */
export class SonarPlan {
  private destroyed = false;
  readonly recordLen: number;
  readonly envLen: number;

  constructor(
    private readonly core: BatVuCore,
    private readonly handle: number,
  ) {
    this.recordLen = core.raw.bv_plan_record_len(handle);
    this.envLen = core.raw.bv_plan_env_len(handle);
  }

  /**
   * Write the captured record here, then call `process()`.
   *
   * Re-derived on every access rather than cached: any allocating call into the
   * core can grow wasm memory and detach an older view. Reading the pointer back
   * costs a few nanoseconds; holding a detached view costs a silent wrong answer.
   */
  get input(): Float32Array {
    this.assertLive();
    return this.core.f32(this.core.raw.bv_plan_input_ptr(this.handle), this.recordLen);
  }

  /** The range envelope from the last `process()`. Same re-derivation rule. */
  get envelope(): Float32Array {
    this.assertLive();
    return this.core.f32(this.core.raw.bv_plan_env_ptr(this.handle), this.envLen);
  }

  /** Compress whatever is in `input` and return the detections. */
  process(): PingResult {
    this.assertLive();
    const ptr = this.core.raw.bv_plan_process(this.handle);
    const result = JSON.parse(this.core.readPacked(ptr)) as PingResult & { error?: string };
    if (result.error) throw new Error(`batvu: ${result.error}`);
    return result;
  }

  /** Convenience: copy samples in and process in one call. */
  processSamples(samples: Float32Array | number[]): PingResult {
    const dst = this.input;
    const n = Math.min(dst.length, samples.length);
    for (let i = 0; i < n; i++) dst[i] = samples[i] as number;
    dst.fill(0, n);
    return this.process();
  }

  /** Range in metres of envelope bin `i`, given the last result's geometry. */
  static rangeOfBin(result: PingResult, i: number): number {
    return result.startRangeM + i * result.rangeStepM;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.core.raw.bv_plan_destroy(this.handle);
    this.destroyed = true;
  }

  private assertLive(): void {
    if (this.destroyed) throw new Error('batvu: this SonarPlan has been destroyed');
  }
}
