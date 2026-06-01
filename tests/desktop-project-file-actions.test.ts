import { describe, expect, it, vi } from 'vitest';
import {
  revealProjectPathWithShell,
  shouldDeleteProjectPathPermanently,
  trashProjectPathWithShell
} from '../apps/desktop/src/electron/project-files/projectFileActions';

describe('desktop project file actions', () => {
  it('reveals files and opens directories through injected shell behavior', async () => {
    const shell = {
      showItemInFolder: vi.fn(),
      openPath: vi.fn(async () => '')
    };

    await revealProjectPathWithShell(shell, { absolutePath: '/project/assets/cover.png', kind: 'file' });
    await revealProjectPathWithShell(shell, { absolutePath: '/project/assets', kind: 'directory' });

    expect(shell.showItemInFolder).toHaveBeenCalledWith('/project/assets/cover.png');
    expect(shell.openPath).toHaveBeenCalledWith('/project/assets');
  });

  it('moves paths to trash through injected shell behavior', async () => {
    const shell = {
      trashItem: vi.fn(async () => undefined)
    };

    await expect(trashProjectPathWithShell(shell, '/project/assets/cover.png')).resolves.toEqual({ ok: true });
    expect(shell.trashItem).toHaveBeenCalledWith('/project/assets/cover.png');
  });

  it('uses dialog confirmation for permanent delete', async () => {
    const confirmedDialog = {
      showMessageBox: vi.fn(async () => ({ response: 0 }))
    };
    const canceledDialog = {
      showMessageBox: vi.fn(async () => ({ response: 1 }))
    };

    await expect(shouldDeleteProjectPathPermanently(confirmedDialog, 'assets/cover.png')).resolves.toBe(true);
    await expect(shouldDeleteProjectPathPermanently(canceledDialog, 'assets/cover.png')).resolves.toBe(false);
  });
});
