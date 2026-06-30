import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { INTEGRATION_CATALOG } from '../apps/app-server/src/integrations/IntegrationCatalog';
import { runIntegrationCommand } from '../apps/app-server/src/integrations/IntegrationCommandRunner';
import {
  buildIntegrationInstallQueryCommand,
  buildIntegrationOperationCommand,
  buildIntegrationQueryCommand,
  detectPythonCliInstaller,
  detectSystemPackageManager,
  parseSystemInstallQueryOutput,
  parseSystemPackageQueryOutput
} from '../apps/app-server/src/integrations/IntegrationBackends';

const SPAWN_TEST_TIMEOUT_MS = 20_000;

describe('integration backends', () => {
  it('detects Homebrew and prefers uv for Python CLI integrations', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'debrute-integrations-backends-'));
    const brew = await writeExecutable(binDir, 'brew', '#!/bin/sh\nexit 0\n');
    const uv = await writeExecutable(binDir, 'uv', '#!/bin/sh\nexit 0\n');
    await writeExecutable(binDir, 'pipx', '#!/bin/sh\nexit 0\n');

    await expect(detectSystemPackageManager({ platform: 'darwin', envPath: binDir })).resolves.toEqual({
      kind: 'system-package-manager',
      manager: 'brew',
      backend: 'brew',
      path: brew,
      available: true
    });
    await expect(detectPythonCliInstaller({ envPath: binDir })).resolves.toEqual({
      kind: 'python-cli-installer',
      installer: 'uv',
      backend: 'uv',
      path: uv,
      available: true
    });
  });

  it('does not expose Linux APT as a real operation backend without an elevation path', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'debrute-integrations-apt-unavailable-'));
    await writeExecutable(binDir, 'apt-get', '#!/bin/sh\nexit 0\n');
    await writeExecutable(binDir, 'apt-cache', '#!/bin/sh\nexit 0\n');

    await expect(detectSystemPackageManager({ platform: 'linux', envPath: binDir })).resolves.toEqual({
      kind: 'system-package-manager',
      available: false,
      unavailableReason: 'System package integration operations are not supported on linux.'
    });
  });

  it('reports Python CLI installer unavailable when uv and pipx are absent', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'debrute-integrations-no-python-installer-'));

    await expect(detectPythonCliInstaller({ envPath: binDir })).resolves.toEqual({
      kind: 'python-cli-installer',
      available: false,
      unavailableReason: 'uv or pipx was not found on PATH.'
    });
  });

  it('builds fixed media and remove-ai-watermarks operation commands', () => {
    const ffmpeg = INTEGRATION_CATALOG.find((integration) => integration.id === 'ffmpeg')!;
    const remove = INTEGRATION_CATALOG.find((integration) => integration.id === 'remove-ai-watermarks')!;

    expect(buildIntegrationOperationCommand(ffmpeg, {
      kind: 'system-package-manager',
      manager: 'brew',
      backend: 'brew',
      path: '/opt/homebrew/bin/brew',
      available: true
    }, 'install')).toEqual({
      backend: 'brew',
      file: '/opt/homebrew/bin/brew',
      args: ['install', '--formula', 'ffmpeg']
    });

    expect(buildIntegrationOperationCommand(remove, {
      kind: 'python-cli-installer',
      installer: 'uv',
      backend: 'uv',
      path: '/opt/homebrew/bin/uv',
      available: true
    }, 'install')).toEqual({
      backend: 'uv',
      file: '/opt/homebrew/bin/uv',
      args: ['tool', 'install', 'git+https://github.com/wiltodelta/remove-ai-watermarks.git']
    });

    expect(buildIntegrationOperationCommand(remove, {
      kind: 'python-cli-installer',
      installer: 'pipx',
      backend: 'pipx',
      path: '/usr/local/bin/pipx',
      available: true
    }, 'update')).toEqual({
      backend: 'pipx',
      file: '/usr/local/bin/pipx',
      args: ['upgrade', 'remove-ai-watermarks']
    });
  });

  it('builds fixed query commands only for system package integrations', () => {
    const ffmpeg = INTEGRATION_CATALOG.find((integration) => integration.id === 'ffmpeg')!;
    const remove = INTEGRATION_CATALOG.find((integration) => integration.id === 'remove-ai-watermarks')!;

    expect(buildIntegrationQueryCommand(ffmpeg, {
      kind: 'system-package-manager',
      manager: 'brew',
      backend: 'brew',
      path: '/opt/homebrew/bin/brew',
      available: true
    })).toEqual({
      backend: 'brew',
      file: '/opt/homebrew/bin/brew',
      args: ['outdated', '--json=v2', '--formula', 'ffmpeg']
    });
    expect(buildIntegrationInstallQueryCommand(remove, {
      kind: 'python-cli-installer',
      installer: 'uv',
      backend: 'uv',
      path: '/opt/homebrew/bin/uv',
      available: true
    })).toBeUndefined();
  });

  it('parses system package query output', () => {
    expect(parseSystemPackageQueryOutput('brew', 'ffmpeg', JSON.stringify({
      formulae: [{ name: 'ffmpeg', installed_versions: ['7.1.1'], current_version: '8.0' }],
      casks: []
    }))).toEqual({
      installedVersion: '7.1.1',
      latestVersion: '8.0',
      updateAvailable: true
    });

    expect(parseSystemInstallQueryOutput('winget', 'Gyan.FFmpeg', [
      'Found FFmpeg [Gyan.FFmpeg]',
      'Version: 8.0'
    ].join('\n'))).toEqual({
      latestVersion: '8.0',
      updateAvailable: false
    });
  });

  it('runs commands with file and args without shell execution', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'debrute-integration-command-runner-'));
    const logPath = join(binDir, 'argv.log');
    const command = await writeExecutable(binDir, 'runner', [
      '#!/bin/sh',
      `printf '%s\\n' "$0|$1|$2" > ${JSON.stringify(logPath)}`,
      'printf "ok\\n"'
    ].join('\n'));

    const result = await runIntegrationCommand({
      file: command,
      args: ['hello', 'world'],
      timeoutMs: 10_000
    });

    expect(result).toMatchObject({ ok: true, stdout: 'ok\n' });
    expect(result.diagnostic).toMatchObject({ exitCode: 0, stdoutTail: 'ok\n' });
    expect(await readFile(logPath, 'utf8')).toContain('runner|hello|world');
  }, SPAWN_TEST_TIMEOUT_MS);

  it('bounds output and kills timed-out commands', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'debrute-integration-command-limits-'));
    const large = await writeExecutable(binDir, 'large-output', [
      '#!/bin/sh',
      'printf "%0200000d\\n" 0',
      'printf "%0200000d\\n" 0 >&2'
    ].join('\n'));
    const sleepy = await writeExecutable(binDir, 'sleepy', '#!/bin/sh\nsleep 5\n');

    const largeResult = await runIntegrationCommand({
      file: large,
      args: [],
      timeoutMs: 10_000
    });
    expect(largeResult.stdout.length).toBeLessThan(200_001);
    expect(largeResult.stderr.length).toBeLessThan(200_001);
    expect(largeResult.diagnostic.stdoutTail?.length).toBeLessThanOrEqual(4096);
    expect(largeResult.diagnostic.stderrTail?.length).toBeLessThanOrEqual(4096);

    await expect(runIntegrationCommand({
      file: sleepy,
      args: [],
      timeoutMs: 50
    })).resolves.toMatchObject({
      ok: false,
      diagnostic: {
        errorKind: 'timeout'
      }
    });
  }, SPAWN_TEST_TIMEOUT_MS);
});

async function writeExecutable(dir: string, name: string, content: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, content, 'utf8');
  await chmod(path, 0o755);
  return path;
}
