import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Workbench global preferences event contract', () => {
  it('keeps global Workbench events independent from project event streams', () => {
    const daemon = source('apps/daemon/src/http/createDebruteDaemonHttpServer.ts');

    expect(daemon).toContain("path === '/api/workbench/events'");
    expect(daemon).toContain('function writeGlobalWorkbenchEventStream');
    expect(daemon).toContain('function writeEventStream');

    const projectStream = sliceBetween(daemon, 'function writeEventStream', 'async function serveWebAsset');
    expect(projectStream).not.toContain('globalRuntime.onEvent');
    expect(projectStream).not.toContain('workbench.preferences.changed');
  });

  it('keeps the web client on global and project event sources without storage sync', () => {
    const client = source('apps/web/src/api/httpWorkbenchApiClient.ts');

    expect(client).toContain('globalEventSource');
    expect(client).toContain('projectEventSource');
    expect(client).toContain('/api/workbench/events');
    expect(client).toContain("projectPath('/events')");
    expect(client).not.toContain('BroadcastChannel');
    expect(client).not.toContain("addEventListener('storage'");
    expect(client).not.toContain('workbenchPreferencesLocalStorage');
  });

  it('does not add Electron preference mirror APIs', () => {
    const shellApi = source('apps/web/src/api/shellApi.ts');
    const preload = source('apps/desktop/src/electron/preload.ts');

    expect(shellApi).not.toContain('workbenchPreferencesSave');
    expect(shellApi).not.toContain('onWorkbenchPreferencesChanged');
    expect(preload).not.toContain('workbenchPreferencesSave');
    expect(preload).not.toContain('onWorkbenchPreferencesChanged');
  });
});

function source(path: string): string {
  return readFileSync(path, 'utf8');
}

function sliceBetween(sourceText: string, start: string, end: string): string {
  const startIndex = sourceText.indexOf(start);
  const endIndex = sourceText.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return sourceText.slice(startIndex, endIndex);
}
