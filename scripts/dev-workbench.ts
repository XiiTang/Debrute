#!/usr/bin/env tsx
import { spawn, type ChildProcess } from 'node:child_process';

import { packageManagerCommand } from './package-manager-command.mjs';
import {
  buildRustRuntime,
  chooseDevelopmentPort,
  ensureRustRuntime,
  stopRustRuntime,
  workspaceRoot
} from './rust-runtime-dev.js';
import {
  stopDevelopmentChild,
  throwDevelopmentCleanupFailures
} from './stop-development-child.mjs';
import { parseWorkbenchDevelopmentOptions } from './workbench-development-options.js';

const developmentOptions = parseWorkbenchDevelopmentOptions(process.argv.slice(2));
let vite: ChildProcess | undefined;
let stopping = false;
let shutdown: Promise<void> | undefined;
let removeRuntimeLost = () => undefined;
const stopRuntimeOnExit = process.env.DEBRUTE_DEV_STOP_RUNTIME_ON_EXIT === '1';

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void stopDevelopment().then(
    () => process.exit(0),
    (error) => {
      console.error(error);
      process.exit(1);
    }
  ));
}

const runtimeRebuilt = await buildRustRuntime();
const control = await ensureRustRuntime({ restartExisting: runtimeRebuilt });
const vitePort = await chooseDevelopmentPort();
const viteOrigin = `http://127.0.0.1:${vitePort}`;
const registration = await control.registerDevWorkbenchOrigin(viteOrigin);
if (registration.result !== 'dev_workbench_origin_registered') {
  control.close();
  throw new Error(`Runtime rejected source Workbench registration: ${registration.result}`);
}
removeRuntimeLost = control.onRuntimeLost((error) => {
  if (stopping) return;
  process.stderr.write(
    `Debrute Runtime stopped during source development (${error.code}): ${error.message}. Restart pnpm dev.\n`
  );
  process.exitCode = 1;
  void stopDevelopment().catch((cleanupError) => {
    console.error(cleanupError);
    process.exitCode = 1;
  });
});
const launchUrl = new URL('/', viteOrigin);
const command = packageManagerCommand(workspaceRoot, [
  '--filter',
  '@debrute/web',
  'dev',
  '--port',
  String(vitePort),
  '--strictPort'
]);
vite = spawn(command.command, command.args, {
  cwd: workspaceRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    DEBRUTE_RUNTIME_ORIGIN: registration.runtime_origin,
    VITE_DEBRUTE_CANVAS_PERF: developmentOptions.canvasPerfEnabled ? '1' : '0',
    VITE_DEBRUTE_STARTUP_PERF: developmentOptions.startupPerfEnabled ? '1' : '0'
  }
});
process.stdout.write(`Debrute Workbench launch URL: ${launchUrl}\n`);
process.stdout.write(`Canvas performance probe: ${developmentOptions.canvasPerfEnabled ? 'enabled' : 'disabled'}\n`);
process.stdout.write(`Startup performance timeline: ${developmentOptions.startupPerfEnabled ? 'enabled' : 'disabled'}\n`);

try {
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    vite?.once('error', reject);
    vite?.once('exit', resolveExit);
  });
  if (!stopping && exitCode !== 0) {
    process.exitCode = exitCode ?? 1;
  }
} finally {
  await stopDevelopment();
  vite = undefined;
}

function stopDevelopment(): Promise<void> {
  stopping = true;
  shutdown ??= (async () => {
    removeRuntimeLost();
    const results = await Promise.allSettled([
      stopDevelopmentChild(vite, { label: 'Vite development server' }),
      (async () => {
        try {
          if (stopRuntimeOnExit) {
            await stopRustRuntime(control);
          }
        } finally {
          control.close();
        }
      })()
    ]);
    throwDevelopmentCleanupFailures(results, 'Workbench development cleanup failed.');
  })();
  return shutdown;
}
