import { cliError } from '../errors/cliErrors.js';
import { commandSpecRecords, commandSpecs, specForCommandPath } from './helpSpec.js';
import type { ParsedDebruteArgs } from '../parser/parseDebruteArgs.js';
import type { DebruteAgentResult } from '../output/renderAgentRecord.js';

export async function runRuntimeCommand(args: ParsedDebruteArgs): Promise<DebruteAgentResult> {
  if (args.command === 'commands') {
    return {
      status: 'ok',
      command: 'commands',
      records: commandSpecRecords(),
      fields: { count: commandSpecs.length }
    };
  }

  if (args.command === 'help') {
    const specItem = specForCommandPath(args.positional);
    if (!specItem) {
      throw cliError('invalid_command', `Unknown Debrute CLI command: ${args.positional.join(' ')}`);
    }
    return {
      status: 'ok',
      command: 'help',
      records: commandSpecRecords([specItem])
    };
  }

  throw cliError('invalid_command', `Unknown Debrute CLI command: ${args.command}`);
}
