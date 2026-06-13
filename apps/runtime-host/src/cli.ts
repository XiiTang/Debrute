import { runRuntimeHost } from './runtimeHost.js';

runRuntimeHost().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
