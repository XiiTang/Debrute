import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { AxisCliPathState } from '@axis/app-protocol';

const BLOCK_START = '# >>> AXIS CLI installer >>>';
const BLOCK_END = '# <<< AXIS CLI installer <<<';
const BLOCK_PATTERN = /(?:^|\n)# >>> AXIS CLI installer >>>\nexport PATH="[^"]+:\$PATH"\n# <<< AXIS CLI installer <<<\n?/;
const execFileAsync = promisify(execFile);
const WINDOWS_USER_ENV_KEY = 'HKCU\\Environment';

export interface WindowsUserPathStore {
  read(): Promise<string>;
  write(value: string): Promise<void>;
}

export function AXIS_CLI_PATH_BLOCK(binDir: string): string {
  return `${BLOCK_START}\nexport PATH="${binDir}:$PATH"\n${BLOCK_END}\n`;
}

export function selectPosixProfilePath(input: {
  homeDir: string;
  platform: NodeJS.Platform;
  shell?: string | undefined;
}): string {
  const shell = input.shell ?? '';
  if (input.platform === 'darwin' && shell.endsWith('/zsh')) {
    return join(input.homeDir, '.zprofile');
  }
  if (input.platform === 'darwin' && shell.endsWith('/bash')) {
    return join(input.homeDir, '.bash_profile');
  }
  if (input.platform === 'linux' && shell.endsWith('/zsh')) {
    return join(input.homeDir, '.zshrc');
  }
  if (input.platform === 'linux' && shell.endsWith('/bash')) {
    return join(input.homeDir, '.bashrc');
  }
  return join(input.homeDir, '.profile');
}

export async function ensurePosixAxisCliPath(input: {
  profilePath: string;
  binDir: string;
}): Promise<void> {
  const current = await readTextIfExists(input.profilePath);
  const block = AXIS_CLI_PATH_BLOCK(input.binDir);
  const next = BLOCK_PATTERN.test(current)
    ? current.replace(BLOCK_PATTERN, (match) => `${match.startsWith('\n') ? '\n' : ''}${block}`)
    : appendBlock(current, block);
  await mkdir(dirname(input.profilePath), { recursive: true });
  await writeFile(input.profilePath, next, 'utf8');
}

export async function removePosixAxisCliPath(profilePath: string): Promise<void> {
  const current = await readTextIfExists(profilePath);
  const next = current
    .replace(BLOCK_PATTERN, (match) => match.startsWith('\n') ? '\n' : '')
    .replace(/\n{2,}$/, '\n');
  await mkdir(dirname(profilePath), { recursive: true });
  await writeFile(profilePath, next, 'utf8');
}

export async function readPosixPathState(input: {
  profilePath: string;
  binDir: string;
  envPath?: string | undefined;
  pathDelimiter: string;
}): Promise<AxisCliPathState> {
  const envHasPath = splitPath(input.envPath, input.pathDelimiter).some((entry) => samePath(entry, input.binDir));
  if (envHasPath) {
    return 'configured';
  }
  const profile = await readTextIfExists(input.profilePath);
  return profile.includes(AXIS_CLI_PATH_BLOCK(input.binDir).trim())
    ? 'configured-pending-terminal'
    : 'not-configured';
}

export function updateWindowsUserPathValue(currentValue: string, binDir: string, add: boolean): string {
  const parts = currentValue.split(';').filter(Boolean);
  const withoutBin = parts.filter((entry) => !samePath(entry, binDir));
  if (!add) {
    return withoutBin.join(';');
  }
  const canonical = parts.find((entry) => samePath(entry, binDir)) ?? binDir;
  return [canonical, ...withoutBin].join(';');
}

export function createWindowsUserPathStore(): WindowsUserPathStore {
  return {
    async read() {
      try {
        const { stdout } = await execFileAsync('reg', ['query', WINDOWS_USER_ENV_KEY, '/v', 'Path'], { windowsHide: true });
        return parseWindowsUserPath(stdout);
      } catch (error) {
        if (isMissingWindowsPathValue(error)) {
          return '';
        }
        throw error;
      }
    },
    async write(value: string) {
      await execFileAsync('reg', ['add', WINDOWS_USER_ENV_KEY, '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', value, '/f'], { windowsHide: true });
    }
  };
}

export async function ensureWindowsAxisCliPath(store: WindowsUserPathStore, binDir: string): Promise<void> {
  const current = await store.read();
  const next = updateWindowsUserPathValue(current, binDir, true);
  if (next !== current) {
    await store.write(next);
  }
}

export async function removeWindowsAxisCliPath(store: WindowsUserPathStore, binDir: string): Promise<void> {
  const current = await store.read();
  const next = updateWindowsUserPathValue(current, binDir, false);
  if (next !== current) {
    await store.write(next);
  }
}

export async function readWindowsPathState(store: WindowsUserPathStore, binDir: string): Promise<AxisCliPathState> {
  const current = await store.read();
  return current.split(';').filter(Boolean).some((entry) => samePath(entry, binDir))
    ? 'configured'
    : 'not-configured';
}

function appendBlock(current: string, block: string): string {
  if (!current) {
    return block;
  }
  return current.endsWith('\n') ? `${current}${block}` : `${current}\n${block}`;
}

function splitPath(value: string | undefined, delimiter: string): string[] {
  return value?.split(delimiter).filter(Boolean) ?? [];
}

function samePath(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingPathError(error)) {
      return '';
    }
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function parseWindowsUserPath(output: string): string {
  const match = output.match(/^\s*Path\s+REG_\w+\s+(.*)$/im);
  return match?.[1]?.trim() ?? '';
}

function isMissingWindowsPathValue(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 1;
}
