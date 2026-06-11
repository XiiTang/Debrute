import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Canvas card bar CSS', () => {
  it('keeps the canvas menu out of the horizontally clipped card scroller', () => {
    const css = readFileSync(join(process.cwd(), 'apps/web/src/styles.css'), 'utf8');

    expect(css).toMatch(/\.canvas-card-scroll\s*{[^}]*overflow-x:\s*auto;[^}]*}/s);
    expect(css).toMatch(/\.canvas-card-menu\s*{[^}]*position:\s*fixed;[^}]*}/s);
  });
});
