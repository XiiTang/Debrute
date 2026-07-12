import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface TsConfigFile {
  compilerOptions?: {
    noEmit?: boolean;
    outDir?: string;
  };
  include?: string[];
  exclude?: string[];
}

const emitTsconfigPaths = [
  'apps/app-server/tsconfig.json',
  'apps/daemon/tsconfig.json',
  'apps/debrute-cli/tsconfig.json',
  'apps/runtime-host/tsconfig.json',
  'packages/app-protocol/tsconfig.json',
  'packages/canvas-core/tsconfig.json',
  'packages/canvas-map-core/tsconfig.json',
  'packages/capability-core/tsconfig.json',
  'packages/capability-runtime/tsconfig.json',
  'packages/photoshop-bridge-plugin-core/tsconfig.json',
  'packages/project-core/tsconfig.json',
  'packages/workbench-runtime/tsconfig.json'
];

describe('Production build hygiene', () => {
  it('excludes colocated test files from TypeScript emit projects', () => {
    const missingExcludes = emitTsconfigPaths.flatMap((path) => {
      const tsconfig = readJson<TsConfigFile>(path);
      if (tsconfig.compilerOptions?.noEmit === true || !tsconfig.compilerOptions?.outDir) {
        return [];
      }
      const excludes = new Set(tsconfig.exclude ?? []);
      return excludes.has('src/**/*.test.ts') && excludes.has('src/**/*.test.tsx')
        ? []
        : [path];
    });

    expect(missingExcludes).toEqual([]);
  });

  it('does not generate source maps in the default Electron runtime bundles', () => {
    const bundleScripts = [
      'apps/runtime-host/scripts/bundle-runtime-host.mjs',
      'apps/desktop/scripts/bundle-electron.mjs'
    ];

    const defaultSourcemapSettings = bundleScripts.flatMap((path) => {
      const source = readSource(path);
      return source.includes('sourcemap: true') ? [path] : [];
    });

    expect(defaultSourcemapSettings).toEqual([]);
  });

  it('keeps Electron Builder release inputs from including source maps', () => {
    const desktopPackage = readJson<{ build?: { files?: string[] } }>('apps/desktop/package.json');

    expect(desktopPackage.build?.files).toContain('!dist-electron/**/*.map');
  });

  it('cleans every TypeScript emit output directory before fresh build verification', () => {
    const cleanScript = readSource('scripts/clean.mjs');
    const missingCleanPaths = emitTsconfigPaths.flatMap((path) => {
      const tsconfig = readJson<TsConfigFile>(path);
      if (tsconfig.compilerOptions?.noEmit === true || !tsconfig.compilerOptions?.outDir) {
        return [];
      }
      const outputPath = join(dirname(path), tsconfig.compilerOptions.outDir).split('\\').join('/');
      return cleanScript.includes(`'${outputPath}'`) ? [] : [outputPath];
    });

    expect(missingCleanPaths).toEqual([]);
    expect(cleanScript).toContain("'apps/runtime-host/bundle'");
  });
});

function readJson<T>(path: string): T {
  return JSON.parse(readSource(path)) as T;
}

function readSource(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}
