import { describe, expect, it } from 'vitest';
import { commandSpecs } from '../src/commands/helpSpec';
import { runRuntimeCommand } from '../src/commands/runtimeCommands';
import { parseDebruteArgs } from '../src/parser/parseDebruteArgs';
import { resolveCliDebruteVersion } from '../src/runtime/cliProductVersion';

describe('debrute no-runtime CLI commands', () => {
  it('lists update and runtime-backed skills.status but not skills.sync', async () => {
    const result = await runRuntimeCommand(parseDebruteArgs(['commands']));

    expect(result.records).toContainEqual(expect.objectContaining({
      fields: expect.objectContaining({ name: 'update' })
    }));
    expect(result.records).toContainEqual(expect.objectContaining({
      fields: expect.objectContaining({ name: 'skills.status' })
    }));
    expect(commandSpecs.some((spec) => spec.command === 'skills.sync')).toBe(false);
  });

  it('rejects skills sync at parse time', () => {
    expect(() => parseDebruteArgs(['skills', 'sync'])).toThrow(/Unknown Debrute CLI command/);
  });

  it('fails version resolution when package metadata is unavailable', async () => {
    await expect(resolveCliDebruteVersion('/tmp/debrute-cli-without-package/dist')).rejects.toThrow(/package metadata/i);
  });
});
