import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import webPackageJson from '../../../package.json';

const workbenchSources = import.meta.glob('../**/*.{ts,tsx}', {
  eager: true,
  import: 'default',
  query: '?raw'
}) as Record<string, string>;
const uiIndexSources = import.meta.glob('./index.ts', {
  eager: true,
  import: 'default',
  query: '?raw'
}) as Record<string, string>;

const disallowedDependencies = [
  'tailwindcss',
  'shadcn',
  'shadcn-ui',
  'antd',
  '@mui/material',
  '@chakra-ui/react',
  '@mantine/core',
  '@fluentui/react-components',
  'bootstrap',
  'react-bootstrap'
];

const disallowedFeatureImports = [
  '@radix-ui/',
  'antd',
  '@mui/',
  '@chakra-ui/',
  '@mantine/',
  '@fluentui/',
  'bootstrap'
];

describe('Workbench UI system contract', () => {
  it('does not use disallowed visual UI dependencies in the Web package', () => {
    const packageJson = webPackageJson as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const dependencyNames = new Set([
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.devDependencies ?? {})
    ]);

    for (const dependency of disallowedDependencies) {
      expect(dependencyNames.has(dependency), dependency).toBe(false);
    }
  });

  it('keeps third-party UI implementation details out of feature code', () => {
    const violations: string[] = [];
    for (const [file, contents] of Object.entries(workbenchSources)) {
      if (file.startsWith('../ui/') || file.endsWith('.test.ts') || file.endsWith('.test.tsx')) {
        continue;
      }
      for (const importTarget of disallowedFeatureImports) {
        if (contents.includes(`from '${importTarget}`) || contents.includes(`from "${importTarget}`)) {
          violations.push(`${file} imports ${importTarget}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('has a single public Workbench UI primitive export surface', () => {
    const contents = uiIndexSources['./index.ts'];
    expect(contents).toBeDefined();
    for (const exportName of [
      'Button',
      'IconButton',
      'CloseButton',
      'Field',
      'Input',
      'SecretInput',
      'Select',
      'Textarea',
      'Switch',
      'Card',
      'Panel',
      'PanelBody',
      'Toolbar',
      'Menu',
      'Tab',
      'TabList',
      'StatusPill',
      'EmptyState',
      'CommentPillInput',
      'cx'
    ]) {
      expect(contents).toContain(exportName);
    }
  });

  it('keeps primitive control chrome with the control stylesheet', () => {
    const controls = readFileSync('apps/web/src/workbench/ui/styles/controls.css', 'utf8');

    for (const selector of ['.db-tabs', '.db-tab', '.db-workbench-close-button']) {
      expect(controls).toContain(selector);
    }
  });

  it('keeps domain chrome with its owning feature stylesheet', () => {
    const explorer = readFileSync('apps/web/src/workbench/styles/explorer.css', 'utf8');
    const terminal = readFileSync('apps/web/src/workbench/styles/terminal.css', 'utf8');
    const canvas = readFileSync('apps/web/src/workbench/styles/canvas.css', 'utf8');

    expect(explorer).toContain('.db-tree-row');
    expect(terminal).toContain('.db-terminal-tabs');
    expect(canvas).toContain('.db-canvas-control');
  });
});
