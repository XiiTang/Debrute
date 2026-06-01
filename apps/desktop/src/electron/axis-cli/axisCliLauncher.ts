import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AxisCliDiagnostic } from '@axis/app-protocol';

export interface AxisCliDevelopmentLauncherInput {
  commandPath: string;
  devLinkFile: string;
  platform: NodeJS.Platform;
  repoRoot: string;
  nodePath: string;
}

export async function createAxisCliDevelopmentLauncher(input: AxisCliDevelopmentLauncherInput): Promise<AxisCliDiagnostic | undefined> {
  const entrypoint = join(input.repoRoot, 'apps/axis-cli/src/index.ts');
  const tsxEntrypoint = join(input.repoRoot, 'node_modules/tsx/dist/cli.mjs');
  if (!await fileExists(entrypoint)) {
    return {
      operation: 'refresh-development-link',
      code: 'source_checkout_missing',
      path: entrypoint,
      message: 'AXIS CLI source checkout is missing.'
    };
  }
  if (!await fileExists(tsxEntrypoint)) {
    return {
      operation: 'refresh-development-link',
      code: 'source_dependency_missing',
      path: tsxEntrypoint,
      message: 'AXIS CLI development dependencies are missing.'
    };
  }

  await mkdir(dirname(input.commandPath), { recursive: true });
  await mkdir(dirname(input.devLinkFile), { recursive: true });
  await writeFile(input.commandPath, launcherText({
    nodePath: input.nodePath,
    repoRoot: input.repoRoot,
    entrypoint,
    tsxEntrypoint,
    platform: input.platform
  }), 'utf8');
  if (input.platform !== 'win32') {
    await chmod(input.commandPath, 0o755);
  }
  await writeFile(input.devLinkFile, `${JSON.stringify({
    mode: 'source-linked',
    repoRoot: input.repoRoot,
    entrypoint,
    tsxEntrypoint
  }, null, 2)}\n`, 'utf8');
  return undefined;
}

function launcherText(input: {
  nodePath: string;
  repoRoot: string;
  entrypoint: string;
  tsxEntrypoint: string;
  platform: NodeJS.Platform;
}): string {
  if (input.platform === 'win32') {
    return [
      '@echo off',
      `set "AXIS_REPO_ROOT=${input.repoRoot}"`,
      `"${input.nodePath}" "${input.tsxEntrypoint}" "${input.entrypoint}" %*`,
      ''
    ].join('\r\n');
  }
  return [
    '#!/bin/sh',
    `export AXIS_REPO_ROOT=${shellQuote(input.repoRoot)}`,
    `exec ${shellQuote(input.nodePath)} ${shellQuote(input.tsxEntrypoint)} ${shellQuote(input.entrypoint)} "$@"`,
    ''
  ].join('\n');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return false;
    }
    throw error;
  }
}
