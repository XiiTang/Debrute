import { describe, expect, it } from 'vitest';

import { requireDesktopPlatform } from './desktopPlatform.js';

describe('requireDesktopPlatform', () => {
  it('accepts only the two Product platforms', () => {
    expect(requireDesktopPlatform('darwin')).toBe('darwin');
    expect(requireDesktopPlatform('win32')).toBe('win32');
    expect(() => requireDesktopPlatform('linux')).toThrow('does not support platform: linux');
  });
});
