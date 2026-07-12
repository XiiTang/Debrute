import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import {
  canvasFeedbackSpatialItemsForMoment,
  type CanvasFeedbackSpatialItem,
  type Diagnostic
} from '@debrute/canvas-core';
import {
  resolveExistingProjectPath,
  resolveProjectPath
} from '@debrute/project-core';
import {
  createCanvasVideoFrameExtractor,
  type CanvasVideoFrameExtractor
} from './CanvasVideoFrameExtractor.js';
import type {
  CanvasFeedbackArtifact,
  CanvasFeedbackRenderJobInput,
  CanvasFeedbackRenderJobSuccess
} from './CanvasFeedbackArtifactWorkerProtocol.js';

const RENDERED_FEEDBACK_PROJECT_PATH = '.debrute/reviews/rendered-feedback';
const TEMPORARY_ARTIFACT_PATH_PATTERN = /\.annotated\.png\.[^/.]+\.tmp(?:\.frame\.png)?$/;

export async function renderCanvasFeedbackArtifact(
  input: CanvasFeedbackRenderJobInput,
  options: { frameExtractor?: CanvasVideoFrameExtractor | undefined } = {}
): Promise<CanvasFeedbackRenderJobSuccess> {
  const sourcePng = input.artifact.kind === 'image'
    ? await imageArtifactSourcePng(input)
    : await videoMomentArtifactSourcePng(input, options.frameExtractor ?? createCanvasVideoFrameExtractor());
  const metadata = await sharp(sourcePng).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error(`Canvas feedback artifact metadata is unavailable: ${input.artifact.projectRelativePath}`);
  }
  const overlay = createCanvasFeedbackOverlaySvg({
    width: metadata.width,
    height: metadata.height,
    items: artifactSpatialItems(input.artifact)
  });
  const output = await sharp(sourcePng)
    .composite([{ input: Buffer.from(overlay), left: 0, top: 0 }])
    .png()
    .toBuffer();
  await mkdir(dirname(input.outputPath), { recursive: true });
  await writeFile(input.outputPath, output);
  return {
    ok: true,
    jobId: input.jobId,
    outputPath: input.outputPath,
    width: metadata.width,
    height: metadata.height
  };
}

export async function removeCanvasFeedbackRenderedArtifact(projectRoot: string, artifactProjectPath: string): Promise<void> {
  await rm(resolveProjectPath(projectRoot, artifactProjectPath), { force: true });
}

export async function removeUnexpectedCanvasFeedbackRenderedArtifacts(
  projectRoot: string,
  expectedProjectPaths: Set<string>
): Promise<void> {
  const artifactPaths = await renderedFeedbackArtifactPaths(
    resolveProjectPath(projectRoot, RENDERED_FEEDBACK_PROJECT_PATH),
    RENDERED_FEEDBACK_PROJECT_PATH
  );
  for (const projectRelativePath of artifactPaths) {
    if (!isCanvasFeedbackTemporaryArtifactPath(projectRelativePath) && !expectedProjectPaths.has(projectRelativePath)) {
      await rm(resolveProjectPath(projectRoot, projectRelativePath), { force: true });
    }
  }
}

export function createCanvasFeedbackOverlaySvg(input: {
  width: number;
  height: number;
  items: readonly CanvasFeedbackSpatialItem[];
}): string {
  const content = input.items.map((item) => spatialItemSvg(item, input.width, input.height)).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${input.width}" height="${input.height}" viewBox="0 0 ${input.width} ${input.height}">
  <style>
    .shape { fill: none; stroke: #ffcc00; stroke-width: 4; paint-order: stroke; }
    .halo { fill: none; stroke: #101010; stroke-width: 7; opacity: 0.82; }
    .badge { fill: #ffcc00; stroke: #101010; stroke-width: 3; }
    .label { fill: #101010; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 18px; font-weight: 700; text-anchor: middle; dominant-baseline: central; }
  </style>
  ${content}
</svg>`;
}

export function canvasFeedbackRenderDiagnostic(
  projectRoot: string,
  artifact: CanvasFeedbackArtifact,
  diagnosticProjectRelativePath: string,
  error: unknown
): Diagnostic {
  const suffix = artifact.kind === 'video-moment' ? ` at ${artifact.moment.label}` : '';
  return {
    id: `canvas-feedback.render_failed:${diagnosticProjectRelativePath}`,
    source: 'project',
    severity: 'error',
    code: 'canvas-feedback.render_failed',
    message: `Canvas feedback artifact could not be created for ${artifact.projectRelativePath}${suffix}: ${errorMessage(error)}`,
    filePath: resolveProjectPath(projectRoot, artifact.projectRelativePath),
    entityId: diagnosticProjectRelativePath
  };
}

async function imageArtifactSourcePng(input: CanvasFeedbackRenderJobInput): Promise<Buffer> {
  const absoluteSourcePath = await resolveExistingProjectPath(input.projectRoot, input.artifact.projectRelativePath);
  return sharp(absoluteSourcePath).rotate().png().toBuffer();
}

async function videoMomentArtifactSourcePng(
  input: CanvasFeedbackRenderJobInput,
  frameExtractor: CanvasVideoFrameExtractor
): Promise<Buffer> {
  if (input.artifact.kind !== 'video-moment') {
    throw new Error('Canvas feedback video frame extraction requires a video moment artifact.');
  }
  const videoAbsolutePath = await resolveExistingProjectPath(input.projectRoot, input.artifact.projectRelativePath);
  const framePath = `${input.outputPath}.frame.png`;
  try {
    await frameExtractor.extractFrame({
      videoAbsolutePath,
      outputAbsolutePath: framePath,
      projectRelativePath: input.artifact.projectRelativePath,
      currentTimeSeconds: input.artifact.moment.currentTimeSeconds
    });
    return await sharp(framePath).rotate().png().toBuffer();
  } finally {
    await rm(framePath, { force: true });
  }
}

function artifactSpatialItems(artifact: CanvasFeedbackArtifact): readonly CanvasFeedbackSpatialItem[] {
  if (artifact.kind === 'image') {
    return artifact.entry.items.filter((item): item is CanvasFeedbackSpatialItem => (
      (item.kind === 'pin' || item.kind === 'region') && item.scope === 'file'
    ));
  }
  return canvasFeedbackSpatialItemsForMoment(artifact.entry, artifact.moment);
}

function spatialItemSvg(item: CanvasFeedbackSpatialItem, width: number, height: number): string {
  const geometry = item.geometry;
  switch (geometry.type) {
  case 'point': {
    const cx = Math.round(geometry.x * width);
    const cy = Math.round(geometry.y * height);
    return `${badgeSvg(item.label, cx, cy)}
<path class="halo" d="M ${cx} ${cy + 14} L ${cx} ${cy + 31}" />
<path class="shape" d="M ${cx} ${cy + 14} L ${cx} ${cy + 31}" />`;
  }
  case 'rect': {
    const x = Math.round(geometry.x * width);
    const y = Math.round(geometry.y * height);
    const w = Math.round(geometry.width * width);
    const h = Math.round(geometry.height * height);
    return `<rect class="halo" x="${x}" y="${y}" width="${w}" height="${h}" />
<rect class="shape" x="${x}" y="${y}" width="${w}" height="${h}" />
${badgeSvg(item.label, x, y)}`;
  }
  }
}

function badgeSvg(label: number, cx: number, cy: number): string {
  return `<circle class="badge" cx="${cx}" cy="${cy}" r="15" /><text class="label" x="${cx}" y="${cy}">${label}</text>`;
}

async function renderedFeedbackArtifactPaths(absoluteDirectoryPath: string, projectDirectoryPath: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(absoluteDirectoryPath, { withFileTypes: true });
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }
    throw error;
  }

  const paths: string[] = [];
  for (const entry of entries) {
    const absoluteEntryPath = join(absoluteDirectoryPath, entry.name);
    const projectEntryPath = `${projectDirectoryPath}/${entry.name}`;
    if (entry.isDirectory()) {
      paths.push(...await renderedFeedbackArtifactPaths(absoluteEntryPath, projectEntryPath));
    } else if (entry.isFile()) {
      paths.push(projectEntryPath);
    }
  }
  return paths;
}

function isNotFoundError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function isCanvasFeedbackTemporaryArtifactPath(projectRelativePath: string): boolean {
  return TEMPORARY_ARTIFACT_PATH_PATTERN.test(projectRelativePath);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
