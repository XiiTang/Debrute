export type CliRuntimePolicy = 'no-runtime' | 'observe-runtime' | 'ensure-runtime';

const NO_RUNTIME = new Set(['commands', 'help', 'skills.status', 'skills.sync']);
const OBSERVE_RUNTIME = new Set(['runtime.status', 'runtime.doctor']);

export function runtimePolicyForCommand(command: string): CliRuntimePolicy {
  if (NO_RUNTIME.has(command)) {
    return 'no-runtime';
  }
  if (OBSERVE_RUNTIME.has(command)) {
    return 'observe-runtime';
  }
  return 'ensure-runtime';
}
