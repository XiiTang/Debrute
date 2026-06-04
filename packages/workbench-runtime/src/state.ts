import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isLoopbackHttpUrl } from './ports.js';

export type WorkbenchRuntimeKind = 'source-dev' | 'packaged' | 'desktop-dev' | 'desktop-packaged';
export type WorkbenchRuntimeProcessControl = 'managed' | 'external';

export interface WorkbenchRuntimeState {
  schemaVersion: 1;
  runtimeKind: WorkbenchRuntimeKind;
  processControl: WorkbenchRuntimeProcessControl;
  daemonUrl: string;
  webUrl: string;
  token: string;
  daemonPid: number;
  webPid?: number;
  daemonLogPath: string;
  webLogPath: string;
  startedAt: string;
  updatedAt: string;
}

export async function readWorkbenchRuntimeState(statePath: string): Promise<WorkbenchRuntimeState | undefined> {
  try {
    return assertWorkbenchRuntimeState(JSON.parse(await readFile(statePath, 'utf8')) as unknown);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return undefined;
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid AXIS workbench runtime state: ${error.message}`);
    }
    throw error;
  }
}

export async function writeWorkbenchRuntimeState(statePath: string, state: WorkbenchRuntimeState): Promise<void> {
  assertWorkbenchRuntimeState(state);
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tempPath, statePath);
}

export async function deleteWorkbenchRuntimeState(statePath: string): Promise<void> {
  await rm(statePath, { force: true });
}

function assertWorkbenchRuntimeState(value: unknown): WorkbenchRuntimeState {
  if (!isRecord(value)) {
    throw invalidState('expected object');
  }
  if (value.schemaVersion !== 1) {
    throw invalidState('schemaVersion must be 1');
  }
  if (!isRuntimeKind(value.runtimeKind)) {
    throw invalidState('unsupported runtimeKind');
  }
  if (!isProcessControl(value.processControl)) {
    throw invalidState('unsupported processControl');
  }
  if (typeof value.daemonUrl !== 'string' || !isLoopbackHttpUrl(value.daemonUrl)) {
    throw invalidState('daemonUrl must be a loopback HTTP origin');
  }
  if (typeof value.webUrl !== 'string' || !isLoopbackHttpUrl(value.webUrl)) {
    throw invalidState('webUrl must be a loopback HTTP origin');
  }
  if (typeof value.token !== 'string' || value.token.length === 0) {
    throw invalidState('token must be a non-empty string');
  }
  if (!isPid(value.daemonPid)) {
    throw invalidState('daemonPid must be a process id');
  }
  if ('webPid' in value && value.webPid !== undefined && !isPid(value.webPid)) {
    throw invalidState('webPid must be a process id');
  }
  if (
    typeof value.daemonLogPath !== 'string'
    || typeof value.webLogPath !== 'string'
    || typeof value.startedAt !== 'string'
    || typeof value.updatedAt !== 'string'
  ) {
    throw invalidState('log paths and timestamps must be strings');
  }
  const state: WorkbenchRuntimeState = {
    schemaVersion: 1,
    runtimeKind: value.runtimeKind,
    processControl: value.processControl,
    daemonUrl: value.daemonUrl,
    webUrl: value.webUrl,
    token: value.token,
    daemonPid: value.daemonPid,
    daemonLogPath: value.daemonLogPath,
    webLogPath: value.webLogPath,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt
  };
  if (typeof value.webPid === 'number') {
    state.webPid = value.webPid;
  }
  return state;
}

function isRuntimeKind(value: unknown): value is WorkbenchRuntimeKind {
  return value === 'source-dev'
    || value === 'packaged'
    || value === 'desktop-dev'
    || value === 'desktop-packaged';
}

function isProcessControl(value: unknown): value is WorkbenchRuntimeProcessControl {
  return value === 'managed' || value === 'external';
}

function isPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function invalidState(message: string): Error {
  return new Error(`Invalid AXIS workbench runtime state: ${message}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as { code?: unknown }).code === 'string';
}
