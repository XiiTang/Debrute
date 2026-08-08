import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const shellStyles = readFileSync('apps/web/src/workbench/styles/shell.css', 'utf8');
const tokenStyles = readFileSync('apps/web/src/workbench/ui/styles/tokens.css', 'utf8');

describe('Workbench Activity surfaces', () => {
  it('uses the shared straight paper Card shell without an Activity radius token', () => {
    const cardRule = cssRule(shellStyles, '.db-activity-card.db-card');

    expect(cardRule).toContain('border: 0;');
    expect(cardRule).toContain('border-radius: 0;');
    expect(cardRule).toContain('background: var(--db-surface-1);');
    expect(cardRule).toContain('box-shadow: var(--db-shadow-floating);');
    expect(cardRule).toContain('mask-image: var(--db-paper-mask-medium);');
    expect(tokenStyles).not.toContain('--db-radius-activity');
  });

  it('leaves the adaptive Center and toolbar visually transparent', () => {
    const centerRule = cssRule(shellStyles, '.db-activity-center');
    const headerRule = cssRule(shellStyles, '.db-activity-center__header');
    const titleRule = cssRule(shellStyles, '.db-activity-center__header h2');
    const clearRule = cssRule(shellStyles, '.db-activity-center__clear');

    expect(centerRule).toContain(
      'max-height: calc(100vh - var(--db-activity-anchor-top) - 8px);'
    );
    expect(centerRule).toContain('background: transparent;');
    expect(centerRule).toContain('border: 0;');
    expect(centerRule).toContain('border-radius: 0;');
    expect(centerRule).toContain('box-shadow: none;');
    expect(centerRule).not.toMatch(/(?:^|\n)\s*height:/);
    expect(centerRule).not.toContain('mask');
    expect(shellStyles).not.toContain('max-height: 560px;');

    expect(headerRule).toContain('background: transparent;');
    expect(headerRule).toContain('border: 0;');
    expect(headerRule).toContain('box-shadow: none;');
    expect(titleRule).toContain('text-shadow: var(--db-titlebar-contrast-shadow);');
    expect(clearRule).toContain('text-shadow: var(--db-titlebar-contrast-shadow);');
  });

  it('scrolls only the collection without a painted scrollbar track', () => {
    const bodyRule = cssRule(shellStyles, '.db-activity-center__body');

    expect(bodyRule).toContain('overflow-x: hidden;');
    expect(bodyRule).toContain('overflow-y: auto;');
    expect(bodyRule).toContain('overscroll-behavior: contain;');
    expect(bodyRule).toContain('scrollbar-width: thin;');
    expect(shellStyles).not.toContain('.db-activity-center__body::-webkit-scrollbar-track');
  });

  it('uses one exact eight-second floating lifecycle and inert exit motion', () => {
    const floatingRule = cssRule(shellStyles, '.db-activity-floating-card--present');
    const exitingRule = cssRule(shellStyles, '.db-activity-card-presence--exiting');
    const centerExitRule = cssRule(shellStyles, '.db-activity-center--exiting');
    const lifecycle = keyframes(shellStyles, 'db-activity-float-lifecycle');
    const reducedMotion = mediaRule(shellStyles, '@media (prefers-reduced-motion: reduce)');

    expect(floatingRule).toContain('animation: db-activity-float-lifecycle 8000ms linear both;');
    expect(shellStyles).toContain('.db-activity-floating-card--exiting,');
    expect(exitingRule).toContain('pointer-events: none;');
    expect(centerExitRule).toContain('pointer-events: none;');
    expect(lifecycle).toContain('1.5%');
    expect(lifecycle).toContain('98.5%');
    expect(reducedMotion).toContain('.db-activity-floating-card--present');
    expect(reducedMotion).toContain('.db-activity-center--exiting');
    expect(reducedMotion).toContain('animation: none;');
  });
});

function cssRule(styles: string, selector: string): string {
  const matches = styles.match(new RegExp(`${escapeRegExp(selector)}\\s*\\{[^}]*\\}`, 'g'));
  if (!matches) throw new Error(`Expected CSS rule for ${selector}.`);
  return matches.join('\n');
}

function keyframes(styles: string, name: string): string {
  const start = styles.indexOf(`@keyframes ${name}`);
  const end = styles.indexOf('\n}', start);
  if (start < 0 || end < 0) throw new Error(`Expected keyframes for ${name}.`);
  return styles.slice(start, end + 2);
}

function mediaRule(styles: string, query: string): string {
  const start = styles.indexOf(query);
  const end = styles.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`Expected media rule for ${query}.`);
  return styles.slice(start, end + 2);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
