import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function packageManagerCommand(workspaceRoot, args = [], services = defaultServices()) {
  const packageManager = readDeclaredPackageManager(workspaceRoot, services);
  if (packageManager.name !== 'pnpm') {
    throw new Error(`Unsupported package manager: ${packageManager.raw}. Debrute requires pnpm.`);
  }

  const corepackEntrypoint = resolveCorepackEntrypoint(services);
  if (corepackEntrypoint) {
    return {
      command: services.execPath,
      args: [corepackEntrypoint, packageManager.name, ...args]
    };
  }

  if (services.platform === 'win32') {
    throw new Error('Corepack is required to launch pnpm from Debrute scripts on Windows.');
  }

  return {
    command: packageManager.name,
    args
  };
}

function readDeclaredPackageManager(workspaceRoot, services) {
  const packageJsonPath = resolve(workspaceRoot, 'package.json');
  const packageJson = JSON.parse(services.readFileSync(packageJsonPath, 'utf8'));
  const raw = packageJson.packageManager;
  if (typeof raw !== 'string') {
    throw new Error(`Missing packageManager in ${packageJsonPath}.`);
  }
  const match = /^([a-z0-9-]+)@/.exec(raw);
  if (!match) {
    throw new Error(`Invalid packageManager in ${packageJsonPath}: ${raw}`);
  }
  return {
    raw,
    name: match[1]
  };
}

function resolveCorepackEntrypoint(services) {
  const corepackEntrypoint = resolve(dirname(services.execPath), 'node_modules/corepack/dist/corepack.js');
  return services.existsSync(corepackEntrypoint) ? corepackEntrypoint : undefined;
}

function defaultServices() {
  return {
    platform: process.platform,
    execPath: process.execPath,
    existsSync,
    readFileSync
  };
}
