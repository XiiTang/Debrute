import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ManagedRuntimeHarness } from '../../helpers/managedRuntimeHarness.js';

describe('runtime-backed project CLI commands', { tags: ['runtime'] }, () => {
  it('initializes, reports, and validates projects through the runtime-backed CLI path', async () => {
    await using harness = await ManagedRuntimeHarness.create();
    const root = await mkdtemp(join(tmpdir(), 'debrute-cli-project-'));
    try {
      await harness.start();

      const initialized = await harness.runCli(['project', 'init', root]);
      const status = await harness.runCli(['project', 'status', root]);
      const validated = await harness.runCli(['project', 'validate', root]);

      expect(initialized[0]).toBe('debrute/1 ok cmd=project.init');
      expect(status.join('\n')).toContain('debrute/1 ok cmd=project.status');
      expect(status.join('\n')).toContain('project_name=');
      expect(validated.join('\n')).toContain('debrute/1 ok cmd=project.validate');
      expect(validated.join('\n')).toContain('errors=0');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
