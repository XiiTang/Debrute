import { describe, expect, it } from 'vitest';

import { INTERNAL_WORKBENCH_RUNTIME_CHILD_COMMAND } from './workbenchRuntimeChildEntrypoint.js';

describe('internal workbench runtime child command', { tags: ['runtime'] }, () => {
  it('uses a pkg-safe internal child command name', () => {
    expect(INTERNAL_WORKBENCH_RUNTIME_CHILD_COMMAND).toBe('internal-workbench-runtime-child');
    expect(INTERNAL_WORKBENCH_RUNTIME_CHILD_COMMAND.startsWith('-')).toBe(false);
  });
});
