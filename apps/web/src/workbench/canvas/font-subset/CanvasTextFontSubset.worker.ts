import {
  CANVAS_TEXT_FONT_SUBSET_CONTRACT_VERSION,
  type CanvasTextFontSubsetFaceResult,
  type CanvasTextFontSubsetRequest,
  type CanvasTextFontSubsetResponse
} from './CanvasTextFontSubsetProtocol.js';

interface CanvasTextSubsetWasmExports {
  readonly memory: WebAssembly.Memory;
  _initialize(): void;
  debrute_subset_contract_version(): number;
  malloc(size: number): number;
  free(pointer: number): void;
  debrute_subset_free(pointer: number): void;
  debrute_subset_woff2(
    inputPointer: number,
    inputLength: number,
    codepointPointer: number,
    codepointCount: number,
    outputPointerPointer: number,
    outputLengthPointer: number
  ): number;
}

interface CanvasTextSubsetWorkerScope {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<CanvasTextFontSubsetRequest>) => void,
    options?: AddEventListenerOptions | boolean
  ): void;
  postMessage(message: CanvasTextFontSubsetResponse, transfer?: Transferable[]): void;
  close(): void;
}

const workerScope = globalThis as unknown as CanvasTextSubsetWorkerScope;
const wasmPromise = loadCanvasTextSubsetWasm();

workerScope.addEventListener('message', (event) => {
  void runRequest(event.data).then((response) => {
    const transfer = response.type === 'success'
      ? response.faces.map((face) => face.bytes)
      : undefined;
    workerScope.postMessage(response, transfer);
  }).catch((error: unknown) => {
    workerScope.postMessage({
      type: 'error',
      contractVersion: CANVAS_TEXT_FONT_SUBSET_CONTRACT_VERSION,
      message: errorMessage(error)
    });
  }).finally(() => {
    workerScope.close();
  });
}, { once: true } as AddEventListenerOptions);

async function runRequest(
  request: CanvasTextFontSubsetRequest
): Promise<CanvasTextFontSubsetResponse> {
  if (request.type !== 'subset'
    || request.contractVersion !== CANVAS_TEXT_FONT_SUBSET_CONTRACT_VERSION) {
    throw new Error('Canvas text font subset Worker received an incompatible request.');
  }
  const wasm = await wasmPromise;
  const codepoints = new Uint32Array(request.codepoints);
  const startedAt = performance.now();
  let peakLinearMemoryBytes = wasm.memory.buffer.byteLength;
  const faces: CanvasTextFontSubsetFaceResult[] = [];
  for (const face of request.faces) {
    const response = await fetch(face.sourceUrl);
    if (!response.ok) {
      throw new Error(`Canvas text font request failed (${response.status}): ${face.sourceUrl}`);
    }
    const input = await response.arrayBuffer();
    await verifyDigest(input, face.digest);
    const subset = subsetWoff2(wasm, new Uint8Array(input), codepoints);
    peakLinearMemoryBytes = Math.max(peakLinearMemoryBytes, subset.linearMemoryBytes);
    faces.push({
      family: face.family,
      weight: face.weight,
      inputBytes: input.byteLength,
      outputBytes: subset.bytes.byteLength,
      durationMs: subset.durationMs,
      bytes: subset.bytes
    });
  }
  return {
    type: 'success',
    contractVersion: CANVAS_TEXT_FONT_SUBSET_CONTRACT_VERSION,
    durationMs: performance.now() - startedAt,
    peakLinearMemoryBytes,
    faces
  };
}

function subsetWoff2(
  wasm: CanvasTextSubsetWasmExports,
  input: Uint8Array,
  codepoints: Uint32Array
): { bytes: ArrayBuffer; durationMs: number; linearMemoryBytes: number } {
  const inputPointer = wasm.malloc(input.byteLength);
  const codepointPointer = wasm.malloc(codepoints.byteLength);
  const outputPointerPointer = wasm.malloc(4);
  const outputLengthPointer = wasm.malloc(4);
  if (!inputPointer || !codepointPointer || !outputPointerPointer || !outputLengthPointer) {
    throw new Error('Canvas text font subset WASM allocation failed.');
  }
  try {
    new Uint8Array(wasm.memory.buffer, inputPointer, input.byteLength).set(input);
    new Uint32Array(wasm.memory.buffer, codepointPointer, codepoints.length).set(codepoints);
    const startedAt = performance.now();
    const status = wasm.debrute_subset_woff2(
      inputPointer,
      input.byteLength,
      codepointPointer,
      codepoints.length,
      outputPointerPointer,
      outputLengthPointer
    );
    const durationMs = performance.now() - startedAt;
    if (status !== 0) {
      throw new Error(`Canvas text font subset WASM failed with status ${status}.`);
    }
    const view = new DataView(wasm.memory.buffer);
    const outputPointer = view.getUint32(outputPointerPointer, true);
    const outputLength = view.getUint32(outputLengthPointer, true);
    if (!outputPointer || outputLength < 4) {
      throw new Error('Canvas text font subset WASM returned an invalid output.');
    }
    const output = new Uint8Array(outputLength);
    output.set(new Uint8Array(wasm.memory.buffer, outputPointer, outputLength));
    wasm.debrute_subset_free(outputPointer);
    return {
      bytes: output.buffer,
      durationMs,
      linearMemoryBytes: wasm.memory.buffer.byteLength
    };
  } finally {
    wasm.free(inputPointer);
    wasm.free(codepointPointer);
    wasm.free(outputPointerPointer);
    wasm.free(outputLengthPointer);
  }
}

async function loadCanvasTextSubsetWasm(): Promise<CanvasTextSubsetWasmExports> {
  const url = new URL(
    '../../../../../../assets/wasm/canvas-text-font-subset-v1.wasm',
    import.meta.url
  );
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Canvas text font subset WASM request failed (${response.status}).`);
  }
  const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), {
    env: {
      emscripten_notify_memory_growth() {
        // The façade accesses the exported memory directly after every growth.
      }
    },
    wasi_snapshot_preview1: {
      proc_exit(code: number) {
        throw new Error(`Canvas text font subset WASM exited with status ${code}.`);
      },
      fd_write() { return 0; },
      fd_close() { return 0; },
      fd_seek() { return 0; },
      environ_sizes_get() { return 0; },
      environ_get() { return 0; }
    }
  });
  const exports = instance.exports as unknown as CanvasTextSubsetWasmExports;
  exports._initialize();
  if (exports.debrute_subset_contract_version() !== CANVAS_TEXT_FONT_SUBSET_CONTRACT_VERSION) {
    throw new Error('Canvas text font subset WASM contract version mismatch.');
  }
  return exports;
}

async function verifyDigest(bytes: ArrayBuffer, expected: string): Promise<void> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const actual = `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
  if (actual !== expected) {
    throw new Error(`Canvas text font digest mismatch: expected ${expected}, received ${actual}.`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export {};
