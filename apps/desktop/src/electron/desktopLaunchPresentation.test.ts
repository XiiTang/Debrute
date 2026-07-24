import { describe, expect, it } from 'vitest';

import { desktopWindowBackgroundColor } from './desktopLaunchPresentation.js';

describe('desktop launch presentation', () => {
  it('uses the warm light and night brand fields before Workbench paints', () => {
    expect(desktopWindowBackgroundColor('light', true)).toBe('#f7e3d0');
    expect(desktopWindowBackgroundColor('dark', false)).toBe('#171714');
    expect(desktopWindowBackgroundColor('system', false)).toBe('#f7e3d0');
    expect(desktopWindowBackgroundColor('system', true)).toBe('#171714');
  });
});
