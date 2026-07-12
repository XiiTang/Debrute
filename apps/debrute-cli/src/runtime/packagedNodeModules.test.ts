import { delimiter } from 'node:path';
import { describe, expect, it } from 'vitest';

import { packagedExecutablePath, packagedNodeModulesPath, packagedNodePathValue } from './packagedNodeModules.js';

describe('packaged CLI Node module paths', { tags: ['runtime'] }, () => {
  it('adds runtime payload node_modules before existing NODE_PATH entries', () => {
    expect(packagedExecutablePath('/payload/debrute')).toBe('/payload/debrute');
    expect(packagedNodeModulesPath('/Users/test/.debrute/products/0.7.0/cli/debrute')).toBe('/Users/test/.debrute/products/0.7.0/cli/node_modules');
    expect(packagedNodePathValue('/payload/debrute', '/existing')).toBe(`/payload/node_modules${delimiter}/existing`);
    expect(packagedNodePathValue('/payload/debrute', `/payload/node_modules${delimiter}/existing`)).toBe(`/payload/node_modules${delimiter}/existing`);
  });
});
