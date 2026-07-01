import { spawn } from 'node:child_process';
import { resolveExistingProjectPath } from '@debrute/project-core';
import type { CanvasLayoutSize, CanvasMediaKind, CanvasNodeKind } from '@debrute/canvas-core';
import sharp from 'sharp';

export interface ReadCanvasNodeLayoutSizeInput {
  projectRoot: string;
  projectRelativePath: string;
  nodeKind: CanvasNodeKind;
  mediaKind: CanvasMediaKind;
  envPath?: string;
}

export interface ReadCanvasVideoMetadataInput {
  projectRoot: string;
  projectRelativePath: string;
  envPath?: string;
}

export interface CanvasVideoMetadata extends CanvasLayoutSize {
  durationSeconds?: number;
}

const FIXED_CANVAS_LAYOUT_SCALE = 10;
const GENERIC_NODE_MAX_VISUAL_WIDTH = 480;
const LATIN_CHARACTER_VISUAL_WIDTH = 8;
const FULL_WIDTH_CHARACTER_VISUAL_WIDTH = 16;
const DIRECTORY_CANVAS_LAYOUT_HEIGHT = 96;
const GENERIC_NODE_MIN_VISUAL_WIDTH = 150;
const TEXT_CANVAS_LAYOUT_SIZE = scaledFixedCanvasLayoutSize({ width: 420, height: 280 });
const AUDIO_CANVAS_LAYOUT_SIZE = scaledFixedCanvasLayoutSize({ width: 320, height: 96 });
const UNKNOWN_CANVAS_LAYOUT_HEIGHT = 120;
const PROJECT_ROOT_DISPLAY_NAME = 'Project Root';

export async function readCanvasNodeLayoutSize(input: ReadCanvasNodeLayoutSizeInput): Promise<CanvasLayoutSize> {
  if (input.nodeKind === 'directory') {
    return genericCanvasLayoutSize({
      projectRelativePath: input.projectRelativePath,
      height: DIRECTORY_CANVAS_LAYOUT_HEIGHT
    });
  }
  if (input.mediaKind === 'text') {
    return TEXT_CANVAS_LAYOUT_SIZE;
  }
  if (input.mediaKind === 'audio') {
    return AUDIO_CANVAS_LAYOUT_SIZE;
  }
  if (input.mediaKind === 'unknown') {
    return genericCanvasLayoutSize({
      projectRelativePath: input.projectRelativePath,
      height: UNKNOWN_CANVAS_LAYOUT_HEIGHT
    });
  }
  const absolutePath = await resolveExistingProjectPath(input.projectRoot, input.projectRelativePath);
  if (input.mediaKind === 'image') {
    return readImageLayoutSize(absolutePath);
  }
  return readVideoLayoutSize(absolutePath, input.envPath);
}

export async function readCanvasVideoMetadata(input: ReadCanvasVideoMetadataInput): Promise<CanvasVideoMetadata> {
  const absolutePath = await resolveExistingProjectPath(input.projectRoot, input.projectRelativePath);
  return readVideoMetadata(absolutePath, input.envPath);
}

async function readImageLayoutSize(absolutePath: string): Promise<CanvasLayoutSize> {
  const metadata = await sharp(absolutePath).metadata();
  if (!isPositiveDimension(metadata.width) || !isPositiveDimension(metadata.height)) {
    throw new Error('Image dimensions could not be read.');
  }
  return {
    width: metadata.width,
    height: metadata.height
  };
}

async function readVideoLayoutSize(
  absolutePath: string,
  envPath: string | undefined
): Promise<CanvasLayoutSize> {
  const metadata = await readVideoMetadata(absolutePath, envPath);
  return {
    width: metadata.width,
    height: metadata.height
  };
}

async function readVideoMetadata(
  absolutePath: string,
  envPath: string | undefined
): Promise<CanvasVideoMetadata> {
  return parseFfprobeVideoMetadata(await runFfprobe(absolutePath, envPath));
}

export function parseFfprobeDimensions(stdout: string): CanvasLayoutSize {
  const metadata = parseFfprobeVideoMetadata(stdout);
  return {
    width: metadata.width,
    height: metadata.height
  };
}

export function parseFfprobeVideoMetadata(stdout: string): CanvasVideoMetadata {
  const parsed = JSON.parse(stdout) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.streams)) {
    throw new Error('ffprobe output did not include streams.');
  }
  const stream = parsed.streams.find((item) => isRecord(item)
    && item.codec_type === 'video'
    && isPositiveDimension(item.width)
    && isPositiveDimension(item.height));
  if (!isRecord(stream) || !isPositiveDimension(stream.width) || !isPositiveDimension(stream.height)) {
    throw new Error('ffprobe output did not include video width and height.');
  }
  const durationSeconds = positiveSeconds(stream.duration) ?? (
    isRecord(parsed.format) ? positiveSeconds(parsed.format.duration) : undefined
  );
  return {
    width: stream.width,
    height: stream.height,
    ...(durationSeconds === undefined ? {} : { durationSeconds })
  };
}

function runFfprobe(absolutePath: string, envPath: string | undefined): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_type,width,height,duration:format=duration',
      '-of',
      'json',
      absolutePath
    ], {
      env: {
        ...process.env,
        ...(envPath !== undefined ? { PATH: envPath } : {})
      }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr.trim() || `ffprobe exited with code ${code}.`));
    });
  });
}

function isPositiveDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function positiveSeconds(value: unknown): number | undefined {
  const numberValue = typeof value === 'string' && value.trim() !== ''
    ? Number(value)
    : typeof value === 'number'
      ? value
      : Number.NaN;
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scaledFixedCanvasLayoutSize(size: CanvasLayoutSize): CanvasLayoutSize {
  return {
    width: size.width * FIXED_CANVAS_LAYOUT_SCALE,
    height: size.height * FIXED_CANVAS_LAYOUT_SCALE
  };
}

function genericCanvasLayoutSize(input: {
  projectRelativePath: string;
  height: number;
}): CanvasLayoutSize {
  return scaledFixedCanvasLayoutSize({
    width: genericVisualWidthForDisplayName(displayNameForCanvasLayout(input.projectRelativePath)),
    height: input.height
  });
}

function displayNameForCanvasLayout(projectRelativePath: string): string {
  if (projectRelativePath === '') {
    return PROJECT_ROOT_DISPLAY_NAME;
  }
  return projectRelativePath.split('/').pop() ?? projectRelativePath;
}

function genericVisualWidthForDisplayName(displayName: string): number {
  const labelWidth = Array.from(displayName).reduce(
    (width, character) => width + visualWidthForDisplayNameCharacter(character),
    0
  );
  return Math.min(
    GENERIC_NODE_MAX_VISUAL_WIDTH,
    Math.max(GENERIC_NODE_MIN_VISUAL_WIDTH, labelWidth)
  );
}

function visualWidthForDisplayNameCharacter(character: string): number {
  const codePoint = character.codePointAt(0);
  if (codePoint !== undefined && isFullWidthCodePoint(codePoint)) {
    return FULL_WIDTH_CHARACTER_VISUAL_WIDTH;
  }
  return LATIN_CHARACTER_VISUAL_WIDTH;
}

function isFullWidthCodePoint(codePoint: number): boolean {
  return (codePoint >= 0x1100 && codePoint <= 0x115f)
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f300 && codePoint <= 0x1faff);
}
