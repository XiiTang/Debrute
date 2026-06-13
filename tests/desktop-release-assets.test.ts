import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isDirectCliInvocation } from '../scripts/desktop-release-assets.mjs';

describe('Desktop release asset script', () => {
  it('detects direct CLI invocation from Windows argv paths', () => {
    expect(isDirectCliInvocation(
      'file:///D:/a/Debrute/Debrute/scripts/desktop-release-assets.mjs',
      'D:\\a\\Debrute\\Debrute\\scripts\\desktop-release-assets.mjs'
    )).toBe(true);
  });

  it('copies the runtime host bundle into the Electron runtime bundle', () => {
    const script = readFileSync(join(process.cwd(), 'apps/desktop/scripts/bundle-electron.mjs'), 'utf8');

    expect(script).toContain("['--filter', '@debrute/runtime-host', 'build']");
    expect(script).toContain("cp('../runtime-host/bundle/runtime-host.cjs', 'dist-electron/runtime-host.cjs')");
    for (const status of ['starting', 'running', 'degraded', 'stopped', 'error']) {
      expect(script).toContain(`cp(\`build/tray_icon_\${status}.png\`, \`dist-electron/tray_icon_\${status}.png\`)`);
    }
  });
});
