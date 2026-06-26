import { readFile, stat } from 'node:fs/promises';
import {
  canvasRasterPreviewWidthsForSource,
  canvasTextPreviewDescriptorProjectPath,
  canvasTextPreviewSourceProjectPath,
  canvasTextPreviewVariantProjectPath,
  normalizeCanvasTextPreviewDescriptor,
  type CanvasTextPreviewDescriptor
} from '@debrute/canvas-core';
import {
  resolveNoSymlinkExistingProjectPath,
  resolveNoSymlinkProjectPathForWrite,
  resolveProjectPath
} from '@debrute/project-core';
import {
  createCanvasRasterPreviewService,
  readCanvasRasterPreviewMetadata,
  writeFileAtomic
} from './CanvasRasterPreviewService.js';

const CANVAS_TEXT_PREVIEW_VARIANT_CONCURRENCY = 24;
const CANVAS_TEXT_PREVIEW_METADATA_CONCURRENCY = 8;

export interface CanvasTextPreviewNodeInput {
  projectRelativePath: string;
  fingerprint: string;
  contentCssWidth: number;
  contentCssHeight: number;
  scrollTop: number;
  scrollLeft: number;
}

export interface CanvasTextPreviewSaveSourceInput extends CanvasTextPreviewNodeInput {
  projectRoot: string;
  canvasId: string;
  sourceTemporaryPath: string;
}

export interface CanvasTextPreviewReadInput {
  projectRoot: string;
  canvasId: string;
  nodes: CanvasTextPreviewNodeInput[];
}

export interface CanvasTextPreviewReconcileInput extends CanvasTextPreviewReadInput {
  devicePixelRatio: number;
}

export interface CanvasTextPreviewResolveVariantInput {
  projectRoot: string;
  canvasId: string;
  projectRelativePath: string;
  fingerprint: string;
  width: number;
}

export interface CanvasTextPreviewService {
  saveSource(input: CanvasTextPreviewSaveSourceInput): Promise<CanvasTextPreviewDescriptor>;
  readDescriptors(input: CanvasTextPreviewReadInput): Promise<Record<string, CanvasTextPreviewDescriptor>>;
  reconcile(input: CanvasTextPreviewReconcileInput): Promise<{ descriptors: Record<string, CanvasTextPreviewDescriptor> }>;
  resolveVariant(input: CanvasTextPreviewResolveVariantInput): Promise<{ absolutePath: string }>;
}

export function createCanvasTextPreviewService(): CanvasTextPreviewService {
  return new LocalCanvasTextPreviewService();
}

class LocalCanvasTextPreviewService implements CanvasTextPreviewService {
  private readonly rasterPreviewService = createCanvasRasterPreviewService({
    generationConcurrency: CANVAS_TEXT_PREVIEW_VARIANT_CONCURRENCY,
    metadataConcurrency: CANVAS_TEXT_PREVIEW_METADATA_CONCURRENCY
  });

  async saveSource(input: CanvasTextPreviewSaveSourceInput): Promise<CanvasTextPreviewDescriptor> {
    const sourceProjectPath = canvasTextPreviewSourceProjectPath(input);
    const descriptorProjectPath = canvasTextPreviewDescriptorProjectPath(input);
    const absoluteSourcePath = await resolveNoSymlinkProjectPathForWrite(input.projectRoot, sourceProjectPath);
    const absoluteDescriptorPath = await resolveNoSymlinkProjectPathForWrite(input.projectRoot, descriptorProjectPath);
    await writeFileAtomic(absoluteSourcePath, await readFile(input.sourceTemporaryPath));
    const metadata = await readCanvasRasterPreviewMetadata(absoluteSourcePath, input.projectRelativePath);
    const sourceWidth = metadata.width;
    const sourceHeight = metadata.height;
    if (typeof sourceWidth !== 'number' || !Number.isFinite(sourceWidth) || sourceWidth <= 0) {
      throw new Error('Canvas text preview source metadata does not include a valid width.');
    }
    if (typeof sourceHeight !== 'number' || !Number.isFinite(sourceHeight) || sourceHeight <= 0) {
      throw new Error('Canvas text preview source metadata does not include a valid height.');
    }
    const descriptor = normalizeCanvasTextPreviewDescriptor({
      fingerprint: input.fingerprint,
      sourceWidth,
      sourceHeight,
      contentCssWidth: input.contentCssWidth,
      contentCssHeight: input.contentCssHeight,
      scrollTop: input.scrollTop,
      scrollLeft: input.scrollLeft,
      variants: []
    });
    await writeTextPreviewDescriptor(absoluteDescriptorPath, descriptor);
    return descriptor;
  }

  async readDescriptors(input: CanvasTextPreviewReadInput): Promise<Record<string, CanvasTextPreviewDescriptor>> {
    const descriptors: Record<string, CanvasTextPreviewDescriptor> = {};
    for (const node of input.nodes) {
      const descriptor = await this.readMatchingDescriptor(input.projectRoot, input.canvasId, node);
      if (!descriptor) {
        continue;
      }
      const existingVariants = await this.existingVariantWidths(input.projectRoot, input.canvasId, node.projectRelativePath, descriptor.variants);
      descriptors[node.projectRelativePath] = {
        ...descriptor,
        variants: existingVariants
      };
    }
    return descriptors;
  }

  async reconcile(input: CanvasTextPreviewReconcileInput): Promise<{ descriptors: Record<string, CanvasTextPreviewDescriptor> }> {
    const entries = await Promise.all(input.nodes.map(async (node) => {
      const descriptor = await this.reconcileNode(input, node);
      return descriptor ? [node.projectRelativePath, descriptor] as const : undefined;
    }));
    const descriptors = Object.fromEntries(entries.filter((entry) => entry !== undefined));
    return { descriptors };
  }

  async resolveVariant(input: CanvasTextPreviewResolveVariantInput): Promise<{ absolutePath: string }> {
    const descriptor = await readTextPreviewDescriptor(input.projectRoot, input);
    if (!descriptor || descriptor.fingerprint !== input.fingerprint || !descriptor.variants.includes(input.width)) {
      throw new Error(`Canvas text preview variant is not available: ${input.projectRelativePath}`);
    }
    return {
      absolutePath: await resolveNoSymlinkExistingProjectPath(input.projectRoot, canvasTextPreviewVariantProjectPath(input))
    };
  }

  private async readMatchingDescriptor(
    projectRoot: string,
    canvasId: string,
    node: CanvasTextPreviewNodeInput
  ): Promise<CanvasTextPreviewDescriptor | undefined> {
    const descriptor = await readTextPreviewDescriptor(projectRoot, {
      canvasId,
      projectRelativePath: node.projectRelativePath
    });
    if (!descriptor || !canvasTextPreviewDescriptorMatchesNode(descriptor, node)) {
      return undefined;
    }
    return descriptor;
  }

  private async existingVariantWidths(
    projectRoot: string,
    canvasId: string,
    projectRelativePath: string,
    variants: number[]
  ): Promise<number[]> {
    const existing: number[] = [];
    for (const width of variants) {
      const projectPath = canvasTextPreviewVariantProjectPath({ canvasId, projectRelativePath, width });
      if (await existingFilePath(projectRoot, projectPath)) {
        existing.push(width);
      }
    }
    return existing;
  }

  private async reconcileNode(
    input: CanvasTextPreviewReconcileInput,
    node: CanvasTextPreviewNodeInput
  ): Promise<CanvasTextPreviewDescriptor | undefined> {
    const descriptor = await this.readMatchingDescriptor(input.projectRoot, input.canvasId, node);
    if (!descriptor) {
      return undefined;
    }
    const sourceProjectPath = canvasTextPreviewSourceProjectPath({
      canvasId: input.canvasId,
      projectRelativePath: node.projectRelativePath
    });
    const absoluteSourcePath = await existingFilePath(input.projectRoot, sourceProjectPath);
    if (!absoluteSourcePath) {
      return undefined;
    }
    const widths = canvasRasterPreviewWidthsForSource({
      sourceWidth: descriptor.sourceWidth,
      devicePixelRatio: input.devicePixelRatio
    });
    const generatedVariants = await Promise.all(widths.map(async (width) => {
      const variantProjectPath = canvasTextPreviewVariantProjectPath({
        canvasId: input.canvasId,
        projectRelativePath: node.projectRelativePath,
        width
      });
      const absoluteVariantPath = await resolveNoSymlinkProjectPathForWrite(input.projectRoot, variantProjectPath);
      const existingVariant = await existingFilePath(input.projectRoot, variantProjectPath);
      if (!existingVariant || !descriptor.variants.includes(width)) {
        await this.rasterPreviewService.generate({
          sourceAbsolutePath: absoluteSourcePath,
          outputAbsolutePath: absoluteVariantPath,
          width,
          outputFormat: 'png'
        });
      }
      return width;
    }));
    const nextDescriptor = normalizeCanvasTextPreviewDescriptor({
      ...descriptor,
      variants: generatedVariants
    });
    await writeTextPreviewDescriptor(
      await resolveNoSymlinkProjectPathForWrite(input.projectRoot, canvasTextPreviewDescriptorProjectPath({
        canvasId: input.canvasId,
        projectRelativePath: node.projectRelativePath
      })),
      nextDescriptor
    );
    return nextDescriptor;
  }
}

async function readTextPreviewDescriptor(
  projectRoot: string,
  input: { canvasId: string; projectRelativePath: string }
): Promise<CanvasTextPreviewDescriptor | undefined> {
  const descriptorPath = await existingFilePath(projectRoot, canvasTextPreviewDescriptorProjectPath(input));
  if (!descriptorPath) {
    return undefined;
  }
  return normalizeCanvasTextPreviewDescriptor(JSON.parse(await readFile(descriptorPath, 'utf8')) as CanvasTextPreviewDescriptor);
}

function canvasTextPreviewDescriptorMatchesNode(
  descriptor: CanvasTextPreviewDescriptor,
  node: CanvasTextPreviewNodeInput
): boolean {
  return descriptor.fingerprint === node.fingerprint
    && descriptor.contentCssWidth === node.contentCssWidth
    && descriptor.contentCssHeight === node.contentCssHeight
    && descriptor.scrollTop === node.scrollTop
    && descriptor.scrollLeft === node.scrollLeft;
}

async function writeTextPreviewDescriptor(
  absolutePath: string,
  descriptor: CanvasTextPreviewDescriptor
): Promise<void> {
  await writeFileAtomic(absolutePath, Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`));
}

async function existingFilePath(projectRoot: string, projectRelativePath: string): Promise<string | undefined> {
  const absolutePath = resolveProjectPath(projectRoot, projectRelativePath);
  try {
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) {
      return undefined;
    }
    return await resolveNoSymlinkExistingProjectPath(projectRoot, projectRelativePath);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}
