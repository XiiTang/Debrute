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
      'Field',
      'Input',
      'SecretInput',
      'Select',
      'Textarea',
      'Switch',
      'Card',
      'Panel',
      'PanelHeader',
      'PanelBody',
      'PanelTitle',
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
    for (const unusedExport of [
      'Checkbox',
      'Slider',
      'Tooltip',
      'Dialog',
      'Popover',
      'Spinner',
      'Command',
      'Combobox',
      'CommentPillInputBadgeMode',
      'CommentPillInputContainerProps'
    ]) {
      expect(contents).not.toContain(unusedExport);
    }
  });

  it('defines final project-level Workbench pattern selectors', () => {
    const patterns = readFileSync('apps/web/src/workbench/ui/styles/workbench-patterns.css', 'utf8');

    for (const selector of [
      '.db-settings-section',
      '.db-settings-section__header',
      '.db-form-grid',
      '.db-form-row',
      '.db-action-row',
      '.db-model-card',
      '.db-model-card__header',
      '.db-model-card__fields',
      '.db-secret-field',
      '.db-status-list',
      '.db-project-open',
      '.db-project-open__meta',
      '.db-integration-list',
      '.db-integration-row',
      '.db-integration-row__action',
      '.db-integration-summary',
      '.db-object-properties',
      '.db-diagnostic-row',
      '.db-floating-bar',
      '.db-canvas-control'
    ]) {
      expect(patterns).toContain(selector);
    }
  });

});
