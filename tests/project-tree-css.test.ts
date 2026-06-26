import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Project Tree CSS', () => {
  it('sizes the Project Tree event surface across the panel blank space', () => {
    const css = readFileSync(join(process.cwd(), 'apps/web/src/workbench/styles/explorer.css'), 'utf8');

    expect(css).toMatch(/\.project-tree-shell\s*{[^}]*height:\s*100%;[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\);/s);
    expect(css).toMatch(/\.project-tree\s*{[^}]*height:\s*100%;/s);
  });
});
