import { runRuntimeHost } from '@debrute/runtime-host';

export async function runInternalWorkbenchRuntimeChild(): Promise<void> {
  await runRuntimeHost();
}
