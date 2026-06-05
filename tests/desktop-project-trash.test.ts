import { describe, expect, it, vi } from 'vitest';
import { trashProjectPathWithDesktopShell } from '../apps/desktop/src/electron/desktopProjectTrash';

describe('desktop project trash', () => {
  it('resolves project-relative paths before using the platform trash', async () => {
    const resolveProjectPath = vi.fn(async () => '/tmp/debrute-project/assets/cover.png');
    const trashItem = vi.fn(async () => undefined);

    await expect(trashProjectPathWithDesktopShell({
      runtimeClient: { resolveProjectPath },
      shell: { trashItem }
    }, {
      projectId: 'project-1',
      projectRelativePath: 'assets/cover.png',
      kind: 'file'
    })).resolves.toEqual({ ok: true });

    expect(resolveProjectPath).toHaveBeenCalledWith('project-1', 'assets/cover.png', 'file');
    expect(trashItem).toHaveBeenCalledWith('/tmp/debrute-project/assets/cover.png');
  });

  it('does not trash anything when project path resolution fails', async () => {
    const resolveProjectPath = vi.fn(async () => {
      throw new Error('Debrute daemon project path resolution failed: 404');
    });
    const trashItem = vi.fn(async () => undefined);

    await expect(trashProjectPathWithDesktopShell({
      runtimeClient: { resolveProjectPath },
      shell: { trashItem }
    }, {
      projectId: 'project-1',
      projectRelativePath: '../outside',
      kind: 'file'
    })).rejects.toThrow('Debrute daemon project path resolution failed: 404');

    expect(trashItem).not.toHaveBeenCalled();
  });

  it('propagates platform trash failures', async () => {
    const resolveProjectPath = vi.fn(async () => '/tmp/debrute-project/assets');
    const trashItem = vi.fn(async () => {
      throw new Error('Trash unavailable');
    });

    await expect(trashProjectPathWithDesktopShell({
      runtimeClient: { resolveProjectPath },
      shell: { trashItem }
    }, {
      projectId: 'project-1',
      projectRelativePath: 'assets',
      kind: 'directory'
    })).rejects.toThrow('Trash unavailable');
  });
});
