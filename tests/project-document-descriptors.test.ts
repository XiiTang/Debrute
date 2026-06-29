import { describe, expect, it } from 'vitest';
import {
  projectDocumentDescriptorForPath,
  projectDocumentDescriptors
} from '../apps/app-server/src/project-documents/documentDescriptors';

describe('Project document descriptors', () => {
  it('declares app-server structured .debrute document roles and owners', () => {
    expect(projectDocumentDescriptors.map((descriptor) => ({
      type: descriptor.type,
      pathPattern: descriptor.pathPattern,
      role: descriptor.role,
      owners: descriptor.owners
    }))).toEqual([
      { type: 'canvas-map', pathPattern: '.debrute/canvas-maps/<canvas-id>.yaml', role: 'source', owners: ['canvas-map', 'canvas-registry'] },
      { type: 'canvas-registry', pathPattern: '.debrute/canvases/index.json', role: 'source', owners: ['canvas-registry'] },
      { type: 'canvas-document', pathPattern: '.debrute/canvases/<canvas-id>.json', role: 'pushed', owners: ['canvas', 'canvas-map', 'canvas-registry'] },
      { type: 'canvas-feedback', pathPattern: '.debrute/reviews/canvas-feedback.json', role: 'metadata', owners: ['canvas-feedback'] },
      { type: 'generated-asset-index', pathPattern: '.debrute/assets/generated-assets-index.json', role: 'metadata', owners: ['generated-assets'] },
      { type: 'generated-asset-record', pathPattern: '.debrute/assets/generated/<record-id>.json', role: 'metadata', owners: ['generated-assets'] },
      { type: 'fingerprint-cache', pathPattern: '.debrute/cache/file-fingerprints.json', role: 'cache', owners: ['generated-assets'] }
    ]);
    expect(projectDocumentDescriptors.every((descriptor) => !Object.hasOwn(descriptor, 'rebuildability'))).toBe(true);
    expect(projectDocumentDescriptors.every((descriptor) => !Object.hasOwn(descriptor, 'writeMode'))).toBe(true);
  });

  it('routes known .debrute paths to descriptors', () => {
    expect(projectDocumentDescriptorForPath('.debrute/project.json')).toBeUndefined();
    expect(projectDocumentDescriptorForPath('.debrute/canvas-maps/canvas-1.yaml')?.type).toBe('canvas-map');
    expect(projectDocumentDescriptorForPath('.debrute/canvases/index.json')?.type).toBe('canvas-registry');
    expect(projectDocumentDescriptorForPath('.debrute/canvases/canvas-1.json')?.type).toBe('canvas-document');
    expect(projectDocumentDescriptorForPath('.debrute/reviews/canvas-feedback.json')?.type).toBe('canvas-feedback');
    expect(projectDocumentDescriptorForPath('.debrute/assets/generated-assets-index.json')?.type).toBe('generated-asset-index');
    expect(projectDocumentDescriptorForPath('.debrute/assets/generated/record-1.json')?.type).toBe('generated-asset-record');
    expect(projectDocumentDescriptorForPath('.debrute/cache/file-fingerprints.json')?.type).toBe('fingerprint-cache');
    expect(projectDocumentDescriptorForPath('.debrute/cache/canvas-image-previews/a/b.webp')).toBeUndefined();
    expect(projectDocumentDescriptorForPath('.debrute/unknown/state.json')).toBeUndefined();
    expect(projectDocumentDescriptorForPath('.debrute/canvas-maps/nested/canvas-1.yaml')).toBeUndefined();
    expect(projectDocumentDescriptorForPath('.debrute/canvas-maps/bad.id.yaml')).toBeUndefined();
    expect(projectDocumentDescriptorForPath('.debrute/canvases/nested/canvas-1.json')).toBeUndefined();
    expect(projectDocumentDescriptorForPath('.debrute/assets/generated/nested/record-1.json')).toBeUndefined();
    expect(projectDocumentDescriptorForPath('.debrute/assets/generated/../escape.json')).toBeUndefined();
  });
});
