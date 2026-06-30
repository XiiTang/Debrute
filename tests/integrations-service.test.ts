import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { IntegrationsService } from '../apps/app-server/src/integrations/IntegrationsService';

const INTEGRATION_SCAN_TEST_TIMEOUT_MS = 20_000;

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
    const binDir = await mkdtemp(join(tmpdir(), 'debrute-integrations-media-ready-'));
    await writeFakeBinary(binDir, 'ffmpeg', 'ffmpeg version 7.1.1');
    await writeFakeBinary(binDir, 'ffprobe', 'ffprobe version 7.1.1');
    const service = new IntegrationsService({ envPath: binDir, cacheTtlMs: 0 });

    const view = await service.listStatus();
    const ffmpeg = view.integrations.find((integration) => integration.integrationId === 'ffmpeg');

    expect(ffmpeg?.status).toBe('ready');
    expect(ffmpeg?.summary).toBe('Ready.');
    expect(ffmpeg?.binaries.map((binary) => binary.version)).toEqual(['7.1.1', '7.1.1']);
    expect(ffmpeg?.binaries.some((binary) => 'path' in binary)).toBe(false);
  }, INTEGRATION_SCAN_TEST_TIMEOUT_MS);

  it('parses ImageMagick and Windows PATHEXT probe versions', async () => {
    const macDir = await mkdtemp(join(tmpdir(), 'debrute-integrations-imagemagick-ready-'));
    await writeFakeBinary(macDir, 'magick', 'Version: ImageMagick 7.0.0');
    const macService = new IntegrationsService({ envPath: macDir, cacheTtlMs: 0 });
    const macView = await macService.listStatus();

    const winDir = await mkdtemp(join(tmpdir(), 'debrute-integrations-windows-'));
    await writeFakeBinary(winDir, 'mediainfo.EXE', 'MediaInfo Command line, MediaInfoLib - v24.12');
    const winService = new IntegrationsService({
      envPath: winDir,
      cacheTtlMs: 0,
      platform: 'win32',
      pathExt: '.EXE'
    });
    const winView = await winService.listStatus();

    expect(macView.integrations.find((integration) => integration.integrationId === 'imagemagick')?.binaries[0]?.version).toBe('7.0.0');
    expect(winView.integrations.find((integration) => integration.integrationId === 'mediainfo')?.binaries[0]?.version).toBe('24.12');
  }, INTEGRATION_SCAN_TEST_TIMEOUT_MS);

  it('reports probe_failed for nonzero probes without exposing command previews', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'debrute-integrations-nonzero-'));
    await writeFakeBinary(binDir, 'mediainfo', 'broken', { exitCode: 2, stderr: 'cannot load library' });
    const service = new IntegrationsService({ envPath: binDir, cacheTtlMs: 0 });

    const view = await service.listStatus();
    const mediainfo = view.integrations.find((integration) => integration.integrationId === 'mediainfo');

    expect(mediainfo?.status).toBe('probe_failed');
    expect(mediainfo?.summary).toBe('mediainfo probe failed.');
    expect(mediainfo?.binaries[0]?.probe).toMatchObject({
      exitCode: 2,
      errorKind: 'nonzero_exit',
      stderrTail: expect.stringContaining('cannot load library')
    });
  }, INTEGRATION_SCAN_TEST_TIMEOUT_MS);

  it('exposes install availability for missing media integrations when the system package manager is present', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'debrute-integrations-install-available-'));
    await writeFakePackageManager(binDir, 'brew', [
      'if [ "$1" = "info" ]; then',
      '  printf \'{"formulae":[{"name":"imagemagick","versions":{"stable":"7.1.2-23"},"installed":[]}],"casks":[]}\\n\'',
      'fi'
    ].join('\n'));
    const service = new IntegrationsService({ envPath: binDir, cacheTtlMs: 0, platform: 'darwin' });

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
  }, INTEGRATION_SCAN_TEST_TIMEOUT_MS);

  it('exposes update availability for ready media integrations when a newer package version exists', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'debrute-integrations-update-available-'));
    await writeFakeBinary(binDir, 'ffmpeg', 'ffmpeg version 7.1.1');
    await writeFakeBinary(binDir, 'ffprobe', 'ffprobe version 7.1.1');
    await writeFakePackageManager(binDir, 'brew', [
      'if [ "$1" = "outdated" ]; then',
      '  printf \'{"formulae":[{"name":"ffmpeg","installed_versions":["7.1.1"],"current_version":"8.0"}],"casks":[]}\\n\'',
      'fi'
    ].join('\n'));
    const service = new IntegrationsService({ envPath: binDir, cacheTtlMs: 0, platform: 'darwin' });

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
  }, INTEGRATION_SCAN_TEST_TIMEOUT_MS);

  it('marks remove-ai-watermarks ready and parses its version', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'debrute-integrations-raiw-ready-'));
    await writeFakeBinary(binDir, 'remove-ai-watermarks', 'remove-ai-watermarks, version 0.5.4');
    await writeFakeBinary(binDir, 'uv', 'uv 0.9.0');
    const service = new IntegrationsService({ envPath: binDir, cacheTtlMs: 0, platform: 'darwin' });

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
    const binDir = await mkdtemp(join(tmpdir(), 'debrute-integrations-raiw-install-'));
    await writeFakeBinary(binDir, 'uv', 'uv 0.9.0');
    const service = new IntegrationsService({ envPath: binDir, cacheTtlMs: 0, platform: 'darwin' });

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
    const binDir = await mkdtemp(join(tmpdir(), 'debrute-integrations-preview-only-'));
    await writeFakePackageManager(binDir, 'brew', [
      'if [ "$1" = "info" ]; then',
      '  printf \'{"formulae":[{"name":"imagemagick","versions":{"stable":"7.1.2-23"},"installed":[]}],"casks":[]}\\n\'',
      'fi'
    ].join('\n'));
    const service = new IntegrationsService({ envPath: binDir, cacheTtlMs: 0, platform: 'darwin' });

    const view = await service.rescan();
    const imagemagick = view.integrations.find((integration) => integration.integrationId === 'imagemagick');

    expect(imagemagick?.operationStatus).toMatchObject({
      availableOperations: ['install']
    });
    expect(JSON.stringify(imagemagick?.operationStatus)).not.toContain('brew install');
  }, 15_000);

  it('runs an install operation and returns a rescanned settings view', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'debrute-integrations-run-install-'));
    const logPath = join(binDir, 'brew.log');
    const magickPath = join(binDir, 'magick');
    await writeFakePackageManager(binDir, 'brew', [
      `printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}`,
      'if [ "$1" = "info" ]; then',
      '  printf \'{"formulae":[{"name":"imagemagick","versions":{"stable":"7.1.2-23"},"installed":[]}],"casks":[]}\\n\'',
      'fi',
      'if [ "$1" = "install" ]; then',
      `  printf '%s\\n' '#!/bin/sh' 'printf "Version: ImageMagick 7.1.2-23\\n"' > ${JSON.stringify(magickPath)}`,
      `  chmod +x ${JSON.stringify(magickPath)}`,
      'fi'
    ].join('\n'));
    const service = new IntegrationsService({ envPath: binDir, cacheTtlMs: 0, platform: 'darwin' });

    const result = await service.runOperation({ integrationId: 'imagemagick', operation: 'install' });

    expect(result.ok).toBe(true);
    expect(await readFile(logPath, 'utf8')).toContain('install --formula imagemagick');
    expect(result.settings.runningOperation).toBeUndefined();
    expect(result.settings.integrations.find((integration) => integration.integrationId === 'imagemagick')?.status).toBe('ready');
  }, INTEGRATION_SCAN_TEST_TIMEOUT_MS);

  it('returns bounded diagnostics and fresh settings when an operation fails', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'debrute-integrations-run-fail-'));
    await writeFakePackageManager(binDir, 'brew', [
      'if [ "$1" = "info" ]; then',
      '  printf \'{"formulae":[{"name":"imagemagick","versions":{"stable":"7.1.2-23"},"installed":[]}],"casks":[]}\\n\'',
      'fi',
      'if [ "$1" = "install" ]; then',
      '  printf "install exploded\\n" >&2',
      '  exit 9',
      'fi'
    ].join('\n'));
    const service = new IntegrationsService({ envPath: binDir, cacheTtlMs: 0, platform: 'darwin' });

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
  }, INTEGRATION_SCAN_TEST_TIMEOUT_MS);

  it('rejects a second operation while one is running', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'debrute-integrations-run-lock-'));
    const logPath = join(binDir, 'brew.log');
    await writeFakePackageManager(binDir, 'brew', [
      `printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}`,
      'if [ "$1" = "info" ]; then',
      '  printf \'{"formulae":[{"name":"imagemagick","versions":{"stable":"7.1.2-23"},"installed":[]}],"casks":[]}\\n\'',
      'fi',
      'if [ "$1" = "install" ]; then',
      '  sleep 1',
      'fi'
    ].join('\n'));
    const service = new IntegrationsService({ envPath: binDir, cacheTtlMs: 0, platform: 'darwin' });
    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });

    const first = service.runOperation(
      { integrationId: 'imagemagick', operation: 'install' },
      { onStarted: () => resolveStarted?.() }
    );
    await started;
    const second = await service.runOperation({ integrationId: 'imagemagick', operation: 'install' });
    const firstResult = await first;

    expect(second).toMatchObject({
      ok: false,
      diagnostic: { errorKind: 'operation_already_running' },
      settings: {
        runningOperation: { integrationId: 'imagemagick', operation: 'install' }
      }
    });
    expect(firstResult.ok).toBe(true);
    expect((await readFile(logPath, 'utf8')).match(/install --formula imagemagick/g)?.length).toBe(1);
  }, INTEGRATION_SCAN_TEST_TIMEOUT_MS);

  it('rejects concurrent attempts while the first operation is still validating', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'debrute-integrations-run-validation-lock-'));
    const logPath = join(binDir, 'brew.log');
    const magickPath = join(binDir, 'magick');
    await writeFakePackageManager(binDir, 'brew', [
      `printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}`,
      'if [ "$1" = "info" ]; then',
      '  sleep 1',
      '  printf \'{"formulae":[{"name":"imagemagick","versions":{"stable":"7.1.2-23"},"installed":[]}],"casks":[]}\\n\'',
      'fi',
      'if [ "$1" = "install" ]; then',
      `  printf '%s\\n' '#!/bin/sh' 'printf "Version: ImageMagick 7.1.2-23\\n"' > ${JSON.stringify(magickPath)}`,
      `  chmod +x ${JSON.stringify(magickPath)}`,
      'fi'
    ].join('\n'));
    const service = new IntegrationsService({ envPath: binDir, cacheTtlMs: 0, platform: 'darwin' });

    const first = service.runOperation({ integrationId: 'imagemagick', operation: 'install' });
    const second = await service.runOperation({ integrationId: 'imagemagick', operation: 'install' });
    const firstResult = await first;

    expect(second).toMatchObject({
      ok: false,
      diagnostic: { errorKind: 'operation_already_running' }
    });
    expect(second.settings.integrations).not.toHaveLength(0);
    expect(firstResult.ok).toBe(true);
    expect((await readFile(logPath, 'utf8')).match(/install --formula imagemagick/g)?.length).toBe(1);
  }, INTEGRATION_SCAN_TEST_TIMEOUT_MS);

  it('does not enter running state for an unavailable operation', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'debrute-integrations-unavailable-operation-'));
    await writeFakePackageManager(binDir, 'brew', [
      'if [ "$1" = "info" ]; then',
      '  printf \'{"formulae":[{"name":"imagemagick","versions":{"stable":"7.1.2-23"},"installed":[]}],"casks":[]}\\n\'',
      'fi'
    ].join('\n'));
    const service = new IntegrationsService({ envPath: binDir, cacheTtlMs: 0, platform: 'darwin' });
    const startedSettings: unknown[] = [];
    const settledSettings: unknown[] = [];

    const result = await service.runOperation(
      { integrationId: 'imagemagick', operation: 'uninstall' },
      {
        onStarted: (settings) => startedSettings.push(settings),
        onSettled: (settings) => settledSettings.push(settings)
      }
    );

    expect(result).toMatchObject({
      ok: false,
      diagnostic: { errorKind: 'operation_unavailable' }
    });
    expect(result.settings.runningOperation).toBeUndefined();
    expect(result.settings.integrations).not.toHaveLength(0);
    expect(startedSettings).toEqual([]);
    expect(settledSettings).toEqual([]);
  }, INTEGRATION_SCAN_TEST_TIMEOUT_MS);

  it('clears running state when the started callback fails', async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'debrute-integrations-start-callback-fail-'));
    await writeFakePackageManager(binDir, 'brew', [
      'if [ "$1" = "info" ]; then',
      '  printf \'{"formulae":[{"name":"imagemagick","versions":{"stable":"7.1.2-23"},"installed":[]}],"casks":[]}\\n\'',
      'fi'
    ].join('\n'));
    const service = new IntegrationsService({ envPath: binDir, cacheTtlMs: 30_000, platform: 'darwin' });

    await expect(service.runOperation(
      { integrationId: 'imagemagick', operation: 'install' },
      {
        onStarted: () => {
          throw new Error('emit failed');
        }
      }
    )).rejects.toThrow('emit failed');

    await expect(service.listStatus()).resolves.not.toHaveProperty('runningOperation');
  }, INTEGRATION_SCAN_TEST_TIMEOUT_MS);
});

async function writeFakeBinary(
  dir: string,
  name: string,
  stdout: string,
  options: { exitCode?: number; stderr?: string } = {}
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  const script = [
    '#!/bin/sh',
    options.stderr ? `printf '%s\\n' ${JSON.stringify(options.stderr)} >&2` : '',
    `printf '%s\\n' ${JSON.stringify(stdout)}`,
    `exit ${options.exitCode ?? 0}`
  ].filter(Boolean).join('\n');
  await writeFile(path, script, 'utf8');
  await chmod(path, 0o755);
  return path;
}

async function writeFakePackageManager(dir: string, name: string, body: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, ['#!/bin/sh', body].join('\n'), 'utf8');
  await chmod(path, 0o755);
  return path;
}
