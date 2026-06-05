import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile, stat } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { promisify } from 'node:util';
import AdmZip from 'adm-zip';

const execFileAsync = promisify(execFile);

export type Sha256Manifest = Map<string, string>;
type ArchiveEntryType = 'file' | 'directory' | 'symlink' | 'hardlink' | 'other';

export interface ArchiveEntryInfo {
  name: string;
  type?: ArchiveEntryType;
}

export function parseSha256Manifest(text: string): Sha256Manifest {
  const manifest = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(trimmed);
    if (!match) continue;
    manifest.set(match[2]!, match[1]!.toLowerCase());
  }
  return manifest;
}

export function checksumForAsset(manifest: Sha256Manifest, assetName: string): string {
  const checksum = manifest.get(assetName);
  if (!checksum) {
    throw new Error(`Checksum manifest does not include ${assetName}.`);
  }
  return checksum;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return hash.digest('hex');
}

export function assertSafeArchiveEntries(entries: Array<string | ArchiveEntryInfo>): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    const entryName = typeof entry === 'string' ? entry : entry.name;
    const entryType = typeof entry === 'string' ? undefined : entry.type;
    const normalized = normalize(entryName).replace(/\\/g, '/');
    if (
      normalized.startsWith('/')
      || /^[A-Za-z]:/.test(normalized)
      || normalized === '..'
      || normalized.startsWith('../')
      || normalized.includes('/../')
      || normalized.length === 0
    ) {
      throw new Error(`Unsafe Debrute CLI archive entry: ${entryName}`);
    }
    if (seen.has(normalized)) {
      throw new Error(`Duplicate Debrute CLI archive entry: ${entryName}`);
    }
    if (entryType && entryType !== 'file' && entryType !== 'directory') {
      throw new Error(`Unsafe Debrute CLI archive entry type for ${entryName}.`);
    }
    seen.add(normalized);
  }
}

export async function extractDebruteCliArchive(input: {
  archivePath: string;
  destinationDir: string;
  platform: NodeJS.Platform;
}): Promise<void> {
  if (input.platform === 'win32') {
    const zip = new AdmZip(input.archivePath);
    assertSafeArchiveEntries(zip.getEntries().map(zipArchiveEntryInfo));
    zip.extractAllTo(input.destinationDir, true);
    return;
  }

  const list = await execFileAsync('tar', ['-tzf', input.archivePath]);
  assertSafeArchiveEntries(list.stdout.split(/\r?\n/).filter(Boolean));
  const verboseList = await execFileAsync('tar', ['-tvzf', input.archivePath]);
  assertSafeArchiveEntries(tarVerboseEntries(verboseList.stdout));
  await execFileAsync('tar', ['-xzf', input.archivePath, '-C', input.destinationDir]);
}

export async function validateExtractedDebruteCliPayload(input: { root: string; executableName: string }): Promise<void> {
  const executable = join(input.root, input.executableName);
  const skills = join(input.root, 'skills');
  const executableStat = await stat(executable).catch(() => undefined);
  if (!executableStat?.isFile()) {
    throw new Error(`Extracted Debrute CLI payload is missing executable ${input.executableName}.`);
  }
  const skillsStat = await stat(skills).catch(() => undefined);
  if (!skillsStat?.isDirectory()) {
    throw new Error('Extracted Debrute CLI payload is missing skills/.');
  }
  await access(skills);
}

function tarVerboseEntries(stdout: string): ArchiveEntryInfo[] {
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => ({
      name: line,
      type: tarModeType(line[0])
    }));
}

function tarModeType(mode: string | undefined): ArchiveEntryType {
  if (mode === '-') return 'file';
  if (mode === 'd') return 'directory';
  if (mode === 'l') return 'symlink';
  if (mode === 'h') return 'hardlink';
  return 'other';
}

function zipArchiveEntryInfo(entry: AdmZip.IZipEntry): ArchiveEntryInfo {
  return {
    name: entry.entryName,
    type: zipEntryType(entry)
  };
}

function zipEntryType(entry: AdmZip.IZipEntry): ArchiveEntryType {
  if (entry.isDirectory) return 'directory';
  const unixFileType = (entry.attr >>> 16) & 0o170000;
  if (unixFileType === 0o120000) return 'symlink';
  if (unixFileType === 0o100000 || unixFileType === 0) return 'file';
  if (unixFileType === 0o040000) return 'directory';
  return 'other';
}
