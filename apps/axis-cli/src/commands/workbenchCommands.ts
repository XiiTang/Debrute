import { stat } from 'node:fs/promises';
import { cliError, isAxisCliError, messageFromUnknown } from '../errors/cliErrors.js';
import type { ParsedAxisArgs } from '../parser/parseAxisArgs.js';
import type { AxisAgentResult } from '../output/renderAgentRecord.js';
import { ensureWorkbenchRuntime, type EnsureWorkbenchRuntimeResult } from '../workbench/workbenchRuntimeLauncher.js';

type WorkbenchFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface WorkbenchCommandServices {
  ensureRuntime?: () => Promise<EnsureWorkbenchRuntimeResult>;
  fetch?: WorkbenchFetch;
}

interface OpenProjectResponse {
  projectId: string;
}

interface AxisHttpErrorBody {
  error?: {
    code?: unknown;
    message?: unknown;
  };
}

export async function runWorkbenchCommand(
  args: ParsedAxisArgs,
  services: WorkbenchCommandServices = {}
): Promise<AxisAgentResult> {
  if (args.command !== 'workbench.url') {
    throw cliError('invalid_command', `Unknown AXIS workbench command: ${args.command}`);
  }

  try {
    const projectRoot = requireProjectRoot(args);
    await assertProjectDirectory(projectRoot);
    const runtime = await (services.ensureRuntime ?? ensureWorkbenchRuntime)();
    const opened = await openProject(runtime.state.daemonUrl, runtime.state.token, projectRoot, services.fetch ?? fetch);
    const projectUrl = workbenchProjectUrl(runtime.state.webUrl, opened.projectId, runtime.state.token);

    return {
      status: 'ok',
      command: args.command,
      fields: {
        project_url: projectUrl,
        web_url: runtime.state.webUrl,
        daemon_url: runtime.state.daemonUrl,
        project_id: opened.projectId,
        web_port: portFromUrl(runtime.state.webUrl),
        daemon_port: portFromUrl(runtime.state.daemonUrl),
        runtime_started: runtime.runtimeStarted,
        runtime_kind: runtime.state.runtimeKind,
        state_path: runtime.statePath
      }
    };
  } catch (error) {
    if (isAxisCliError(error)) {
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

function requireProjectRoot(args: ParsedAxisArgs): string {
  if (!args.projectRoot) {
    throw cliError('missing_argument', 'workbench.url requires <project>.');
  }
  return args.projectRoot;
}

async function assertProjectDirectory(projectRoot: string): Promise<void> {
  try {
    if (!(await stat(projectRoot)).isDirectory()) {
      throw cliError('project_not_found', `Project path must resolve to a directory: ${projectRoot}`);
    }
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw cliError('project_not_found', `Project path must resolve to a directory: ${projectRoot}`);
    }
    throw error;
  }
}

async function openProject(
  daemonUrl: string,
  token: string,
  projectRoot: string,
  fetchImpl: WorkbenchFetch
): Promise<OpenProjectResponse> {
  try {
    const response = await fetchImpl(new URL('/api/projects/open', daemonUrl).toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-axis-daemon-token': token
      },
      body: JSON.stringify({ projectRoot })
    });
    if (!response.ok) {
      throw await cliErrorFromProjectOpenResponse(response);
    }
    const parsed = await response.json() as Partial<OpenProjectResponse>;
    if (!parsed.projectId) {
      throw cliError('runtime_health_failed', 'AXIS daemon project open response did not include projectId.');
    }
    return { projectId: parsed.projectId };
  } catch (error) {
    if (isAxisCliError(error)) {
      throw error;
    }
    throw cliError('runtime_health_failed', messageFromUnknown(error));
  }
}

async function cliErrorFromProjectOpenResponse(response: Response) {
  const daemonError = await readDaemonError(response);
  if (!daemonError) {
    return cliError('runtime_health_failed', `AXIS daemon project open failed: ${response.status}`);
  }

  switch (daemonError.code) {
    case 'daemon_not_ready':
    case 'forbidden':
      return cliError('runtime_health_failed', daemonError.message);
    case 'not_found':
      return cliError('project_not_found', daemonError.message);
    case 'invalid_project_path':
    case 'project_path_forbidden':
    case 'project_invalid':
      return cliError('project_invalid', daemonError.message);
    case 'invalid_input':
      return cliError('invalid_input', daemonError.message);
    case 'internal_error':
      return cliError('internal_error', daemonError.message);
    default:
      return cliError(response.status >= 500 ? 'internal_error' : 'invalid_input', daemonError.message);
  }
}

async function readDaemonError(response: Response): Promise<{ code: string; message: string } | undefined> {
  try {
    const parsed = await response.json() as AxisHttpErrorBody;
    const code = parsed.error?.code;
    const message = parsed.error?.message;
    if (typeof code === 'string' && typeof message === 'string' && message.trim()) {
      return { code, message };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function workbenchProjectUrl(webUrl: string, projectId: string, token: string): string {
  const url = new URL(`/projects/${encodeURIComponent(projectId)}`, webUrl);
  url.searchParams.set('axis-token', token);
  return url.toString();
}

function portFromUrl(url: string): number {
  const parsed = new URL(url);
  return Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as { code?: unknown }).code === 'string';
}
