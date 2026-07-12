import type { WorkbenchRuntimeOwner, WorkbenchRuntimeState } from './state.js';

const TERMINATION_DEADLINE_MS = 5_000;
const TERMINATION_POLL_INTERVAL_MS = 50;

export interface WorkbenchRuntimeProcessOperations {
  signalProcess: (pid: number, signal: 'SIGTERM') => void;
  probeProcess: (pid: number) => boolean;
  monotonicNow: () => number;
}

const defaultProcessOperations: WorkbenchRuntimeProcessOperations = {
  signalProcess: (pid, signal) => {
    process.kill(pid, signal);
  },
  probeProcess: (pid) => process.kill(pid, 0),
  monotonicNow: () => performance.now()
};

export async function terminateManagedWorkbenchRuntime(
  state: WorkbenchRuntimeState,
  operations: WorkbenchRuntimeProcessOperations = defaultProcessOperations
): Promise<void> {
  if (state.processControl !== 'managed') {
    return;
  }
  await terminateRuntimePids(state, operations);
}

export function isWorkbenchRuntimeOwnedBy(
  state: WorkbenchRuntimeState,
  owner: WorkbenchRuntimeOwner
): boolean {
  return state.owner.kind === owner.kind
    && state.owner.ownerId === owner.ownerId;
}

export async function terminateOwnedWorkbenchRuntime(
  state: WorkbenchRuntimeState,
  owner: WorkbenchRuntimeOwner,
  operations: WorkbenchRuntimeProcessOperations = defaultProcessOperations
): Promise<void> {
  if (state.processControl !== 'managed' || !isWorkbenchRuntimeOwnedBy(state, owner)) {
    return;
  }
  await terminateRuntimePids(state, operations);
}

async function terminateRuntimePids(
  state: WorkbenchRuntimeState,
  operations: WorkbenchRuntimeProcessOperations
): Promise<void> {
  const livePids = new Set(recordedPids(state));
  const signalFailures: unknown[] = [];
  for (const pid of livePids) {
    try {
      operations.signalProcess(pid, 'SIGTERM');
    } catch (error) {
      if (isProcessAbsentError(error)) {
        livePids.delete(pid);
        continue;
      }
      signalFailures.push(error);
    }
  }
  if (signalFailures.length === 1) {
    throw signalFailures[0];
  }
  if (signalFailures.length > 1) {
    throw new AggregateError(signalFailures, 'Debrute workbench runtime SIGTERM failed.');
  }

  const deadline = operations.monotonicNow() + TERMINATION_DEADLINE_MS;
  while (livePids.size > 0) {
    for (const pid of livePids) {
      try {
        if (!operations.probeProcess(pid)) {
          livePids.delete(pid);
        }
      } catch (error) {
        if (isProcessAbsentError(error)) {
          livePids.delete(pid);
          continue;
        }
        throw error;
      }
    }
    if (livePids.size === 0) {
      return;
    }
    if (operations.monotonicNow() >= deadline) {
      throw new Error(
        `Debrute workbench runtime termination deadline exceeded with live processes: ${livePidNames(state, livePids).join(', ')}.`
      );
    }
    await sleep(TERMINATION_POLL_INTERVAL_MS);
  }
}

function recordedPids(state: WorkbenchRuntimeState): number[] {
  return [...new Set(
    [state.daemonPid, state.webPid].filter((value): value is number => typeof value === 'number')
  )];
}

function livePidNames(state: WorkbenchRuntimeState, livePids: ReadonlySet<number>): string[] {
  const names = livePids.has(state.daemonPid) ? [`daemonPid=${state.daemonPid}`] : [];
  if (state.webPid !== undefined && livePids.has(state.webPid)) {
    names.push(`webPid=${state.webPid}`);
  }
  return names;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function isProcessAbsentError(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ESRCH';
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as { code?: unknown }).code === 'string';
}
