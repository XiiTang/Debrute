import { readdir, stat } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import {
  normalizeProjectRelativePath,
  projectFileRevision,
  resolveExistingProjectPath
} from '@debrute/project-core';
import type {
  CanvasVideoPresentation,
  CanvasVideoTextTrack
} from '@debrute/canvas-core';

export interface BuildCanvasVideoPresentationInput {
  projectRoot: string;
  projectRelativePath: string;
  durationSeconds?: number | undefined;
}

export async function buildCanvasVideoPresentation(input: BuildCanvasVideoPresentationInput): Promise<CanvasVideoPresentation> {
  const projectRelativePath = normalizeProjectRelativePath(input.projectRelativePath);
  return {
    kind: 'video',
    ...(input.durationSeconds === undefined ? {} : { durationSeconds: input.durationSeconds }),
    textTracks: await textTracks(input, projectRelativePath)
  };
}

async function textTracks(input: BuildCanvasVideoPresentationInput, videoPath: string): Promise<CanvasVideoTextTrack[]> {
  const candidates = await siblingProjectPaths(input.projectRoot, videoPath);
  const tracks: CanvasVideoTextTrack[] = [];
  for (const path of candidates) {
    const parsed = parseTrackPath(videoPath, path);
    if (!parsed) {
      continue;
    }
    const asset = await companionAsset(input, path);
    if (asset) {
      tracks.push({
        projectRelativePath: asset.projectRelativePath,
        revision: asset.revision,
        kind: parsed.kind,
        label: parsed.label,
        ...(parsed.srclang ? { srclang: parsed.srclang } : {}),
        default: false
      });
    }
  }
  const captionTrackCount = tracks.filter((track) => track.kind === 'captions' || track.kind === 'subtitles').length;
  return tracks
    .sort((left, right) => trackSortRank(left) - trackSortRank(right) || left.projectRelativePath.localeCompare(right.projectRelativePath))
    .map((track) => ({
      ...track,
      default: captionTrackCount === 1 && (track.kind === 'captions' || track.kind === 'subtitles')
    }));
}

function trackSortRank(track: CanvasVideoTextTrack): number {
  if (track.kind === 'captions' || track.kind === 'subtitles') {
    return 0;
  }
  if (track.kind === 'chapters') {
    return 1;
  }
  return 2;
}

function parseTrackPath(videoPath: string, candidatePath: string): Pick<CanvasVideoTextTrack, 'kind' | 'label' | 'srclang'> | undefined {
  if (!candidatePath.endsWith('.vtt')) {
    return undefined;
  }
  const base = basenameWithoutMediaExtension(videoPath);
  const name = candidatePath.split('/').pop() ?? candidatePath;
  if (!name.startsWith(`${base}.`)) {
    return undefined;
  }
  const parts = name.slice(base.length + 1, -'.vtt'.length).split('.').filter(Boolean);
  const marker = parts.at(-1);
  const kind = marker === 'captions'
    ? 'captions'
    : marker === 'subtitles'
      ? 'subtitles'
      : marker === 'chapters'
        ? 'chapters'
        : marker === 'thumbnails' || marker === 'storyboard'
          ? 'metadata'
          : 'subtitles';
  const language = languageForTrackParts(parts, kind);
  return {
    kind,
    label: kind === 'metadata' ? 'thumbnails' : labelForTrack(kind, language),
    ...(language ? { srclang: language } : {})
  };
}

function languageForTrackParts(parts: string[], kind: CanvasVideoTextTrack['kind']): string | undefined {
  if (parts.length === 0 || kind === 'metadata') {
    return undefined;
  }
  const marker = parts.at(-1);
  if (marker === 'captions' || marker === 'subtitles' || marker === 'chapters') {
    return parts.length > 1 ? parts.slice(0, -1).join('.') : undefined;
  }
  return parts.join('.');
}

function labelForTrack(kind: CanvasVideoTextTrack['kind'], language: string | undefined): string {
  if (language === 'en') return kind === 'captions' ? 'English Captions' : 'English';
  if (language === 'zh-CN') return kind === 'captions' ? 'Chinese Captions' : 'Chinese';
  if (language) return language;
  if (kind === 'chapters') return 'Chapters';
  return kind === 'captions' ? 'Captions' : 'Subtitles';
}

async function companionAsset(input: BuildCanvasVideoPresentationInput, projectRelativePath: string): Promise<{
  projectRelativePath: string;
  revision: string;
} | undefined> {
  let absolutePath: string;
  try {
    absolutePath = await resolveExistingProjectPath(input.projectRoot, projectRelativePath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }
  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(absolutePath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }
  if (!fileStat.isFile()) {
    return undefined;
  }
  const revision = projectFileRevision(fileStat.size, fileStat.mtimeMs);
  return {
    projectRelativePath,
    revision
  };
}

async function siblingProjectPaths(projectRoot: string, videoPath: string): Promise<string[]> {
  const directory = dirname(videoPath);
  const absoluteDirectory = await resolveExistingProjectPath(projectRoot, directory === '.' ? '' : directory);
  const base = basenameWithoutMediaExtension(videoPath);
  return (await readdir(absoluteDirectory))
    .filter((name) => name.startsWith(`${base}.`))
    .map((name) => normalizeProjectRelativePath(join(directory, name)))
    .filter((path) => path !== videoPath && path.endsWith('.vtt'))
    .sort();
}

function basenameWithoutMediaExtension(projectRelativePath: string): string {
  const name = projectRelativePath.split('/').pop() ?? projectRelativePath;
  const extension = extname(name);
  return extension ? name.slice(0, -extension.length) : name;
}

function isNotFoundError(error: unknown): boolean {
  return isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}
