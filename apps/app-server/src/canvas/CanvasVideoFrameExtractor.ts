import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface CanvasVideoFrameExtractorInput {
  videoAbsolutePath: string;
  outputAbsolutePath: string;
  projectRelativePath: string;
  currentTimeSeconds: number;
}

export interface CanvasVideoFrameExtractor {
  extractFrame(input: CanvasVideoFrameExtractorInput): Promise<void>;
}

export function createCanvasVideoFrameExtractor(input: {
  envPath?: string | undefined;
} = {}): CanvasVideoFrameExtractor {
  return new FfmpegCanvasVideoFrameExtractor(input.envPath);
}

class FfmpegCanvasVideoFrameExtractor implements CanvasVideoFrameExtractor {
  constructor(private readonly envPath: string | undefined) {}

  async extractFrame(input: CanvasVideoFrameExtractorInput): Promise<void> {
    await mkdir(dirname(input.outputAbsolutePath), { recursive: true });
    const temporaryOutputPath = `${input.outputAbsolutePath}.${randomUUID()}.tmp.jpg`;
    try {
      await runFfmpeg([
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-ss',
        String(input.currentTimeSeconds),
        '-i',
        input.videoAbsolutePath,
        '-frames:v',
        '1',
        temporaryOutputPath
      ], this.envPath);
      await rename(temporaryOutputPath, input.outputAbsolutePath);
    } catch (error) {
      await rm(temporaryOutputPath, { force: true });
      throw error;
    }
  }
}

async function runFfmpeg(args: string[], envPath: string | undefined): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('ffmpeg', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        ...(envPath !== undefined ? { PATH: envPath } : {})
      }
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}.`));
    });
  });
}
