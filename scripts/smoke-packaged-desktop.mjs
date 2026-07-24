import { spawn, spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createServer } from 'node:net';
import process from 'node:process';

import { chromium } from 'playwright';

const options = parseArguments(process.argv.slice(2));
await access(options.desktop);
await access(options.cli);
verifyDesktopSignature(options);

const port = await reserveLoopbackPort();
const desktop = spawn(options.desktop, [
  '--remote-debugging-address=127.0.0.1',
  `--remote-debugging-port=${port}`
], {
  detached: process.platform !== 'win32',
  stdio: ['ignore', 'pipe', 'pipe']
});
const desktopOutput = [];
desktop.stdout.on('data', (chunk) => desktopOutput.push(chunk.toString()));
desktop.stderr.on('data', (chunk) => desktopOutput.push(chunk.toString()));
const desktopExit = new Promise((resolve) => {
  desktop.once('error', (error) => resolve({ error }));
  desktop.once('exit', (code, signal) => resolve({ code, signal }));
});

try {
  const target = await waitForPackagedDesktop(port, desktopExit, options.cli);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 10_000 });
  try {
    const page = browser.contexts().flatMap((context) => context.pages())
      .find((candidate) => candidate.url() === target.url);
    if (!page) throw new Error('CDP did not expose the packaged Workbench page.');
    const state = await withDeadline(
      page.evaluate(async () => ({
        origin: location.origin,
        root: document.querySelector('#root')?.childElementCount ?? 0,
        titlebar: document.querySelector('[data-testid="workbench-titlebar"]') !== null,
        ended: document.querySelector('[data-testid="workbench-connection-ended"]') !== null,
        shell: typeof window.debruteShell === 'object'
          && typeof window.debruteShell.getNativeWindowState === 'function',
        nativeWindowState: await window.debruteShell?.getNativeWindowState()
      })),
      10_000,
      'Packaged Workbench inspection timed out.'
    );
    if (state.origin !== new URL(target.url).origin || state.root === 0) {
      throw new Error('Packaged Workbench assets did not render from the Runtime origin.');
    }
    if (!state.shell || !state.titlebar || typeof state.nativeWindowState?.maximized !== 'boolean') {
      throw new Error('Packaged preload or native Desktop shell is unavailable.');
    }
    if (state.ended) throw new Error('Packaged Workbench entered connection-ended state.');
  } finally {
    await withDeadline(browser.close(), 5_000, 'Packaged CDP connection did not close.');
  }

  const stopped = await runCli(options.cli, ['runtime', 'stop'], Date.now() + 15_000);
  if (stopped.code !== 0 || !stopped.output.includes('accepted=true')) {
    throw new Error(`Bundled CLI did not accept Product Quit:\n${stopped.output}`);
  }
  const exit = await withDeadline(desktopExit, 15_000, 'Desktop did not exit after Product Quit.');
  if (exit.error) throw exit.error;
  if (exit.code !== 0) throw new Error(`Desktop exited with ${exit.code ?? exit.signal}.`);
  await waitForRuntimeStopped(options.cli);
} catch (error) {
  let cleanupError;
  try {
    await cleanupFailedLaunch(options.cli, desktop, desktopExit);
  } catch (cleanup) {
    cleanupError = cleanup;
  }
  const output = desktopOutput.join('').trim();
  const failure = output ? new Error(`${error.message}\nDesktop output:\n${output}`) : error;
  if (cleanupError) {
    throw new AggregateError([failure, cleanupError], 'Smoke test and exact cleanup failed.');
  }
  throw failure;
}

async function waitForPackagedDesktop(port, exitPromise, cli) {
  const deadline = Date.now() + 30_000;
  let lastStatus = '';
  while (Date.now() < deadline) {
    const outcome = await Promise.race([
      Promise.all([
        runCli(cli, ['runtime', 'status'], deadline),
        readCdpTargets(port, deadline)
      ]).then(([status, targets]) => ({ status, targets })),
      exitPromise.then((exit) => ({ exit }))
    ]);
    if (outcome.exit) {
      throw new Error(`Desktop failed before readiness: ${describeDesktopExit(outcome.exit)}.`);
    }
    const { status, targets } = outcome;
    lastStatus = status.output;
    const target = targets.find((candidate) => candidate.type === 'page');
    if (status.code === 0
      && status.output.includes('runtime_state=ready')
      && status.output.includes('native_tray=active')
      && target) {
      const debuggerUrl = new URL(target.webSocketDebuggerUrl);
      if (debuggerUrl.hostname !== '127.0.0.1' || Number(debuggerUrl.port) !== port) {
        throw new Error('Electron CDP endpoint is not bound to the requested loopback address.');
      }
      const targetUrl = new URL(target.url);
      if (targetUrl.protocol !== 'http:' || targetUrl.hostname !== '127.0.0.1') {
        throw new Error(`Workbench target is not served by loopback Runtime: ${target.url}`);
      }
      return target;
    }
    await delay(250);
  }
  throw new Error(`Runtime/Desktop did not become ready. Last status:\n${lastStatus}`);
}

async function readCdpTargets(port, deadline) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(Math.max(1, Math.min(1_000, deadline - Date.now())))
    });
    if (!response.ok) return [];
    const targets = await response.json();
    return Array.isArray(targets) ? targets : [];
  } catch {
    return [];
  }
}

async function waitForRuntimeStopped(cli) {
  const deadline = Date.now() + 15_000;
  let lastStatus = '';
  while (Date.now() < deadline) {
    const status = await runCli(cli, ['runtime', 'status'], deadline);
    lastStatus = status.output;
    if (status.code === 0 && status.output.includes('runtime_state=stopped')) return;
    await delay(100);
  }
  throw new Error(`Runtime remained live after Product Quit. Last status:\n${lastStatus}`);
}

async function cleanupFailedLaunch(cli, child, exitPromise) {
  const failures = [];
  try {
    const cleanupDeadline = Date.now() + 15_000;
    const status = await runCli(cli, ['runtime', 'status'], cleanupDeadline);
    if (status.code !== 0) {
      throw new Error(`Bundled CLI could not inspect Runtime during cleanup:\n${status.output}`);
    }
    if (!status.output.includes('runtime_state=stopped')) {
      const stopped = await runCli(cli, ['runtime', 'stop'], cleanupDeadline);
      if (stopped.code !== 0 || !stopped.output.includes('accepted=true')) {
        throw new Error(`Bundled CLI could not stop Runtime during cleanup:\n${stopped.output}`);
      }
      await waitForRuntimeStopped(cli);
    }
  } catch (error) {
    failures.push(error);
  }
  if (Number.isInteger(child.pid) && child.exitCode === null && child.signalCode === null) {
    try {
      terminateExactChildTree(child.pid);
      await withDeadline(exitPromise, 5_000, 'Exact Desktop child tree did not stop.');
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Exact packaged Desktop cleanup failed.');
  }
}

function describeDesktopExit(exit) {
  return exit.error?.message ?? String(exit.code ?? exit.signal);
}

function verifyDesktopSignature({ desktop, platform }) {
  if (platform === 'darwin') {
    const marker = '/Contents/MacOS/';
    const markerIndex = desktop.indexOf(marker);
    if (markerIndex < 0) throw new Error('macOS Desktop path is not inside an application bundle.');
    const application = desktop.slice(0, markerIndex);
    const result = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', application], {
      encoding: 'utf8',
      timeout: 15_000
    });
    if (result.status !== 0) throw new Error(`macOS signature is invalid:\n${result.stderr}`);
    return;
  }
  const literal = desktop.replaceAll("'", "''");
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `$signature = Get-AuthenticodeSignature -LiteralPath '${literal}'; if ($signature.Status -ne 'Valid') { Write-Error $signature.StatusMessage; exit 1 }`
  ], { encoding: 'utf8', timeout: 15_000 });
  if (result.status !== 0) throw new Error(`Windows signature is invalid:\n${result.stderr}`);
}

function terminateExactChildTree(pid) {
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      encoding: 'utf8',
      timeout: 5_000
    });
    if (result.status !== 0) throw new Error(`taskkill failed for PID ${pid}: ${result.stderr}`);
  } else {
    process.kill(-pid, 'SIGKILL');
  }
}

function runCli(cli, arguments_, deadline) {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      reject(new Error(`Bundled CLI deadline expired before ${arguments_.join(' ')}.`));
      return;
    }
    const child = spawn(cli, arguments_, { windowsHide: true });
    const output = [];
    let settled = false;
    const resolveOnce = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      const timeoutError = new Error(`Bundled CLI timed out: ${arguments_.join(' ')}.`);
      try {
        child.kill('SIGKILL');
        rejectOnce(timeoutError);
      } catch (killError) {
        rejectOnce(new AggregateError(
          [timeoutError, killError],
          `Bundled CLI timed out and PID ${child.pid} could not be killed.`
        ));
      }
    }, remaining);
    child.stdout.on('data', (chunk) => output.push(chunk.toString()));
    child.stderr.on('data', (chunk) => output.push(chunk.toString()));
    child.once('error', (error) => {
      rejectOnce(error);
    });
    child.once('exit', (code) => {
      resolveOnce({ code, output: output.join('') });
    });
  });
}

function reserveLoopbackPort() {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Loopback CDP port allocation failed.'));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function withDeadline(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]?.replace(/^--/, '');
    const value = argv[index + 1];
    if (!name || !value) throw new Error('Arguments must be --name value pairs.');
    values.set(name, value);
  }
  const desktop = values.get('desktop');
  const cli = values.get('cli');
  const platform = values.get('platform');
  if (!desktop || !cli || !['darwin', 'win32'].includes(platform)) {
    throw new Error('Usage: smoke-packaged-desktop --desktop <path> --cli <path> --platform darwin|win32');
  }
  return { desktop, cli, platform };
}
