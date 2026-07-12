import { chmod, mkdtempDisposable, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWorkbenchLaunchUrl } from '@debrute/workbench-runtime';
import type { RunIntegrationOperationResult, WorkbenchProjectOpenResult, WorkbenchTitleBarState } from '@debrute/app-protocol';
import { DaemonTestHarness } from '../../../helpers/daemonTestHarness.js';

describe('daemon Workbench HTTP routes', () => {
  it('accepts a single-port Workbench web session cookie without exposing the daemon token to the browser', async () => {
    await using harness = await DaemonTestHarness.create();
    const runtime = harness.runtime;
    const { rootPath: projectRoot } = await harness.createProject();
    await writeFile(join(projectRoot, 'brief.md'), '# Brief', 'utf8');
    const launchUrl = createWorkbenchLaunchUrl({
      webUrl: runtime.daemonUrl,
      token: runtime.token,
      next: '/projects/project-1'
    });
    const launch = await fetch(launchUrl, { redirect: 'manual' });
    const cookie = launch.headers.get('set-cookie');
    expect(launch.status).toBe(303);
    expect(launch.headers.get('location')).toBe('/projects/project-1');
    expect(cookie).toContain('debrute_web_session=');
    expect(cookie).not.toContain('test-token');
    const openedResponse = await fetch(`${runtime.daemonUrl}/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: cookie!
      },
      body: JSON.stringify({ projectRoot })
    });
    expect(openedResponse.status).toBe(200);
    const opened = await openedResponse.json() as WorkbenchProjectOpenResult;
    expect(opened.projectId).toBeTruthy();
    expect(JSON.stringify(opened)).not.toContain('test-token');
  });

  it('does not accept daemon tokens in old browser query strings', async () => {
    await using harness = await DaemonTestHarness.create();
    const runtime = harness.runtime;
    const url = new URL('/api/runtime/product', runtime.daemonUrl);
    url.searchParams.set('debrute-token', 'test-token');
    const response = await fetch(url);
    expect(response.status).toBe(403);
  });

  it('returns an API 404 for removed browser-session routes after authentication', async () => {
    await using harness = await DaemonTestHarness.create();
    const response = await harness.fetchJson<Record<string, unknown>>('/api/browser-session');
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      error: {
        code: 'not_found',
        message: 'Unknown Debrute API route: /api/browser-session'
      }
    });
  });

  it('runs integration operations through the global integrations HTTP route', async () => {
    await using binDirectory = await mkdtempDisposable(join(tmpdir(), 'debrute-daemon-integrations-operation-bin-'));
    const binDir = binDirectory.path;
    if (process.platform === 'darwin') {
      await writeDarwinBrewFixture(binDir);
    }
    await using harness = await DaemonTestHarness.create({
      appServerOptions: {
        integrationEnvPath: binDir
      }
    });
    const result = await harness.fetchOkJson<RunIntegrationOperationResult>('/api/integrations/imagemagick/install', {
      method: 'POST',
      headers: { 'x-debrute-daemon-token': 'test-token' }
    });
    expect(result).toMatchObject({
      integrationId: 'imagemagick',
      operation: 'install'
    });
    expect(result.settings.runningOperation).toBeUndefined();
    if (process.platform === 'darwin') {
      expect(result.ok).toBe(true);
      expect(result.settings.integrations.find((integration) => integration.integrationId === 'imagemagick')?.status).toBe('ready');
    } else {
      expect(result).toMatchObject({
        ok: false,
        diagnostic: { errorKind: 'backend_unavailable' }
      });
      expect(result.settings.backends.find((backend) => backend.kind === 'system-package-manager'))
        .toMatchObject({ available: false });
    }
    const invalidId = await harness.fetchJson('/api/integrations/unknown/install', {
      method: 'POST'
    });
    expect(invalidId.status).toBe(404);
    const invalidOperation = await harness.fetchJson('/api/integrations/imagemagick/preview', {
      method: 'POST'
    });
    expect(invalidOperation.status).toBe(404);
  });

  it('serves Workbench title-bar state from runtime chrome state', async () => {
    await using harness = await DaemonTestHarness.create();
    const runtime = harness.runtime;
    const { rootPath: projectRoot } = await harness.createProject({ 'brief.md': '# Brief' });
    const opened = await harness.fetchOkJson<WorkbenchProjectOpenResult>(`/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': runtime.token
      },
      body: JSON.stringify({ projectRoot })
    });
    const titleBar = await harness.fetchOkJson<WorkbenchTitleBarState>(`/api/workbench/title-bar?host=desktop&projectId=${opened.projectId}`, { headers: { 'x-debrute-daemon-token': runtime.token } });
    expect(titleBar.title).toBe(opened.snapshot.metadata.project.name);
    expect(titleBar.recentProjectRoots).toEqual([await realpath(projectRoot)]);
    expect(titleBar.menus.map((menu) => menu.label)).toEqual(['File', 'Edit', 'View']);
  });

  it('rejects invalid Workbench title-bar host values', async () => {
    await using harness = await DaemonTestHarness.create();
    const response = await harness.fetchJson<Record<string, unknown>>('/api/workbench/title-bar?host=mobile');
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: 'invalid_input' }
    });
  });

  it('clears runtime recent projects through the Workbench chrome route', async () => {
    await using harness = await DaemonTestHarness.create();
    const response = await harness.fetchJson('/api/workbench/recent-projects', {
      method: 'DELETE'
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });
});

async function writeDarwinBrewFixture(binDir: string): Promise<void> {
  const magickSource = [
    '#!/usr/bin/env node',
    "process.stdout.write('Version: ImageMagick 7.1.2-23\\n');",
    ''
  ].join('\n');
  const brewSource = [
    '#!/usr/bin/env node',
    "const { chmodSync, writeFileSync } = require('node:fs');",
    "const { join } = require('node:path');",
    `const magickSource = ${JSON.stringify(magickSource)};`,
    "const command = process.argv[2] ?? '';",
    "if (command === 'info') {",
    "  process.stdout.write('{\"formulae\":[{\"name\":\"imagemagick\",\"versions\":{\"stable\":\"7.1.2-23\"},\"installed\":[]}],\"casks\":[]}\\n');",
    "} else if (command === 'install') {",
    "  const magickPath = join(__dirname, 'magick');",
    '  writeFileSync(magickPath, magickSource);',
    '  chmodSync(magickPath, 0o755);',
    "} else if (command === 'outdated') {",
    "  process.stdout.write('{\"formulae\":[],\"casks\":[]}\\n');",
    '}',
    ''
  ].join('\n');
  const brewPath = join(binDir, 'brew');
  await writeFile(brewPath, brewSource, 'utf8');
  await chmod(brewPath, 0o755);
}
