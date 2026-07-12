import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface RootPackageJson {
  engines: Record<string, string>;
  devDependencies: Record<string, string>;
}

describe('Node.js runtime contract', { tags: ['runtime'] }, () => {
  const root = process.cwd();
  const nodeTypesVersion = '24.13.1';

  it('declares Node.js 24 as the only supported Node major', () => {
    const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as RootPackageJson;
    const workspace = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');

    expect(packageJson.engines.node).toBe('>=24 <25');
    expect(packageJson.devDependencies['@types/node']).toBe(`^${nodeTypesVersion}`);
    expect(workspace).toContain(`"@types/node": ${nodeTypesVersion}`);
  });
});
