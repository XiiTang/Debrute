import { resolveWorkbenchRuntimePaths, type WorkbenchRuntimePaths } from './paths.js';
import { terminateManagedWorkbenchRuntime } from './processControl.js';
import { registryError, isWorkbenchRuntimeRegistryError } from './errors.js';
import {
  deleteWorkbenchRuntimeState,
  readWorkbenchRuntimeState,
  writeWorkbenchRuntimeState,
  type WorkbenchRuntimeState
} from './state.js';
import { isWorkbenchRuntimeHealthy } from './health.js';
import { withWorkbenchRuntimeStartupLock } from './lock.js';

const RUNTIME_HEALTH_TIMEOUT_MS = 30_000;
const RUNTIME_HEALTH_INTERVAL_MS = 250;

export interface EnsureRegisteredWorkbenchRuntimeInput {
  paths?: WorkbenchRuntimePaths;
  isHealthy?: (state: WorkbenchRuntimeState) => Promise<boolean>;
  launch: (paths: WorkbenchRuntimePaths) => Promise<WorkbenchRuntimeState>;
  shouldTerminateStaleRuntime?: (state: WorkbenchRuntimeState) => boolean;
  onRuntimeLaunchFailed?: (state: WorkbenchRuntimeState) => Promise<void>;
}

export interface EnsureRegisteredWorkbenchRuntimeResult {
  runtimeStarted: boolean;
  statePath: string;
  state: WorkbenchRuntimeState;
}

export async function ensureRegisteredWorkbenchRuntime(
  input: EnsureRegisteredWorkbenchRuntimeInput
): Promise<EnsureRegisteredWorkbenchRuntimeResult> {
  const paths = input.paths ?? resolveWorkbenchRuntimePaths();
  const isHealthy = input.isHealthy ?? isWorkbenchRuntimeHealthy;
  const existing = await readStateOrDeleteInvalid(paths.statePath);
  if (existing && await isHealthy(existing)) {
    return { runtimeStarted: false, statePath: paths.statePath, state: existing };
  }

  return withWorkbenchRuntimeStartupLock(paths, async () => {
    const lockedExisting = await readStateOrDeleteInvalid(paths.statePath);
    if (lockedExisting && await isHealthy(lockedExisting)) {
      return { runtimeStarted: false, statePath: paths.statePath, state: lockedExisting };
    }
    if (lockedExisting) {
      if (input.shouldTerminateStaleRuntime?.(lockedExisting) === true) {
        await terminateManagedWorkbenchRuntime(lockedExisting);
      }
      await deleteWorkbenchRuntimeState(paths.statePath);
    }

    let launched: WorkbenchRuntimeState;
    try {
      launched = await input.launch(paths);
    } catch (error) {
      if (isWorkbenchRuntimeRegistryError(error)) {
        throw error;
      }
      throw registryError('runtime_launch_failed', messageFromUnknown(error), { cause: error });
    }
    try {
      await waitForRuntimeHealth(launched, isHealthy);
      try {
        await writeWorkbenchRuntimeState(paths.statePath, launched);
      } catch (error) {
        throw registryError('runtime_state_write_failed', messageFromUnknown(error));
      }
      return { runtimeStarted: true, statePath: paths.statePath, state: launched };
    } catch (error) {
      try {
        await input.onRuntimeLaunchFailed?.(launched);
      } catch (cleanupError) {
        throw aggregateCleanupFailure(error, cleanupError);
      }
      await deleteWorkbenchRuntimeState(paths.statePath);
      throw error;
    }
  });
}

async function readStateOrDeleteInvalid(statePath: string): Promise<WorkbenchRuntimeState | undefined> {
  try {
    return await readWorkbenchRuntimeState(statePath);
  } catch (error) {
    if (isInvalidStateError(error)) {
      await deleteWorkbenchRuntimeState(statePath);
      return undefined;
    }
    throw registryError('runtime_state_unreadable', messageFromUnknown(error));
  }
}

async function waitForRuntimeHealth(
  state: WorkbenchRuntimeState,
  isHealthy: (state: WorkbenchRuntimeState) => Promise<boolean>
): Promise<void> {
  const deadline = Date.now() + RUNTIME_HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isHealthy(state).catch((error) => {
      throw registryError('runtime_health_failed', messageFromUnknown(error));
    })) {
      return;
    }
    await sleep(RUNTIME_HEALTH_INTERVAL_MS);
  }
  throw registryError('runtime_health_failed', 'Debrute workbench runtime did not become healthy.');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function isInvalidStateError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Invalid Debrute workbench runtime state:');
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function aggregateCleanupFailure(primaryError: unknown, cleanupError: unknown): AggregateError {
  return new AggregateError(
    [primaryError, cleanupError],
    messageFromUnknown(primaryError),
    { cause: primaryError }
  );
}
