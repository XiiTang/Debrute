import { ProjectDocumentRegistry, type ProjectDocumentDescriptor } from './ProjectDocumentRegistry.js';

export const projectDocumentDescriptors: ProjectDocumentDescriptor[] = [
  descriptor('canvas-map', '.debrute/canvas-maps/<canvas-id>.yaml', 'source', ['canvas-map', 'canvas-registry'], (path) => (
    /^\.debrute\/canvas-maps\/[A-Za-z0-9][A-Za-z0-9_-]*\.yaml$/.test(path)
  )),
  descriptor('canvas-registry', '.debrute/canvases/index.json', 'source', ['canvas-registry'], (path) => (
    path === '.debrute/canvases/index.json'
  )),
  descriptor('canvas-document', '.debrute/canvases/<canvas-id>.json', 'pushed', ['canvas', 'canvas-map', 'canvas-registry'], (path) => (
    /^\.debrute\/canvases\/[A-Za-z0-9][A-Za-z0-9_-]*\.json$/.test(path)
    && path !== '.debrute/canvases/index.json'
  )),
  descriptor('canvas-feedback', '.debrute/reviews/canvas-feedback.json', 'metadata', ['canvas-feedback'], (path) => (
    path === '.debrute/reviews/canvas-feedback.json'
  )),
  descriptor('generated-asset-index', '.debrute/assets/generated-assets-index.json', 'metadata', ['generated-assets'], (path) => (
    path === '.debrute/assets/generated-assets-index.json'
  )),
  descriptor('generated-asset-record', '.debrute/assets/generated/<record-id>.json', 'metadata', ['generated-assets'], (path) => (
    /^\.debrute\/assets\/generated\/[A-Za-z0-9][A-Za-z0-9_.-]*\.json$/.test(path)
  )),
  descriptor('fingerprint-cache', '.debrute/cache/file-fingerprints.json', 'cache', ['generated-assets'], (path) => (
    path === '.debrute/cache/file-fingerprints.json'
  ))
];

export const projectDocumentRegistry = new ProjectDocumentRegistry(projectDocumentDescriptors);

export function projectDocumentDescriptorForPath(projectRelativePath: string): ProjectDocumentDescriptor | undefined {
  return projectDocumentRegistry.descriptorForPath(projectRelativePath);
}

function descriptor(
  type: string,
  pathPattern: string,
  role: ProjectDocumentDescriptor['role'],
  owners: readonly string[],
  matches: (projectRelativePath: string) => boolean
): ProjectDocumentDescriptor {
  return { type, pathPattern, role, owners, matches };
}
