import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { DebruteGlobalRuntimeServer, GlobalConfigStore } from '../../../apps/app-server/src/index';
import { INTEGRATION_CATALOG } from '../../../apps/app-server/src/integrations/IntegrationCatalog';
import {
  nodeIntegrationProcessAdapter,
  runIntegrationCommand
} from '../../../apps/app-server/src/integrations/IntegrationCommandRunner';
import {
  buildIntegrationInstallQueryCommand,
  buildIntegrationOperationCommand,
  buildIntegrationQueryCommand,
  detectPythonCliInstaller,
  detectSystemPackageManager,
  parseSystemInstallQueryOutput,
  parseSystemPackageQueryOutput
} from '../../../apps/app-server/src/integrations/IntegrationBackends';
import { IntegrationsService } from '../../../apps/app-server/src/integrations/IntegrationsService';

describe('app-server integrations', () => {
  describe('DebruteGlobalRuntimeServer integration settings', () => {
    it('emits an integrations settings change event after rescan', async () => {
      const home = await mkdtemp(join(tmpdir(), 'debrute-integrations-rescan-event-home-'));
      const globalRuntime = new DebruteGlobalRuntimeServer({
        globalConfigStore: new GlobalConfigStore({ debruteHome: home }),
        integrationEnvPath: ''
      });
      const events: string[] = [];
      globalRuntime.onEvent((event) => events.push(event.type));
      try {
        await globalRuntime.integrationsRescan();
        expect(events).toContain('globalSettings.changed');
      } finally {
        globalRuntime.close();
        await rm(home, { recursive: true, force: true });
      }
    });

    it('emits integration settings events when an operation starts and settles', async () => {
      const home = await mkdtemp(join(tmpdir(), 'debrute-integrations-operation-event-home-'));
      const binaries: Record<string, {
        stdout: string;
      }> = {};
      const processAdapter = createMemoryIntegrationProcessAdapter({
        binaries,
        executables: ['brew'],
        runCommand: async (_file, args) => {
          if (args[0] === 'install') {
            binaries.magick = { stdout: 'Version: ImageMagick 7.1.2-23' };
            return commandResult();
          }
          return commandResult({ stdout: brewInstallQueryOutput() });
        }
      });
      const globalRuntime = new DebruteGlobalRuntimeServer({
        globalConfigStore: new GlobalConfigStore({ debruteHome: home }),
        integrationEnvPath: 'C:\\integration-bin',
        integrationPlatform: 'darwin',
        integrationPathExt: '.EXE',
        integrationProcessAdapter: processAdapter
      });
      const events: Array<{
        type: string;
        settings?: {
          integrations?: {
            runningOperation?: unknown;
          };
        };
      }> = [];
      globalRuntime.onEvent((event) => events.push(event));
      try {
        const result = await globalRuntime.integrationsRunOperation({ integrationId: 'imagemagick', operation: 'install' });
        expect(result.ok).toBe(true);
        expect(events.filter((event) => event.type === 'globalSettings.changed')).toHaveLength(2);
        expect(events[0]?.settings?.integrations?.runningOperation).toEqual({ integrationId: 'imagemagick', operation: 'install' });
        expect(events.at(-1)?.settings?.integrations?.runningOperation).toBeUndefined();
      } finally {
        globalRuntime.close();
        await rm(home, { recursive: true, force: true });
      }
    });

    it('does not emit running integration events for unavailable operations', async () => {
      const home = await mkdtemp(join(tmpdir(), 'debrute-integrations-unavailable-event-home-'));
      const processAdapter = createMemoryIntegrationProcessAdapter({
        binaries: {},
        executables: ['brew'],
        runCommand: async () => commandResult({ stdout: brewInstallQueryOutput() })
      });
      const globalRuntime = new DebruteGlobalRuntimeServer({
        globalConfigStore: new GlobalConfigStore({ debruteHome: home }),
        integrationEnvPath: 'C:\\integration-bin',
        integrationPlatform: 'darwin',
        integrationPathExt: '.EXE',
        integrationProcessAdapter: processAdapter
      });
      const events: Array<{
        type: string;
        settings?: {
          integrations?: {
            runningOperation?: unknown;
            integrations?: unknown[];
          };
        };
      }> = [];
      globalRuntime.onEvent((event) => events.push(event));
      try {
        const result = await globalRuntime.integrationsRunOperation({ integrationId: 'imagemagick', operation: 'uninstall' });
        expect(result).toMatchObject({
          ok: false,
          diagnostic: { errorKind: 'operation_unavailable' }
        });
        expect(result.settings.runningOperation).toBeUndefined();
        expect(result.settings.integrations).not.toHaveLength(0);
        expect(events.filter((event) => event.type === 'globalSettings.changed')).toEqual([]);
      } finally {
        globalRuntime.close();
        await rm(home, { recursive: true, force: true });
      }
    });
  });

  describe('integration backends', () => {
    it('detects Homebrew and prefers uv for Python CLI integrations', async () => {
      const processAdapter = createMemoryIntegrationProcessAdapter({
        binaries: {},
        executables: ['brew', 'uv', 'pipx']
      });
      await expect(detectSystemPackageManager({
        platform: 'darwin',
        envPath: 'C:\\integration-bin',
        pathExt: '.EXE',
        processAdapter
      })).resolves.toEqual({
        kind: 'system-package-manager',
        manager: 'brew',
        backend: 'brew',
        path: 'C:\\integration-bin\\brew.EXE',
        available: true
      });
      await expect(detectPythonCliInstaller({
        platform: 'darwin',
        envPath: 'C:\\integration-bin',
        pathExt: '.EXE',
        processAdapter
      })).resolves.toEqual({
        kind: 'python-cli-installer',
        installer: 'uv',
        backend: 'uv',
        path: 'C:\\integration-bin\\uv.EXE',
        available: true
      });
      const realBinDir = await mkdtemp(join(tmpdir(), 'debrute-integration-resolver-'));
      try {
        const windowsCommand = join(realBinDir, 'tool.CMD');
        await writeFile(windowsCommand, 'fixture', 'utf8');
        await expect(nodeIntegrationProcessAdapter.resolveExecutable(
          'tool',
          realBinDir,
          'win32',
          '.CMD;.EXE'
        )).resolves.toBe(windowsCommand);
        if (process.platform !== 'win32') {
          const posixCommand = join(realBinDir, 'posix-tool');
          await writeFile(posixCommand, 'fixture', 'utf8');
          await chmod(posixCommand, 0o755);
          await expect(nodeIntegrationProcessAdapter.resolveExecutable(
            'posix-tool',
            realBinDir,
            'linux',
            ''
          )).resolves.toBe(posixCommand);
          await chmod(posixCommand, 0o644);
          await expect(nodeIntegrationProcessAdapter.resolveExecutable(
            'posix-tool',
            realBinDir,
            'linux',
            ''
          )).resolves.toBeUndefined();
        }
      } finally {
        await rm(realBinDir, { recursive: true, force: true });
      }
    });

    it('does not expose Linux APT as a real operation backend without an elevation path', async () => {
      const processAdapter = createMemoryIntegrationProcessAdapter({
        binaries: {},
        executables: ['apt-get', 'apt-cache']
      });
      await expect(detectSystemPackageManager({
        platform: 'linux',
        envPath: 'C:\\integration-bin',
        pathExt: '.EXE',
        processAdapter
      })).resolves.toEqual({
        kind: 'system-package-manager',
        available: false,
        unavailableReason: 'System package integration operations are not supported on linux.'
      });
    });

    it('reports Python CLI installer unavailable when uv and pipx are absent', async () => {
      const processAdapter = createMemoryIntegrationProcessAdapter({ binaries: {} });
      await expect(detectPythonCliInstaller({
        platform: 'win32',
        envPath: 'C:\\integration-bin',
        pathExt: '.EXE',
        processAdapter
      })).resolves.toEqual({
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
      const result = await runIntegrationCommand({
        file: process.execPath,
        args: [
          '--input-type=module',
          '--eval',
          `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(1))); process.stdout.write('ok\\n');`,
          'hello',
          'world'
        ],
        timeoutMs: 10000
      });
      expect(result).toMatchObject({ ok: true, stdout: 'ok\n' });
      expect(result.diagnostic).toMatchObject({ exitCode: 0, stdoutTail: 'ok\n' });
      expect(JSON.parse(await readFile(logPath, 'utf8'))).toEqual(['hello', 'world']);
      await expect(nodeIntegrationProcessAdapter.runProbe(
        process.execPath,
        ['--eval', "process.stdout.write('probe ok\\n');"],
        10_000
      )).resolves.toMatchObject({ ok: true, stdout: 'probe ok\n', exitCode: 0 });
      await expect(nodeIntegrationProcessAdapter.runProbe(
        process.execPath,
        ['--eval', "process.stderr.write('probe failed\\n'); process.exit(7);"],
        10_000
      )).resolves.toMatchObject({
        ok: false,
        stderr: 'probe failed\n',
        exitCode: 7,
        errorKind: 'nonzero_exit'
      });
    });

    it('bounds output and kills timed-out commands', async () => {
      const largeResult = await runIntegrationCommand({
        file: process.execPath,
        args: [
          '--eval',
          `process.stdout.write('0'.repeat(200_000)); process.stderr.write('0'.repeat(200_000));`
        ],
        timeoutMs: 10000
      });
      expect(largeResult.stdout.length).toBeLessThan(200001);
      expect(largeResult.stderr.length).toBeLessThan(200001);
      expect(largeResult.diagnostic.stdoutTail?.length).toBeLessThanOrEqual(4096);
      expect(largeResult.diagnostic.stderrTail?.length).toBeLessThanOrEqual(4096);
      await expect(runIntegrationCommand({
        file: process.execPath,
        args: ['--eval', 'setInterval(() => undefined, 30_000);'],
        timeoutMs: 50
      })).resolves.toMatchObject({
        ok: false,
        diagnostic: {
          errorKind: 'timeout'
        }
      });
      await expect(nodeIntegrationProcessAdapter.runProbe(
        process.execPath,
        ['--eval', 'setInterval(() => undefined, 30_000);'],
        50
      )).resolves.toMatchObject({ ok: false, errorKind: 'timeout' });
    });
  });

  describe('IntegrationsService', () => {
    it('returns not_found when required binaries are absent', async () => {
      const envDir = await mkdtemp(join(tmpdir(), 'debrute-integrations-empty-'));
      const service = new IntegrationsService({ envPath: envDir, cacheTtlMs: 0 });
      const view = await service.listStatus();
      const ffmpeg = view.integrations.find((integration) => integration.integrationId === 'ffmpeg');
      expect(ffmpeg?.status).toBe('not_found');
      expect(ffmpeg?.summary).toBe('ffmpeg is missing.');
      expect(ffmpeg?.binaries.map((binary) => binary.status)).toEqual(['not_found', 'not_found']);
    });

    it('marks media integrations ready when all required probes exit successfully', async () => {
      const processAdapter = createMemoryIntegrationProcessAdapter({
        binaries: {
          ffmpeg: { stdout: 'ffmpeg version 7.1.1' },
          ffprobe: { stdout: 'ffprobe version 7.1.1' }
        }
      });
      const service = new IntegrationsService({
        envPath: 'C:\\integration-bin',
        platform: 'win32',
        pathExt: '.EXE',
        cacheTtlMs: 0,
        processAdapter
      });
      const view = await service.listStatus();
      const ffmpeg = view.integrations.find((integration) => integration.integrationId === 'ffmpeg');
      expect(ffmpeg?.status).toBe('ready');
      expect(ffmpeg?.summary).toBe('Ready.');
      expect(ffmpeg?.binaries.map((binary) => binary.version)).toEqual(['7.1.1', '7.1.1']);
      expect(ffmpeg?.binaries.some((binary) => 'path' in binary)).toBe(false);
    });

    it('parses ImageMagick and Windows PATHEXT probe versions', async () => {
      const processAdapter = createMemoryIntegrationProcessAdapter({
        binaries: {
          magick: { stdout: 'Version: ImageMagick 7.0.0' },
          mediainfo: { stdout: 'MediaInfo Command line, MediaInfoLib - v24.12' }
        }
      });
      const macService = new IntegrationsService({
        envPath: 'C:\\integration-bin',
        platform: 'darwin',
        cacheTtlMs: 0,
        processAdapter
      });
      const macView = await macService.listStatus();
      const winService = new IntegrationsService({
        envPath: 'C:\\integration-bin',
        cacheTtlMs: 0,
        platform: 'win32',
        pathExt: '.EXE',
        processAdapter
      });
      const winView = await winService.listStatus();
      expect(macView.integrations.find((integration) => integration.integrationId === 'imagemagick')?.binaries[0]?.version).toBe('7.0.0');
      expect(winView.integrations.find((integration) => integration.integrationId === 'mediainfo')?.binaries[0]?.version).toBe('24.12');
    });

    it('reports probe_failed for nonzero probes without exposing command previews', async () => {
      const processAdapter = createMemoryIntegrationProcessAdapter({
        binaries: {
          mediainfo: { stdout: 'broken', exitCode: 2, stderr: 'cannot load library' }
        }
      });
      const service = new IntegrationsService({
        envPath: 'C:\\integration-bin',
        platform: 'win32',
        pathExt: '.EXE',
        cacheTtlMs: 0,
        processAdapter
      });
      const view = await service.listStatus();
      const mediainfo = view.integrations.find((integration) => integration.integrationId === 'mediainfo');
      expect(mediainfo?.status).toBe('probe_failed');
      expect(mediainfo?.summary).toBe('mediainfo probe failed.');
      expect(mediainfo?.binaries[0]?.probe).toMatchObject({
        exitCode: 2,
        errorKind: 'nonzero_exit',
        stderrTail: expect.stringContaining('cannot load library')
      });
    });

    it('exposes install availability for missing media integrations when the system package manager is present', async () => {
      const processAdapter = createMemoryIntegrationProcessAdapter({
        binaries: {},
        executables: ['brew'],
        runCommand: async () => commandResult({ stdout: brewInstallQueryOutput() })
      });
      const service = new IntegrationsService({
        envPath: 'C:\\integration-bin',
        cacheTtlMs: 0,
        platform: 'darwin',
        processAdapter
      });
      const view = await service.listStatus();
      const imagemagick = view.integrations.find((integration) => integration.integrationId === 'imagemagick');
      expect(view.backends).toContainEqual({ kind: 'system-package-manager', backend: 'brew', available: true });
      expect(imagemagick?.operationStatus).toMatchObject({
        backendKind: 'system-package-manager',
        backend: 'brew',
        packageName: 'imagemagick',
        latestVersion: '7.1.2-23',
        availableOperations: ['install']
      });
      expect(JSON.stringify(imagemagick?.operationStatus)).not.toContain('brew install');
    });

    it('exposes update availability for ready media integrations when a newer package version exists', async () => {
      const processAdapter = createMemoryIntegrationProcessAdapter({
        binaries: {
          ffmpeg: { stdout: 'ffmpeg version 7.1.1' },
          ffprobe: { stdout: 'ffprobe version 7.1.1' }
        },
        executables: ['brew'],
        runCommand: async () => commandResult({
          stdout: JSON.stringify({
            formulae: [{ name: 'ffmpeg', installed_versions: ['7.1.1'], current_version: '8.0' }],
            casks: []
          })
        })
      });
      const service = new IntegrationsService({
        envPath: 'C:\\integration-bin',
        cacheTtlMs: 0,
        platform: 'darwin',
        processAdapter
      });
      const view = await service.listStatus();
      const ffmpeg = view.integrations.find((integration) => integration.integrationId === 'ffmpeg');
      expect(ffmpeg?.operationStatus).toMatchObject({
        backendKind: 'system-package-manager',
        backend: 'brew',
        packageName: 'ffmpeg',
        installedVersion: '7.1.1',
        latestVersion: '8.0',
        availableOperations: ['update', 'uninstall']
      });
      expect(JSON.stringify(ffmpeg?.operationStatus)).not.toContain('brew upgrade');
    });

    it('marks remove-ai-watermarks ready and parses its version', async () => {
      const processAdapter = createMemoryIntegrationProcessAdapter({
        binaries: {
          'remove-ai-watermarks': { stdout: 'remove-ai-watermarks, version 0.5.4' }
        },
        executables: ['uv']
      });
      const service = new IntegrationsService({
        envPath: 'C:\\integration-bin',
        cacheTtlMs: 0,
        platform: 'darwin',
        processAdapter
      });
      const view = await service.listStatus();
      const integration = view.integrations.find((entry) => entry.integrationId === 'remove-ai-watermarks');
      expect(view.backends).toContainEqual({ kind: 'python-cli-installer', backend: 'uv', available: true });
      expect(integration?.status).toBe('ready');
      expect(integration?.binaries[0]?.version).toBe('0.5.4');
      expect(integration?.operationStatus).toMatchObject({
        backendKind: 'python-cli-installer',
        backend: 'uv',
        packageName: 'remove-ai-watermarks',
        availableOperations: ['update', 'uninstall']
      });
      expect(integration?.operationStatus?.latestVersion).toBeUndefined();
    });

    it('exposes remove-ai-watermarks install availability through uv when missing', async () => {
      const processAdapter = createMemoryIntegrationProcessAdapter({
        binaries: {},
        executables: ['uv']
      });
      const service = new IntegrationsService({
        envPath: 'C:\\integration-bin',
        cacheTtlMs: 0,
        platform: 'darwin',
        processAdapter
      });
      const view = await service.listStatus();
      const integration = view.integrations.find((entry) => entry.integrationId === 'remove-ai-watermarks');
      expect(integration?.status).toBe('not_found');
      expect(integration?.operationStatus).toMatchObject({
        backendKind: 'python-cli-installer',
        backend: 'uv',
        availableOperations: ['install']
      });
    });

    it('does not expose command previews for integration operations', async () => {
      const processAdapter = createMemoryIntegrationProcessAdapter({
        binaries: {},
        executables: ['brew'],
        runCommand: async () => commandResult({ stdout: brewInstallQueryOutput() })
      });
      const service = new IntegrationsService({
        envPath: 'C:\\integration-bin',
        cacheTtlMs: 0,
        platform: 'darwin',
        processAdapter
      });
      const view = await service.rescan();
      const imagemagick = view.integrations.find((integration) => integration.integrationId === 'imagemagick');
      expect(imagemagick?.operationStatus).toMatchObject({
        availableOperations: ['install']
      });
      expect(JSON.stringify(imagemagick?.operationStatus)).not.toContain('brew install');
    });

    it('runs an install operation and returns a rescanned settings view', async () => {
      const binaries: Record<string, {
        stdout: string;
      }> = {};
      const commands: string[] = [];
      const processAdapter = createMemoryIntegrationProcessAdapter({
        binaries,
        executables: ['brew'],
        runCommand: async (_file, args) => {
          commands.push(args.join(' '));
          if (args[0] === 'install') {
            binaries.magick = { stdout: 'Version: ImageMagick 7.1.2-23' };
            return commandResult();
          }
          return commandResult({ stdout: brewInstallQueryOutput() });
        }
      });
      const service = new IntegrationsService({
        envPath: 'C:\\integration-bin',
        cacheTtlMs: 0,
        platform: 'darwin',
        processAdapter
      });
      const result = await service.runOperation({ integrationId: 'imagemagick', operation: 'install' });
      expect(result.ok).toBe(true);
      expect(commands).toContain('install --formula imagemagick');
      expect(result.settings.runningOperation).toBeUndefined();
      expect(result.settings.integrations.find((integration) => integration.integrationId === 'imagemagick')?.status).toBe('ready');
    });

    it('returns bounded diagnostics and fresh settings when an operation fails', async () => {
      const processAdapter = createMemoryIntegrationProcessAdapter({
        binaries: {},
        executables: ['brew'],
        runCommand: async (_file, args) => args[0] === 'install'
          ? commandResult({ ok: false, exitCode: 9, stderr: 'install exploded' })
          : commandResult({ stdout: brewInstallQueryOutput() })
      });
      const service = new IntegrationsService({
        envPath: 'C:\\integration-bin',
        cacheTtlMs: 0,
        platform: 'darwin',
        processAdapter
      });
      const result = await service.runOperation({ integrationId: 'imagemagick', operation: 'install' });
      expect(result).toMatchObject({
        ok: false,
        integrationId: 'imagemagick',
        operation: 'install',
        diagnostic: {
          exitCode: 9,
          errorKind: 'nonzero_exit',
          stderrTail: expect.stringContaining('install exploded')
        }
      });
      expect(JSON.stringify(result.diagnostic)).not.toContain('brew install');
      expect(result.settings.integrations.find((integration) => integration.integrationId === 'imagemagick')?.status).toBe('not_found');
    });

    it('rejects a second operation while one is running', async () => {
      const commands: string[] = [];
      const processAdapter = createMemoryIntegrationProcessAdapter({
        binaries: {},
        executables: ['brew'],
        runCommand: async (_file, args) => {
          commands.push(args.join(' '));
          return args[0] === 'info'
            ? commandResult({ stdout: brewInstallQueryOutput() })
            : commandResult();
        }
      });
      const service = new IntegrationsService({
        envPath: 'C:\\integration-bin',
        cacheTtlMs: 0,
        platform: 'darwin',
        processAdapter
      });
      let resolveStarted: (() => void) | undefined;
      let releaseStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        resolveStarted = resolve;
      });
      const operationMayStart = new Promise<void>((resolve) => {
        releaseStarted = resolve;
      });
      const first = service.runOperation({ integrationId: 'imagemagick', operation: 'install' }, {
        onStarted: () => {
          resolveStarted?.();
          return operationMayStart;
        }
      });
      await started;
      const second = await service.runOperation({ integrationId: 'imagemagick', operation: 'install' });
      releaseStarted?.();
      const firstResult = await first;
      expect(second).toMatchObject({
        ok: false,
        diagnostic: { errorKind: 'operation_already_running' },
        settings: {
          runningOperation: { integrationId: 'imagemagick', operation: 'install' }
        }
      });
      expect(firstResult.ok).toBe(true);
      expect(commands.filter((command) => command === 'install --formula imagemagick')).toHaveLength(1);
    });

    it('rejects concurrent attempts while the first operation is still validating', async () => {
      const binaries: Record<string, {
        stdout: string;
      }> = {};
      const commands: string[] = [];
      const processAdapter = createMemoryIntegrationProcessAdapter({
        binaries,
        executables: ['brew'],
        runCommand: async (_file, args) => {
          commands.push(args.join(' '));
          if (args[0] === 'install') {
            binaries.magick = { stdout: 'Version: ImageMagick 7.1.2-23' };
            return commandResult();
          }
          return commandResult({ stdout: brewInstallQueryOutput() });
        }
      });
      const service = new IntegrationsService({
        envPath: 'C:\\integration-bin',
        cacheTtlMs: 0,
        platform: 'darwin',
        processAdapter
      });
      const first = service.runOperation({ integrationId: 'imagemagick', operation: 'install' });
      const second = await service.runOperation({ integrationId: 'imagemagick', operation: 'install' });
      const firstResult = await first;
      expect(second).toMatchObject({
        ok: false,
        diagnostic: { errorKind: 'operation_already_running' }
      });
      expect(second.settings.integrations).not.toHaveLength(0);
      expect(firstResult.ok).toBe(true);
      expect(commands.filter((command) => command === 'install --formula imagemagick')).toHaveLength(1);
    });

    it('does not enter running state for an unavailable operation', async () => {
      const processAdapter = createMemoryIntegrationProcessAdapter({
        binaries: {},
        executables: ['brew'],
        runCommand: async () => commandResult({ stdout: brewInstallQueryOutput() })
      });
      const service = new IntegrationsService({
        envPath: 'C:\\integration-bin',
        cacheTtlMs: 0,
        platform: 'darwin',
        processAdapter
      });
      const startedSettings: unknown[] = [];
      const settledSettings: unknown[] = [];
      const result = await service.runOperation({ integrationId: 'imagemagick', operation: 'uninstall' }, {
        onStarted: (settings) => {
          startedSettings.push(settings);
        },
        onSettled: (settings) => {
          settledSettings.push(settings);
        }
      });
      expect(result).toMatchObject({
        ok: false,
        diagnostic: { errorKind: 'operation_unavailable' }
      });
      expect(result.settings.runningOperation).toBeUndefined();
      expect(result.settings.integrations).not.toHaveLength(0);
      expect(startedSettings).toEqual([]);
      expect(settledSettings).toEqual([]);
    });

    it('clears running state when the started callback fails', async () => {
      const processAdapter = createMemoryIntegrationProcessAdapter({
        binaries: {},
        executables: ['brew'],
        runCommand: async () => commandResult({ stdout: brewInstallQueryOutput() })
      });
      const service = new IntegrationsService({
        envPath: 'C:\\integration-bin',
        cacheTtlMs: 30000,
        platform: 'darwin',
        processAdapter
      });
      await expect(service.runOperation({ integrationId: 'imagemagick', operation: 'install' }, {
        onStarted: () => {
          throw new Error('emit failed');
        }
      })).rejects.toThrow('emit failed');
      await expect(service.listStatus()).resolves.not.toHaveProperty('runningOperation');
    });
  });
});
function createMemoryIntegrationProcessAdapter(input: {
  binaries: Record<string, {
    stdout: string;
    stderr?: string;
    exitCode?: number;
  }>;
  executables?: string[];
  runCommand?: (file: string, args: string[]) => Promise<{
    ok: boolean;
    stdout: string;
    stderr: string;
    diagnostic: {
      exitCode?: number;
      errorKind?: 'nonzero_exit';
      stderrTail?: string;
    };
  }>;
}) {
  return {
    resolveExecutable: async (name: string) => input.binaries[name] || input.executables?.includes(name)
      ? `C:\\integration-bin\\${name}.EXE`
      : undefined,
    runProbe: async (file: string) => {
      const name = file.split(/[\\/]/).at(-1)?.replace(/\.EXE$/i, '') ?? '';
      const binary = input.binaries[name];
      if (!binary) {
        return { ok: false, stdout: '', stderr: 'missing', errorKind: 'spawn_error' as const };
      }
      const exitCode = binary.exitCode ?? 0;
      return {
        ok: exitCode === 0,
        stdout: binary.stdout,
        stderr: binary.stderr ?? '',
        exitCode,
        ...(exitCode === 0 ? {} : { errorKind: 'nonzero_exit' as const })
      };
    },
    runCommand: async (command: {
      file: string;
      args: string[];
    }) => input.runCommand
        ? input.runCommand(command.file, command.args)
        : { ok: true, stdout: '', stderr: '', diagnostic: { exitCode: 0 } }
  };
}
function commandResult(input: {
  ok?: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
} = {}) {
  const ok = input.ok ?? true;
  const stdout = input.stdout ?? '';
  const stderr = input.stderr ?? '';
  const exitCode = input.exitCode ?? (ok ? 0 : 1);
  return {
    ok,
    stdout,
    stderr,
    diagnostic: {
      exitCode,
      ...(ok ? {} : { errorKind: 'nonzero_exit' as const }),
      ...(stderr ? { stderrTail: stderr } : {})
    }
  };
}
function brewInstallQueryOutput(): string {
  return JSON.stringify({
    formulae: [{ name: 'imagemagick', versions: { stable: '7.1.2-23' }, installed: [] }],
    casks: []
  });
}
