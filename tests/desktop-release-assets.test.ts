import { describe, expect, it } from 'vitest';
import { isDirectCliInvocation } from '../scripts/desktop-release-assets.mjs';

describe('Desktop release asset script', () => {
  it('detects direct CLI invocation from Windows argv paths', () => {
    expect(isDirectCliInvocation(
      'file:///D:/a/Debrute/Debrute/scripts/desktop-release-assets.mjs',
      'D:\\a\\Debrute\\Debrute\\scripts\\desktop-release-assets.mjs'
    )).toBe(true);
  });
});
