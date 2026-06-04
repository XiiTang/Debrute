import { delimiter, dirname, resolve } from 'node:path';
import { Module } from 'node:module';

export function configurePackagedNodeModules(execPath = packagedExecutablePath()): void {
  if (!isPkgRuntime()) {
    return;
  }
  const nextNodePath = packagedNodePathValue(execPath, process.env.NODE_PATH);
  if (nextNodePath === process.env.NODE_PATH) {
    return;
  }
  process.env.NODE_PATH = nextNodePath;
  (Module as unknown as { _initPaths(): void })._initPaths();
}

export function packagedExecutablePath(execPath = process.execPath): string {
  return execPath;
}

export function packagedNodeModulesPath(execPath: string): string {
  return resolve(dirname(execPath), 'node_modules');
}

export function packagedNodePathValue(execPath: string, currentNodePath = ''): string {
  const nodeModulesPath = packagedNodeModulesPath(execPath);
  const entries = currentNodePath.split(delimiter).filter(Boolean);
  return [nodeModulesPath, ...entries.filter((entry) => entry !== nodeModulesPath)].join(delimiter);
}

function isPkgRuntime(): boolean {
  return typeof (process as { pkg?: unknown }).pkg === 'object';
}
