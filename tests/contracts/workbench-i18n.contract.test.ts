import { describe, expect, it } from 'vitest';
import { dictionaries } from '../../apps/web/src/workbench/i18n/dictionaries.js';

describe('Workbench i18n contract', () => {
  it('keeps public dictionaries on the same non-empty key schema', () => {
    const englishKeys = Object.keys(dictionaries.en).sort();
    const simplifiedChineseKeys = Object.keys(dictionaries['zh-CN']).sort();

    expect(simplifiedChineseKeys).toEqual(englishKeys);
    expect(Object.values(dictionaries.en).every((value) => value.length > 0)).toBe(true);
    expect(Object.values(dictionaries['zh-CN']).every((value) => value.length > 0)).toBe(true);
  });
});
