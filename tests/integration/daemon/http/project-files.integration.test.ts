import { mkdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { DebruteAppServer } from '@debrute/app-server';
import type { AppServerEvent, WorkbenchProjectPickerOpenResult } from '@debrute/app-protocol';
import { projectFileRevision } from '@debrute/project-core';
import {
  createDaemonProjectSnapshotFixture,
  DaemonTestHarness,
  readDaemonSseEvent
} from '../../../helpers/daemonTestHarness.js';

describe('daemon project file HTTP routes', () => {
  it('protects the project picker open route with token and method checks', async () => {
    const nativeShell = nativeShellFixture(async () => undefined);
    await using harness = await DaemonTestHarness.create({
      nativeShell
    });
    const runtime = harness.runtime;
    const tokenless = await fetch(`${runtime.daemonUrl}/api/projects/open-picker`, {
      method: 'POST'
    });
    expect(tokenless.status).toBe(403);
    expect(nativeShell.chooseDirectory).not.toHaveBeenCalled();
    const wrongMethod = await harness.fetchJson<{
      error: {
        code: string;
      };
    }>('/api/projects/open-picker');
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.body).toMatchObject({
      error: { code: 'method_not_allowed' }
    });
  });

  it('returns a quiet cancel result when the native picker is canceled', async () => {
    const nativeShell = nativeShellFixture(async () => undefined);
    await using harness = await DaemonTestHarness.create({
      nativeShell
    });
    const runtime = harness.runtime;
    const result = await harness.fetchOkJson<WorkbenchProjectPickerOpenResult>(`/api/projects/open-picker`, {
      method: 'POST',
      headers: { 'x-debrute-daemon-token': runtime.token }
    });
    expect(result).toEqual({ opened: false });
  });

  it('opens picker-selected directories without exposing projectRoot in the response', async () => {
    let selectedPath: string | undefined;
    const nativeShell = nativeShellFixture(async () => selectedPath);
    await using harness = await DaemonTestHarness.create({ nativeShell });
    const runtime = harness.runtime;
    const { rootPath: projectRoot } = await harness.createProject({ 'brief.md': '# Brief' });
    selectedPath = projectRoot;
    const result = await harness.fetchOkJson<WorkbenchProjectPickerOpenResult>(`/api/projects/open-picker`, {
      method: 'POST',
      headers: { 'x-debrute-daemon-token': runtime.token }
    });
    expect(result).toMatchObject({
      opened: true,
      projectRevision: 1,
      snapshot: {
        files: expect.arrayContaining([{ projectRelativePath: 'brief.md', kind: 'file' }])
      }
    });
    expect(result.opened && result.projectId).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain(projectRoot);
    expect(JSON.stringify(result)).not.toContain('projectRoot');
    expect(harness.projectRootForProjectId(result.opened ? result.projectId : '')).toBe(await realpath(projectRoot));
  });

  it('rejects picker-selected paths that are not directories', async () => {
    let selectedPath: string | undefined;
    const nativeShell = nativeShellFixture(async () => selectedPath);
    await using harness = await DaemonTestHarness.create({ nativeShell });
    const { rootPath: projectRoot } = await harness.createProject({ 'brief.md': '# Brief' });
    selectedPath = join(projectRoot, 'brief.md');
    const response = await harness.fetchJson<Record<string, unknown>>('/api/projects/open-picker', {
      method: 'POST'
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: {
        code: 'invalid_input',
        message: 'projectRoot must resolve to a directory.'
      }
    });
  });

  it('rejects explicit project opens with non-absolute paths', async () => {
    await using harness = await DaemonTestHarness.create();
    const response = await harness.fetchJson<Record<string, unknown>>('/api/projects/open', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({ projectRoot: 'relative/project' })
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: {
        code: 'invalid_input',
        message: 'projectRoot must be an absolute local path.'
      }
    });
  });

  it('protects project read routes with the daemon token', async () => {
    await using harness = await DaemonTestHarness.create();
    const runtime = harness.runtime;
    const { rootPath: projectRoot } = await harness.createProject();
    await writeFile(join(projectRoot, 'brief.md'), '# Brief', 'utf8');
    const opened = await harness.fetchOkJson<{
      projectId: string;
      projectRevision: number;
    }>(`/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({ projectRoot })
    });
    const tokenlessText = await fetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/files/text/brief.md`);
    expect(tokenlessText.status).toBe(403);
    const authorizedText = await harness.fetchOkJson<{
      content: string;
    }>(`/api/projects/${opened.projectId}/files/text/brief.md`, {
      headers: { 'x-debrute-daemon-token': 'test-token' }
    });
    expect(authorizedText.content).toBe('# Brief');
    const tokenlessEvents = await fetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/events?clientId=security-test`);
    expect(tokenlessEvents.status).toBe(403);
    const authorizedEvents = await fetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/events?clientId=security-test`, {
      headers: { 'x-debrute-daemon-token': 'test-token' }
    });
    expect(authorizedEvents.status).toBe(200);
    await authorizedEvents.body?.cancel();
  });

  it('opens a project and exposes text file routes through HTTP', async () => {
    await using harness = await DaemonTestHarness.create();
    const runtime = harness.runtime;
    const { rootPath: projectRoot } = await harness.createProject();
    await mkdir(join(projectRoot, 'briefs'), { recursive: true });
    await writeFile(join(projectRoot, 'briefs/outline.md'), '# Outline', 'utf8');
    const opened = await harness.fetchOkJson<{
      projectId: string;
      projectRevision: number;
      snapshot: {
        files: Array<{
          projectRelativePath: string;
        }>;
      };
    }>(`/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({ projectRoot })
    });
    expect(JSON.stringify(opened)).not.toContain(projectRoot);
    expect(opened.projectId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(opened.projectId).not.toBe(Buffer.from(projectRoot, 'utf8').toString('base64url'));
    expect(opened.snapshot).not.toHaveProperty('projectRoot');
    expect(opened.snapshot.files.map((file) => file.projectRelativePath)).toContain('briefs/outline.md');
    const textFile = await harness.fetchOkJson<Record<string, unknown> & { revision: string }>(`/api/projects/${opened.projectId}/files/text/briefs/outline.md`);
    expect(textFile).toMatchObject({
      projectRelativePath: 'briefs/outline.md',
      content: '# Outline'
    });
    expect(textFile).not.toHaveProperty('absolutePath');
    expect(JSON.stringify(textFile)).not.toContain(projectRoot);
    const updated = await harness.fetchOkJson<{ projectRevision: number }>(`/api/projects/${opened.projectId}/files/text/briefs/outline.md`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({
        baseRevision: opened.projectRevision,
        content: '# Updated',
        expectedRevision: textFile.revision
      })
    });
    await expect(readFile(join(projectRoot, 'briefs/outline.md'), 'utf8')).resolves.toBe('# Updated');

    const staleResponse = await fetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/files/text/briefs/outline.md`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({
        baseRevision: updated.projectRevision,
        content: '# Stale overwrite',
        expectedRevision: textFile.revision
      })
    });
    expect(staleResponse.status).toBe(409);
    await expect(staleResponse.json()).resolves.toMatchObject({
      error: { code: 'project_file_revision_conflict' }
    });
    await expect(readFile(join(projectRoot, 'briefs/outline.md'), 'utf8')).resolves.toBe('# Updated');

    const missingRevisionResponse = await fetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/files/text/briefs/outline.md`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({ baseRevision: updated.projectRevision, content: '# Missing revision' })
    });
    expect(missingRevisionResponse.status).toBe(400);
    await expect(missingRevisionResponse.json()).resolves.toMatchObject({
      error: { code: 'invalid_input' }
    });
    const unscoped = await fetch(`${runtime.daemonUrl}/not-a-project/files/text/briefs/outline.md`);
    expect(unscoped.status).toBe(404);
  });

  it('returns project revisions on project open, live project listing, and mutation responses', async () => {
    await using harness = await DaemonTestHarness.create();
    const { rootPath: projectRoot } = await harness.createProject();
    await writeFile(join(projectRoot, 'brief.md'), '# Brief', 'utf8');
    const opened = await harness.fetchOkJson<{
      projectId: string;
      projectRevision: number;
    }>(`/api/projects/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ projectRoot })
    });
    expect(opened.projectRevision).toBe(1);
    await expect(harness.fetchOkJson(`/api/projects`)).resolves.toMatchObject({
      projects: [{ projectId: opened.projectId, projectRevision: 1 }]
    });
    const created = await harness.fetchOkJson<{
      projectRevision: number;
      snapshot: {
        files: unknown[];
      };
    }>(`/api/projects/${opened.projectId}/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({
        baseRevision: 1,
        kind: 'file',
        parentProjectRelativePath: '',
        name: 'next.md'
      })
    });
    expect(created.projectRevision).toBe(2);
    expect(created.snapshot.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ projectRelativePath: 'next.md' })
    ]));
  });

  it('rejects stale shared-state mutations with the current revision and snapshot', async () => {
    await using harness = await DaemonTestHarness.create();
    const { rootPath: projectRoot } = await harness.createProject();
    await writeFile(join(projectRoot, 'brief.md'), '# Brief', 'utf8');
    const opened = await harness.fetchOkJson<{
      projectId: string;
      projectRevision: number;
    }>(`/api/projects/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ projectRoot })
    });
    await harness.fetchOkJson(`/api/projects/${opened.projectId}/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({
        baseRevision: opened.projectRevision,
        kind: 'file',
        parentProjectRelativePath: '',
        name: 'first.md'
      })
    });
    const stale = await harness.fetchJson<Record<string, unknown>>(`/api/projects/${opened.projectId}/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseRevision: opened.projectRevision,
        kind: 'file',
        parentProjectRelativePath: '',
        name: 'second.md'
      })
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      error: {
        code: 'stale_project_revision',
        details: {
          projectId: opened.projectId,
          projectRevision: 2,
          snapshot: {
            files: expect.arrayContaining([
              expect.objectContaining({ projectRelativePath: 'first.md' })
            ])
          }
        }
      }
    });
  });

  it('refreshes after draining queued project changes without stale revision rejection', async () => {
    const listeners = new Set<(event: AppServerEvent) => void>();
    let projectRoot = '';
    let currentSnapshot = createDaemonProjectSnapshotFixture(projectRoot);
    const emitChanged = (files: Array<{
      projectRelativePath: string;
      kind: 'file';
    }>) => {
      currentSnapshot = {
        ...createDaemonProjectSnapshotFixture(projectRoot),
        files
      };
      for (const listener of listeners) {
        listener({ type: 'project.changed', snapshot: currentSnapshot });
      }
    };
    const appServer = {
      openProject: async (root: string) => {
        currentSnapshot = createDaemonProjectSnapshotFixture(root);
        return currentSnapshot;
      },
      getSnapshot: () => currentSnapshot,
      currentSnapshot: () => currentSnapshot,
      drainSessionOperations: async () => {
        emitChanged([{ projectRelativePath: 'external.md', kind: 'file' }]);
      },
      refreshProject: async () => {
        emitChanged([
          { projectRelativePath: 'external.md', kind: 'file' },
          { projectRelativePath: 'refreshed.md', kind: 'file' }
        ]);
        return currentSnapshot;
      },
      onEvent: (listener: (event: AppServerEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close: () => undefined
    } as unknown as DebruteAppServer;
    await using harness = await DaemonTestHarness.create({
      createAppServer: () => appServer
    });
    ({ rootPath: projectRoot } = await harness.createProject());
    currentSnapshot = createDaemonProjectSnapshotFixture(projectRoot);
    const opened = await harness.fetchOkJson<{
      projectId: string;
      projectRevision: number;
    }>(`/api/projects/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-debrute-daemon-token': 'test-token' },
      body: JSON.stringify({ projectRoot })
    });
    const response = await harness.fetchJson<{
      projectRevision: number;
      snapshot: {
        files: Array<{
          projectRelativePath: string;
        }>;
      };
    }>(`/api/projects/${opened.projectId}/refresh`, { method: 'POST' });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const refreshed = response.body;
    expect(refreshed.projectRevision).toBe(3);
    expect(refreshed.snapshot.files.map((file) => file.projectRelativePath)).toEqual([
      'external.md',
      'refreshed.md'
    ]);
  });

  it('rejects raw project file requests without a revision query', async () => {
    await using harness = await DaemonTestHarness.create();
    const { rootPath: projectRoot } = await harness.createProject();
    await mkdir(join(projectRoot, 'generated'), { recursive: true });
    await writeFile(join(projectRoot, 'generated/cover.png'), 'asset-bytes', 'utf8');
    const opened = await harness.fetchOkJson<{
      projectId: string;
      projectRevision: number;
    }>(`/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({ projectRoot })
    });
    const response = await harness.fetchJson<{
      error: {
        code: string;
      };
    }>(`/api/projects/${opened.projectId}/files/raw/generated/cover.png`);
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: 'missing_revision' }
    });
  });

  it('serves supported project image formats with registry content types', async () => {
    await using harness = await DaemonTestHarness.create();
    const { rootPath: projectRoot } = await harness.createProject();
    await mkdir(join(projectRoot, 'assets'), { recursive: true });
    await writeFile(join(projectRoot, 'assets/photo.jpe'), 'jpeg-bytes', 'utf8');
    await writeFile(join(projectRoot, 'assets/photo.jfif'), 'jpeg-bytes', 'utf8');
    await writeFile(join(projectRoot, 'assets/render.avif'), 'avif-bytes', 'utf8');
    await writeFile(join(projectRoot, 'assets/scan.tif'), 'tiff-bytes', 'utf8');
    await writeFile(join(projectRoot, 'assets/scan.tiff'), 'tiff-bytes', 'utf8');
    await writeFile(join(projectRoot, 'assets/icon.svgz'), 'svgz-bytes', 'utf8');
    await writeFile(join(projectRoot, 'assets/animated.gif'), 'gif-bytes', 'utf8');
    const opened = await harness.fetchOkJson<{
      projectId: string;
      projectRevision: number;
    }>(`/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({ projectRoot })
    });
    for (const [path, contentType] of [
      ['assets/photo.jpe', 'image/jpeg'],
      ['assets/photo.jfif', 'image/jpeg'],
      ['assets/render.avif', 'image/avif'],
      ['assets/scan.tif', 'image/tiff'],
      ['assets/scan.tiff', 'image/tiff'],
      ['assets/icon.svgz', 'image/svg+xml']
    ] as const) {
      const fileStat = await stat(join(projectRoot, path));
      const revision = projectFileRevision(fileStat.size, fileStat.mtimeMs);
      const response = await harness.fetchBytes(`/api/projects/${opened.projectId}/files/raw/${path}?v=${revision}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(contentType);
    }
    const gifStat = await stat(join(projectRoot, 'assets/animated.gif'));
    const gifRevision = projectFileRevision(gifStat.size, gifStat.mtimeMs);
    const gif = await harness.fetchBytes(`/api/projects/${opened.projectId}/files/raw/assets/animated.gif?v=${gifRevision}`);
    expect(gif.status).toBe(200);
    expect(gif.headers.get('content-type')).toBe('application/octet-stream');
  });

  it('serves supported audio video and VTT project files with media content types', async () => {
    await using harness = await DaemonTestHarness.create();
    const { rootPath: projectRoot } = await harness.createProject();
    await mkdir(join(projectRoot, 'assets'), { recursive: true });
    for (const [path, body] of [
      ['assets/clip.mp4', 'mp4-bytes'],
      ['assets/clip.webm', 'webm-bytes'],
      ['assets/clip.mov', 'mov-bytes'],
      ['assets/clip.m4v', 'm4v-bytes'],
      ['assets/theme.mp3', 'mp3-bytes'],
      ['assets/theme.wav', 'wav-bytes'],
      ['assets/theme.ogg', 'ogg-bytes'],
      ['assets/theme.m4a', 'm4a-bytes'],
      ['assets/theme.aac', 'aac-bytes'],
      ['assets/theme.flac', 'flac-bytes'],
      ['assets/theme.weba', 'weba-bytes'],
      ['assets/clip.en.vtt', 'WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n']
    ] as const) {
      await writeFile(join(projectRoot, path), body, 'utf8');
    }
    const opened = await harness.fetchOkJson<{
      projectId: string;
      projectRevision: number;
    }>(`/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({ projectRoot })
    });
    for (const [path, contentType] of [
      ['assets/clip.mp4', 'video/mp4'],
      ['assets/clip.webm', 'video/webm'],
      ['assets/clip.mov', 'video/quicktime'],
      ['assets/clip.m4v', 'video/x-m4v'],
      ['assets/theme.mp3', 'audio/mpeg'],
      ['assets/theme.wav', 'audio/wav'],
      ['assets/theme.ogg', 'audio/ogg'],
      ['assets/theme.m4a', 'audio/mp4'],
      ['assets/theme.aac', 'audio/mp4'],
      ['assets/theme.flac', 'audio/flac'],
      ['assets/theme.weba', 'audio/webm'],
      ['assets/clip.en.vtt', 'text/vtt; charset=utf-8']
    ] as const) {
      const fileStat = await stat(join(projectRoot, path));
      const revision = projectFileRevision(fileStat.size, fileStat.mtimeMs);
      const response = await harness.fetchBytes(`/api/projects/${opened.projectId}/files/raw/${path}?v=${revision}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(contentType);
    }
  });

  it('serves raw project files with byte range responses', async () => {
    await using harness = await DaemonTestHarness.create();
    const { rootPath: projectRoot } = await harness.createProject();
    await mkdir(join(projectRoot, 'generated'), { recursive: true });
    await writeFile(join(projectRoot, 'generated/clip.mp4'), '0123456789', 'utf8');
    const opened = await harness.fetchOkJson<{
      projectId: string;
      projectRevision: number;
    }>(`/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({ projectRoot })
    });
    const fileStat = await stat(join(projectRoot, 'generated/clip.mp4'));
    const revision = projectFileRevision(fileStat.size, fileStat.mtimeMs);
    const rawPath = `/api/projects/${opened.projectId}/files/raw/generated/clip.mp4?v=${revision}`;
    const first = await harness.fetchBytes(rawPath, { headers: { range: 'bytes=2-5' } });
    expect(first.status).toBe(206);
    expect(first.headers.get('accept-ranges')).toBe('bytes');
    expect(first.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(first.headers.get('content-length')).toBe('4');
    expect(new TextDecoder().decode(first.body)).toBe('2345');
    const openEnded = await harness.fetchBytes(rawPath, { headers: { range: 'bytes=7-' } });
    expect(openEnded.status).toBe(206);
    expect(openEnded.headers.get('content-range')).toBe('bytes 7-9/10');
    expect(new TextDecoder().decode(openEnded.body)).toBe('789');
    const suffix = await harness.fetchBytes(rawPath, { headers: { range: 'bytes=-3' } });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get('content-range')).toBe('bytes 7-9/10');
    expect(new TextDecoder().decode(suffix.body)).toBe('789');
    const invalid = await harness.fetchBytes(rawPath, { headers: { range: 'bytes=20-30' } });
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get('content-range')).toBe('bytes */10');
  });

  it('protects native project path operations with daemon token and validates project paths', async () => {
    const nativeShell = nativeShellFixture(async () => undefined);
    await using harness = await DaemonTestHarness.create({ nativeShell });
    const { rootPath: projectRoot } = await harness.createProject({
      'briefs/outline.md': '# Outline'
    });
    const runtime = harness.runtime;
    const opened = await harness.fetchOkJson<{
      projectId: string;
      projectRevision: number;
    }>(`/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': runtime.token
      },
      body: JSON.stringify({ projectRoot })
    });
    const rejectedCopy = await fetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/files/path/batch/copy-path`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entries: [{ projectRelativePath: 'briefs/outline.md', kind: 'file' }] })
    });
    expect(rejectedCopy.status).toBe(403);
    const canonicalProjectRoot = await realpath(projectRoot);
    await expect(harness.fetchOkJson<{
      paths: string[];
    }>(`/api/projects/${opened.projectId}/files/path/batch/copy-path`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': runtime.token
      },
      body: JSON.stringify({
        entries: [
          { projectRelativePath: 'briefs/outline.md', kind: 'file' },
          { projectRelativePath: 'briefs', kind: 'directory' }
        ]
      })
    })).resolves.toEqual({
      paths: [
        join(canonicalProjectRoot, 'briefs/outline.md'),
        join(canonicalProjectRoot, 'briefs')
      ]
    });
    await expect(harness.fetchOkJson(`/api/projects/${opened.projectId}/files/path/briefs/outline.md/reveal`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': runtime.token
      },
      body: JSON.stringify({ kind: 'file' })
    })).resolves.toEqual({ ok: true });
    expect(nativeShell.showItemInFolder).toHaveBeenCalledWith(join(canonicalProjectRoot, 'briefs/outline.md'));
    const trashResult = await harness.fetchOkJson<{
      results: Array<{
        projectRelativePath: string;
        kind: 'file' | 'directory';
        status: string;
      }>;
      snapshot: {
        files: Array<{
          projectRelativePath: string;
        }>;
      };
    }>(`/api/projects/${opened.projectId}/files/path/batch/trash`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': runtime.token
      },
      body: JSON.stringify({
        baseRevision: opened.projectRevision,
        entries: [{ projectRelativePath: 'briefs/outline.md', kind: 'file' }]
      })
    });
    expect(trashResult.results).toMatchObject([
      { projectRelativePath: 'briefs/outline.md', kind: 'file', status: 'ok' }
    ]);
    expect(JSON.stringify(trashResult)).not.toContain(projectRoot);
    expect(nativeShell.trashItem).toHaveBeenCalledWith(join(canonicalProjectRoot, 'briefs/outline.md'));
  });

  it('serves batch project file operation routes', async () => {
    await using harness = await DaemonTestHarness.create();
    const runtime = harness.runtime;
    const { rootPath: projectRoot } = await harness.createProject();
    await mkdir(join(projectRoot, 'briefs'), { recursive: true });
    await writeFile(join(projectRoot, 'briefs/outline.md'), '# Outline', 'utf8');
    await writeFile(join(projectRoot, 'cover.png'), 'cover', 'utf8');
    const opened = await harness.fetchOkJson<{
      projectId: string;
      projectRevision: number;
    }>(`/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': runtime.token
      },
      body: JSON.stringify({ projectRoot })
    });
    const headers = {
      'content-type': 'application/json',
      'x-debrute-daemon-token': runtime.token
    };
    const copied = await harness.fetchOkJson<{
      projectRevision: number;
      results: Array<{
        projectRelativePath: string;
        status: string;
      }>;
      snapshot: {
        files: Array<{
          projectRelativePath: string;
        }>;
      };
    }>(`/api/projects/${opened.projectId}/files/batch/copy`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        baseRevision: opened.projectRevision,
        entries: [{ projectRelativePath: 'cover.png', kind: 'file' }],
        targetDirectoryProjectRelativePath: 'briefs'
      })
    });
    expect(copied.results).toMatchObject([
      { projectRelativePath: 'briefs/cover.png', status: 'ok' }
    ]);
    expect(JSON.stringify(copied)).not.toContain(projectRoot);
    const moved = await harness.fetchOkJson<{
      projectRevision: number;
      results: Array<{
        projectRelativePath: string;
        status: string;
      }>;
      snapshot: {
        files: Array<{
          projectRelativePath: string;
        }>;
      };
    }>(`/api/projects/${opened.projectId}/files/batch/move`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        baseRevision: copied.projectRevision,
        entries: [{ projectRelativePath: 'briefs/cover.png', kind: 'file' }],
        targetDirectoryProjectRelativePath: '',
        overwrite: true
      })
    });
    expect(moved.results).toMatchObject([
      { projectRelativePath: 'cover.png', status: 'ok' }
    ]);
    const deleted = await harness.fetchOkJson<{
      results: Array<{
        projectRelativePath: string;
        status: string;
      }>;
      snapshot: {
        files: Array<{
          projectRelativePath: string;
        }>;
      };
    }>(`/api/projects/${opened.projectId}/files/batch/delete-permanently`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        baseRevision: moved.projectRevision,
        entries: [{ projectRelativePath: 'cover.png', kind: 'file' }]
      })
    });
    expect(deleted.results).toMatchObject([
      { projectRelativePath: 'cover.png', status: 'ok' }
    ]);
    expect(deleted.snapshot.files.map((file) => file.projectRelativePath)).not.toContain('cover.png');
  });

  it('serves external import routes for local paths and browser uploads', async () => {
    await using harness = await DaemonTestHarness.create();
    const runtime = harness.runtime;
    const { rootPath: projectRoot } = await harness.createProject();
    const { rootPath: externalRoot } = await harness.createProject();
    await mkdir(join(projectRoot, 'assets'), { recursive: true });
    await writeFile(join(externalRoot, 'cover.png'), 'cover', 'utf8');
    const opened = await harness.fetchOkJson<{
      projectId: string;
      projectRevision: number;
    }>(`/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': runtime.token
      },
      body: JSON.stringify({ projectRoot })
    });
    const localImport = await harness.fetchOkJson<{
      projectRevision: number;
      results: Array<{
        projectRelativePath: string;
        status: string;
      }>;
      snapshot: {
        files: Array<{
          projectRelativePath: string;
        }>;
      };
    }>(`/api/projects/${opened.projectId}/files/import/local`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': runtime.token
      },
      body: JSON.stringify({
        baseRevision: opened.projectRevision,
        sources: [join(externalRoot, 'cover.png')],
        targetDirectoryProjectRelativePath: 'assets'
      })
    });
    expect(localImport.results).toMatchObject([
      { projectRelativePath: 'assets/cover.png', status: 'ok' }
    ]);
    expect(JSON.stringify(localImport)).not.toContain(projectRoot);
    const uploadForm = new FormData();
    uploadForm.append('plan', JSON.stringify({
      baseRevision: localImport.projectRevision,
      targetDirectoryProjectRelativePath: 'assets',
      entries: [
        { kind: 'directory', projectRelativePath: 'assets/pages' },
        { kind: 'file', projectRelativePath: 'assets/pages/page.png', fileField: 'file:1' }
      ]
    }));
    uploadForm.append('file:1', new File(['page'], 'page.png'));
    const upload = await harness.fetchOkJson<{
      results: Array<{
        projectRelativePath: string;
        status: string;
      }>;
      snapshot: {
        files: Array<{
          projectRelativePath: string;
        }>;
      };
    }>(`/api/projects/${opened.projectId}/files/import/uploads`, {
      method: 'POST',
      headers: {
        'x-debrute-daemon-token': runtime.token
      },
      body: uploadForm
    });
    expect(upload.results).toMatchObject([
      { projectRelativePath: 'assets/pages', status: 'ok' },
      { projectRelativePath: 'assets/pages/page.png', status: 'ok' }
    ]);
    await expect(readFile(join(projectRoot, 'assets/pages/page.png'), 'utf8')).resolves.toBe('page');
  });

  it('streams browser upload request bodies beyond the previous 100MB limit', async () => {
    await using harness = await DaemonTestHarness.create();
    const runtime = harness.runtime;
    const { rootPath: projectRoot } = await harness.createProject();
    await mkdir(join(projectRoot, 'assets'), { recursive: true });
    const opened = await harness.fetchOkJson<{
      projectId: string;
      projectRevision: number;
    }>(`/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': runtime.token
      },
      body: JSON.stringify({ projectRoot })
    });
    const byteLength = 100 * 1024 * 1024 + 1;
    const uploadForm = new FormData();
    uploadForm.append('plan', JSON.stringify({
      baseRevision: opened.projectRevision,
      targetDirectoryProjectRelativePath: 'assets',
      entries: [{ kind: 'file', projectRelativePath: 'assets/large.bin', fileField: 'file:0' }]
    }));
    uploadForm.append('file:0', new File([new Uint8Array(byteLength)], 'large.bin'));
    const response = await harness.fetchJson<{
      results: Array<{
        projectRelativePath: string;
        kind: 'file';
      }>;
    }>(`/api/projects/${opened.projectId}/files/import/uploads`, {
      method: 'POST',
      body: uploadForm
    });
    expect(response.status).toBe(200);
    const upload = response.body;
    expect(upload.results).toMatchObject([{ projectRelativePath: 'assets/large.bin', kind: 'file' }]);
    await expect(stat(join(projectRoot, 'assets/large.bin')).then((fileStat) => fileStat.size)).resolves.toBe(byteLength);
  });

  it('does not parse upload bodies through Request.formData buffering', async () => {
    await using harness = await DaemonTestHarness.create();
    const runtime = harness.runtime;
    const { rootPath: projectRoot } = await harness.createProject();
    await mkdir(join(projectRoot, 'assets'), { recursive: true });
    const originalFormData = Request.prototype.formData;
    onTestFinished(() => {
      Request.prototype.formData = originalFormData;
    });
    Request.prototype.formData = async function blockedFormData(): Promise<FormData> {
      throw new Error('Request.formData must not be used for upload imports.');
    };
    const opened = await harness.fetchOkJson<{
      projectId: string;
      projectRevision: number;
    }>(`/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': runtime.token
      },
      body: JSON.stringify({ projectRoot })
    });
    const uploadForm = new FormData();
    uploadForm.append('plan', JSON.stringify({
      baseRevision: opened.projectRevision,
      targetDirectoryProjectRelativePath: 'assets',
      entries: [{ kind: 'file', projectRelativePath: 'assets/page.png', fileField: 'file:0' }]
    }));
    uploadForm.append('file:0', new File(['page'], 'page.png'));
    const response = await harness.fetchJson(`/api/projects/${opened.projectId}/files/import/uploads`, {
      method: 'POST',
      body: uploadForm
    });
    expect(response.status).toBe(200);
    await expect(readFile(join(projectRoot, 'assets/page.png'), 'utf8')).resolves.toBe('page');
  });

  it('honors project ids on project-scoped routes', async () => {
    await using harness = await DaemonTestHarness.create();
    const { rootPath: projectRoot } = await harness.createProject();
    await mkdir(join(projectRoot, 'briefs'), { recursive: true });
    await writeFile(join(projectRoot, 'briefs/outline.md'), '# Outline', 'utf8');
    const opened = await harness.fetchOkJson<{
      projectId: string;
      projectRevision: number;
    }>(`/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({ projectRoot })
    });
    await expect(harness.fetchOkJson(`/api/projects/${opened.projectId}/files/text/briefs/outline.md`))
      .resolves.toMatchObject({ content: '# Outline' });
    const rejected = await harness.fetchJson<{
      error: {
        code: string;
      };
    }>('/api/projects/unknown-project-id/files/text/briefs/outline.md');
    expect(rejected.status).toBe(404);
    expect(rejected.body).toMatchObject({
      error: { code: 'project_not_open' }
    });
  });

  it('rejects project files that resolve outside the project through symlinks', async () => {
    await using harness = await DaemonTestHarness.create();
    const { rootPath: projectRoot } = await harness.createProject();
    const { rootPath: outsideRoot } = await harness.createProject({ 'outside.txt': 'outside' });
    const outsideFile = join(outsideRoot, 'outside.txt');
    await symlink(outsideFile, join(projectRoot, 'linked.txt'));
    const opened = await harness.fetchOkJson<{
      projectId: string;
    }>(`/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({ projectRoot })
    });
    const response = await harness.fetchJson<{
      error: {
        code: string;
      };
    }>(`/api/projects/${opened.projectId}/files/text/linked.txt`);
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      error: { code: 'project_path_forbidden' }
    });
  });

  it('requires an explicit project root when opening a project', async () => {
    await using harness = await DaemonTestHarness.create();
    const { rootPath: projectRoot } = await harness.createProject();
    await writeFile(join(projectRoot, 'brief.md'), '# Brief', 'utf8');
    const response = await harness.fetchJson<{
      error: {
        code: string;
      };
    }>('/api/projects/open', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({})
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { code: 'invalid_input' }
    });
    await expect(harness.fetchOkJson('/api/projects')).resolves.toEqual({
      projects: []
    });
  });

  it('returns invalid_input for project-open roots that do not resolve to directories', async () => {
    await using harness = await DaemonTestHarness.create();
    const { rootPath: invalidRoot } = await harness.createProject({
      'not-a-directory': 'not a directory'
    });
    const filePath = join(invalidRoot, 'not-a-directory');
    const missingPath = join(invalidRoot, 'missing');
    for (const projectRoot of [missingPath, filePath]) {
      const response = await harness.fetchJson<{
        error: {
          code: string;
        };
      }>('/api/projects/open', {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({ projectRoot })
      });
      expect(response.status, projectRoot).toBe(400);
      expect(response.body).toMatchObject({
        error: { code: 'invalid_input' }
      });
    }
    await expect(harness.fetchOkJson('/api/projects')).resolves.toEqual({
      projects: []
    });
  });

  it('serves generated asset metadata and raw files from browser-facing asset routes', async () => {
    let appServer: DebruteAppServer | undefined;
    await using harness = await DaemonTestHarness.create({
      createAppServer: () => {
        appServer = new DebruteAppServer();
        return appServer;
      }
    });
    const runtime = harness.runtime;
    const { rootPath: projectRoot } = await harness.createProject({
      'generated/cover.png': 'asset-bytes'
    });
    const opened = await harness.fetchOkJson<{
      projectId: string;
      projectRevision: number;
    }>(`/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({ projectRoot })
    });
    if (!appServer) {
      throw new Error('Daemon did not create a project app server.');
    }
    expect(opened.projectRevision).toBe(1);
    const events = await fetch(`${runtime.daemonUrl}/api/projects/${opened.projectId}/events?clientId=generated-assets-client`, {
      headers: { 'x-debrute-daemon-token': 'test-token' }
    });
    expect(events.status).toBe(200);
    const record = await appServer.recordGeneratedAssetMetadata({
      modelRunId: 'model-run-1',
      projectRelativePath: 'generated/cover.png',
      artifactRole: 'primary-image',
      artifactIndex: 0,
      modelRun: {
        request: { prompt: 'cover' },
        output: { ok: true }
      }
    });
    await expect(readDaemonSseEvent<{
      type: string;
      projectId: string;
      projectRevision: number;
      record: {
        recordId: string;
        projectRelativePath: string;
      };
    }>(events)).resolves.toMatchObject({
      type: 'generatedAsset.metadata.changed',
      projectId: opened.projectId,
      projectRevision: 2,
      record: {
        recordId: record.recordId,
        projectRelativePath: 'generated/cover.png'
      }
    });
    const liveProjects = await harness.fetchOkJson<{
      projects: Array<{
        projectId: string;
        projectRevision: number;
      }>;
    }>(`/api/projects`, {
      headers: { 'x-debrute-daemon-token': 'test-token' }
    });
    expect(liveProjects.projects).toEqual([
      expect.objectContaining({
        projectId: opened.projectId,
        projectRevision: 2
      })
    ]);
    const list = await harness.fetchOkJson<{
      assets: Array<{
        assetId: string;
        projectRelativePath: string;
        rawUrl: string;
      }>;
    }>(`/api/projects/${opened.projectId}/generated-assets`, {
      headers: { 'x-debrute-daemon-token': 'test-token' }
    });
    expect(list.assets).toEqual([
      expect.objectContaining({
        assetId: record.recordId,
        projectRelativePath: 'generated/cover.png',
        rawUrl: `/api/projects/${opened.projectId}/generated-assets/${record.recordId}/raw`
      })
    ]);
    expect(JSON.stringify(list)).not.toContain(projectRoot);
    const detail = await harness.fetchOkJson<Record<string, unknown>>(`/api/projects/${opened.projectId}/generated-assets/${record.recordId}`, {
      headers: { 'x-debrute-daemon-token': 'test-token' }
    });
    expect(detail).toMatchObject({
      assetId: record.recordId,
      projectRelativePath: 'generated/cover.png',
      record
    });
    expect(JSON.stringify(detail)).not.toContain(projectRoot);
    const rawAsset = await harness.fetchBytes(list.assets[0]!.rawUrl);
    expect(new TextDecoder().decode(rawAsset.body)).toBe('asset-bytes');
  });

  it('rejects generated asset lookup paths that resolve outside the project through symlinks', async () => {
    await using harness = await DaemonTestHarness.create();
    const { rootPath: projectRoot } = await harness.createProject();
    const { rootPath: outsideRoot } = await harness.createProject({ 'outside.png': 'outside' });
    const outsideFile = join(outsideRoot, 'outside.png');
    await mkdir(join(projectRoot, 'generated'), { recursive: true });
    await symlink(outsideFile, join(projectRoot, 'generated/linked.png'));
    const opened = await harness.fetchOkJson<{
      projectId: string;
    }>(`/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({ projectRoot })
    });
    const response = await harness.fetchJson<{
      error: {
        code: string;
      };
    }>(`/api/projects/${opened.projectId}/generated-assets/lookup`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({ projectRelativePath: 'generated/linked.png' })
    });
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      error: { code: 'project_path_forbidden' }
    });
  });

  it('rejects unsupported methods on file and preview resource routes', async () => {
    await using harness = await DaemonTestHarness.create();
    const { rootPath: projectRoot } = await harness.createProject();
    await mkdir(join(projectRoot, 'generated'), { recursive: true });
    await writeFile(join(projectRoot, 'generated/cover.png'), 'asset-bytes', 'utf8');
    const opened = await harness.fetchOkJson<{
      projectId: string;
    }>(`/api/projects/open`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-debrute-daemon-token': 'test-token'
      },
      body: JSON.stringify({ projectRoot })
    });
    for (const [method, path] of [
      ['POST', `/api/projects/${opened.projectId}/files/raw/generated/cover.png`],
      ['POST', `/api/projects/${opened.projectId}/canvas-image-preview?path=generated%2Fcover.png&v=rev&w=512`],
      ['GET', `/api/projects/${opened.projectId}/generated-assets/lookup?path=generated%2Fcover.png`]
    ] as const) {
      const response = await harness.fetchJson<{
        error: {
          code: string;
        };
      }>(path, { method });
      expect(response.status, `${method} ${path}`).toBe(405);
      expect(response.body).toMatchObject({
        error: { code: 'method_not_allowed' }
      });
    }
  });
});

function nativeShellFixture(chooseDirectory: () => Promise<string | undefined>) {
  return {
    platform: process.platform,
    chooseDirectory: vi.fn(chooseDirectory),
    showItemInFolder: vi.fn(async () => undefined),
    openPath: vi.fn(async () => undefined),
    trashItem: vi.fn(async () => undefined)
  };
}
