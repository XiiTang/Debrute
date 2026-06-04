import { spawn } from 'node:child_process';
import { resolveExistingProjectPath } from '@axis/project-core';
import type { CanvasLayoutSize, CanvasMediaKind, CanvasNodeKind } from '@axis/canvas-core';
import sharp from 'sharp';

export interface ReadCanvasNodeLayoutSizeInput {
  projectRoot: string;
  projectRelativePath: string;
  nodeKind: CanvasNodeKind;
  mediaKind: CanvasMediaKind;
  envPath?: string;
}

const FIXED_CANVAS_LAYOUT_SCALE = 10;
const DIRECTORY_CANVAS_LAYOUT_SIZE = scaledFixedCanvasLayoutSize({ width: 240, height: 96 });
const TEXT_CANVAS_LAYOUT_SIZE = scaledFixedCanvasLayoutSize({ width: 420, height: 280 });
const AUDIO_CANVAS_LAYOUT_SIZE = scaledFixedCanvasLayoutSize({ width: 320, height: 96 });
const UNKNOWN_CANVAS_LAYOUT_SIZE = scaledFixedCanvasLayoutSize({ width: 260, height: 120 });

export async function readCanvasNodeLayoutSize(input: ReadCanvasNodeLayoutSizeInput): Promise<CanvasLayoutSize> {
  if (input.nodeKind === 'directory') {
    return DIRECTORY_CANVAS_LAYOUT_SIZE;
  }
  if (input.mediaKind === 'text') {
    return TEXT_CANVAS_LAYOUT_SIZE;
  }
  if (input.mediaKind === 'audio') {
    return AUDIO_CANVAS_LAYOUT_SIZE;
  }
  if (input.mediaKind === 'unknown') {
    return UNKNOWN_CANVAS_LAYOUT_SIZE;
  }
  const absolutePath = await resolveExistingProjectPath(input.projectRoot, input.projectRelativePath);
  if (input.mediaKind === 'image') {
    return readImageLayoutSize(absolutePath);
  }
  return readVideoLayoutSize(absolutePath, input.envPath);
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
  return parseFfprobeDimensions(await runFfprobe(absolutePath, envPath));
}

export function parseFfprobeDimensions(stdout: string): CanvasLayoutSize {
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
  return {
    width: stream.width,
    height: stream.height
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
      'stream=codec_type,width,height',
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scaledFixedCanvasLayoutSize(size: CanvasLayoutSize): CanvasLayoutSize {
  return {
    width: size.width * FIXED_CANVAS_LAYOUT_SCALE,
    height: size.height * FIXED_CANVAS_LAYOUT_SCALE
  };
}
