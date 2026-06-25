import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const designPath = join(root, 'DESIGN.md');

describe('project DESIGN.md contract', () => {
  it('defines the single root project-level front-end design contract', () => {
    expect(existsSync(designPath)).toBe(true);

    const design = readFileSync(designPath, 'utf8');
    expect(design).toContain('name: Debrute Front-End Design System');
    expect(design).toContain('description: Project-level front-end design constraints for Debrute.');
    expect(design).toContain('## Front-End Surfaces');
    expect(design).toContain('## Source Ownership');
    expect(design).toContain('## Canvas Exceptions');
    expect(design).toContain('## Enforcement');
  });

  it('keeps the required DESIGN.md section order', () => {
    const design = readFileSync(designPath, 'utf8');
    const requiredSections = [
      '## Overview',
      '## Colors',
      '## Typography',
      '## Layout',
      '## Elevation & Depth',
      '## Shapes',
      '## Components',
      '## Front-End Surfaces',
      '## Source Ownership',
      '## Canvas Exceptions',
      "## Do's and Don'ts",
      '## Iteration Guide',
      '## Enforcement'
    ];

    let previousIndex = -1;
    for (const section of requiredSections) {
      const index = design.indexOf(section);
      expect(index, section).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }
  });

  it('declares canonical project-level tokens that map to Workbench UI tokens', () => {
    const design = readFileSync(designPath, 'utf8');

    for (const token of [
      'canvas: "#181818"',
      'surface-1: "#1f1f1f"',
      'surface-2: "#262626"',
      'surface-3: "#303030"',
      'text: "#ffffff"',
      'border: "#3a3a3a"',
      'selection: "#ffffff"',
      'ui-xs:',
      'ui-sm:',
      'ui-md:',
      'ui-lg:',
      'control-xs:',
      'control-sm:',
      'control-md:',
      'button-default:',
      'icon-button:',
      'input:',
      'panel:',
      'card:'
    ]) {
      expect(design).toContain(token);
    }
  });

  it('keeps Workbench implementation ownership explicit', () => {
    const design = readFileSync(designPath, 'utf8');

    for (const sourcePath of [
      'apps/web/src/workbench/ui/styles/tokens.css',
      'apps/web/src/workbench/ui/*.tsx',
      'apps/web/src/workbench/ui/styles/workbench-patterns.css',
      'apps/web/src/workbench/styles/*.css',
      'apps/photoshop-uxp-plugin/src/styles.css',
      'apps/photoshop-cep-plugin/src/styles.css',
      'apps/desktop/src/electron/*'
    ]) {
      expect(design).toContain(sourcePath);
    }
  });

  it('does not introduce per-surface DESIGN.md appendix files', () => {
    const disallowedDesignFiles = findDesignFiles(root)
      .filter((file) => file !== 'DESIGN.md')
      .filter((file) => !file.startsWith('debrute-docs-private/'));

    expect(disallowedDesignFiles).toEqual([]);
  });
});

function findDesignFiles(directory: string, prefix = ''): string[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'dist-electron') {
      continue;
    }
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...findDesignFiles(absolutePath, relativePath));
    } else if (entry.isFile() && entry.name === 'DESIGN.md') {
      results.push(relativePath);
    }
  }
  return results;
}
