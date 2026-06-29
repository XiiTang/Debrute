import { describe, expect, it } from 'vitest';
import { runtimePolicyForCommand } from '../src/runtime/cliRuntimePolicy';

describe('CLI runtime policy', () => {
  it('keeps metadata commands local', () => {
    for (const command of ['commands', 'help']) {
      expect(runtimePolicyForCommand(command)).toBe('no-runtime');
    }
  });

  it('observes runtime status without starting runtime', () => {
    for (const command of ['runtime.status', 'runtime.doctor']) {
      expect(runtimePolicyForCommand(command)).toBe('observe-runtime');
    }
  });

  it('ensures runtime for project, model, workbench, product, Skills, and generation commands', () => {
    for (const command of [
      'update',
      'workbench.start',
      'skills.status',
      'models.image.list',
      'models.image.describe',
      'models.video.list',
      'models.video.describe',
      'project.init',
      'project.status',
      'project.validate',
      'canvas-map.push',
      'canvas.create',
      'canvas.rename',
      'canvas.delete',
      'canvas.reorder',
      'canvas.repair-index',
      'canvas.reset-layout',
      'generated-asset.lookup',
      'generate.image',
      'generate.image-batch',
      'generate.video'
    ]) {
      expect(runtimePolicyForCommand(command)).toBe('ensure-runtime');
    }
  });
});
