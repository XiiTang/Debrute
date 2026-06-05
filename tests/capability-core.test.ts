import { describe, expect, it } from 'vitest';
import {
  capabilityError,
  capabilityOk,
  projectArtifactPointers
} from '@debrute/capability-core';

describe('capability-core', () => {
  it('creates structured capability results without a public registry layer', () => {
    expect(capabilityOk({ content: 'ok' })).toEqual({
      status: 'ok',
      outputs: { content: 'ok' }
    });
    expect(capabilityError('invalid_input', 'Bad input.', { field: 'prompt' })).toEqual({
      status: 'error',
      error: {
        code: 'invalid_input',
        message: 'Bad input.',
        details: { field: 'prompt' }
      }
    });
  });

  it('maps project-relative artifacts to capability artifact pointers', () => {
    expect(projectArtifactPointers([
      {
        artifactId: 'artifact-1',
        projectRelativePath: 'generated/cover.png',
        title: 'Cover',
        mimeType: 'image/png',
        width: 1024,
        height: 1024
      }
    ])).toEqual([
      {
        artifactId: 'artifact-1',
        projectRelativePath: 'generated/cover.png',
        available: true,
        title: 'Cover',
        mimeType: 'image/png',
        width: 1024,
        height: 1024
      }
    ]);
  });
});
