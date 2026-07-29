import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cargoRunner = resolve(repositoryRoot, 'scripts/run-cargo-with-native-raster.mjs');
const runtimeIntegrationTests = resolve(repositoryRoot, 'apps/runtime/tests');
const serialTarget = 'workbench_http';
const runtimeTargets = (await readdir(runtimeIntegrationTests, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && extname(entry.name) === '.rs')
  .map((entry) => basename(entry.name, '.rs'))
  .sort();

if (!runtimeTargets.includes(serialTarget)) {
  throw new Error(`Required Rust integration test target is missing: ${serialTarget}`);
}

const parallelRuntimeTargets = runtimeTargets.filter((target) => target !== serialTarget);

const isolatedTests = await listCargoTests(serialTarget);
for (const [index, testName] of isolatedTests.entries()) {
  process.stdout.write(
    `[test:rust] ${serialTarget} ${index + 1}/${isolatedTests.length}: ${testName}\n`
  );
  await runCargo([
    'test',
    '-p',
    'debrute-runtime',
    '--test',
    serialTarget,
    testName,
    '--',
    '--exact',
    '--test-threads=1'
  ]);
}
await runCargo(['test', '--workspace', '--exclude', 'debrute-runtime']);
await runCargo([
  'test',
  '-p',
  'debrute-runtime',
  '--lib',
  '--bins',
  '--examples',
  ...parallelRuntimeTargets.flatMap((target) => ['--test', target])
]);
await runCargo(['test', '-p', 'debrute-runtime', '--doc']);

async function listCargoTests(target) {
  const child = spawn(
    process.execPath,
    [
      cargoRunner,
      '--',
      'test',
      '-p',
      'debrute-runtime',
      '--test',
      target,
      '--',
      '--list',
      '--format=terse'
    ],
    {
      cwd: repositoryRoot,
      env: process.env,
      stdio: ['inherit', 'pipe', 'inherit']
    }
  );
  child.stdout.setEncoding('utf8');
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  const exitCode = await waitForClose(child);
  if (exitCode !== 0) process.exit(exitCode ?? 1);
  const tests = output
    .split(/\r?\n/u)
    .map((line) => line.match(/^(.+): test$/u)?.[1])
    .filter((testName) => testName !== undefined);
  if (tests.length === 0) {
    throw new Error(`No Rust tests were discovered for isolated target: ${target}`);
  }
  return tests;
}

async function runCargo(arguments_) {
  const child = spawn(process.execPath, [cargoRunner, '--', ...arguments_], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: 'inherit'
  });
  const exitCode = await waitForClose(child);
  if (exitCode !== 0) process.exit(exitCode ?? 1);
}

function waitForClose(child) {
  return new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', resolveExit);
  });
}
