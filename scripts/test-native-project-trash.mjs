import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testName = process.platform === 'win32'
  ? 'windows_native_trash_roundtrip_restores_only_its_uuid_fixture'
  : process.platform === 'darwin'
    ? 'macos_native_trash_roundtrip_restores_only_its_uuid_fixture'
    : undefined;
if (!testName) {
  throw new Error('The native Project Trash recovery probe requires macOS or Windows.');
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cargoRunner = resolve(repositoryRoot, 'scripts/run-cargo-with-native-raster.mjs');
const child = spawn(process.execPath, [
  cargoRunner,
  '--',
  'test',
  '-p',
  'debrute-native-fs',
  '--test',
  'native_trash',
  '--',
  '--ignored',
  '--exact',
  testName,
  '--test-threads=1'
], {
  cwd: repositoryRoot,
  env: process.env,
  stdio: 'inherit'
});

const exitCode = await new Promise((resolveExit, rejectRun) => {
  child.once('error', rejectRun);
  child.once('close', resolveExit);
});
process.exit(exitCode ?? 1);
