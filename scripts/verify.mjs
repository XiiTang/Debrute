import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { packageManagerCommand } from './package-manager-command.mjs';
import {
  parseVerificationArguments,
  runVerification
} from './verification-pipeline.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

try {
  const options = parseVerificationArguments(process.argv.slice(2));
  await runVerification({
    ...options,
    runScript: (script) => runPackageScript(script)
  });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function runPackageScript(script) {
  const invocation = packageManagerCommand(repositoryRoot, [script]);
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: 'inherit'
    });
    child.once('error', rejectRun);
    child.once('close', (exitCode) => {
      if (exitCode === 0) {
        resolveRun();
      } else {
        rejectRun(new Error(`Verification stage ${script} exited with code ${exitCode ?? 1}.`));
      }
    });
  });
}
