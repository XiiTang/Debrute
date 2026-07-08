import { cliError, isDebruteCliError, messageFromUnknown } from '../errors/cliErrors.js';
import type { ParsedDebruteArgs } from '../parser/parseDebruteArgs.js';
import type { DebruteAgentResult } from '../output/renderAgentRecord.js';
import { ensureWorkbenchRuntime, type EnsureWorkbenchRuntimeResult } from '../workbench/workbenchRuntimeLauncher.js';
import { createWorkbenchLaunchUrl, normalizeWorkbenchLaunchNextPath } from '@debrute/workbench-runtime';

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
    const next = launchNextPath(args.options.next);
    const runtime = await (services.ensureRuntime ?? ensureWorkbenchRuntime)();
    const launchUrl = createWorkbenchLaunchUrl({
      webUrl: runtime.state.webUrl,
      token: runtime.state.token,
      next
    });
    return {
      status: 'ok',
      command: args.command,
      fields: {
        web_url: runtime.state.webUrl,
        launch_url: launchUrl,
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

function launchNextPath(input: string | undefined): string {
  const next = input ?? '/';
  const normalized = normalizeWorkbenchLaunchNextPath(next);
  if (!normalized) {
    throw cliError('invalid_input', `Debrute Workbench launch next path must be a normalized same-origin path: ${next}`, {
      next
    });
  }
  return normalized;
}

function portFromUrl(url: string): number {
  const parsed = new URL(url);
  return Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
}
