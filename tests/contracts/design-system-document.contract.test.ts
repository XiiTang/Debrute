import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const designPath = join(process.cwd(), 'docs/design-system.md');

describe('design system document contract', () => {
  it('defines one durable Workbench design contract and executable token source', () => {
    expect(existsSync(designPath)).toBe(true);
    const design = readFileSync(designPath, 'utf8');

    expect(design).toMatch(/^---\nversion: alpha\nname: Debrute Front-End Design System\ndescription: Project-level front-end design constraints for Debrute\.\ntokenSource: apps\/web\/src\/workbench\/ui\/styles\/tokens\.css\ndesignStatus: current\nimplementationStatus: implemented\n---\n/);
    for (const section of [
      '## Overview',
      '## Product Language',
      '## Token Semantics',
      '## Component Model',
      '## Workbench Surfaces',
      '## Source Ownership',
      '## Canvas Exceptions',
      '## Enforcement'
    ]) {
      expect(design).toContain(section);
    }
  });

  it('assigns final source ownership without duplicating executable values', () => {
    const design = readFileSync(designPath, 'utf8');

    for (const sourcePath of [
      'apps/web/src/styles.css',
      'apps/web/src/workbench/ui/styles/tokens.css',
      'apps/web/src/workbench/ui/*.tsx',
      'apps/web/src/workbench/ui/styles/workbench-patterns.css',
      'apps/web/src/workbench/shell/*',
      'apps/web/src/workbench/<feature>/*',
      'apps/web/src/workbench/styles/<feature>.css'
    ]) {
      expect(design).toContain(sourcePath);
    }

    expect(design).toContain('Feature classes may position primitives, but they do not redefine primitive chrome.');
    expect(design).toContain('A pattern is shared only when independent Workbench features use the same role.');
  });
});
