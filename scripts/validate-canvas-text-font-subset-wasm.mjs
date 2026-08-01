import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = join(root, 'assets/wasm/canvas-text-font-subset.lock.json');

export async function validateCanvasTextFontSubsetWasm() {
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  const hashedInputs = [
    lock.artifact,
    lock.inputs.wrapper,
    lock.inputs.configOverride,
    ...lock.licenses
  ];
  for (const input of hashedInputs) {
    const path = join(root, input.path);
    const bytes = await readFile(path);
    const actual = sha256(bytes);
    if (actual !== input.sha256) {
      throw new Error(`${input.path} hash mismatch: expected ${input.sha256}, received ${actual}.`);
    }
  }
  const artifactPath = join(root, lock.artifact.path);
  const artifactStat = await stat(artifactPath);
  if (artifactStat.size !== lock.artifact.bytes) {
    throw new Error(
      `${lock.artifact.path} size mismatch: expected ${lock.artifact.bytes}, received ${artifactStat.size}.`
    );
  }
  const module = await WebAssembly.compile(await readFile(artifactPath));
  assertList('imports', lock.abi.imports, WebAssembly.Module.imports(module).map(formatModuleBinding));
  assertList('exports', lock.abi.exports, WebAssembly.Module.exports(module).map(formatModuleBinding));
  const { exports } = await WebAssembly.instantiate(module, {
    env: { emscripten_notify_memory_growth() {} },
    wasi_snapshot_preview1: {
      proc_exit(code) { throw new Error(`WASM exited with status ${code}.`); },
      fd_close() { return 0; },
      fd_write() { return 0; },
      fd_seek() { return 0; }
    }
  });
  exports._initialize();
  const actualContractVersion = exports.debrute_subset_contract_version();
  if (actualContractVersion !== lock.contractVersion) {
    throw new Error(
      `WASM contract mismatch: expected ${lock.contractVersion}, received ${actualContractVersion}.`
    );
  }
}

function formatModuleBinding(binding) {
  return `${binding.module ? `${binding.module}.` : ''}${binding.name}:${binding.kind}`;
}

function assertList(label, expected, actual) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Canvas text font subset WASM ${label} mismatch.\n`
      + `Expected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`
    );
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  validateCanvasTextFontSubsetWasm().then(() => {
    console.log('Canvas text font subset WASM validation passed.');
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
