import { cliError, isDebruteCliError, messageFromUnknown } from '../errors/cliErrors.js';
import type { ParsedDebruteArgs } from '../parser/parseDebruteArgs.js';
import type { DebruteAgentResult } from '../output/renderAgentRecord.js';
import { ensureWorkbenchRuntime, type EnsureWorkbenchRuntimeResult } from '../workbench/workbenchRuntimeLauncher.js';

export interface WorkbenchCommandServices {
  ensureRuntime?: () => Promise<EnsureWorkbenchRuntimeResult>;
}

export async function runWorkbenchCommand(
  args: ParsedDebruteArgs,
  services: WorkbenchCommandServices = {}
): Promise<DebruteAgentResult> {
  if (args.command !== 'workbench.start') {
    throw cliError('invalid_command', `Unknown Debrute workbench command: ${args.command}`);
  }

  try {
    const runtime = await (services.ensureRuntime ?? ensureWorkbenchRuntime)();
    return {
      status: 'ok',
      command: args.command,
      fields: {
        web_url: runtime.state.webUrl,
        daemon_url: runtime.state.daemonUrl,
        web_port: portFromUrl(runtime.state.webUrl),
        daemon_port: portFromUrl(runtime.state.daemonUrl),
        runtime_started: runtime.runtimeStarted,
        runtime_kind: runtime.state.runtimeKind,
        state_path: runtime.statePath
      }
    };
  } catch (error) {
    if (isDebruteCliError(error)) {
      return {
        status: 'error',
        command: args.command,
        code: error.code,
        message: error.message,
        fields: error.fields
      };
    }
    return {
      status: 'error',
      command: args.command,
      code: 'internal_error',
      message: messageFromUnknown(error)
    };
  }
}

function portFromUrl(url: string): number {
  const parsed = new URL(url);
  return Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
}
