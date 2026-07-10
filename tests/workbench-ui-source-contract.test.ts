import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const entryStyleFile = 'apps/web/src/styles.css';
const featureStyles = {
  canvas: 'apps/web/src/workbench/styles/canvas.css',
  explorer: 'apps/web/src/workbench/styles/explorer.css',
  inspector: 'apps/web/src/workbench/styles/inspector.css',
  integrations: 'apps/web/src/workbench/styles/integrations.css',
  projectOpen: 'apps/web/src/workbench/styles/project-open.css',
  settings: 'apps/web/src/workbench/styles/settings.css',
  shell: 'apps/web/src/workbench/styles/shell.css',
  terminal: 'apps/web/src/workbench/styles/terminal.css',
  titlebar: 'apps/web/src/workbench/styles/titlebar.css'
} as const;

const featureSourceRoots = {
  canvas: 'apps/web/src/workbench/canvas',
  explorer: 'apps/web/src/workbench/project-explorer',
  projectOpen: 'apps/web/src/workbench/project-open',
  settings: 'apps/web/src/workbench/settings',
  shell: 'apps/web/src/workbench/shell',
  terminal: 'apps/web/src/workbench/terminal'
} as const;

const featureClassPrefixes = {
  canvas: ['canvas-', 'db-canvas-'],
  explorer: ['db-tree-row', 'project-tree-'],
  projectOpen: ['project-open-'],
  settings: ['settings-'],
  terminal: ['db-terminal-']
} as const;

describe('Workbench UI source contract', () => {
  it('keeps the Web entry stylesheet import-only', () => {
    const lines = source(entryStyleFile).split('\n').map((line) => line.trim()).filter(Boolean);
    expect(lines.every((line) => line.startsWith('@import '))).toBe(true);
    expect(lines).toContain('@import "./workbench/ui/styles/tokens.css";');
    expect(lines).toContain('@import "./workbench/ui/styles/workbench-patterns.css";');
    for (const file of Object.values(featureStyles)) {
      const relative = file.replace('apps/web/src/', './');
      expect(lines).toContain(`@import "${relative}";`);
    }
  });

  it('defines the required token families in the executable token source', () => {
    const tokens = source('apps/web/src/workbench/ui/styles/tokens.css');
    for (const token of [
      '--db-bg', '--db-surface-1', '--db-surface-2', '--db-surface-3',
      '--db-text', '--db-text-muted', '--db-text-subtle', '--db-border',
      '--db-warning', '--db-danger', '--db-info', '--db-success',
      '--db-space-1', '--db-radius-sm', '--db-control-xs', '--db-font-xs',
      '--db-duration-fast', '--db-z-canvas', '--db-z-overlays'
    ]) {
      expect(tokens).toContain(token);
    }
    expect(tokens).toContain(':root[data-theme="dark"]');
    expect(tokens).toContain(':root[data-theme="light"]');
  });

  it('keeps primitive and feature class families with their owners', () => {
    const controls = source('apps/web/src/workbench/ui/styles/controls.css');
    const patterns = source('apps/web/src/workbench/ui/styles/workbench-patterns.css');

    expect(controls).toContain('.db-button');
    expect(controls).toContain('.db-icon-button');
    expect(controls).toContain('.db-icon-button--window');
    expect(controls).toContain('.db-icon-button--window-close');
    expect(controls).toContain('.db-tab');
    expect(controls).toContain('.db-workbench-close-button');
    expect(patterns).toContain('.db-surface-header');
    expect(patterns).toContain('.db-action-row');
    expect(patterns).toContain('.db-record-row');

    expect(source(featureStyles.canvas)).toContain('.db-canvas-control');
    expect(source(featureStyles.explorer)).toContain('.db-tree-row');
    expect(source(featureStyles.inspector)).toContain('.db-object-properties');
    expect(source(featureStyles.projectOpen)).toContain('.project-open-panel');
    expect(source(featureStyles.settings)).toContain('.settings-model-card');
    expect(source(featureStyles.shell)).toContain('.db-notification-stack');
    expect(source(featureStyles.terminal)).toContain('.db-terminal-tab');
  });

  it('keeps feature-owned class families out of shared patterns', () => {
    const patterns = source('apps/web/src/workbench/ui/styles/workbench-patterns.css');
    expect(patterns).not.toMatch(/\.(?:canvas-|db-canvas-|db-terminal-|db-tree-row|inspector-|project-open-|settings-)/);
  });

  it('keeps feature-owned class names out of other feature source', () => {
    for (const [consumer, root] of Object.entries(featureSourceRoots)) {
      for (const file of sourceFiles(root)) {
        const content = source(file);
        for (const classNameExpression of classNameExpressions(content)) {
          for (const [owner, prefixes] of Object.entries(featureClassPrefixes)) {
            if (owner === consumer) {
              continue;
            }
            for (const prefix of prefixes) {
              expect(classNameExpression, `${consumer} source ${file} consumes ${owner} class prefix ${prefix}`).not.toContain(prefix);
            }
          }
        }
      }
    }
  });

  it('keeps primitive chrome out of feature styles', () => {
    const primitiveSelector = /\.(?:db-button|db-icon-button|db-input|db-select|db-textarea|db-switch|db-card|db-panel|db-tab)(?:\b|[-_:])/;
    const chromeDeclaration = /(?:^|;)\s*(?:background(?:-color)?|border(?:-[a-z-]+)?|border-radius|box-shadow|color|font(?:-[a-z-]+)?|(?:min-|max-)?(?:width|height)|padding(?:-[a-z-]+)?|outline(?:-[a-z-]+)?|opacity|cursor|transition(?:-[a-z-]+)?)\s*:/m;
    for (const [owner, file] of Object.entries(featureStyles)) {
      const rules = source(file).matchAll(/([^{}]+)\{([^{}]*)\}/g);
      for (const [, selector, declarations] of rules) {
        if (primitiveSelector.test(selector ?? '')) {
          expect(declarations, `${owner}: ${selector?.trim()}`).not.toMatch(chromeDeclaration);
        }
      }
    }
  });

});

function source(file: string): string {
  return readFileSync(file, 'utf8');
}

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return /\.(?:ts|tsx)$/.test(entry.name) && !entry.name.includes('.test.') ? [path] : [];
  });
}

function classNameExpressions(content: string): string[] {
  return Array.from(content.matchAll(/className\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/g))
    .map((match) => match[1] ?? match[2] ?? match[3] ?? '');
}
