import { describe, expect, it } from 'vitest';
import { isSupportedAdobeBridgeWorkbenchFile } from './adobeBridgeLabels';

describe('Adobe Bridge labels', () => {
  it('excludes project-internal namespaces case-insensitively from sendable files', () => {
    expect(isSupportedAdobeBridgeWorkbenchFile('assets/cover.png')).toBe(true);
    expect(isSupportedAdobeBridgeWorkbenchFile('.debrute/cache/cover.png')).toBe(false);
    expect(isSupportedAdobeBridgeWorkbenchFile('.DeBrute/cache/cover.png')).toBe(false);
    expect(isSupportedAdobeBridgeWorkbenchFile('.GIT/objects/cover.png')).toBe(false);
  });
});
