import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { promisify } from 'node:util';

const DEFAULT_TIMEOUT_MS = 5_000;
const execFileAsync = promisify(execFile);

export async function terminateWindowsProcessTree(
  child,
  {
    label = 'child process',
    timeoutMs = DEFAULT_TIMEOUT_MS
  } = {},
  services = defaultServices()
) {
  if (services.platform !== 'win32') {
    throw new Error('terminateWindowsProcessTree can only be used on Windows.');
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (!Number.isInteger(child.pid) || child.pid <= 0) {
    throw new Error(`Cannot terminate ${label}: the child process has no valid PID.`);
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Cannot terminate ${label}: timeoutMs must be a positive integer.`);
  }

  const windowsDirectory = services.windowsDirectory;
  if (!windowsDirectory) {
    throw new Error(`Cannot terminate ${label}: WINDIR is required.`);
  }
  if (!win32.isAbsolute(windowsDirectory)) {
    throw new Error(`Cannot terminate ${label}: WINDIR must be an absolute Windows path.`);
  }
  const taskkill = win32.join(windowsDirectory, 'System32', 'taskkill.exe');
  const exit = observeChildExit(child);
  try {
    if (hasExited(child)) {
      return;
    }
    await services.runTaskkill(
      taskkill,
      ['/PID', String(child.pid), '/T', '/F'],
      timeoutMs
    );
    await withDeadline(
      exit.promise,
      timeoutMs,
      `${label} PID ${child.pid} did not exit after taskkill completed.`
    );
  } finally {
    exit.dispose();
  }
}

function defaultServices() {
  return {
    platform: process.platform,
    windowsDirectory: process.env.WINDIR,
    runTaskkill
  };
}

function runTaskkill(command, args, timeoutMs) {
  return execFileAsync(command, args, {
    timeout: timeoutMs,
    windowsHide: true
  });
}

function observeChildExit(child) {
  let onExit;
  const promise = new Promise((resolve) => {
    onExit = () => resolve();
    child.once('exit', onExit);
    if (hasExited(child)) {
      child.off('exit', onExit);
      resolve();
    }
  });
  return {
    promise,
    dispose() {
      child.off('exit', onExit);
    }
  };
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function withDeadline(promise, timeoutMs, message) {
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
