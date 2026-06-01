import { describe, expect, it } from 'vitest';
import {
  CANVAS_PREVIEW_PROTOCOL,
  PROJECT_FILE_PROTOCOL,
  assertProjectFileRevision,
  canvasPreviewRequestFromProtocolUrl,
  projectFileRequestFromProtocolUrl,
  projectRelativePathFromProtocolUrl
} from '../apps/desktop/src/electron/protocols/projectProtocols';

describe('desktop canvas image preview protocol URLs', () => {
  it('parses original project-file URLs without exposing arbitrary hosts or empty paths', () => {
    expect(projectRelativePathFromProtocolUrl(
      'axis-project-file://project/flow/cover%20art.png?v=rev',
      PROJECT_FILE_PROTOCOL
    )).toBe('flow/cover art.png');
    expect(projectFileRequestFromProtocolUrl(
      'axis-project-file://project/flow/cover%20art.png?v=rev'
    )).toEqual({
      projectRelativePath: 'flow/cover art.png',
      revision: 'rev'
    });

    expect(() => projectRelativePathFromProtocolUrl(
      'axis-project-file://other/flow/cover.png?v=rev',
      PROJECT_FILE_PROTOCOL
    )).toThrow('Invalid project file URL');
    expect(() => projectRelativePathFromProtocolUrl(
      'axis-project-file://project/?v=rev',
      PROJECT_FILE_PROTOCOL
    )).toThrow('Project file URL is missing a path');
    expect(() => projectFileRequestFromProtocolUrl(
      'axis-project-file://project/flow/cover.png'
    )).toThrow('Project file URL is missing a revision');
    expect(() => projectFileRequestFromProtocolUrl(
      'axis-project-file://project/flow/cover.png?v=rev&retry=1'
    )).toThrow('Unexpected project file URL parameter');
  });

  it('rejects stale original project-file revisions', () => {
    expect(() => assertProjectFileRevision({
      projectRelativePath: 'flow/cover.png',
      revision: '1001:2048',
      size: 2048,
      mtimeMs: 1001.2
    })).not.toThrow();

    expect(() => assertProjectFileRevision({
      projectRelativePath: 'flow/cover.png',
      revision: 'stale',
      size: 2048,
      mtimeMs: 1001.2
    })).toThrow('Project file revision does not match source');
  });

  it('parses canvas preview URLs and rejects missing revisions or unsupported widths', () => {
    expect(canvasPreviewRequestFromProtocolUrl(
      'axis-canvas-preview://project/flow/cover%20art.png?v=123%3A456&w=512'
    )).toEqual({
      projectRelativePath: 'flow/cover art.png',
      revision: '123:456',
      width: 512
    });

    expect(() => canvasPreviewRequestFromProtocolUrl(
      'axis-canvas-preview://project/flow/cover.png?w=512'
    )).toThrow('Canvas preview URL is missing a revision');
    expect(() => canvasPreviewRequestFromProtocolUrl(
      'axis-canvas-preview://project/flow/cover.png?v=rev&w=300'
    )).toThrow('Unsupported Canvas preview width');
    expect(() => canvasPreviewRequestFromProtocolUrl(
      'axis-canvas-preview://project/flow/cover.png?v=rev&w=0512'
    )).toThrow('Unsupported Canvas preview width');
    expect(() => canvasPreviewRequestFromProtocolUrl(
      'axis-canvas-preview://project/flow/cover.png?v=rev&w=512.0'
    )).toThrow('Unsupported Canvas preview width');
    expect(() => canvasPreviewRequestFromProtocolUrl(
      'axis-canvas-preview://project/flow/cover.png?v=rev&w=512&retry=1'
    )).toThrow('Unexpected Canvas preview URL parameter');
    expect(() => projectRelativePathFromProtocolUrl(
      'axis-project-file://project/flow/cover.png?v=rev',
      CANVAS_PREVIEW_PROTOCOL
    )).toThrow('Invalid project file URL');
  });
});
