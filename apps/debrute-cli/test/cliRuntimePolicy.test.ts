import { describe, expect, it } from 'vitest';
import { runtimePolicyForCommand } from '../src/runtime/cliRuntimePolicy';

describe('CLI runtime policy', () => {
  it('keeps metadata and skills commands local', () => {
    for (const command of ['commands', 'help', 'skills.status', 'skills.sync']) {
      expect(runtimePolicyForCommand(command)).toBe('no-runtime');
    }
  });

  it('observes runtime status without starting runtime', () => {
    for (const command of ['runtime.status', 'runtime.doctor']) {
      expect(runtimePolicyForCommand(command)).toBe('observe-runtime');
    }
  });

  it('ensures runtime for project, model, workbench, and generation commands', () => {
    for (const command of [
      'workbench.url',
      'models.image.list',
      'models.image.describe',
      'models.video.list',
      'models.video.describe',
      'llm.request',
      'project.init',
      'project.status',
      'project.validate',
      'canvas-map.publish',
      'canvas.create',
      'canvas.rename',
      'canvas.delete',
      'canvas.reorder',
      'canvas.repair-index',
      'generated-asset.lookup',
      'generate.image',
      'generate.image-batch',
      'generate.video'
    ]) {
      expect(runtimePolicyForCommand(command)).toBe('ensure-runtime');
    }
  });
});
