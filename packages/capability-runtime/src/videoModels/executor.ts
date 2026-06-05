import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { readProjectFileBytes, writeProjectFile } from '@debrute/project-core';
import type { SecretsConfig, VideoModelsConfig } from '../config.js';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  fetchWithRequestTimeout,
  readResponseArrayBufferWithTimeout as readResponseArrayBufferBodyWithTimeout,
  readResponseTextWithTimeout as readResponseTextBodyWithTimeout
} from '../requestTimeout.js';
import { createVideoModelCatalog, type VideoModelCatalogEntry } from './catalog.js';

export type VideoModelFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface VideoModelRequestInput {
  model: string;
  arguments: Record<string, unknown>;
  timeoutMs?: number;
}

export interface VideoModelRequestArtifact {
  artifactId: string;
  title: string;
  projectRelativePath: string;
  mimeType: string;
  width?: number;
  height?: number;
}

export interface ExecuteVideoModelRequestInput {
  projectRoot: string;
  invocationId: string;
  input: VideoModelRequestInput;
  settings: VideoModelsConfig;
  secrets: Pick<SecretsConfig, 'videoModelApiKeys'>;
  fetch?: VideoModelFetch;
  recordGeneratedAsset?: VideoGeneratedAssetRecorder;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  pollMaxAttempts?: number;
  signal?: AbortSignal;
}

export interface VideoGeneratedAssetRecorderInput {
  projectRelativePath: string;
  modelRun: {
    request: unknown;
    output: unknown;
  };
}

export type VideoGeneratedAssetRecorder = (input: VideoGeneratedAssetRecorderInput) => Promise<void>;

type ModelEndpointResponse = {
  status?: number;
  body: unknown;
};

export type ExecuteVideoModelRequestResult =
  | { status: 'ok'; content: string; artifacts: VideoModelRequestArtifact[]; logs: Array<Record<string, unknown>> }
  | { status: 'error'; content: string; error: 'invalid_input' | 'model_unavailable' | 'video_model_not_configured' | 'video_request_failed'; logs: Array<Record<string, unknown>> };

interface RequestState {
  projectRoot: string;
  invocationId: string;
  entry: VideoModelCatalogEntry;
  baseUrl: string;
  apiKey: string;
  requestModelId: string;
  args: Record<string, unknown>;
  fetch: VideoModelFetch;
  recordGeneratedAsset?: VideoGeneratedAssetRecorder;
  modelRun: ModelRunLog;
  logs: Array<Record<string, unknown>>;
  pollIntervalMs: number;
  requestTimeoutMs: number;
  pollMaxAttempts: number;
  signal?: AbortSignal;
}

interface ModelRunLog {
  request?: unknown;
  responses: ModelResponseLog[];
}

interface ModelResponseLog {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

type VideoRequestError = Extract<ExecuteVideoModelRequestResult, { status: 'error' }>;
type JsonResponseResult = { ok: true; payload: Record<string, unknown>; endpointResponse: ModelEndpointResponse } | { ok: false; result: VideoRequestError };
type VideoTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'expired' | 'canceled';

const DEFAULT_POLL_ATTEMPTS = 180;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

export async function executeVideoModelRequest(input: ExecuteVideoModelRequestInput): Promise<ExecuteVideoModelRequestResult> {
  const logs: Array<Record<string, unknown>> = [];
  const catalog = createVideoModelCatalog();
  const entry = catalog.get(input.input.model);
  const modelSettings = input.settings.videoModels.find((model) => model.debruteModelId === input.input.model);
  const apiKey = input.secrets.videoModelApiKeys[input.input.model]?.trim() ?? '';
  if (!entry) {
    return {
      status: 'error',
      content: `Video model is unavailable: ${input.input.model}`,
      error: 'model_unavailable',
      logs
    };
  }
  if (!apiKey) {
    return {
      status: 'error',
      content: `Video model API key is missing: ${input.input.model}`,
      error: 'video_model_not_configured',
      logs
    };
  }

  let args: Record<string, unknown>;
  try {
    args = await resolveContentReferences(input.input.arguments, input.projectRoot);
  } catch (error) {
    return {
      status: 'error',
      content: errorMessage(error),
      error: 'invalid_input',
      logs
    };
  }

  const state: RequestState = {
    projectRoot: input.projectRoot,
    invocationId: input.invocationId,
    entry,
    baseUrl: modelSettings?.baseUrlOverride?.trim() || entry.defaultBaseUrl,
    apiKey,
    requestModelId: modelSettings?.requestModelIdOverride?.trim() || entry.defaultRequestModelId,
    args,
    fetch: input.fetch ?? fetch,
    ...(input.recordGeneratedAsset ? { recordGeneratedAsset: input.recordGeneratedAsset } : {}),
    modelRun: { responses: [] },
    logs,
    pollIntervalMs: input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    requestTimeoutMs: input.requestTimeoutMs ?? input.input.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    pollMaxAttempts: input.pollMaxAttempts ?? DEFAULT_POLL_ATTEMPTS,
    ...(input.signal ? { signal: input.signal } : {})
  };
  log(state, 'resolve_model', {
    model: entry.debruteModelId,
    requestModelId: state.requestModelId,
    configured: true
  });

  try {
    const result = await executeVolcengineArk(state);
    if (result.status === 'error') {
      return result;
    }
    return {
      status: 'ok',
      content: `Generated ${result.artifacts.length} video artifact(s).`,
      artifacts: result.artifacts,
      logs
    };
  } catch (error) {
    log(state, 'error', { message: errorMessage(error) });
    return {
      status: 'error',
      content: `Video request failed: ${errorMessage(error)}`,
      error: 'video_request_failed',
      logs
    };
  }
}

async function executeVolcengineArk(
  state: RequestState
): Promise<{ status: 'ok'; artifacts: VideoModelRequestArtifact[] } | VideoRequestError> {
  const body = { model: state.requestModelId, ...stripOutputArgs(state.args) };
  const submitUrl = joinUrl(state.baseUrl, 'contents/generations/tasks');
  log(state, 'build_request', { url: submitUrl, argumentKeys: Object.keys(state.args).sort(), contentTypes: contentTypes(state.args.content) });
  const submit = await postJson(state, submitUrl, authorizationHeaders(state), body);
  if (!submit.ok) {
    return submit.result;
  }
  const taskId = extractTaskId(submit.payload);
  if (!taskId) {
    return modelFailure(state, 'Video request failed: model response did not include a task id.', submit.endpointResponse);
  }

  const pollUrl = joinUrl(state.baseUrl, `contents/generations/tasks/${encodeURIComponent(taskId)}`);
  for (let attempt = 0; attempt < state.pollMaxAttempts; attempt += 1) {
    const poll = await getJson(state, pollUrl, authorizationHeaders(state));
    if (!poll.ok) {
      return poll.result;
    }
    const taskStatus = taskStatusFromPayload(poll.payload);
    if (!taskStatus) {
      return modelFailure(state, 'Video request failed: model endpoint returned an unknown task status.', poll.endpointResponse);
    }
    log(state, 'execute_request', { phase: 'poll', taskId, taskStatus });
    if (taskStatus === 'succeeded') {
      const videoUrl = extractOutputUrl(poll.payload, 'video_url');
      if (!videoUrl) {
        return modelFailure(state, 'Video request failed: model response did not include content.video_url.', poll.endpointResponse);
      }
      const artifacts: VideoModelRequestArtifact[] = [await storeDownloadedArtifact(state, videoUrl, 0, 'video/mp4')];
      if (state.args.return_last_frame === true) {
        const lastFrameUrl = extractOutputUrl(poll.payload, 'last_frame_url');
        if (lastFrameUrl) {
          artifacts.push(await storeDownloadedArtifact(state, lastFrameUrl, 1, 'image/png'));
        }
      }
      log(state, 'store_artifacts', { count: artifacts.length });
      return { status: 'ok', artifacts };
    }
    if (taskStatus === 'failed' || taskStatus === 'expired' || taskStatus === 'canceled') {
      return modelFailure(state, `Video request failed: model task ${taskStatus}.`, poll.endpointResponse);
    }
    await delay(state.pollIntervalMs, state.signal);
  }
  return modelFailure(state, 'Video request failed: model task polling timed out.', { body: { taskId, pollMaxAttempts: state.pollMaxAttempts } });
}

async function resolveContentReferences(args: Record<string, unknown>, projectRoot: string): Promise<Record<string, unknown>> {
  const content = args.content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error('Video request arguments.content must be a non-empty official Volcengine Ark content array.');
  }
  const resolvedContent = [];
  for (const item of content) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Video request content items must be objects.');
    }
    const next = { ...(item as Record<string, unknown>) };
    if (next.type === 'image_url') {
      next.image_url = { ...urlContainer(next.image_url, 'image_url'), url: await resolveImageUrl(urlString(next.image_url, 'image_url'), projectRoot) };
    } else if (next.type === 'audio_url') {
      next.audio_url = { ...urlContainer(next.audio_url, 'audio_url'), url: await resolveAudioUrl(urlString(next.audio_url, 'audio_url'), projectRoot) };
    } else if (next.type === 'video_url') {
      const url = urlString(next.video_url, 'video_url');
      if (!isHttpUrl(url) && !url.startsWith('asset://')) {
        throw new Error(`Local video input requires a public URL or asset:// reference: ${url}`);
      }
    }
    resolvedContent.push(next);
  }
  return { ...args, content: resolvedContent };
}

async function resolveImageUrl(url: string, projectRoot: string): Promise<string> {
  if (isHttpUrl(url) || url.startsWith('data:image/') || url.startsWith('asset://')) {
    return url;
  }
  const bytes = await readLocalReference(projectRoot, url, 'Image');
  return `data:${imageMimeType(Buffer.from(bytes), url)};base64,${Buffer.from(bytes).toString('base64')}`;
}

async function resolveAudioUrl(url: string, projectRoot: string): Promise<string> {
  if (isHttpUrl(url) || url.startsWith('data:audio/') || url.startsWith('asset://')) {
    return url;
  }
  const bytes = await readLocalReference(projectRoot, url, 'Audio');
  return `data:${audioMimeType(url)};base64,${Buffer.from(bytes).toString('base64')}`;
}

async function readLocalReference(projectRoot: string, path: string, label: string): Promise<Uint8Array> {
  try {
    return await readProjectFileBytes(projectRoot, path);
  } catch {
    throw new Error(`${label} reference not found in project: ${path}`);
  }
}

async function postJson(state: RequestState, url: string, headers: Record<string, string>, body: unknown): Promise<JsonResponseResult> {
  const requestHeaders = { 'content-type': 'application/json', ...headers };
  recordModelRequest(state, {
    method: 'POST',
    url,
    headers: requestHeaders,
    body
  });
  const response = await fetchWithTimeout(state, url, {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify(body)
  });
  return parseModelResponse(state, response);
}

async function getJson(state: RequestState, url: string, headers: Record<string, string>): Promise<JsonResponseResult> {
  recordModelRequest(state, {
    method: 'GET',
    url,
    headers
  });
  const response = await fetchWithTimeout(state, url, { method: 'GET', headers });
  return parseModelResponse(state, response);
}

async function parseModelResponse(state: RequestState, response: Response): Promise<JsonResponseResult> {
  const rawBody = await readResponseTextWithTimeout(state, response);
  let body: Record<string, unknown>;
  try {
    body = parseJsonObject(rawBody);
  } catch (error) {
    const endpointResponse = {
      status: response.status,
      body: rawBody.trim() ? { raw: truncateString(rawBody) } : { raw: '' }
    };
    state.modelRun.responses.push({
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: endpointResponse.body
    });
    log(state, 'execute_request', { status: response.status, payloadShape: summarizeJsonShape(endpointResponse.body) });
    return { ok: false, result: modelFailure(state, `Video request failed: ${errorMessage(error)}`, endpointResponse) };
  }
  state.modelRun.responses.push({
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body
  });
  const endpointResponse = { status: response.status, body: redactModelResponseValue(body, state.apiKey) };
  log(state, 'execute_request', { status: response.status, payloadShape: summarizeJsonShape(body) });
  if (!response.ok) {
    return { ok: false, result: modelFailure(state, `Video request failed: model endpoint responded with HTTP ${response.status}.`, endpointResponse) };
  }
  return { ok: true, payload: body, endpointResponse };
}

async function fetchWithTimeout(state: RequestState, url: string, init: RequestInit): Promise<Response> {
  return fetchWithRequestTimeout(state.fetch, url, init, {
    signal: state.signal,
    timeoutMs: state.requestTimeoutMs,
    timeoutMessage: `Video request timed out after ${state.requestTimeoutMs}ms`,
    abortMessage: 'Video request aborted.'
  });
}

async function readResponseTextWithTimeout(state: RequestState, response: Response): Promise<string> {
  return readResponseTextBodyWithTimeout(response, {
    signal: state.signal,
    timeoutMs: state.requestTimeoutMs,
    timeoutMessage: `Video response body timed out after ${state.requestTimeoutMs}ms`,
    abortMessage: 'Video request aborted.'
  });
}

async function readResponseArrayBufferWithTimeout(state: RequestState, response: Response): Promise<ArrayBuffer> {
  return readResponseArrayBufferBodyWithTimeout(response, {
    signal: state.signal,
    timeoutMs: state.requestTimeoutMs,
    timeoutMessage: `Video response body timed out after ${state.requestTimeoutMs}ms`,
    abortMessage: 'Video request aborted.'
  });
}

async function storeDownloadedArtifact(state: RequestState, url: string, index: number, fallbackMimeType: string): Promise<VideoModelRequestArtifact> {
  const response = await fetchWithTimeout(state, url, { method: 'GET' });
  const bytes = new Uint8Array(await readResponseArrayBufferWithTimeout(state, response));
  if (!response.ok) {
    throw new Error(`Video artifact download failed: ${response.status}`);
  }
  const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim() || fallbackMimeType;
  const artifactId = randomUUID();
  const extension = extensionForMimeType(mimeType);
  const outputPath = stringArg(state.args, 'output_path');
  const outputDirectory = stringArg(state.args, 'output_directory') ?? `generated/${state.invocationId}`;
  const projectRelativePath = outputPath && index === 0
    ? outputPath
    : `${outputDirectory.replace(/\/$/, '')}/${artifactId}.${extension}`;
  const normalizedPath = await writeProjectFile(state.projectRoot, projectRelativePath, bytes);
  await state.recordGeneratedAsset?.({
    projectRelativePath: normalizedPath,
    modelRun: {
      request: state.modelRun.request ?? null,
      output: {
        responses: [...state.modelRun.responses],
        artifactIndex: index,
        sourceUrl: url
      }
    }
  });
  return {
    artifactId,
    title: basename(normalizedPath),
    projectRelativePath: normalizedPath,
    mimeType
  };
}

function recordModelRequest(state: RequestState, request: unknown): void {
  if (state.modelRun.request === undefined) {
    state.modelRun.request = request;
  }
}

function modelFailure(state: RequestState, content: string, endpointResponse?: ModelEndpointResponse): VideoRequestError {
  log(state, 'model_failure', {
    message: content,
    endpointStatus: endpointResponse?.status ?? null,
    payloadShape: summarizeJsonShape(endpointResponse?.body)
  });
  return {
    status: 'error',
    content,
    error: 'video_request_failed',
    logs: state.logs
  };
}

function urlContainer(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Video request content item ${field} must be an object with a url field.`);
  }
  return value as Record<string, unknown>;
}

function urlString(value: unknown, field: string): string {
  const container = urlContainer(value, field);
  const url = typeof container.url === 'string' ? container.url.trim() : '';
  if (!url) {
    throw new Error(`Video request content item ${field}.url must be a non-empty string.`);
  }
  return url;
}

function extractTaskId(payload: Record<string, unknown>): string | null {
  return typeof payload.id === 'string' && payload.id.trim() ? payload.id.trim() : null;
}

function taskStatusFromPayload(payload: Record<string, unknown>): VideoTaskStatus | undefined {
  const raw = String(payload.status ?? '').toLowerCase();
  if (raw === 'succeeded') {
    return 'succeeded';
  }
  if (raw === 'failed') {
    return 'failed';
  }
  if (raw === 'expired') {
    return 'expired';
  }
  if (raw === 'canceled' || raw === 'cancelled') {
    return 'canceled';
  }
  if (raw === 'running' || raw === 'in_progress') {
    return 'running';
  }
  if (raw === 'queued' || raw === 'pending') {
    return 'queued';
  }
  return undefined;
}

function extractOutputUrl(payload: Record<string, unknown>, key: 'video_url' | 'last_frame_url'): string | null {
  const value = objectAt(payload.content)?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function authorizationHeaders(state: Pick<RequestState, 'apiKey'>): Record<string, string> {
  return { authorization: `Bearer ${state.apiKey}` };
}

function stripOutputArgs(args: Record<string, unknown>): Record<string, unknown> {
  const next = { ...args };
  delete next.output_path;
  delete next.output_directory;
  return next;
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//.test(value);
}

function imageMimeType(bytes: Buffer, path: string): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    return 'image/jpeg';
  }
  if (/\.webp$/i.test(path)) {
    return 'image/webp';
  }
  if (/\.gif$/i.test(path)) {
    return 'image/gif';
  }
  return 'image/png';
}

function audioMimeType(path: string): string {
  if (/\.mp3$/i.test(path)) {
    return 'audio/mpeg';
  }
  if (/\.m4a$/i.test(path)) {
    return 'audio/mp4';
  }
  if (/\.ogg$/i.test(path)) {
    return 'audio/ogg';
  }
  if (/\.flac$/i.test(path)) {
    return 'audio/flac';
  }
  return 'audio/wav';
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType) {
    case 'video/mp4':
      return 'mp4';
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'image/png':
      return 'png';
    default:
      return mimeType.startsWith('image/') ? 'png' : 'mp4';
  }
}

function parseJsonObject(rawBody: string): Record<string, unknown> {
  if (!rawBody.trim()) {
    throw new Error('model endpoint returned an empty response.');
  }
  const parsed = JSON.parse(rawBody) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('model endpoint returned a non-object JSON response.');
  }
  return parsed as Record<string, unknown>;
}

function objectAt(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function redactModelResponseValue(value: unknown, apiKey: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactModelResponseValue(item, apiKey));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      /authorization|token|secret|api[-_]?key|apikey/i.test(key) ? '[redacted]' : redactModelResponseValue(item, apiKey)
    ]));
  }
  if (typeof value === 'string') {
    let next = value;
    if (apiKey) {
      next = next.split(apiKey).join('[redacted]');
    }
    if (/^data:(image|audio)\//.test(next)) {
      return `${next.slice(0, next.indexOf(',') + 1)}[redacted]`;
    }
    return truncateString(next);
  }
  return value;
}

function truncateString(value: string): string {
  return value.length > 2_000 ? `${value.slice(0, 2_000)}...[truncated]` : value;
}

function summarizeJsonShape(value: unknown): unknown {
  if (Array.isArray(value)) {
    return { type: 'array', length: value.length };
  }
  if (value && typeof value === 'object') {
    return { type: 'object', keys: Object.keys(value as Record<string, unknown>).sort() };
  }
  return { type: typeof value };
}

function contentTypes(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => objectAt(item)?.type ? [String(objectAt(item)?.type)] : []);
}

function log(state: Pick<RequestState, 'logs'>, stage: string, data: Record<string, unknown> = {}): void {
  state.logs.push({ stage, ...data });
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(signal?.reason ?? new Error('Video request aborted.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
