import { describe, expect, it } from 'vitest';
import {
  CanvasTextPreviewFailure,
  canvasTextPreviewFailureFromUnknown
} from './CanvasTextPreviewFailure';

const fields = {
  canvasId: 'canvas-1',
  projectRelativePath: 'references/art/api/12_cma_1993.143.json',
  fingerprint: 'sha256:current'
};

describe('CanvasTextPreviewFailure', { tags: ['canvas-text'] }, () => {
  it('preserves the owned stage and concrete Error message', () => {
    const failure = canvasTextPreviewFailureFromUnknown(
      'source_upload_failed',
      fields,
      new Error('HTTP 500 while saving source.png')
    );

    expect(failure).toBeInstanceOf(CanvasTextPreviewFailure);
    expect(failure.stage).toBe('source_upload_failed');
    expect(failure.message).toBe('HTTP 500 while saving source.png');
    expect(failure.fields).toEqual(fields);
  });

  it('turns a browser Event into a stable owned-stage message', () => {
    const failure = canvasTextPreviewFailureFromUnknown(
      'raster_failed',
      { ...fields, sceneWidth: 420, sceneHeight: 280 },
      new Event('error')
    );

    expect(failure.message).toBe('Canvas text preview raster failed (browser event: error).');
    expect(failure.message).not.toContain('[object Event]');
  });

  it('uses a stage-specific message for an uninformative rejection', () => {
    expect(canvasTextPreviewFailureFromUnknown(
      'preview_decode_failed',
      fields,
      undefined
    ).message).toBe('Canvas text preview variant decode failed.');
  });
});
