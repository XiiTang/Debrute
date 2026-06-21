import { access, open, stat } from 'node:fs/promises';
import {
  isKnownProjectTextFilePath,
  projectFileRevision,
  projectTextMimeTypeFromPath,
  resolveExistingProjectPath
} from '@debrute/project-core';
import {
  CANVAS_DOCUMENT_SCHEMA_VERSION,
  isCanvasDocumentId,
  projectCanvas,
  type CanvasDocument,
  type CanvasMediaKind,
  type CanvasNodeAvailability,
  type CanvasNodeElement,
  type CanvasProjection,
  type Diagnostic
} from '@debrute/canvas-core';
import { canvasImagePreviewSourceInfo } from './CanvasImagePreviewService.js';

export class CanvasProjectionService {
  async projectCanvasDocument(
    projectRoot: string,
    canvas: CanvasDocument,
    diagnostics: Diagnostic[] = []
  ): Promise<CanvasProjection> {
    const availabilityByPath = new Map(await Promise.all(canvas.nodeElements.map(async (node) => [
      node.projectRelativePath,
      await inspectCanvasNodeAvailability(projectRoot, node)
    ] as const)));
    return projectCanvas({
      canvas,
      diagnostics,
      nodeAvailability: (node) => availabilityByPath.get(node.projectRelativePath)!
    });
  }

  projectCanvasWithKnownAvailability(canvas: CanvasDocument, projection: CanvasProjection): CanvasProjection {
    const availabilityByPath = new Map(projection.nodes.map((node) => [node.projectRelativePath, node.availability]));
    return projectCanvas({
      canvas,
      diagnostics: projection.diagnostics,
      nodeAvailability: (node) => {
        const availability = availabilityByPath.get(node.projectRelativePath);
        if (!availability) {
          throw new Error(`Canvas node availability is not loaded: ${node.projectRelativePath}`);
        }
        return availability;
      }
    });
  }
}

export function assertCurrentCanvasDocument(value: unknown, filePath: string): CanvasDocument {
  if (isRecord(value) && typeof value.id === 'string' && !isCanvasDocumentId(value.id)) {
    throw new Error(`Invalid canvas document id: ${filePath}`);
  }
  if (isCurrentCanvasDocument(value)) {
    return value;
  }
  throw new Error(`Invalid canvas document schema: ${filePath}`);
}

export function canvasMediaKindFromPath(projectRelativePath: string): CanvasMediaKind {
  const lowerPath = projectRelativePath.toLowerCase();
  if (/\.(png|jpe?g|webp|svg|gif)$/.test(lowerPath)) {
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

function isCurrentCanvasDocument(value: unknown): value is CanvasDocument {
  if (!isRecord(value) || value.schemaVersion !== CANVAS_DOCUMENT_SCHEMA_VERSION) {
    return false;
  }
  return hasOnlyKeys(value, ['schemaVersion', 'id', 'nodeElements', 'annotations', 'preferences'])
    && typeof value.id === 'string'
    && isCanvasDocumentId(value.id)
    && Array.isArray(value.nodeElements)
    && value.nodeElements.every(isCurrentCanvasNodeElement)
    && Array.isArray(value.annotations)
    && isRecord(value.preferences)
    && hasOnlyKeys(value.preferences, ['showDiagnostics'])
    && typeof value.preferences.showDiagnostics === 'boolean';
}

function isCurrentCanvasNodeElement(value: unknown): value is CanvasNodeElement {
  return isRecord(value)
    && hasOnlyKeys(value, ['projectRelativePath', 'nodeKind', 'mediaKind', 'x', 'y', 'width', 'height', 'z', 'layoutMode'])
    && typeof value.projectRelativePath === 'string'
    && (value.nodeKind === 'directory' || value.nodeKind === 'file')
    && (value.mediaKind === undefined || value.mediaKind === 'image' || value.mediaKind === 'video' || value.mediaKind === 'audio' || value.mediaKind === 'text' || value.mediaKind === 'unknown')
    && typeof value.x === 'number'
    && typeof value.y === 'number'
    && typeof value.width === 'number'
    && typeof value.height === 'number'
    && typeof value.z === 'number'
    && (value.layoutMode === undefined || value.layoutMode === 'manual');
}

function mimeTypeFromProjectPath(projectRelativePath: string, firstLine?: string): string {
  const lowerPath = projectRelativePath.toLowerCase();
  if (lowerPath.endsWith('.png')) {
    return 'image/png';
  }
  if (lowerPath.endsWith('.jpg') || lowerPath.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  if (lowerPath.endsWith('.webp')) {
    return 'image/webp';
  }
  if (lowerPath.endsWith('.svg')) {
    return 'image/svg+xml';
  }
  if (lowerPath.endsWith('.gif')) {
    return 'image/gif';
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

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
