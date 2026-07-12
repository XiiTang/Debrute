import { describe, expect, it } from 'vitest';

import { projectFileRevision } from './index.js';

describe('project revisions', () => {
  it('owns project file revision tokens in project-core', () => {
    expect(projectFileRevision(2048, 1001.2)).toBe('1001:2048');
  });
});
