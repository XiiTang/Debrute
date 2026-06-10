import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface RootPackageJson {
  engines: Record<string, string>;
  devDependencies: Record<string, string>;
}

describe('Node.js runtime contract', () => {
  const root = process.cwd();
  const nodeTypesVersion = '24.13.1';

  it('declares Node.js 24 as the only supported Node major', () => {
    const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as RootPackageJson;
    const workspace = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');

    expect(packageJson.engines.node).toBe('>=24 <25');
    expect(packageJson.devDependencies['@types/node']).toBe(`^${nodeTypesVersion}`);
    expect(workspace).toContain(`"@types/node": ${nodeTypesVersion}`);
  });

  it('makes doctor reject every non-Node.js 24 major', () => {
    const doctor = readFileSync(join(root, 'scripts/doctor.mjs'), 'utf8');

    expect(doctor).toContain('nodeMajor !== 24');
    expect(doctor).toContain('Node.js 24 is required. Current:');
    expect(doctor).not.toContain('nodeMajor < 22');
    expect(doctor).not.toContain('Node.js 22 or newer');
  });
});
