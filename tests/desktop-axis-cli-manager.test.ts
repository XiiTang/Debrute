import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createAxisCliManager } from '../apps/desktop/src/electron/axis-cli/axisCliManager';
import { resolveAxisCliPaths } from '../apps/desktop/src/electron/axis-cli/axisCliPaths';

const execFileAsync = promisify(execFile);

describe('Axis CLI manager', () => {
  it('creates the local development source-linked launcher and PATH entry', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'axis-cli-home-'));
    const repoRoot = mkdtempSync(join(tmpdir(), 'axis-cli-repo-'));
    const syncLogPath = join(homeDir, 'skills-sync.log');
    const nodePath = await writeFakeDevelopmentNode(homeDir, syncLogPath);
    await mkdir(join(repoRoot, 'apps/axis-cli/src'), { recursive: true });
    await mkdir(join(repoRoot, 'node_modules/tsx/dist'), { recursive: true });
    await writeFile(join(repoRoot, 'apps/axis-cli/src/index.ts'), '', 'utf8');
    await writeFile(join(repoRoot, 'node_modules/tsx/dist/cli.mjs'), '', 'utf8');

    const manager = createAxisCliManager({
      appVersion: '0.1.0',
      arch: 'arm64',
      env: { PATH: '/usr/bin', SHELL: '/bin/zsh' },
      homeDir,
      nodePath,
      packaged: false,
      platform: 'darwin',
      releaseClient: unavailableReleaseClient(),
      repoRoot
    });

    const status = await manager.refreshDevelopmentLink();

    expect(status.mode).toBe('source-linked');
    expect(status.commandPath).toBe(join(homeDir, '.axis/bin/axis'));
    expect(await readFile(status.commandPath, 'utf8')).toContain(join(repoRoot, 'apps/axis-cli/src/index.ts'));
    expect((await stat(status.commandPath)).mode & 0o111).toBeGreaterThan(0);
    expect(await readFile(join(homeDir, '.zprofile'), 'utf8')).toContain('# >>> AXIS CLI installer >>>');
    expect(await readFile(syncLogPath, 'utf8')).toContain('skills sync --force');
  });

  it('serializes CLI operations', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'axis-cli-lock-'));
    const manager = createAxisCliManager({
      appVersion: '0.1.0',
      arch: 'arm64',
      env: { PATH: '/usr/bin', SHELL: '/bin/zsh' },
      homeDir,
      packaged: true,
      platform: 'darwin',
      releaseClient: {
        installLatest: async () => new Promise(() => undefined),
        getLatestVersion: async () => undefined
      }
    });

    const running = manager.install();
    await expect(manager.repair()).resolves.toMatchObject({
      diagnostic: { code: 'operation_already_running' }
    });
    running.catch(() => undefined);
  });

  it('uses the install lock across manager instances', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'axis-cli-file-lock-'));
    let releaseFirstOperation!: () => void;
    const firstOperationStarted = new Promise<void>((resolve) => {
      const firstManager = createAxisCliManager({
        appVersion: '0.1.0',
        arch: 'arm64',
        env: { PATH: '/usr/bin', SHELL: '/bin/zsh' },
        homeDir,
        packaged: true,
        platform: 'darwin',
        releaseClient: {
          installLatest: async () => {
            resolve();
            await new Promise<void>((release) => {
              releaseFirstOperation = release;
            });
            throw Object.assign(new Error('stop first install'), { code: 'download_failed' });
          },
          getLatestVersion: async () => undefined
        }
      });
      void firstManager.install();
    });
    await firstOperationStarted;

    const secondManager = createAxisCliManager({
      appVersion: '0.1.0',
      arch: 'arm64',
      env: { PATH: '/usr/bin', SHELL: '/bin/zsh' },
      homeDir,
      packaged: true,
      platform: 'darwin',
      releaseClient: {
        installLatest: async () => {
          throw new Error('lock was not respected');
        },
        getLatestVersion: async () => undefined
      }
    });

    await expect(secondManager.install()).resolves.toMatchObject({
      diagnostic: { code: 'operation_already_running' }
    });
    releaseFirstOperation();
  });

  it('reports source-linked launchers as broken when the checkout is missing', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'axis-cli-source-broken-home-'));
    const repoRoot = mkdtempSync(join(tmpdir(), 'axis-cli-source-broken-repo-'));
    const nodePath = await writeFakeDevelopmentNode(homeDir, join(homeDir, 'skills-sync.log'));
    await mkdir(join(repoRoot, 'apps/axis-cli/src'), { recursive: true });
    await mkdir(join(repoRoot, 'node_modules/tsx/dist'), { recursive: true });
    await writeFile(join(repoRoot, 'apps/axis-cli/src/index.ts'), '', 'utf8');
    await writeFile(join(repoRoot, 'node_modules/tsx/dist/cli.mjs'), '', 'utf8');
    const manager = createAxisCliManager({
      appVersion: '0.1.0',
      arch: 'arm64',
      env: { PATH: join(homeDir, '.axis/bin'), SHELL: '/bin/zsh' },
      homeDir,
      nodePath,
      packaged: false,
      platform: 'darwin',
      releaseClient: unavailableReleaseClient(),
      repoRoot
    });
    await manager.refreshDevelopmentLink();

    await rm(repoRoot, { recursive: true, force: true });
    await expect(manager.getStatus()).resolves.toMatchObject({
      mode: 'broken',
      managed: true,
      diagnostic: { code: 'source_checkout_missing' }
    });
  });

  it('repairs an unusable release command by reinstalling the latest release', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'axis-cli-repair-home-'));
    const paths = resolveAxisCliPaths({ homeDir, platform: 'darwin', arch: 'arm64' });
    await mkdir(paths.binDir, { recursive: true });
    await writeFile(paths.commandPath, '#!/bin/sh\nexit 127\n', 'utf8');
    await chmod(paths.commandPath, 0o755);
    let installs = 0;
    const manager = createAxisCliManager({
      appVersion: '0.1.0',
      arch: 'arm64',
      env: { PATH: paths.binDir, SHELL: '/bin/zsh' },
      homeDir,
      packaged: true,
      platform: 'darwin',
      releaseClient: {
        getLatestVersion: async () => '0.2.0',
        installLatest: async (input) => {
          installs += 1;
          await writeTarReleaseArchive(input.stagingArchivePath, '0.2.0');
          return { version: '0.2.0', archivePath: input.stagingArchivePath };
        }
      }
    });

    const status = await manager.repair();
    expect(status).toMatchObject({
      mode: 'release',
      managed: true,
      installedVersion: '0.2.0'
    });
    expect(status.diagnostic).toBeUndefined();
    expect(installs).toBe(1);
  });

  it('runs force Skills sync after release install verifies the active command', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'axis-cli-install-sync-home-'));
    const syncLogPath = join(homeDir, 'skills-sync.log');
    const manager = createAxisCliManager({
      appVersion: '0.1.0',
      arch: 'arm64',
      env: { PATH: '/usr/bin', SHELL: '/bin/zsh' },
      homeDir,
      packaged: true,
      platform: 'darwin',
      releaseClient: {
        getLatestVersion: async () => '0.2.0',
        installLatest: async (input) => {
          await writeTarReleaseArchive(input.stagingArchivePath, '0.2.0', { syncLogPath });
          return { version: '0.2.0', archivePath: input.stagingArchivePath };
        }
      }
    });

    const status = await manager.install();

    expect(status).toMatchObject({ mode: 'release', installedVersion: '0.2.0' });
    expect(status.diagnostic).toBeUndefined();
    expect(await readFile(syncLogPath, 'utf8')).toContain('skills sync --force');
  });

  it('runs normal Skills sync after release update verifies the active command', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'axis-cli-update-sync-home-'));
    const syncLogPath = join(homeDir, 'skills-sync.log');
    let installs = 0;
    const manager = createAxisCliManager({
      appVersion: '0.1.0',
      arch: 'arm64',
      env: { PATH: '/usr/bin', SHELL: '/bin/zsh' },
      homeDir,
      packaged: true,
      platform: 'darwin',
      releaseClient: {
        getLatestVersion: async () => installs === 0 ? '0.1.0' : '0.2.0',
        installLatest: async (input) => {
          installs += 1;
          const version = installs === 1 ? '0.1.0' : '0.2.0';
          await writeTarReleaseArchive(input.stagingArchivePath, version, { syncLogPath });
          return { version, archivePath: input.stagingArchivePath };
        }
      }
    });

    await manager.install();
    await writeFile(syncLogPath, '', 'utf8');
    const status = await manager.update();
    const syncLog = await readFile(syncLogPath, 'utf8');

    expect(status).toMatchObject({ mode: 'release', installedVersion: '0.2.0' });
    expect(syncLog).toContain('skills sync');
    expect(syncLog).not.toContain('--force');
  });

  it('runs force Skills sync when repairing an already installed release CLI', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'axis-cli-repair-sync-home-'));
    const syncLogPath = join(homeDir, 'skills-sync.log');
    const manager = createAxisCliManager({
      appVersion: '0.1.0',
      arch: 'arm64',
      env: { PATH: '/usr/bin', SHELL: '/bin/zsh' },
      homeDir,
      packaged: true,
      platform: 'darwin',
      releaseClient: {
        getLatestVersion: async () => '0.2.0',
        installLatest: async (input) => {
          await writeTarReleaseArchive(input.stagingArchivePath, '0.2.0', { syncLogPath });
          return { version: '0.2.0', archivePath: input.stagingArchivePath };
        }
      }
    });

    await manager.install();
    await writeFile(syncLogPath, '', 'utf8');
    const status = await manager.repair();

    expect(status).toMatchObject({ mode: 'release', installedVersion: '0.2.0' });
    expect(await readFile(syncLogPath, 'utf8')).toContain('skills sync --force');
  });

  it('does not sync Skills when release installation fails before command verification', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'axis-cli-no-sync-before-verify-'));
    const syncLogPath = join(homeDir, 'skills-sync.log');
    const manager = createAxisCliManager({
      appVersion: '0.1.0',
      arch: 'arm64',
      env: { PATH: '/usr/bin', SHELL: '/bin/zsh' },
      homeDir,
      packaged: true,
      platform: 'darwin',
      releaseClient: {
        getLatestVersion: async () => '0.2.0',
        installLatest: async () => ({
          version: '0.2.0',
          archivePath: join(homeDir, 'missing.tar.gz')
        })
      }
    });

    const status = await manager.install();

    expect(status.diagnostic?.code).not.toBe('skills_sync_failed');
    await expect(readFile(syncLogPath, 'utf8')).rejects.toThrow();
  });

  it('keeps the verified release CLI active when post-install Skills sync fails', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'axis-cli-sync-fail-home-'));
    const syncLogPath = join(homeDir, 'skills-sync.log');
    const manager = createAxisCliManager({
      appVersion: '0.1.0',
      arch: 'arm64',
      env: { PATH: '/usr/bin', SHELL: '/bin/zsh' },
      homeDir,
      packaged: true,
      platform: 'darwin',
      releaseClient: {
        getLatestVersion: async () => '0.2.0',
        installLatest: async (input) => {
          await writeTarReleaseArchive(input.stagingArchivePath, '0.2.0', {
            syncLogPath,
            syncExitCode: 7
          });
          return { version: '0.2.0', archivePath: input.stagingArchivePath };
        }
      }
    });

    const status = await manager.install();

    expect(status).toMatchObject({
      mode: 'release',
      installedVersion: '0.2.0',
      diagnostic: { code: 'skills_sync_failed' }
    });
  });

  it('uses bounded diagnostics for archive extraction failures', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'axis-cli-bad-archive-'));
    const manager = createAxisCliManager({
      appVersion: '0.1.0',
      arch: 'arm64',
      env: { PATH: '/usr/bin', SHELL: '/bin/zsh' },
      homeDir,
      packaged: true,
      platform: 'darwin',
      releaseClient: {
        getLatestVersion: async () => '0.2.0',
        installLatest: async (input) => {
          await writeFile(input.stagingArchivePath, 'not a tar archive', 'utf8');
          return { version: '0.2.0', archivePath: input.stagingArchivePath };
        }
      }
    });

    await expect(manager.install()).resolves.toMatchObject({
      diagnostic: { code: 'archive_extract_failed' }
    });
  });
});

async function writeTarReleaseArchive(
  archivePath: string,
  version: string,
  options: { syncLogPath?: string; syncExitCode?: number } = {}
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'axis-cli-release-payload-'));
  const payload = join(root, 'payload');
  await mkdir(payload, { recursive: true });
  const binaryPath = join(payload, 'axis');
  const syncExitCode = options.syncExitCode ?? 0;
  await writeFile(binaryPath, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then',
    `  echo ${version}`,
    '  exit 0',
    'fi',
    'if [ "$1" = "skills" ] && [ "$2" = "sync" ]; then',
    options.syncLogPath ? `  echo "$*" >> "${options.syncLogPath}"` : '  true',
    syncExitCode === 0 ? '  echo "axis/1 ok cmd=skills.sync"' : '  echo "sync failed" >&2',
    `  exit ${syncExitCode}`,
    'fi',
    `echo ${version}`,
    ''
  ].join('\n'), 'utf8');
  await chmod(binaryPath, 0o755);
  await writeFile(join(payload, 'package.json'), `${JSON.stringify({ version }, null, 2)}\n`, 'utf8');
  await execFileAsync('tar', ['-czf', archivePath, '-C', payload, '.']);
  await rm(root, { recursive: true, force: true });
}

async function writeFakeDevelopmentNode(homeDir: string, syncLogPath: string): Promise<string> {
  const nodePath = join(homeDir, 'fake-node');
  await writeFile(nodePath, [
    '#!/bin/sh',
    'if [ "$3" = "--version" ]; then',
    '  echo "0.0.0-dev"',
    '  exit 0',
    'fi',
    'if [ "$3" = "skills" ] && [ "$4" = "sync" ]; then',
    `  echo "$3 $4 $5" >> "${syncLogPath}"`,
    '  echo "axis/1 ok cmd=skills.sync"',
    '  exit 0',
    'fi',
    'echo "0.0.0-dev"',
    ''
  ].join('\n'), 'utf8');
  await chmod(nodePath, 0o755);
  return nodePath;
}

function unavailableReleaseClient() {
  return {
    getLatestVersion: async () => undefined,
    installLatest: async () => {
      throw Object.assign(new Error('Release install is unavailable in development tests.'), { code: 'release_not_found' });
    }
  };
}
