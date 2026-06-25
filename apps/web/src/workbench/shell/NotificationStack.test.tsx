import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('NotificationStack', () => {
  it('does not intercept pointer recovery drags for panels behind passive notifications', () => {
    const css = readFileSync('apps/web/src/workbench/ui/styles/workbench-patterns.css', 'utf8');

    expect(css).toMatch(/\.db-notification-stack\s*{[^}]*pointer-events: none;/s);
  });
});
