import { describe, expect, it } from 'vitest';
import { classicUxpHtml } from '../vite.config.js';

describe('Photoshop UXP HTML build', () => {
  it('loads the bundled IIFE as a classic local script', () => {
    expect(classicUxpHtml(
      '<html><head><script type="module" crossorigin src="./assets/index.js"></script></head>'
        + '<body><div id="app"></div></body></html>'
    )).toBe(
      '<html><head></head><body><div id="app"></div>'
        + '<script src="./assets/index.js"></script>\n</body></html>'
    );
  });

  it('places the classic entry after the panel root', () => {
    const html = classicUxpHtml(
      '<html><head><script type="module" src="./main.ts"></script></head>'
        + '<body><div id="app"></div></body></html>'
    );
    expect(html.indexOf('id="app"')).toBeLessThan(html.indexOf('<script'));
  });
});
