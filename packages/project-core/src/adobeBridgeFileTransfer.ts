import { createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  assertProjectTreeVisibleMutationPath,
  joinProjectPath,
  normalizeProjectDirectoryPath,
  resolveExistingProjectPath,
  resolveProjectPathForWrite
} from './projectPaths.js';

export const ADOBE_BRIDGE_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const SUPPORTED_PROJECT_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.psd']);
export type AdobeBridgeProjectFileErrorCode =
  | 'invalid_transfer_payload'
  | 'upload_too_large'
  | 'target_directory_missing'
  | 'target_directory_not_visible';

export class AdobeBridgeProjectFileError extends Error {
  constructor(
    readonly code: AdobeBridgeProjectFileErrorCode,
    message: string,
    readonly fields: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

export interface ImportAdobeBridgePngTransferInput {
  targetDirectoryProjectRelativePath: string;
  suggestedName: string;
  content: Uint8Array | AsyncIterable<Uint8Array>;
  byteLength: number;
  mimeType: string;
}

export interface AdobeBridgeProjectFileResult {
  projectRelativePath: string;
  kind: 'file';
}

export function isSupportedAdobeBridgeProjectImageFile(projectRelativePath: string): boolean {
  try {
    assertProjectTreeVisibleMutationPath(projectRelativePath);
  } catch {
    return false;
  }
  return SUPPORTED_PROJECT_IMAGE_EXTENSIONS.has(extname(projectRelativePath).toLowerCase());
}

export function sanitizeAdobeBridgePngBasename(input: string): string {
  const withoutExtension = input.replace(/\.[A-Za-z0-9]+$/, '');
  const sanitized = withoutExtension
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .trim();
  return sanitized || 'Photoshop Layer';
}

export function nextAdobeBridgeTransferFileName(existingNames: Set<string>, suggestedName: string): string {
  const stem = sanitizeAdobeBridgePngBasename(suggestedName);
  const first = `${stem}.png`;
  if (!existingNames.has(first)) {
    return first;
  }
  let index = 2;
  while (true) {
    const candidate = `${stem} ${index}.png`;
    if (!existingNames.has(candidate)) {
      return candidate;
    }
    index += 1;
  }
}

export async function importAdobeBridgePngTransfer(
  projectRoot: string,
  input: ImportAdobeBridgePngTransferInput
): Promise<AdobeBridgeProjectFileResult> {
  if (input.mimeType !== 'image/png') {
    throw new AdobeBridgeProjectFileError('invalid_transfer_payload', `Unsupported Adobe Bridge upload type: ${input.mimeType}`, {
      mimeType: input.mimeType
    });
  }
  if (!Number.isInteger(input.byteLength) || input.byteLength < 1) {
    throw new AdobeBridgeProjectFileError('invalid_transfer_payload', 'Adobe Bridge upload byteLength must be a positive integer.', {
      byteLength: input.byteLength
    });
  }
  if (input.byteLength > ADOBE_BRIDGE_MAX_UPLOAD_BYTES) {
    throw new AdobeBridgeProjectFileError('upload_too_large', `Adobe Bridge upload is too large: ${input.byteLength} bytes.`, {
      byteLength: input.byteLength,
      maxBytes: ADOBE_BRIDGE_MAX_UPLOAD_BYTES
    });
  }

  const targetDirectory = normalizeAdobeBridgeTargetDirectory(input.targetDirectoryProjectRelativePath);
  const visibleProbePath = targetDirectory
    ? joinProjectPath(targetDirectory, '__debrute_probe__.png')
    : '__debrute_probe__.png';
  assertAdobeBridgeTargetVisible(visibleProbePath);

  const targetDirectoryAbsolutePath = await resolveAdobeBridgeTargetDirectory(projectRoot, targetDirectory);
  const targetDirectoryStat = await stat(targetDirectoryAbsolutePath);
  if (!targetDirectoryStat.isDirectory()) {
    throw new AdobeBridgeProjectFileError('target_directory_missing', `Adobe Bridge target path is not a directory: ${targetDirectory}`, {
      targetDirectoryProjectRelativePath: targetDirectory
    });
  }

  const entries = await readdir(targetDirectoryAbsolutePath, { withFileTypes: true });
  const fileName = nextAdobeBridgeTransferFileName(new Set(entries.map((entry) => entry.name)), input.suggestedName);
  const projectRelativePath = joinProjectPath(targetDirectory, fileName);
  assertAdobeBridgeTargetVisible(projectRelativePath);
  const absolutePath = await resolveProjectPathForWrite(projectRoot, projectRelativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeTransferContent(absolutePath, input.content);
  return { projectRelativePath, kind: 'file' };
}

function normalizeAdobeBridgeTargetDirectory(targetDirectoryProjectRelativePath: string): string {
  try {
    return normalizeProjectDirectoryPath(targetDirectoryProjectRelativePath);
  } catch (error) {
    throw new AdobeBridgeProjectFileError('invalid_transfer_payload', error instanceof Error ? error.message : 'Invalid Adobe Bridge target directory.', {
      targetDirectoryProjectRelativePath
    });
  }
}

async function resolveAdobeBridgeTargetDirectory(projectRoot: string, targetDirectoryProjectRelativePath: string): Promise<string> {
  try {
    return await resolveExistingProjectPath(projectRoot, targetDirectoryProjectRelativePath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new AdobeBridgeProjectFileError('target_directory_missing', `Adobe Bridge target directory does not exist: ${targetDirectoryProjectRelativePath}`, {
        targetDirectoryProjectRelativePath
      });
    }
    throw new AdobeBridgeProjectFileError('target_directory_not_visible', error instanceof Error ? error.message : 'Adobe Bridge target directory is not visible.', {
      targetDirectoryProjectRelativePath
    });
  }
}

function assertAdobeBridgeTargetVisible(projectRelativePath: string): void {
  try {
    assertProjectTreeVisibleMutationPath(projectRelativePath);
  } catch {
    throw new AdobeBridgeProjectFileError('target_directory_not_visible', `Adobe Bridge target directory is not visible: ${projectRelativePath}`, {
      projectRelativePath
    });
  }
}

async function writeTransferContent(absolutePath: string, content: Uint8Array | AsyncIterable<Uint8Array>): Promise<void> {
  if (content instanceof Uint8Array) {
    await writeFile(absolutePath, content);
    return;
  }
  const temporaryPath = join(dirname(absolutePath), `.debrute-adobe-transfer-${randomUUID()}.tmp`);
  let moved = false;
  try {
    await pipeline(Readable.from(content), createWriteStream(temporaryPath, { flags: 'wx' }));
    await rename(temporaryPath, absolutePath);
    moved = true;
  } finally {
    if (!moved) {
      await rm(temporaryPath, { force: true });
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}
