import { chmod } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import AdmZip from 'adm-zip';
import type { AxisCliTarget } from './axisCliPaths.js';

const execFileAsync = promisify(execFile);

export async function extractAxisCliArchive(input: {
  archivePath: string;
  destinationDir: string;
  target: AxisCliTarget;
}): Promise<void> {
  try {
    if (input.target.archiveExtension === 'zip') {
      const zip = new AdmZip(input.archivePath);
      zip.extractAllTo(input.destinationDir, true);
      return;
    }
    await execFileAsync('tar', ['-xzf', input.archivePath, '-C', input.destinationDir]);
  } catch (error) {
    throw Object.assign(new Error('AXIS CLI archive extraction failed.'), {
      code: 'archive_extract_failed',
      path: input.archivePath,
      cause: error
    });
  }
}

export async function ensureAxisCliExecutable(path: string, platform: NodeJS.Platform): Promise<void> {
  if (platform !== 'win32') {
    await chmod(path, 0o755);
  }
}
