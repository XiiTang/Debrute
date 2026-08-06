import {
  canvasPreviewContinuityKey,
  canvasPreviewTargetIdentityFromDigest
} from '@debrute/canvas-core';
import type { ProjectedCanvasNode } from './CanvasScene.js';
import type { CanvasRasterPreviewRequest } from './CanvasRasterPreviewPresentation.js';
import { canvasImageSource } from './canvasImagePreviews.js';
import { canvasRawFileBindingId } from './canvasRawFileUrls.js';

export function canvasImageRasterPreviewRequestForNode(
  node: Pick<ProjectedCanvasNode, 'projectRelativePath' | 'nodeKind' | 'mediaKind' | 'width' | 'availability'>
): CanvasRasterPreviewRequest {
  if (node.nodeKind !== 'file'
    || node.mediaKind !== 'image'
    || node.availability.state !== 'available'
    || node.availability.canvasImagePreviewable !== true) {
    return {};
  }
  const sourceWidth = node.availability.canvasImagePreviewSourceWidth;
  if (typeof sourceWidth !== 'number' || !Number.isFinite(sourceWidth) || sourceWidth <= 0) {
    throw new Error('Canvas previewable image nodes must include a positive finite source width.');
  }
  const bindingId = canvasRawFileBindingId(node.availability.fileUrl);
  const sourceRevision = node.availability.revision;
  const targetIdentity = canvasPreviewTargetIdentityFromDigest(sourceRevision);
  return {
    continuityKey: canvasPreviewContinuityKey({
      mediaKind: 'image',
      bindingId,
      projectRelativePath: node.projectRelativePath,
      continuityIdentity: sourceRevision
    }),
    variantTarget: {
      mediaKind: 'image',
      bindingId,
      projectRelativePath: node.projectRelativePath,
      targetIdentity,
      sourceWidth,
      srcForWidth: (width) => canvasImageSource({
        bindingId,
        projectRelativePath: node.projectRelativePath,
        sourceRevision,
        previewWidth: width
      }).src
    }
  };
}
