import { access, open, stat } from 'node:fs/promises';
import {
  isKnownProjectTextFilePath,
  isSupportedProjectImagePath,
  projectFileRevision,
  projectImageMimeTypeFromPath,
  projectTextMimeTypeFromPath,
  resolveExistingProjectPath
} from '@debrute/project-core';
import {
  isCanvasDocumentId,
  isCanvasDocumentName,
  projectCanvas,
  type CanvasDocument,
  type CanvasMediaKind,
  type CanvasNodeAvailability,
  type CanvasNodeElement,
  type CanvasProjection,
  type Diagnostic
} from '@debrute/canvas-core';
import { canvasImagePreviewSourceInfo } from './CanvasImagePreviewService.js';
import type {
  CanvasVideoMetadata,
  ReadCanvasVideoMetadataInput
} from './CanvasNodeDimensionsService.js';
import { buildCanvasVideoPresentation } from './CanvasVideoPresentationService.js';

export interface CanvasProjectionServiceDependencies {
  readCanvasVideoMetadata(input: ReadCanvasVideoMetadataInput): Promise<CanvasVideoMetadata>;
}

export class CanvasProjectionService {
  constructor(private readonly dependencies: CanvasProjectionServiceDependencies) {}

  async projectCanvasDocument(
    projectRoot: string,
    canvas: CanvasDocument,
    diagnostics: Diagnostic[] = []
  ): Promise<CanvasProjection> {
    const inspectionByPath = new Map(await Promise.all(canvas.nodeElements.map(async (node) => [
      node.projectRelativePath,
      await inspectCanvasNode(projectRoot, node, this.dependencies)
    ] as const)));
    const projected = projectCanvas({
      canvas,
      diagnostics,
      nodeAvailability: (node) => inspectionByPath.get(node.projectRelativePath)!.availability
    });
    return {
      ...projected,
      nodes: await Promise.all(projected.nodes.map(async (node) => {
        if (node.mediaKind !== 'video' || node.availability.state !== 'available') {
          return node;
        }
        const inspection = inspectionByPath.get(node.projectRelativePath)!;
        return {
          ...node,
          videoPresentation: await buildCanvasVideoPresentation({
            projectRoot,
            projectRelativePath: node.projectRelativePath,
            durationSeconds: inspection.videoMetadata?.durationSeconds
          })
        };
      }))
    };
  }

  projectCanvasWithKnownProjection(canvas: CanvasDocument, projection: CanvasProjection): CanvasProjection {
    const projectionByPath = new Map(projection.nodes.map((node) => [node.projectRelativePath, node]));
    const projected = projectCanvas({
      canvas,
      diagnostics: projection.diagnostics,
      nodeAvailability: (node) => {
        const projectedNode = projectionByPath.get(node.projectRelativePath);
        if (!projectedNode) {
          throw new Error(`Canvas node availability is not loaded: ${node.projectRelativePath}`);
        }
        return projectedNode.availability;
      }
    });
    return {
      ...projected,
      nodes: projected.nodes.map((node) => {
        if (node.mediaKind !== 'video' || node.availability.state !== 'available') {
          return node;
        }
        const projectedNode = projectionByPath.get(node.projectRelativePath);
        if (!projectedNode?.videoPresentation) {
          throw new Error(`Canvas video presentation is not loaded: ${node.projectRelativePath}`);
        }
        return {
          ...node,
          videoPresentation: projectedNode.videoPresentation
        };
      })
    };
  }
}

interface CanvasNodeInspection {
  availability: CanvasNodeAvailability;
  videoMetadata?: CanvasVideoMetadata;
}

export function assertCurrentCanvasDocument(value: unknown, filePath: string): CanvasDocument {
  if (isRecord(value) && typeof value.id === 'string' && !isCanvasDocumentId(value.id)) {
    throw new Error(`Invalid canvas document id: ${filePath}`);
  }
  if (isCurrentCanvasDocument(value)) {
    return value;
  }
  throw new Error(`Invalid canvas document: ${filePath}`);
}

export function canvasMediaKindFromPath(projectRelativePath: string): CanvasMediaKind {
  const lowerPath = projectRelativePath.toLowerCase();
  if (isSupportedProjectImagePath(projectRelativePath)) {
    return 'image';
  }
  if (/\.(mp4|webm|mov|m4v)$/.test(lowerPath)) {
    return 'video';
  }
  if (/\.(mp3|wav|wave|ogg|oga|opus|m4a|aac|flac|weba)$/.test(lowerPath)) {
    return 'audio';
  }
  if (isKnownProjectTextFilePath(projectRelativePath)) {
    return 'text';
  }
  return 'unknown';
}

export async function canvasMediaKindForProjectFile(projectRoot: string, projectRelativePath: string): Promise<CanvasMediaKind> {
  const pathKind = canvasMediaKindFromPath(projectRelativePath);
  if (pathKind !== 'unknown') {
    return pathKind;
  }
  const absolutePath = await resolveExistingProjectPath(projectRoot, projectRelativePath);
  const firstLine = await firstLineForTextClassification(absolutePath);
  return isKnownProjectTextFilePath(projectRelativePath, firstLine) ? 'text' : 'unknown';
}

async function inspectCanvasNodeAvailability(projectRoot: string, node: CanvasNodeElement): Promise<CanvasNodeAvailability> {
  let absolutePath: string;
  try {
    absolutePath = await resolveExistingProjectPath(projectRoot, node.projectRelativePath);
  } catch (error) {
    return {
      state: 'unreadable',
      message: errorMessage(error)
    };
  }

  try {
    const fileStat = await stat(absolutePath);
    if (node.nodeKind === 'directory') {
      if (!fileStat.isDirectory()) {
        return {
          state: 'unreadable',
          message: `Project path is not a directory: ${node.projectRelativePath}`
        };
      }
      return {
        state: 'available',
        size: 0,
        mimeType: 'inode/directory',
        fileUrl: '',
        mtimeMs: fileStat.mtimeMs,
        revision: projectFileRevision(0, fileStat.mtimeMs)
      };
    }
    if (!fileStat.isFile()) {
      return {
        state: 'unreadable',
        message: `Project path is not a file: ${node.projectRelativePath}`
      };
    }
    await access(absolutePath);
    const revision = projectFileRevision(fileStat.size, fileStat.mtimeMs);
    const firstLine = node.mediaKind === 'text'
      ? await firstLineForTextClassification(absolutePath)
      : undefined;
    const mimeType = mimeTypeFromProjectPath(node.projectRelativePath, firstLine);
    const canvasImagePreview = node.mediaKind === 'image'
      ? await canvasImagePreviewSourceInfo(projectRoot, node.projectRelativePath)
      : undefined;
    return {
      state: 'available',
      size: fileStat.size,
      mimeType,
      fileUrl: '',
      ...(canvasImagePreview ? {
        canvasImagePreviewable: canvasImagePreview.previewable,
        ...(canvasImagePreview.sourceWidth === undefined ? {} : { canvasImagePreviewSourceWidth: canvasImagePreview.sourceWidth })
      } : {}),
      mtimeMs: fileStat.mtimeMs,
      revision
    };
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return {
        state: 'missing',
        message: `Project path is missing: ${node.projectRelativePath}`
      };
    }
    return {
      state: 'unreadable',
      message: errorMessage(error)
    };
  }
}

async function inspectCanvasNode(
  projectRoot: string,
  node: CanvasNodeElement,
  dependencies: CanvasProjectionServiceDependencies
): Promise<CanvasNodeInspection> {
  const availability = await inspectCanvasNodeAvailability(projectRoot, node);
  if (availability.state !== 'available' || node.mediaKind !== 'video') {
    return { availability };
  }
  try {
    return {
      availability,
      videoMetadata: await dependencies.readCanvasVideoMetadata({
        projectRoot,
        projectRelativePath: node.projectRelativePath
      })
    };
  } catch (error) {
    return {
      availability: {
        state: 'unreadable',
        message: errorMessage(error)
      }
    };
  }
}

function isCurrentCanvasDocument(value: unknown): value is CanvasDocument {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.id === 'string'
    && isCanvasDocumentId(value.id)
    && isCanvasDocumentName(value.name)
    && Array.isArray(value.nodeElements)
    && value.nodeElements.every(isCurrentCanvasNodeElement)
    && Array.isArray(value.annotations)
    && value.annotations.every(isCurrentCanvasAnnotation)
    && isRecord(value.preferences)
    && typeof value.preferences.showDiagnostics === 'boolean';
}

function isCurrentCanvasAnnotation(value: unknown): value is CanvasDocument['annotations'][number] {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.text === 'string'
    && typeof value.x === 'number'
    && typeof value.y === 'number';
}

function isCurrentCanvasNodeElement(value: unknown): value is CanvasNodeElement {
  return isRecord(value)
    && typeof value.projectRelativePath === 'string'
    && (value.nodeKind === 'directory' || value.nodeKind === 'file')
    && (value.mediaKind === undefined || value.mediaKind === 'image' || value.mediaKind === 'video' || value.mediaKind === 'audio' || value.mediaKind === 'text' || value.mediaKind === 'unknown')
    && typeof value.x === 'number'
    && typeof value.y === 'number'
    && typeof value.width === 'number'
    && typeof value.height === 'number'
    && typeof value.z === 'number'
    && (value.layoutMode === undefined || value.layoutMode === 'manual')
    && (value.videoPlayback === undefined
      || (value.nodeKind === 'file' && value.mediaKind === 'video' && isCurrentCanvasVideoPlaybackState(value.videoPlayback)));
}

function isCurrentCanvasVideoPlaybackState(value: unknown): value is NonNullable<CanvasNodeElement['videoPlayback']> {
  const currentTimeSeconds = isRecord(value) ? value.currentTimeSeconds : undefined;
  return isRecord(value)
    && typeof currentTimeSeconds === 'number'
    && Number.isFinite(currentTimeSeconds)
    && currentTimeSeconds >= 0;
}

function mimeTypeFromProjectPath(projectRelativePath: string, firstLine?: string): string {
  const lowerPath = projectRelativePath.toLowerCase();
  const imageMimeType = projectImageMimeTypeFromPath(projectRelativePath);
  if (imageMimeType) {
    return imageMimeType;
  }
  if (lowerPath.endsWith('.mp4')) {
    return 'video/mp4';
  }
  if (lowerPath.endsWith('.webm')) {
    return 'video/webm';
  }
  if (lowerPath.endsWith('.mov')) {
    return 'video/quicktime';
  }
  if (lowerPath.endsWith('.m4v')) {
    return 'video/x-m4v';
  }
  if (lowerPath.endsWith('.mp3')) {
    return 'audio/mpeg';
  }
  if (lowerPath.endsWith('.wav') || lowerPath.endsWith('.wave')) {
    return 'audio/wav';
  }
  if (lowerPath.endsWith('.ogg') || lowerPath.endsWith('.oga') || lowerPath.endsWith('.opus')) {
    return 'audio/ogg';
  }
  if (lowerPath.endsWith('.m4a') || lowerPath.endsWith('.aac')) {
    return 'audio/mp4';
  }
  if (lowerPath.endsWith('.flac')) {
    return 'audio/flac';
  }
  if (lowerPath.endsWith('.weba')) {
    return 'audio/webm';
  }
  return projectTextMimeTypeFromPath(projectRelativePath, firstLine);
}

async function firstLineForTextClassification(absolutePath: string): Promise<string | undefined> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(absolutePath, 'r');
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const content = buffer.subarray(0, bytesRead).toString('utf8');
    if (content.includes('\u0000') || content.includes('\uFFFD')) {
      return undefined;
    }
    return content.split(/\r?\n/, 1)[0] ?? '';
  } finally {
    await file?.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
