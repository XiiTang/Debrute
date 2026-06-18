import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, extname } from 'node:path';
import type {
  AdobeBridgeSettings,
  DaemonBridgeImportRequestMessage,
  SaveAdobeBridgeSettingsInput,
  SendProjectFileToPhotoshopInput,
  SendProjectFileToPhotoshopResult
} from '@debrute/app-protocol';
import {
  AdobeBridgeProjectFileError,
  importAdobeBridgePngTransfer,
  isSupportedAdobeBridgeProjectImageFile,
  resolveExistingProjectPath
} from '@debrute/project-core';
import { AdobeBridgeError, adobeBridgeHttpStatus, createAdobeBridgeError } from './AdobeBridgeErrors.js';
import { ADOBE_BRIDGE_TRANSFER_TIMEOUT_MS, type AdobeBridgeService } from './AdobeBridgeService.js';
import type { ProjectSessionRegistry } from '../http/ProjectSessionRegistry.js';

interface TransferContentEntry {
  transferId: string;
  projectId: string;
  adobeClientId: string;
  projectRelativePath: string;
  token: string;
  expiresAt: number;
}

export interface AdobeBridgeHttpRouteContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  daemonUrl: string;
  bridge: AdobeBridgeService;
  sessions: ProjectSessionRegistry;
  getSettings(): Promise<AdobeBridgeSettings>;
  saveSettings(input: SaveAdobeBridgeSettingsInput): Promise<AdobeBridgeSettings>;
  sendImportRequest(adobeClientId: string, message: DaemonBridgeImportRequestMessage): boolean;
  transferContents: Map<string, TransferContentEntry>;
}

export async function routeAdobeBridgeHttp(context: AdobeBridgeHttpRouteContext): Promise<boolean> {
  const method = context.request.method ?? 'GET';
  const path = context.url.pathname;

  if (method === 'GET' && path === '/api/adobe-bridge') {
    context.bridge.setSettings(await context.getSettings());
    syncAdobeBridgeProjects(context);
    writeJson(context.response, 200, context.bridge.state());
    return true;
  }

  if (method === 'PUT' && path === '/api/adobe-bridge/settings') {
    const settings = await context.saveSettings(await readJsonBody<SaveAdobeBridgeSettingsInput>(context.request));
    context.bridge.setSettings(settings);
    syncAdobeBridgeProjects(context);
    writeJson(context.response, 200, context.bridge.state());
    return true;
  }

  const linkRoute = /^\/api\/projects\/([^/]+)\/adobe-bridge\/links(?:\/([^/]+))?$/.exec(path);
  if (linkRoute?.[1]) {
    await handleLinkRoute(context, method, decodeURIComponent(linkRoute[1]), linkRoute[2] ? decodeURIComponent(linkRoute[2]) : undefined);
    return true;
  }

  const pluginLinkRoute = /^\/api\/adobe-bridge\/plugin\/projects\/([^/]+)\/link$/.exec(path);
  if (pluginLinkRoute?.[1]) {
    await handlePluginLinkRoute(context, method, decodeURIComponent(pluginLinkRoute[1]));
    return true;
  }

  const sendRoute = /^\/api\/projects\/([^/]+)\/adobe-bridge\/send-to-photoshop$/.exec(path);
  if (sendRoute?.[1]) {
    if (method !== 'POST') {
      throw new AdobeBridgeError('invalid_transfer_payload', 'Unsupported Adobe Bridge send method.');
    }
    await handleSendProjectFileToPhotoshop(context, decodeURIComponent(sendRoute[1]));
    return true;
  }

  const uploadRoute = /^\/api\/adobe-bridge\/plugin\/projects\/([^/]+)\/uploads$/.exec(path);
  if (method === 'POST' && uploadRoute?.[1]) {
    await handlePhotoshopUpload(context, decodeURIComponent(uploadRoute[1]));
    return true;
  }

  const contentRoute = /^\/api\/adobe-bridge\/transfers\/([^/]+)\/content$/.exec(path);
  if (method === 'GET' && contentRoute?.[1]) {
    await handleTransferContent(context, decodeURIComponent(contentRoute[1]));
    return true;
  }

  return false;
}

export function syncAdobeBridgeProjects(context: Pick<AdobeBridgeHttpRouteContext, 'bridge' | 'sessions'>): void {
  context.bridge.replaceProjects(context.sessions.list().map((session) => ({
    projectId: session.projectId,
    projectName: session.snapshot.metadata.project.name,
    projectRevision: session.projectRevision,
    connectedWorkbenchClientCount: session.clients.size,
    files: session.snapshot.files
  })));
}

async function handleLinkRoute(
  context: AdobeBridgeHttpRouteContext,
  method: string,
  projectId: string,
  adobeClientIdFromPath: string | undefined
): Promise<void> {
  syncAdobeBridgeProjects(context);
  context.bridge.setSettings(await context.getSettings());
  if (method === 'POST' && !adobeClientIdFromPath) {
    const body = await readJsonBody<{ adobeClientId?: unknown }>(context.request);
    const adobeClientId = stringField(body.adobeClientId, 'adobeClientId');
    writeJson(context.response, 200, context.bridge.linkProjectToPhotoshop(projectId, adobeClientId));
    return;
  }
  if (method === 'DELETE' && adobeClientIdFromPath) {
    writeJson(context.response, 200, context.bridge.unlinkProjectFromPhotoshop(projectId, adobeClientIdFromPath));
    return;
  }
  throw new AdobeBridgeError('invalid_transfer_payload', 'Unsupported Adobe Bridge link method.');
}

async function handlePluginLinkRoute(
  context: AdobeBridgeHttpRouteContext,
  method: string,
  projectId: string
): Promise<void> {
  syncAdobeBridgeProjects(context);
  context.bridge.setSettings(await context.getSettings());
  const adobeClientId = requiredHeader(context.request, 'x-debrute-adobe-client-id');
  if (method === 'POST') {
    context.bridge.linkProjectToPhotoshop(projectId, adobeClientId);
    writeJson(context.response, 200, context.bridge.stateForPhotoshopClient(adobeClientId));
    return;
  }
  if (method === 'DELETE') {
    context.bridge.unlinkProjectFromPhotoshop(projectId, adobeClientId);
    writeJson(context.response, 200, context.bridge.stateForPhotoshopClient(adobeClientId));
    return;
  }
  throw new AdobeBridgeError('invalid_transfer_payload', 'Unsupported Adobe Bridge plugin link method.');
}

async function handleSendProjectFileToPhotoshop(
  context: AdobeBridgeHttpRouteContext,
  projectId: string
): Promise<void> {
  syncAdobeBridgeProjects(context);
  context.bridge.setSettings(await context.getSettings());
  const body = await readJsonBody<SendProjectFileToPhotoshopInput>(context.request);
  const adobeClientId = stringField(body.adobeClientId, 'adobeClientId');
  const projectRelativePath = stringField(body.projectRelativePath, 'projectRelativePath');
  context.bridge.assertTransferAllowed(projectId, adobeClientId);
  if (!isSupportedAdobeBridgeProjectImageFile(projectRelativePath)) {
    throw createAdobeBridgeError('unsupported_file_type', { projectRelativePath });
  }
  const session = context.sessions.get(projectId);
  if (!session) {
    throw createAdobeBridgeError('project_offline', { projectId });
  }
  const absolutePath = await resolveExistingProjectPath(session.projectRoot, projectRelativePath);
  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile()) {
    throw createAdobeBridgeError('unsupported_file_type', { projectRelativePath });
  }
  const transfer = context.bridge.createTransfer({
    direction: 'debrute-to-photoshop',
    projectId,
    adobeClientId,
    projectRelativePath
  });
  const token = randomUUID();
  context.transferContents.set(transfer.transferId, {
    transferId: transfer.transferId,
    projectId,
    adobeClientId,
    projectRelativePath,
    token,
    expiresAt: Date.now() + ADOBE_BRIDGE_TRANSFER_TIMEOUT_MS
  });
  const downloadUrl = new URL(`/api/adobe-bridge/transfers/${encodeURIComponent(transfer.transferId)}/content`, context.daemonUrl);
  downloadUrl.searchParams.set('token', token);
  const message: DaemonBridgeImportRequestMessage = {
    type: 'transfer.import.request',
    transferId: transfer.transferId,
    projectId,
    projectRelativePath,
    fileName: basename(projectRelativePath),
    mimeType: mimeTypeForAdobeBridgeProjectFile(projectRelativePath),
    byteLength: fileStat.size,
    downloadUrl: downloadUrl.toString()
  };
  if (!context.sendImportRequest(adobeClientId, message)) {
    context.bridge.updateTransfer({
      transferId: transfer.transferId,
      status: 'failed',
      errorCode: 'adobe_client_offline',
      message: createAdobeBridgeError('adobe_client_offline').message
    });
    throw createAdobeBridgeError('adobe_client_offline', { adobeClientId });
  }
  const runningTransfer = context.bridge.updateTransfer({ transferId: transfer.transferId, status: 'running' })!;
  writeJson(context.response, 200, {
    transfer: runningTransfer
  } satisfies SendProjectFileToPhotoshopResult);
}

async function handlePhotoshopUpload(context: AdobeBridgeHttpRouteContext, projectId: string): Promise<void> {
  syncAdobeBridgeProjects(context);
  context.bridge.setSettings(await context.getSettings());
  const adobeClientId = requiredHeader(context.request, 'x-debrute-adobe-client-id');
  const transferId = requiredHeader(context.request, 'x-debrute-transfer-id');
  const targetDirectoryProjectRelativePath = requiredPercentEncodedHeader(context.request, 'x-debrute-target-directory');
  const suggestedName = requiredPercentEncodedHeader(context.request, 'x-debrute-suggested-name');
  const mimeType = String(context.request.headers['content-type'] ?? '').split(';')[0] ?? '';
  context.bridge.assertTransferAllowed(projectId, adobeClientId);
  const releaseRequest = context.sessions.registerRequest(projectId);
  const session = context.sessions.get(projectId);
  if (!releaseRequest || !session) {
    throw createAdobeBridgeError('project_offline', { projectId });
  }
  try {
    const byteLength = Number(context.request.headers['content-length'] ?? '0');
    const transfer = context.bridge.createTransfer({
      transferId,
      direction: 'photoshop-to-debrute',
      projectId,
      adobeClientId,
      projectRelativePath: null
    });
    const result = await context.sessions.runProjectOperation(projectId, async (record) => {
      const imported = await importAdobeBridgePngTransfer(record.projectRoot, {
        targetDirectoryProjectRelativePath,
        suggestedName,
        content: context.request,
        byteLength,
        mimeType
      });
      await record.appServer.refreshProject();
      return {
        projectRelativePath: imported.projectRelativePath,
        kind: imported.kind
      };
    });
    context.bridge.updateTransfer({
      transferId: transfer.transferId,
      status: 'succeeded',
      projectRelativePath: result.projectRelativePath
    });
    writeJson(context.response, 200, {
      transferId,
      projectId,
      projectRevision: result.projectRevision,
      projectRelativePath: result.projectRelativePath,
      kind: result.kind
    });
  } catch (error) {
    context.bridge.updateTransfer({
      transferId,
      status: 'failed',
      ...adobeBridgeTransferFailure(error)
    });
    throw error;
  } finally {
    releaseRequest();
  }
}

function adobeBridgeTransferFailure(error: unknown): { errorCode?: AdobeBridgeError['code']; message?: string } {
  if (error instanceof AdobeBridgeProjectFileError) {
    const bridgeError = createAdobeBridgeError(error.code, error.fields);
    return { errorCode: bridgeError.code, message: bridgeError.message };
  }
  if (error instanceof AdobeBridgeError) {
    return { errorCode: error.code, message: error.message };
  }
  return error instanceof Error ? { message: error.message } : {};
}

async function handleTransferContent(context: AdobeBridgeHttpRouteContext, transferId: string): Promise<void> {
  const entry = context.transferContents.get(transferId);
  if (!entry || context.url.searchParams.get('token') !== entry.token || Date.now() > entry.expiresAt) {
    throw createAdobeBridgeError('transfer_url_expired', { transferId });
  }
  context.bridge.setSettings(await context.getSettings());
  context.bridge.assertTransferAllowed(entry.projectId, entry.adobeClientId);
  const transfer = context.bridge.state().transfers.find((candidate) => candidate.transferId === transferId);
  if (transfer?.status !== 'pending' && transfer?.status !== 'running') {
    throw createAdobeBridgeError('transfer_url_expired', { transferId });
  }
  const session = context.sessions.get(entry.projectId);
  if (!session) {
    throw createAdobeBridgeError('project_offline', { projectId: entry.projectId });
  }
  const absolutePath = await resolveExistingProjectPath(session.projectRoot, entry.projectRelativePath);
  const fileStat = await stat(absolutePath);
  context.response.writeHead(200, {
    'content-length': String(fileStat.size),
    'content-type': mimeTypeForAdobeBridgeProjectFile(entry.projectRelativePath)
  });
  await new Promise<void>((resolve, reject) => {
    createReadStream(absolutePath)
      .once('error', reject)
      .once('end', resolve)
      .pipe(context.response);
  });
}

export function mimeTypeForAdobeBridgeProjectFile(projectRelativePath: string): DaemonBridgeImportRequestMessage['mimeType'] {
  const extension = extname(projectRelativePath).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.psd') return 'image/vnd.adobe.photoshop';
  throw createAdobeBridgeError('unsupported_file_type', { projectRelativePath });
}

function requiredHeader(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  if (typeof value !== 'string' || !value.trim()) {
    throw createAdobeBridgeError('invalid_transfer_payload', { header: name });
  }
  return value;
}

function requiredPercentEncodedHeader(request: IncomingMessage, name: string): string {
  const value = requiredHeader(request, name);
  try {
    return decodeURIComponent(value);
  } catch {
    throw createAdobeBridgeError('invalid_transfer_payload', { header: name });
  }
}

function stringField(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw createAdobeBridgeError('invalid_transfer_payload', { field: name });
  }
  return value;
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  let body = '';
  for await (const chunk of request) {
    body += String(chunk);
  }
  return body.trim() ? JSON.parse(body) as T : {} as T;
}

export function writeAdobeBridgeCaughtError(response: ServerResponse, error: unknown): boolean {
  if (error instanceof AdobeBridgeProjectFileError) {
    const bridgeError = createAdobeBridgeError(error.code, error.fields);
    writeJson(response, adobeBridgeHttpStatus(bridgeError.code), {
      error: {
        code: bridgeError.code,
        message: bridgeError.message,
        details: bridgeError.fields
      }
    });
    return true;
  }
  if (!(error instanceof AdobeBridgeError)) {
    return false;
  }
  writeJson(response, adobeBridgeHttpStatus(error.code), {
    error: {
      code: error.code,
      message: error.message,
      details: error.fields
    }
  });
  return true;
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}
