import { describe, expect, it } from 'vitest';
import {
  projectRelativePathCacheKey,
  projectRevisionCacheKey
} from './projectCacheKeys';

describe('project cache keys', () => {
  it('creates one filesystem segment from a nested project path', () => {
    const key = projectRelativePathCacheKey('images/cover.png');

    expect(key).toMatch(/^images%2Fcover\.png--[a-f0-9]{16}$/);
    expect(key).not.toContain('/');
    expect(key).not.toContain('\\');
    expect(projectRelativePathCacheKey('images/cover.png')).toBe(key);
  });

  it('preserves distinct keys when readable prefixes match', () => {
    const first = projectRelativePathCacheKey(`assets/${'a'.repeat(120)}-one.png`);
    const second = projectRelativePathCacheKey(`assets/${'a'.repeat(120)}-two.png`);

    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(114);
    expect(second.length).toBeLessThanOrEqual(114);
  });

  it('supports unicode and special characters without path separators', () => {
    const key = projectRelativePathCacheKey('\u62fc\u63a5\u56fe/\u97e9\u8bed page:1.png');

    expect(key).toMatch(/--[a-f0-9]{16}$/);
    expect(key).toContain('%2F');
    expect(key).toContain('%20');
    expect(key).toContain('%3A');
    expect(key).not.toContain('/');
    expect(key).not.toContain('\\');
  });

  it('rejects unsafe project paths through normal project path validation', () => {
    expect(() => projectRelativePathCacheKey('../escape.png'))
      .toThrow('Project path must not contain "." or ".." segments');
    expect(() => projectRelativePathCacheKey('/absolute.png'))
      .toThrow('Project path must be relative');
  });

  it('encodes revision tokens as one filesystem segment', () => {
    expect(projectRevisionCacheKey('1780000000000:204800')).toBe('1780000000000%3A204800');
    expect(projectRevisionCacheKey('rev/a')).toBe('rev%2Fa');
    expect(() => projectRevisionCacheKey('')).toThrow('Project revision cache key source must be non-empty.');
  });
});
