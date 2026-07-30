import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import rootVitestConfig from '../../vitest.config.js';
import { testTags } from '../config/shared.js';

const packageJson = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
) as { scripts: Record<string, string> };
const webPackageJson = JSON.parse(
  readFileSync(new URL('../../apps/web/package.json', import.meta.url), 'utf8')
) as { scripts: Record<string, string> };
const desktopPackageJson = JSON.parse(
  readFileSync(new URL('../../apps/desktop/package.json', import.meta.url), 'utf8')
) as { scripts: Record<string, string> };
const releaseWorkflow = readFileSync(
  new URL('../../.github/workflows/debrute-release.yml', import.meta.url),
  'utf8'
);
const nextestConfig = readFileSync(
  new URL('../../.config/nextest.toml', import.meta.url),
  'utf8'
);
const rustTestRunner = readFileSync(
  new URL('../../scripts/test-rust.mjs', import.meta.url),
  'utf8'
);
const runtimeCargoManifest = readFileSync(
  new URL('../../apps/runtime/Cargo.toml', import.meta.url),
  'utf8'
);
const runtimeIntegrationHarness = readFileSync(
  new URL('../../apps/runtime/tests/runtime_integration.rs', import.meta.url),
  'utf8'
);
const runtimeIntegrationModules = readdirSync(
  new URL('../../apps/runtime/tests/', import.meta.url)
)
  .filter((fileName) => fileName.endsWith('.rs') && fileName !== 'runtime_integration.rs')
  .sort();
const declaredRuntimeIntegrationModules = Array.from(
  runtimeIntegrationHarness.matchAll(/^#\[path = "([^"]+\.rs)"\]$/gmu),
  (match) => match[1]
).sort();
const rustLibrariesWithoutDoctests = [
  '../../apps/runtime/',
  '../../packages/native-control/',
  '../../packages/native-fs/',
  '../../packages/native-process/',
  '../../packages/windows-product-fs/'
];

describe('local test command surface', () => {
  it('runs the layout gate before the default Vitest suite', () => {
    expect(packageJson.scripts.test).toBe('pnpm test:layout && vitest run');
  });

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

  it('generates Control bindings through the exact owning Runtime library', () => {
    expect(packageJson.scripts['generate:control-protocol']).toBe(
      'node scripts/run-cargo-with-native-raster.mjs -- test -p debrute-runtime --lib export_bindings'
    );
  });

  it('keeps standalone checks and builds complete while exposing artifact-only composition', () => {
    expect(packageJson.scripts.check).toBe(
      'pnpm generate:control-protocol && pnpm check:typescript'
    );
    expect(packageJson.scripts.build).toBe(
      'pnpm generate:control-protocol && pnpm check:typescript && pnpm build:artifacts'
    );
    expect(packageJson.scripts['build:artifacts']).toBe(
      'pnpm --filter @debrute/desktop build:artifacts'
    );
    expect(webPackageJson.scripts.build).toBe('pnpm check && pnpm build:artifacts');
    expect(webPackageJson.scripts['build:artifacts']).toBe(
      'pnpm --workspace-root brand:sync && vite build && node ../../scripts/check-web-build-budget.mjs'
    );
    expect(desktopPackageJson.scripts.build).toBe(
      'pnpm --filter @debrute/web build && pnpm build:runtime && pnpm check && pnpm bundle'
    );
    expect(desktopPackageJson.scripts['build:artifacts']).toBe(
      'pnpm --filter @debrute/web build:artifacts && pnpm build:runtime && pnpm bundle'
    );
  });

  it('separates product Rust lint from exhaustive Rust lint', () => {
    expect(packageJson.scripts['check:rust']).toBe(
      'cargo fmt --all -- --check && node scripts/run-cargo-with-native-raster.mjs -- clippy --workspace --lib --bins -- -D warnings'
    );
    expect(packageJson.scripts['check:rust:all']).toBe(
      'cargo fmt --all -- --check && node scripts/run-cargo-with-native-raster.mjs -- clippy --workspace --all-targets --features test-support,native-watcher-probe -- -D warnings'
    );
  });

  it('pins Runtime isolation and one-pass native Rust orchestration', () => {
    expect(nextestConfig).toContain('nextest-version = { required = "0.9.140" }');
    expect(nextestConfig).toContain('test-threads = 4');
    expect(nextestConfig).toContain('slow-timeout = { period = "60s", terminate-after = 3 }');
    expect(packageJson.scripts['test:rust']).toBe('node scripts/test-rust.mjs');
    expect(rustTestRunner).toContain("'runtime_integration'");
    expect(rustTestRunner).toContain("process.platform === 'win32'");
    expect(rustTestRunner).toContain("'--no-fail-fast'");
    expect(runtimeCargoManifest).toContain('autotests = false');
    expect(runtimeCargoManifest).toContain('name = "runtime_integration"');
    expect(declaredRuntimeIntegrationModules).toEqual(runtimeIntegrationModules);
    expect(releaseWorkflow).toContain('tool: nextest@0.9.140');
    expect(releaseWorkflow).toContain(
      '      - name: Verify native Project watcher\n'
      + '        run: pnpm test:rust:native-watcher'
    );
  });

  it('disables doctests only in libraries without executable Rust documentation', () => {
    for (const packagePath of rustLibrariesWithoutDoctests) {
      const packageUrl = new URL(packagePath, import.meta.url);
      const manifest = readFileSync(new URL('Cargo.toml', packageUrl), 'utf8');
      expect(manifest, packagePath).toContain('doctest = false');

      const sourceUrl = new URL('src/', packageUrl);
      const sourceFiles = readdirSync(sourceUrl, { recursive: true })
        .filter((fileName) => fileName.endsWith('.rs'));
      for (const fileName of sourceFiles) {
        const source = readFileSync(new URL(fileName, sourceUrl), 'utf8');
        expect(source, `${packagePath}src/${fileName}`).not.toMatch(
          /^\/\/[!/]\s*```(?:\s*$|rust\b|no_run\b|ignore\b|should_panic\b|compile_fail\b)/mu
        );
      }
    }
  });

  it('routes daily and exhaustive verification through one timed pipeline', () => {
    expect(packageJson.scripts.verify).toBe('node scripts/verify.mjs');
    expect(packageJson.scripts['verify:all']).toBe(
      'node scripts/verify.mjs --all-rust-targets'
    );
  });

  it('enforces exhaustive Rust lint in the release preflight', () => {
    expect(releaseWorkflow).toContain('      - run: pnpm check:rust:all');
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
      'apps/photoshop-uxp-plugin/src/main.ts'
    ]));
  });
});
