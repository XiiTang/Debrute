import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import rootVitestConfig from '../../vitest.config.js';
import { testTags } from '../config/shared.js';

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
) as { scripts: Record<string, string> };

describe('local test command surface', () => {
  it('declares exactly the five approved functional tags', () => {
    expect(testTags.map(({ name }) => name)).toEqual([
      'canvas-text',
      'canvas-video',
      'terminal',
      'settings',
      'runtime'
    ]);
  });

  it('uses one native tag filter for Canvas text tests', () => {
    expect(packageJson.scripts['test:canvas-text'])
      .toBe('vitest run --tagsFilter=canvas-text');
  });

  it('runs three complete stability seeds without retry or worker overrides', () => {
    expect(packageJson.scripts['test:stability']).toBe(
      'vitest run --sequence.shuffle.files --sequence.seed=104729'
      + ' && vitest run --sequence.shuffle.files --sequence.seed=130363'
      + ' && vitest run --sequence.shuffle.files --sequence.seed=155921'
    );
  });

  it('uses one deterministic default file order at the workspace root', () => {
    const sequence = (rootVitestConfig as {
      test?: { sequence?: { shuffle?: { files?: boolean }; seed?: number } };
    }).test?.sequence;

    expect(sequence).toEqual({
      shuffle: { files: true },
      seed: 104729
    });
  });

  it('selects only coverage-contributing projects for local V8 coverage', () => {
    expect(packageJson.scripts['test:coverage']).toBe(
      'vitest run --coverage --project=unit-* --project=dom-web --project=contracts'
    );
  });

  it('merges loaded external coverage and unloaded source from every selected project root', () => {
    const coverage = (rootVitestConfig as {
      test?: { coverage?: { allowExternal?: boolean; include?: string[]; exclude?: string[] } };
    }).test?.coverage;

    expect(coverage?.allowExternal).toBe(true);
    expect(coverage?.include).toEqual(['src/**/*.{ts,tsx}']);
  });

  it('excludes only thin executable entry glue', () => {
    const coverage = (rootVitestConfig as {
      test?: { coverage?: { exclude?: string[] } };
    }).test?.coverage;

    expect(coverage?.exclude).toEqual(expect.arrayContaining([
      'apps/web/src/main.tsx'
    ]));
    expect(coverage?.exclude).not.toEqual(expect.arrayContaining([
      'apps/desktop/src/electron/main.ts',
      'apps/photoshop-cep-plugin/src/main.ts',
      'apps/photoshop-uxp-plugin/src/main.ts'
    ]));
  });
});
