import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRuntimeHostConfig } from '../apps/runtime-host/src/runtimeHostConfig';

describe('@debrute/runtime-host config', () => {
  it('parses only the environment needed to start the runtime host', () => {
    const config = parseRuntimeHostConfig({
      env: {
        DEBRUTE_RUNTIME_HOST_DAEMON_PORT: '17321',
        DEBRUTE_RUNTIME_HOST_TOKEN_FILE: '/tmp/debrute-token',
        DEBRUTE_RUNTIME_HOST_WEB_DIST_DIR: '/Applications/Debrute.app/Contents/Resources/app.asar/dist'
      }
    });

    expect(config).toEqual({
      host: '127.0.0.1',
      daemonPort: 17321,
      tokenFile: '/tmp/debrute-token',
      webDistDir: '/Applications/Debrute.app/Contents/Resources/app.asar/dist'
    });
  });

  it('does not print runtime state because it contains the daemon token', () => {
    const source = readFileSync(join(process.cwd(), 'apps/runtime-host/src/runtimeHost.ts'), 'utf8');

    expect(source).not.toContain('JSON.stringify(state)');
    expect(source).not.toContain('process.stdout.write');
  });
});
