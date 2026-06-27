import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isLoopbackHttpUrl } from './ports.js';

export type WorkbenchRuntimeKind = 'source-dev' | 'packaged' | 'desktop-dev' | 'desktop-packaged';
export type WorkbenchRuntimeProcessControl = 'managed' | 'external';
export type WorkbenchRuntimeOwnerKind = 'cli' | 'desktop' | 'dev';

export interface WorkbenchRuntimeOwner {
  kind: WorkbenchRuntimeOwnerKind;
  ownerId: string;
  pid: number;
}

export interface WorkbenchRuntimeState {
  runtimeKind: WorkbenchRuntimeKind;
  processControl: WorkbenchRuntimeProcessControl;
  owner: WorkbenchRuntimeOwner;
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
      throw new Error(`Invalid Debrute workbench runtime state: ${error.message}`);
    }
    throw error;
  }
}

export async function writeWorkbenchRuntimeState(statePath: string, state: WorkbenchRuntimeState): Promise<void> {
  const normalizedState = assertWorkbenchRuntimeState(state);
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(normalizedState, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tempPath, statePath);
}

export async function deleteWorkbenchRuntimeState(statePath: string): Promise<void> {
  await rm(statePath, { force: true });
}

function assertWorkbenchRuntimeState(value: unknown): WorkbenchRuntimeState {
  if (!isRecord(value)) {
    throw invalidState('expected object');
  }
  if (!isRuntimeKind(value.runtimeKind)) {
    throw invalidState('unsupported runtimeKind');
  }
  if (!isProcessControl(value.processControl)) {
    throw invalidState('unsupported processControl');
  }
  if (!isRuntimeOwner(value.owner)) {
    throw invalidState('owner must include kind, ownerId, and pid');
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
    runtimeKind: value.runtimeKind,
    processControl: value.processControl,
    owner: value.owner,
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

function isRuntimeOwner(value: unknown): value is WorkbenchRuntimeOwner {
  if (!isRecord(value)) {
    return false;
  }
  return isOwnerKind(value.kind)
    && typeof value.ownerId === 'string'
    && value.ownerId.length > 0
    && isPid(value.pid);
}

function isOwnerKind(value: unknown): value is WorkbenchRuntimeOwnerKind {
  return value === 'cli' || value === 'desktop' || value === 'dev';
}

function isPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function invalidState(message: string): Error {
  return new Error(`Invalid Debrute workbench runtime state: ${message}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as { code?: unknown }).code === 'string';
}
