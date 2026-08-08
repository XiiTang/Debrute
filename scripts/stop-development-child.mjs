import { terminateWindowsProcessTree } from './terminate-windows-process-tree.mjs';

const WINDOWS_DEVELOPMENT_GRACE_PERIOD_MS = 2_000;

export async function stopDevelopmentChild(child, { label = 'development child process' } = {}) {
  if (!child || hasExited(child)) {
    return;
  }
  if (process.platform === 'win32') {
    await terminateWindowsProcessTree(child, {
      label,
      gracePeriodMs: WINDOWS_DEVELOPMENT_GRACE_PERIOD_MS
    });
    return;
  }
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      child.off('exit', onExit);
      child.off('error', onError);
      callback(value);
    };
    const onExit = () => finish(resolve);
    const onError = (error) => finish(reject, error);
    child.once('exit', onExit);
    child.once('error', onError);
    if (hasExited(child)) {
      finish(resolve);
      return;
    }
    try {
      if (!child.kill('SIGTERM')) {
        finish(reject, new Error(`Cannot terminate ${label}: could not send SIGTERM.`));
      }
    } catch (error) {
      finish(reject, error);
    }
  });
}

export function throwDevelopmentCleanupFailures(results, message) {
  const failures = results.flatMap((result) => (
    result.status === 'rejected' ? [result.reason] : []
  ));
  if (failures.length > 0) {
    throw new AggregateError(failures, message);
  }
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}
