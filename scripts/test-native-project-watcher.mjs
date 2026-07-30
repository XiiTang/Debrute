import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const probeDeadlineMs = 15_000;
const probeTimeoutDiagnostic = process.platform === 'darwin'
  ? ' see notify-rs/notify#942.'
  : '';
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cargoRunner = resolve(repositoryRoot, 'scripts/run-cargo-with-native-raster.mjs');
const targetRoot = resolveTargetRoot();
const executable = resolve(
  targetRoot,
  'debug',
  'examples',
  process.platform === 'win32'
    ? 'native_project_watcher_probe.exe'
    : 'native_project_watcher_probe'
);

await run(process.execPath, [
  cargoRunner,
  '--',
  'build',
  '-p',
  'debrute-runtime',
  '--features',
  'native-watcher-probe',
  '--example',
  'native_project_watcher_probe'
]);
await runSupervisedProbe();

function resolveTargetRoot() {
  const configured = process.env.CARGO_TARGET_DIR;
  if (!configured) return resolve(repositoryRoot, 'target');
  return isAbsolute(configured) ? configured : resolve(repositoryRoot, configured);
}

function run(command, arguments_) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, arguments_, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: 'inherit'
    });
    child.once('error', rejectRun);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(new Error(
        `${command} exited with code ${String(code)} and signal ${String(signal)}.`
      ));
    });
  });
}

async function runSupervisedProbe() {
  const probeRoot = await mkdtemp(join(tmpdir(), 'debrute-native-project-watcher-probe-'));
  let probeError;
  let cleanupError;
  try {
    await runProbe(probeRoot);
  } catch (error) {
    probeError = error;
  }
  try {
    await rm(probeRoot, { recursive: true });
  } catch (error) {
    cleanupError = new Error(`Failed to remove native watcher probe root ${probeRoot}.`, {
      cause: error
    });
  }
  if (probeError && cleanupError) {
    throw new AggregateError(
      [probeError, cleanupError],
      'Native Project watcher probe and supervisor cleanup both failed.'
    );
  }
  if (probeError) throw probeError;
  if (cleanupError) throw cleanupError;
}

function runProbe(probeRoot) {
  return new Promise((resolveProbe, rejectProbe) => {
    const child = spawn(executable, [probeRoot], {
      cwd: repositoryRoot,
      env: process.env,
      stdio: 'inherit'
    });
    let timedOut = false;
    let killFailed = false;
    let settled = false;
    const resolveOnce = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveProbe();
    };
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectProbe(error);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (!child.kill('SIGKILL')) {
        killFailed = true;
      }
    }, probeDeadlineMs);
    child.once('error', (error) => {
      rejectOnce(error);
    });
    child.once('close', (code, signal) => {
      if (timedOut) {
        rejectOnce(new Error(
          killFailed
            ? `Native Project watcher probe exceeded ${probeDeadlineMs} ms and PID ${String(child.pid)} could not be killed.`
            : `Native Project watcher probe exceeded ${probeDeadlineMs} ms and was killed.${probeTimeoutDiagnostic}`
        ));
        return;
      }
      if (code === 0) {
        resolveOnce();
        return;
      }
      rejectOnce(new Error(
        `Native Project watcher probe exited with code ${String(code)} and signal ${String(signal)}.`
      ));
    });
  });
}
