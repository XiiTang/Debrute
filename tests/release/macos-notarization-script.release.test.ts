import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const scriptPath = join(process.cwd(), 'scripts/notarize-macos-artifact.cjs');

describe('macOS notarization script', () => {
  it('handles stapler commands that inherit stdio without captured output', async () => {
    const program = `
      const childProcess = require('node:child_process');
      const commands = [];
      childProcess.execFileSync = (command, args = []) => {
        commands.push({ command, args });
        if (command !== 'xcrun') {
          throw new Error('Unexpected command: ' + command);
        }
        if (args[0] === 'notarytool' && args[1] === 'submit') {
          return JSON.stringify({ id: 'submission-id' });
        }
        if (args[0] === 'notarytool' && args[1] === 'info') {
          return JSON.stringify({ status: 'Accepted' });
        }
        if (args[0] === 'stapler') {
          return null;
        }
        throw new Error('Unexpected xcrun args: ' + args.join(' '));
      };
      process.env.APPLE_API_KEY = '/tmp/AuthKey_TEST.p8';
      process.env.APPLE_API_KEY_ID = 'KEYID';
      process.env.APPLE_API_ISSUER = 'ISSUER';
      const { notarizeAndStaple } = require(${JSON.stringify(scriptPath)});
      notarizeAndStaple({
        submitPath: '/tmp/debrute.app.zip',
        staplePath: '/tmp/debrute.app',
        label: 'debrute.app',
        pollSeconds: 0
      }).then((submissionId) => {
        console.log(JSON.stringify({
          submissionId,
          staplerCommands: commands
            .filter(({ args }) => args[0] === 'stapler')
            .map(({ args }) => args.slice(0, 2))
        }));
      }).catch((error) => {
        console.error(error instanceof Error ? error.stack : String(error));
        process.exit(1);
      });
    `;

    const result = spawnSync(process.execPath, ['-e', program], { encoding: 'utf8' });

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      submissionId: 'submission-id',
      staplerCommands: [
        ['stapler', 'staple'],
        ['stapler', 'validate']
      ]
    });
  });
});
