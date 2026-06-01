import { stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { AxisAppServer } from '@axis/app-server';
import { resolveProjectPath } from '@axis/project-core';
import {
  CANVAS_PREVIEW_PROTOCOL,
  PROJECT_FILE_PROTOCOL,
  assertProjectFileRevision,
  canvasPreviewRequestFromProtocolUrl,
  projectFileRequestFromProtocolUrl
} from './projectProtocols.js';

export interface ProjectProtocolLike {
  handle(scheme: string, handler: (request: Request) => Promise<Response>): void;
}

export interface ProjectNetLike {
  fetch(url: string, init?: { signal?: AbortSignal }): Promise<Response>;
}

export interface RegisterProjectFileProtocolsInput {
  protocol: ProjectProtocolLike;
  net: ProjectNetLike;
  server: AxisAppServer;
}

export function registerProjectFileProtocols(input: RegisterProjectFileProtocolsInput): void {
  registerProjectFileProtocol(input);
  registerCanvasPreviewProtocol(input);
}

function registerProjectFileProtocol({ protocol, net, server }: RegisterProjectFileProtocolsInput): void {
  protocol.handle(PROJECT_FILE_PROTOCOL, async (request) => {
    try {
      const { projectRelativePath, revision } = projectFileRequestFromProtocolUrl(request.url);
      const absolutePath = resolveProjectPath(server.getSnapshot().projectRoot, projectRelativePath);
      const fileStat = await stat(absolutePath);
      if (!fileStat.isFile()) {
        throw new Error(`Project path is not a file: ${projectRelativePath}`);
      }
      assertProjectFileRevision({
        projectRelativePath,
        revision,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs
      });
      return net.fetch(pathToFileURL(absolutePath).toString());
    } catch (error) {
      return new Response(error instanceof Error ? error.message : String(error), { status: 404 });
    }
  });
}

function registerCanvasPreviewProtocol({ protocol, net, server }: RegisterProjectFileProtocolsInput): void {
  protocol.handle(CANVAS_PREVIEW_PROTOCOL, async (request) => {
    try {
      const previewRequest = canvasPreviewRequestFromProtocolUrl(request.url);
      const preview = await server.resolveCanvasImagePreview({
        ...previewRequest,
        abortSignal: request.signal
      });
      return net.fetch(pathToFileURL(preview.absolutePath).toString(), { signal: request.signal });
    } catch (error) {
      return new Response(error instanceof Error ? error.message : String(error), { status: 404 });
    }
  });
}
