import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDebruteCliInstaller } from '../apps/desktop/src/electron/debruteCliInstaller';
import { debruteCliManagedPaths } from '../apps/desktop/src/electron/debruteCliPaths';
import {
  getDebruteCliStatus,
  manualInstallCommand,
  repairDebruteCliPath,
  readDebruteCliSkillsStatus
} from '../apps/desktop/src/electron/debruteCliStatus';

describe('Desktop Debrute CLI installer', () => {
  it('builds status without accepting renderer-provided URL or command', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-cli-status-'));
    try {
      const installer = createDebruteCliInstaller({
        desktopVersion: '0.2.0',
        userHome: home,
        platform: 'darwin',
        arch: 'arm64',
        fetchAsset: async () => { throw new Error('not used'); },
        runDebrute: async () => ({ stdout: 'debrute 0.2.0\n', stderr: '', exitCode: 0 })
      });

      const status = await installer.getStatus();

      expect(status.kind).toBe('not_installed');
      expect(status.manualCommand).toContain('debrute-cli-0.2.0-macos-arm64.tar.gz');
      expect(status.manualCommand).toContain('debrute skills sync');
      expect(status.manualCommand).not.toContain('--force');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('does not activate a CLI when checksum verification fails', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-cli-checksum-'));
    const tmp = await mkdtemp(join(tmpdir(), 'debrute-cli-download-'));
    try {
      const archivePath = join(tmp, 'debrute-cli-0.2.0-macos-arm64.tar.gz');
      await writeFile(archivePath, 'not the expected archive', 'utf8');
      const installer = createDebruteCliInstaller({
        desktopVersion: '0.2.0',
        userHome: home,
        platform: 'darwin',
        arch: 'arm64',
        fetchAsset: async (url, destination) => {
          if (url.endsWith('debrute_SHA256SUMS')) {
            await writeFile(destination, `${'0'.repeat(64)}  debrute-cli-0.2.0-macos-arm64.tar.gz\n`, 'utf8');
          } else {
            await writeFile(destination, await readFile(archivePath));
          }
        },
        runDebrute: async () => ({ stdout: 'debrute 0.2.0\n', stderr: '', exitCode: 0 })
      });

      const result = await installer.install();

      expect(result.ok).toBe(false);
      expect(result.status.kind).toBe('error');
      await expect(pathExists(join(home, '.debrute', 'bin', 'debrute'))).resolves.toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('keeps the active same-version CLI when archive extraction fails', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-cli-existing-install-'));
    try {
      const paths = debruteCliManagedPaths({ userHome: home, version: '0.2.0', platform: 'darwin' });
      await mkdir(paths.installDir, { recursive: true });
      await mkdir(paths.binDir, { recursive: true });
      await writeFile(paths.executablePath, 'existing debrute', 'utf8');
      await symlink(paths.executablePath, paths.shimPath);
      const installer = createDebruteCliInstaller({
        desktopVersion: '0.2.0',
        userHome: home,
        platform: 'darwin',
        arch: 'arm64',
        fetchAsset: fakeSuccessfulFetch,
        extractArchive: async () => { throw new Error('extract failed'); },
        runDebrute: async () => ({ stdout: 'debrute 0.2.0\n', stderr: '', exitCode: 0 })
      });

      const result = await installer.install();

      expect(result.ok).toBe(false);
      expect(result.status.kind).toBe('error');
      await expect(readFile(paths.executablePath, 'utf8')).resolves.toBe('existing debrute');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('keeps verified install successful when PATH repair fails after activation', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-cli-path-fail-'));
    try {
      const installer = createDebruteCliInstaller({
        desktopVersion: '0.2.0',
        userHome: home,
        platform: 'darwin',
        arch: 'arm64',
        fetchAsset: fakeSuccessfulFetch,
        extractArchive: async ({ destinationDir }) => {
          await mkdir(join(destinationDir, 'skills', 'debrute-core'), { recursive: true });
          await writeFile(join(destinationDir, 'debrute'), '', 'utf8');
          await writeFile(join(destinationDir, 'skills', 'debrute-core', 'SKILL.md'), '---\nname: debrute-core\n---\n', 'utf8');
        },
        repairPath: async () => { throw new Error('profile locked'); },
        runDebrute: async (_debrutePath, args) => ({
          stdout: args.includes('--version') ? 'debrute 0.2.0\n' : 'debrute/1 skills_sync_completed updated=1 added=0 skipped_deleted=0 force=false\n',
          stderr: '',
          exitCode: 0
        })
      });

      const result = await installer.install();

      expect(result.ok).toBe(true);
      expect(result.status.kind).toBe('installed_but_not_on_path');
      await expect(pathExists(join(home, '.debrute', 'bin', 'debrute'))).resolves.toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('reports a verified install as installed after PATH repair succeeds for new sessions', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-cli-path-success-'));
    try {
      const installer = createDebruteCliInstaller({
        desktopVersion: '0.2.0',
        userHome: home,
        platform: 'darwin',
        arch: 'arm64',
        envPath: '/usr/bin:/bin',
        fetchAsset: fakeSuccessfulFetch,
        extractArchive: async ({ destinationDir }) => {
          await mkdir(join(destinationDir, 'skills', 'debrute-core'), { recursive: true });
          await writeFile(join(destinationDir, 'debrute'), '', 'utf8');
          await writeFile(join(destinationDir, 'skills', 'debrute-core', 'SKILL.md'), '---\nname: debrute-core\n---\n', 'utf8');
        },
        repairPath: async () => undefined,
        runDebrute: async (_debrutePath, args) => ({
          stdout: args.includes('--version') ? 'debrute 0.2.0\n' : 'debrute/1 skills_sync_completed updated=1 added=0 skipped_deleted=0 force=false\n',
          stderr: '',
          exitCode: 0
        })
      });

      const result = await installer.install();

      expect(result.ok).toBe(true);
      expect(result.status.kind).toBe('installed');
      await expect(pathExists(join(home, '.debrute', 'bin', 'debrute'))).resolves.toBe(true);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('reports installed but not on PATH when another debrute command shadows the managed shim', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-cli-shadowed-'));
    try {
      const paths = debruteCliManagedPaths({ userHome: home, version: '0.2.0', platform: 'darwin' });
      const externalBin = join(home, 'external-bin');
      await mkdir(paths.binDir, { recursive: true });
      await mkdir(externalBin, { recursive: true });
      await writeFile(paths.shimPath, '', 'utf8');
      await writeFile(join(externalBin, 'debrute'), '', 'utf8');

      const status = await getDebruteCliStatus({
        desktopVersion: '0.2.0',
        userHome: home,
        platform: 'darwin',
        arch: 'arm64',
        envPath: `${externalBin}:${paths.binDir}`,
        runDebrute: async () => ({ stdout: 'debrute 0.2.0\n', stderr: '', exitCode: 0 })
      });

      expect(status.kind).toBe('installed_but_not_on_path');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('returns a Skills status error when the managed state file is unreadable', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-cli-skills-state-'));
    try {
      await mkdir(join(home, '.debrute'), { recursive: true });
      await writeFile(join(home, '.debrute', 'skills-state.json'), '{not-json', 'utf8');

      await expect(readDebruteCliSkillsStatus({ userHome: home, cliVersion: '0.2.0' })).resolves.toEqual({
        kind: 'error',
        code: 'skills_state_unreadable',
        message: 'Debrute Skills state cannot be read.'
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('does not synthesize a Skills status when Desktop status has no installed CLI', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-cli-sync-no-status-'));
    try {
      const installer = createDebruteCliInstaller({
        desktopVersion: '0.2.0',
        userHome: home,
        platform: 'darwin',
        arch: 'arm64',
        runDebrute: async () => ({
          stdout: 'debrute/1 ok cmd=skills.sync\n',
          stderr: '',
          exitCode: 0
        })
      });

      const result = await installer.syncSkills();

      expect(result).toEqual({
        ok: false,
        status: {
          kind: 'error',
          code: 'debrute_cli_status_unavailable',
          message: 'Debrute CLI status does not include Skills state.'
        }
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('builds POSIX manual install commands that verify the downloaded archive in /tmp', () => {
    const command = manualInstallCommand({ version: '0.2.0', platform: 'darwin', arch: 'arm64' }).command;

    expect(command).toContain('cd "/tmp"');
    expect(command).toContain('grep "  $DEBRUTE_ASSET$" "debrute_SHA256SUMS" | shasum -a 256 -c -');
    expect(command).toContain('tar -xzf "$DEBRUTE_ASSET"');
  });

  it('builds a PowerShell manual install command with valid quoted cmd shim content', () => {
    const command = manualInstallCommand({ version: '0.2.0', platform: 'win32', arch: 'x64' }).command;

    expect(command).toContain('Set-Content "$DebruteHome\\bin\\debrute.cmd" ("@echo off" + [Environment]::NewLine + "`"$DebruteHome\\cli\\$Version\\debrute.exe`" %*")');
    expect(command).not.toContain('\\"$DebruteHome\\cli\\$Version\\debrute.exe\\"');
  });

  it('does not silently replace unreadable shell profiles when repairing PATH', async () => {
    const home = await mkdtemp(join(tmpdir(), 'debrute-cli-profile-unreadable-'));
    const profile = join(home, '.zprofile');
    try {
      await writeFile(profile, 'existing profile', 'utf8');
      await chmod(profile, 0o200);

      await expect(repairDebruteCliPath({ userHome: home, platform: 'darwin', shell: '/bin/zsh' })).rejects.toThrow();
      await chmod(profile, 0o600);
      await expect(readFile(profile, 'utf8')).resolves.toBe('existing profile');
    } finally {
      await chmod(profile, 0o600).catch(() => undefined);
      await rm(home, { recursive: true, force: true });
    }
  });
});

async function fakeSuccessfulFetch(url: string, destination: string): Promise<void> {
  const archiveBytes = Buffer.from('fake archive bytes');
  if (url.endsWith('debrute_SHA256SUMS')) {
    const checksum = createHash('sha256').update(archiveBytes).digest('hex');
    await writeFile(destination, `${checksum}  debrute-cli-0.2.0-macos-arm64.tar.gz\n`, 'utf8');
    return;
  }
  await writeFile(destination, archiveBytes);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
