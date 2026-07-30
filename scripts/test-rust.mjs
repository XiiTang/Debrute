import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { prepareNativeRasterPayload } from './native-raster-payload.mjs';
import { ensureNativeRasterPayload } from './prepare-native-raster.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const preparationStartedAt = performance.now();
await ensureNativeRasterPayload();
const cargoEnvironment = await prepareNativeRasterPayload({ profile: 'debug' });
reportDuration('native raster preparation', preparationStartedAt);

await runStage('Runtime tests', [
  'nextest',
  'run',
  '-p',
  'debrute-runtime',
  '--features',
  'test-support',
  '--lib',
  '--bins',
  '--test',
  'runtime_integration'
]);

const nativeTestArguments = process.platform === 'win32'
  ? [
      'test',
      '-p',
      'debrute-native-control',
      '-p',
      'debrute-native-fs',
      '-p',
      'debrute-native-process',
      '-p',
      'debrute-windows-product-fs',
      '--no-fail-fast'
    ]
  : [
      'test',
      '-p',
      'debrute-native-fs',
      '-p',
      'debrute-native-process',
      '--lib',
      '--no-fail-fast'
    ];
await runStage('native support tests', nativeTestArguments);

async function runStage(name, arguments_) {
  const startedAt = performance.now();
  const child = spawn('cargo', arguments_, {
    cwd: repositoryRoot,
    env: cargoEnvironment,
    stdio: 'inherit'
  });
  const exitCode = await waitForClose(child);
  reportDuration(name, startedAt);
  if (exitCode !== 0) process.exit(exitCode ?? 1);
}

function reportDuration(name, startedAt) {
  const seconds = (performance.now() - startedAt) / 1000;
  process.stdout.write(`[test:rust] ${name}: ${seconds.toFixed(2)}s\n`);
}

function waitForClose(child) {
  return new Promise((resolveExit, rejectRun) => {
    child.once('error', rejectRun);
    child.once('close', resolveExit);
  });
}
