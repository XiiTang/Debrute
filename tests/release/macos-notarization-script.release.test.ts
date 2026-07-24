import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const scriptPath = join(process.cwd(), 'scripts/notarize-macos-artifact.cjs');

describe('macOS notarization script', () => {
  it('submits once with bounded waiting and staples an accepted result', () => {
    const program = `
      const childProcess = require('node:child_process');
      const commands = [];
      childProcess.execFileSync = (command, args = []) => {
        commands.push({ command, args });
        if (command !== 'xcrun') {
          throw new Error('Unexpected command: ' + command);
        }
        if (args[0] === 'notarytool' && args[1] === 'submit') {
          return JSON.stringify({ id: 'submission-id', status: 'Accepted' });
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
      try {
        const submissionId = notarizeAndStaple({
          submitPath: '/tmp/debrute.app.zip',
          staplePath: '/tmp/debrute.app',
          label: 'debrute.app'
        });
        console.log(JSON.stringify({
          submissionId,
          notarytoolCommands: commands
            .filter(({ args }) => args[0] === 'notarytool')
            .map(({ args }) => args),
          staplerCommands: commands
            .filter(({ args }) => args[0] === 'stapler')
            .map(({ args }) => args.slice(0, 2))
        }));
      } catch (error) {
        console.error(error instanceof Error ? error.stack : String(error));
        process.exit(1);
      }
    `;

    const result = spawnSync(process.execPath, ['-e', program], { encoding: 'utf8' });

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      submissionId: 'submission-id',
      notarytoolCommands: [[
        'notarytool',
        'submit',
        '/tmp/debrute.app.zip',
        '--key',
        '/tmp/AuthKey_TEST.p8',
        '--key-id',
        'KEYID',
        '--issuer',
        'ISSUER',
        '--wait',
        '--timeout',
        '2h',
        '--output-format',
        'json'
      ]],
      staplerCommands: [
        ['stapler', 'staple'],
        ['stapler', 'validate']
      ]
    });
  });

  it('fails a rejected submission without stapling', () => {
    const program = `
      const childProcess = require('node:child_process');
      const commands = [];
      childProcess.execFileSync = (command, args = []) => {
        commands.push({ command, args });
        if (args[0] === 'notarytool' && args[1] === 'submit') {
          return JSON.stringify({ id: 'rejected-id', status: 'Invalid' });
        }
        if (args[0] === 'notarytool' && args[1] === 'log') {
          return 'notary log';
        }
        throw new Error('Unexpected command: ' + command + ' ' + args.join(' '));
      };
      process.env.APPLE_API_KEY = '/tmp/AuthKey_TEST.p8';
      process.env.APPLE_API_KEY_ID = 'KEYID';
      process.env.APPLE_API_ISSUER = 'ISSUER';
      const { notarizeAndStaple } = require(${JSON.stringify(scriptPath)});
      try {
        notarizeAndStaple({
          submitPath: '/tmp/debrute.app.zip',
          staplePath: '/tmp/debrute.app',
          label: 'debrute.app'
        });
        process.exit(2);
      } catch (error) {
        console.log(JSON.stringify({
          message: error.message,
          staplerCalls: commands.filter(({ args }) => args[0] === 'stapler').length,
          notarytoolActions: commands
            .filter(({ args }) => args[0] === 'notarytool')
            .map(({ args }) => args[1])
        }));
      }
    `;

    const result = spawnSync(process.execPath, ['-e', program], { encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('notary log');
    expect(JSON.parse(result.stdout)).toEqual({
      message: 'Notary submission rejected-id for debrute.app finished with Invalid.',
      staplerCalls: 0,
      notarytoolActions: ['submit', 'log']
    });
  });

});
