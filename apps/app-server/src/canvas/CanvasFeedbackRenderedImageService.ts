import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import {
  canvasFeedbackRenderedProjectPath,
  type CanvasImageFeedbackRegion,
  type Diagnostic
} from '@debrute/canvas-core';
import {
  resolveExistingProjectPath,
  resolveProjectPath
} from '@debrute/project-core';
import type {
  CanvasFeedbackRenderJobInput,
  CanvasFeedbackRenderJobSuccess
} from './CanvasFeedbackRenderedImageWorkerProtocol.js';

const RENDERED_FEEDBACK_PROJECT_PATH = '.debrute/reviews/rendered-feedback';

export async function renderCanvasFeedbackAnnotatedImage(
  input: CanvasFeedbackRenderJobInput
): Promise<CanvasFeedbackRenderJobSuccess> {
  const absoluteSourcePath = await resolveExistingProjectPath(input.projectRoot, input.entry.projectRelativePath);
  const normalizedSourcePng = await sharp(absoluteSourcePath).rotate().png().toBuffer();
  const metadata = await sharp(normalizedSourcePng).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error(`Canvas feedback rendered image metadata is unavailable: ${input.entry.projectRelativePath}`);
  }
  const overlay = createCanvasFeedbackOverlaySvg({
    width: metadata.width,
    height: metadata.height,
    entry: input.entry
  });
  const output = await sharp(normalizedSourcePng)
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

export async function removeCanvasFeedbackRenderedArtifact(projectRoot: string, projectRelativePath: string): Promise<void> {
  await rm(resolveProjectPath(projectRoot, canvasFeedbackRenderedProjectPath(projectRelativePath)), { force: true });
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
    if (!projectRelativePath.endsWith('.tmp') && !expectedProjectPaths.has(projectRelativePath)) {
      await rm(resolveProjectPath(projectRoot, projectRelativePath), { force: true });
    }
  }
}

export function createCanvasFeedbackOverlaySvg(input: {
  width: number;
  height: number;
  entry: { regions: CanvasImageFeedbackRegion[] };
}): string {
  const content = input.entry.regions.map((region) => regionSvg(region, input.width, input.height)).join('\n');
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

export function canvasFeedbackRenderDiagnostic(projectRoot: string, projectRelativePath: string, error: unknown): Diagnostic {
  return {
    id: `canvas-feedback.render_failed:${projectRelativePath}`,
    source: 'project',
    severity: 'error',
    code: 'canvas-feedback.render_failed',
    message: `Canvas feedback rendered image could not be created for ${projectRelativePath}: ${errorMessage(error)}`,
    filePath: resolveProjectPath(projectRoot, projectRelativePath),
    entityId: projectRelativePath
  };
}

function regionSvg(region: CanvasImageFeedbackRegion, width: number, height: number): string {
  const geometry = region.geometry;
  switch (geometry.type) {
  case 'point': {
    const cx = Math.round(geometry.x * width);
    const cy = Math.round(geometry.y * height);
    return `${badgeSvg(region.label, cx, cy)}
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
${badgeSvg(region.label, x, y)}`;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
