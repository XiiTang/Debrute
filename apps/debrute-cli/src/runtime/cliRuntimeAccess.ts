import {
  checkWorkbenchRuntimeHealth,
  isWorkbenchRuntimeOwnedBy,
  readWorkbenchRuntimeState,
  resolveWorkbenchRuntimePaths,
  type EnsureRegisteredWorkbenchRuntimeResult,
  type WorkbenchRuntimeHealthStatus,
  type WorkbenchRuntimeOwner,
  type WorkbenchRuntimeState
} from '@debrute/workbench-runtime';
import type {
  DaemonCliCommandRequest,
  DaemonCliRunEvent,
  DebruteAgentCommandResult,
  SkillsStatusSnapshot
} from '@debrute/app-protocol';
import type { ParsedDebruteArgs } from '../parser/parseDebruteArgs.js';
import { renderAgentProgressRecord } from '../output/renderAgentRecord.js';
import { ensureWorkbenchRuntime } from '../workbench/workbenchRuntimeLauncher.js';
import { resolveCliRuntimeOwner } from '../workbench/cliRuntimeOwner.js';
import { createCliSkillsRuntime } from './createCliSkillsRuntime.js';
import {
  addCliSkillsToRuntimeDoctor,
  addCliSkillsToRuntimeStatus
} from './cliSkillsRuntimeSummary.js';
import { runtimePolicyForCommand } from './cliRuntimePolicy.js';

type RuntimeFetch = (url: string, init?: RequestInit) => Promise<Response>;
type EnsureRuntimeForCli = (input?: {
  shouldTerminateStaleRuntime?: (state: WorkbenchRuntimeState) => boolean;
}) => Promise<EnsureRegisteredWorkbenchRuntimeResult>;

export interface CliRuntimeAccessServices {
  ensureRuntime?: EnsureRuntimeForCli;
  readRuntimeState?: typeof readWorkbenchRuntimeState;
  checkHealth?: (state: WorkbenchRuntimeState) => Promise<WorkbenchRuntimeHealthStatus>;
  skillsStatus?: () => Promise<SkillsStatusSnapshot>;
  fetch?: RuntimeFetch;
  owner?: WorkbenchRuntimeOwner;
  output?: (text: string) => void;
}

export async function runRuntimeBackedCliCommand(
  args: ParsedDebruteArgs,
  services: CliRuntimeAccessServices = {}
): Promise<DebruteAgentCommandResult> {
  const policy = runtimePolicyForCommand(args.command);
  if (policy === 'no-runtime') {
    throw new Error(`Command ${args.command} is not runtime-backed.`);
  }
  if (policy === 'observe-runtime') {
    return observeRuntimeCommand(args, services);
  }
  const owner = services.owner ?? await resolveCliRuntimeOwner();
  const ensureRuntime = services.ensureRuntime ?? (() => ensureWorkbenchRuntime());
  const runtime = await ensureRuntime({
    shouldTerminateStaleRuntime: (state) => isWorkbenchRuntimeOwnedBy(state, owner)
  });
  if (args.command === 'workbench.url') {
    throw new Error('workbench.url uses the dedicated workbench URL command path.');
  }
  if (args.command === 'generate.image-batch') {
    return applyRuntimeBackedResultExitCode(
      await postDaemonCliRunStream(runtime.state, args, services.fetch ?? fetch, services.output)
    );
  }
  return applyRuntimeBackedResultExitCode(await postDaemonCliRun(runtime.state, args, services.fetch ?? fetch));
}

async function observeRuntimeCommand(
  args: ParsedDebruteArgs,
  services: CliRuntimeAccessServices
): Promise<DebruteAgentCommandResult> {
  const statePath = resolveWorkbenchRuntimePaths().statePath;
  let state: WorkbenchRuntimeState | undefined;
  try {
    state = await (services.readRuntimeState ?? readWorkbenchRuntimeState)(statePath);
  } catch (error) {
    return addCliSkillsToObserveResult(args.command, unreadableRuntimeObserveResult(args.command, error), services);
  }
  if (!state) {
    return addCliSkillsToObserveResult(args.command, stoppedRuntimeObserveResult(args.command), services);
  }
  const health = await (services.checkHealth ?? checkWorkbenchRuntimeHealth)(state);
  if (health !== 'healthy' && health !== 'web-unavailable') {
    return addCliSkillsToObserveResult(args.command, {
      status: 'ok',
      command: args.command,
      fields: {
        runtime_state: health,
        runtime_kind: state.runtimeKind,
        owner_kind: state.owner.kind,
        owner_id: state.owner.ownerId
      }
    }, services);
  }
  const result = await postDaemonCliRun(state, args, services.fetch ?? fetch);
  return addCliSkillsToObserveResult(args.command, result, services);
}

function unreadableRuntimeObserveResult(command: string, error: unknown): DebruteAgentCommandResult {
  const message = `Debrute workbench runtime state is unreadable: ${messageFromUnknown(error)}`;
  if (command !== 'runtime.doctor') {
    return {
      status: 'error',
      command,
      code: 'runtime_state_unreadable',
      message
    };
  }
  return {
    status: 'ok',
    command,
    records: [{
      name: 'diagnostic',
      fields: {
        code: 'runtime_state_unreadable',
        severity: 'error',
        message
      }
    }],
    fields: {
      runtime_state: 'unreadable',
      diagnostics: 1
    }
  };
}

function stoppedRuntimeObserveResult(command: string): DebruteAgentCommandResult {
  if (command !== 'runtime.doctor') {
    return {
      status: 'ok',
      command,
      fields: { runtime_state: 'stopped' }
    };
  }
  return {
    status: 'ok',
    command,
    records: [{
      name: 'diagnostic',
      fields: {
        code: 'runtime_stopped',
        severity: 'warning',
        message: 'Debrute workbench runtime is not running.'
      }
    }],
    fields: {
      runtime_state: 'stopped',
      diagnostics: 1
    }
  };
}

async function postDaemonCliRun(
  state: WorkbenchRuntimeState,
  args: ParsedDebruteArgs,
  fetchImpl: RuntimeFetch
): Promise<DebruteAgentCommandResult> {
  const response = await fetchImpl(new URL('/api/cli/run', state.daemonUrl).toString(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-debrute-daemon-token': state.token
    },
    body: JSON.stringify(commandRequest(args))
  });
  if (!response.ok) {
    throw new Error(`Debrute runtime CLI bridge failed: ${response.status}`);
  }
  return await response.json() as DebruteAgentCommandResult;
}

async function postDaemonCliRunStream(
  state: WorkbenchRuntimeState,
  args: ParsedDebruteArgs,
  fetchImpl: RuntimeFetch,
  output?: (text: string) => void
): Promise<DebruteAgentCommandResult> {
  const response = await fetchImpl(new URL('/api/cli/run-stream', state.daemonUrl).toString(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-debrute-daemon-token': state.token
    },
    body: JSON.stringify(commandRequest(args))
  });
  if (!response.ok || !response.body) {
    throw new Error(`Debrute runtime CLI stream failed: ${response.status}`);
  }
  let finalResult: DebruteAgentCommandResult | undefined;
  for await (const line of ndjsonLines(response.body)) {
    const event = JSON.parse(line) as DaemonCliRunEvent;
    if (event.type === 'progress') {
      output?.(renderAgentProgressRecord(event.command, event.fields));
    } else {
      finalResult = event.result;
    }
  }
  if (!finalResult) {
    throw new Error('Debrute runtime CLI stream ended without a final result.');
  }
  return finalResult;
}

function applyRuntimeBackedResultExitCode(result: DebruteAgentCommandResult): DebruteAgentCommandResult {
  const failed = result.fields?.failed;
  if (
    result.command === 'generate.image-batch'
    && result.status === 'ok'
    && typeof failed === 'number'
    && failed > 0
  ) {
    process.exitCode = 1;
  }
  return result;
}

function commandRequest(args: ParsedDebruteArgs): DaemonCliCommandRequest {
  return {
    command: args.command,
    positional: args.positional,
    options: args.options,
    ...(args.projectRoot ? { projectRoot: args.projectRoot } : {})
  };
}

async function addCliSkillsToObserveResult(
  command: string,
  result: DebruteAgentCommandResult,
  services: CliRuntimeAccessServices
): Promise<DebruteAgentCommandResult> {
  if (result.status !== 'ok') {
    return result;
  }
  if (command !== 'runtime.status' && command !== 'runtime.doctor') {
    return result;
  }
  const snapshot = await readCliSkillsStatus(services);
  return command === 'runtime.status'
    ? addCliSkillsToRuntimeStatus(result, snapshot)
    : addCliSkillsToRuntimeDoctor(result, snapshot);
}

async function readCliSkillsStatus(services: CliRuntimeAccessServices): Promise<SkillsStatusSnapshot> {
  if (services.skillsStatus) {
    return services.skillsStatus();
  }
  const skillsRuntime = await createCliSkillsRuntime();
  return skillsRuntime.skillsService.status();
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function* ndjsonLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      if (line) {
        yield line;
      }
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
  }
  const tail = buffer.trim();
  if (tail) {
    yield tail;
  }
}
