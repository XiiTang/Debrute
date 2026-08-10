import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

import { terminateWindowsProcessTree } from './terminate-windows-process-tree.mjs';

const WINDOWS_CLI_ENVIRONMENT_KEY = 'DEBRUTE_SMOKE_MANAGED_CLI';
const SAFE_CLI_ARGUMENT = /^[A-Za-z0-9._:=/-]+$/;

export function runManagedCli(cli, arguments_, { platform, timeoutMs, label = 'managed CLI' }) {
  if (!['darwin', 'win32'].includes(platform)) {
    throw new Error(`Unsupported managed CLI smoke platform: ${platform}`);
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Managed CLI timeout must be a positive integer.');
  }
  const invocation = managedCliInvocation(resolve(cli), arguments_, platform);
  return new Promise((resolveResult, reject) => {
    const child = spawn(invocation.command, invocation.arguments, {
      env: invocation.environment,
      windowsHide: true
    });
    const output = [];
    let settled = false;
    const resolveOnce = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const timeoutError = new Error(`${label} timed out: ${arguments_.join(' ')}.`);
      void terminateTimedOutCli(child, platform, label).then(
        () => reject(timeoutError),
        (killError) => reject(new AggregateError(
          [timeoutError, killError],
          `${label} timed out and its exact process tree could not be terminated.`
        ))
      );
    }, timeoutMs);
    child.stdout.on('data', (chunk) => output.push(chunk.toString()));
    child.stderr.on('data', (chunk) => output.push(chunk.toString()));
    child.once('error', rejectOnce);
    child.once('exit', (code) => resolveOnce({ code, output: output.join('') }));
  });
}

function managedCliInvocation(cli, arguments_, platform) {
  if (platform !== 'win32') {
    return { command: cli, arguments: arguments_, environment: process.env };
  }
  if (!cli.toLowerCase().endsWith('.cmd')) {
    throw new Error(`Windows managed CLI smoke requires the stable debrute.cmd: ${cli}`);
  }
  if (!arguments_.every((argument) => SAFE_CLI_ARGUMENT.test(argument))) {
    throw new Error('Managed CLI smoke arguments must use the closed command-token alphabet.');
  }
  return {
    command: process.env.ComSpec ?? 'cmd.exe',
    arguments: [
      '/d',
      '/s',
      '/c',
      `call "%${WINDOWS_CLI_ENVIRONMENT_KEY}%" ${arguments_.join(' ')}`
    ],
    environment: {
      ...process.env,
      [WINDOWS_CLI_ENVIRONMENT_KEY]: cli
    }
  };
}

async function terminateTimedOutCli(child, platform, label) {
  if (platform === 'win32') {
    await terminateWindowsProcessTree(child, { label });
  } else {
    child.kill('SIGKILL');
  }
}
