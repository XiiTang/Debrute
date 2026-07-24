import type { RuntimeControlClient } from '@debrute/runtime-control-client';
import { describe, expect, it, vi } from 'vitest';

import { DesktopProductQuit } from './desktopProductQuit.js';

describe('DesktopProductQuit', () => {
  it('records early Command-Q and sends it exactly once on the existing Control acquisition', async () => {
    const quitProduct = vi.fn(async () => ({ result: 'ok' as const }));
    const control = { quitProduct } as Pick<RuntimeControlClient, 'quitProduct'>;
    const quit = new DesktopProductQuit();

    await quit.request();
    expect(quit.requested).toBe(true);
    expect(quitProduct).not.toHaveBeenCalled();

    await expect(quit.sendRecordedRequest(control)).resolves.toBe(true);
    await quit.request(control);
    await expect(quit.sendRecordedRequest(control)).resolves.toBe(true);
    expect(quitProduct).toHaveBeenCalledOnce();
  });

  it('reports the exact rejection and does not replay Product Quit', async () => {
    const quitProduct = vi.fn(async () => ({
      result: 'rejected' as const,
      code: 'update_commit_in_progress' as const
    }));
    const control = { quitProduct } as Pick<RuntimeControlClient, 'quitProduct'>;
    const quit = new DesktopProductQuit();

    await expect(quit.request(control)).rejects.toThrow(
      'Runtime rejected Product Quit: update_commit_in_progress'
    );
    await expect(quit.request(control)).resolves.toBeUndefined();
    expect(quitProduct).toHaveBeenCalledOnce();
  });
});
