import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDebruteDaemonHttpServer } from './createDebruteDaemonHttpServer.js';
import type { DebruteHttpErrorBody, WorkbenchProjectOpenResult } from '@debrute/app-protocol';

describe('createDebruteDaemonHttpServer Canvas text preview routes', () => {
  it('returns source-missing and invalid-input errors from the text preview image endpoint', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-daemon-text-preview-'));
    const server = createDebruteDaemonHttpServer({
      port: 0,
      token: 'test-token',
      adobeBridgeDiscoveryPort: 0
    });
    try {
      const runtime = await server.listen();
      const open = await fetch(`${runtime.daemonUrl}/api/projects/open`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-debrute-daemon-token': server.token
        },
        body: JSON.stringify({ projectRoot })
      });
      expect(open.status).toBe(200);
      const project = await open.json() as WorkbenchProjectOpenResult;

      const missing = await fetch(`${runtime.daemonUrl}/api/projects/${project.projectId}/canvas-text-preview?canvasId=canvas-1&path=notes%2Fmissing.md&fingerprint=fingerprint-missing&w=80`, {
        headers: { 'x-debrute-daemon-token': server.token }
      });
      expect(missing.status).toBe(404);
      await expect(missing.json()).resolves.toMatchObject({
        error: {
          code: 'canvas_text_preview_source_missing',
          message: 'Canvas text preview source is not available: notes/missing.md'
        }
      } satisfies Partial<DebruteHttpErrorBody>);

      const invalidWidth = await fetch(`${runtime.daemonUrl}/api/projects/${project.projectId}/canvas-text-preview?canvasId=canvas-1&path=notes%2Fmissing.md&fingerprint=fingerprint-missing&w=0`, {
        headers: { 'x-debrute-daemon-token': server.token }
      });
      expect(invalidWidth.status).toBe(400);
      await expect(invalidWidth.json()).resolves.toMatchObject({
        error: {
          code: 'invalid_input',
          message: 'w must be a positive integer.'
        }
      } satisfies Partial<DebruteHttpErrorBody>);
    } finally {
      await server.close();
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
