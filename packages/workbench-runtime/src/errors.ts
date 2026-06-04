export type WorkbenchRuntimeRegistryErrorCode =
  | 'runtime_launch_failed'
  | 'runtime_health_failed'
  | 'runtime_state_unreadable'
  | 'runtime_state_write_failed'
  | 'runtime_lock_timeout';

export class WorkbenchRuntimeRegistryError extends Error {
  constructor(
    readonly code: WorkbenchRuntimeRegistryErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'WorkbenchRuntimeRegistryError';
  }
}

export function registryError(
  code: WorkbenchRuntimeRegistryErrorCode,
  message: string
): WorkbenchRuntimeRegistryError {
  return new WorkbenchRuntimeRegistryError(code, message);
}

export function isWorkbenchRuntimeRegistryError(error: unknown): error is WorkbenchRuntimeRegistryError {
  return error instanceof WorkbenchRuntimeRegistryError;
}
