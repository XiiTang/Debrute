import { describe, expect, it, vi } from 'vitest';
import { waitForWorkbenchShellFonts } from './workbenchShellFonts.js';

describe('Workbench shell font readiness', () => {
  it('waits once for every base Workbench font face before React renders', async () => {
    const load = vi.fn(async () => []);

    await waitForWorkbenchShellFonts({ load });

    expect(load.mock.calls).toEqual([
      ['700 16px "Smiley Sans"', 'Debrute'],
      ['400 16px "Noto Sans SC"', 'Debrute 设置'],
      ['600 16px "Noto Sans SC"', 'Debrute 设置'],
      ['700 16px "Noto Sans SC"', 'Debrute 设置'],
      ['400 16px "Noto Sans Mono CJK SC"', 'Debrute 设置'],
      ['700 16px "Noto Sans Mono CJK SC"', 'Debrute 设置']
    ]);
  });
});
