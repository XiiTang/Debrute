import { randomUUID } from 'node:crypto';
import { basename, extname } from 'node:path';
import { readProjectFileBytes, writeProjectFile } from '@debrute/project-core';
import type { ImageModelsConfig, SecretsConfig } from '../config.js';
import {
  fetchWithRequestTimeout,
  readResponseArrayBufferWithTimeout as readResponseArrayBufferBodyWithTimeout,
  readResponseTextWithTimeout as readResponseTextBodyWithTimeout
} from '../requestTimeout.js';
import { redactRuntimeSecretString, redactRuntimeSecrets } from '../modelRunMetadataRedaction.js';
import {
  assertPublicHttpUrl,
  fetchPublicHttpUrl,
  resolveHttpRedirectUrl,
  type PublicRemoteHostLookup,
  type PublicRemoteHttpTransport
} from '../remoteFetchPolicy.js';
import {
  createImageModelCatalog,
  imageInputFieldsForCatalogEntry,
  modelSpecificImageObjectKindForCatalogEntry,
  type ImageModelCatalogEntry,
  type ModelSpecificImageObjectKind
} from './catalog.js';

export type ImageModelFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface ImageModelRequestInput {
  model: string;
  arguments: Record<string, unknown>;
  timeoutMs?: number;
}

export interface ImageModelRequestArtifact {
  artifactId: string;
  title: string;
  projectRelativePath: string;
  mimeType: string;
  width: number;
  height: number;
}

export interface ExecuteImageModelRequestInput {
  projectRoot: string;
  invocationId: string;
  input: ImageModelRequestInput;
  settings: ImageModelsConfig;
  secrets: Pick<SecretsConfig, 'imageModelApiKeys'>;
  fetch?: ImageModelFetch;
  recordGeneratedAsset?: ImageGeneratedAssetRecorder;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  wanPollMaxAttempts?: number;
  vydraPollMaxAttempts?: number;
  remoteUrlLookup?: PublicRemoteHostLookup;
  remoteHttpTransport?: PublicRemoteHttpTransport;
  signal?: AbortSignal;
}

export interface ImageGeneratedAssetRecorderInput {
  projectRelativePath: string;
  modelRun: {
    request: unknown;
    output: unknown;
  };
}

export type ImageGeneratedAssetRecorder = (input: ImageGeneratedAssetRecorderInput) => Promise<void>;

export type ExecuteImageModelRequestResult =
  | { status: 'ok'; content: string; artifacts: ImageModelRequestArtifact[]; logs: Array<Record<string, unknown>> }
  | { status: 'error'; content: string; error: string; logs: Array<Record<string, unknown>>; details?: Record<string, unknown> };

interface ImagePayload {
  data: Uint8Array;
  mimeType: string;
  source?: ImagePayloadSource;
}

type ImagePayloadSource =
  | { kind: 'project-file'; projectRelativePath: string; bytes: number }
  | { kind: 'data-url'; bytes: number };

interface RequestState {
  projectRoot: string;
  invocationId: string;
  entry: ImageModelCatalogEntry;
  baseUrl: string;
  apiKey: string;
  requestModelId: string;
  args: Record<string, unknown>;
  fetch: ImageModelFetch;
  recordGeneratedAsset?: ImageGeneratedAssetRecorder;
  modelRun: ModelRunLog;
  logs: Array<Record<string, unknown>>;
  pollIntervalMs: number;
  requestTimeoutMs: number;
  wanPollMaxAttempts: number;
  vydraPollMaxAttempts: number;
  remoteUrlLookup?: PublicRemoteHostLookup;
  remoteHttpTransport?: PublicRemoteHttpTransport;
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

type ModelImageSuccess = { status: 'ok'; images: ImagePayload[]; output: Record<string, unknown> | null };
type ImageRequestError = Extract<ExecuteImageModelRequestResult, { status: 'error' }>;
type ModelImageResult = ModelImageSuccess | ImageRequestError;

const DEFAULT_WAN_POLL_ATTEMPTS = 60;
const DEFAULT_VYDRA_POLL_ATTEMPTS = 60;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_IMAGE_REQUEST_TIMEOUT_MS = 600_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const CATALOG_IMAGE_INPUT_FIELDS = [...new Set(createImageModelCatalog().listAll().flatMap(imageInputFieldsForCatalogEntry))];

export async function executeImageModelRequest(input: ExecuteImageModelRequestInput): Promise<ExecuteImageModelRequestResult> {
  const logs: Array<Record<string, unknown>> = [];
  const catalog = createImageModelCatalog();
  const entry = catalog.get(input.input.model);
  const modelSettings = input.settings.imageModels.find((model) => model.debruteModelId === input.input.model);
  const apiKey = input.secrets.imageModelApiKeys[input.input.model]?.trim() ?? '';
  if (!entry) {
    return {
      status: 'error',
      content: `Image model is unavailable: ${input.input.model}`,
      error: 'model_unavailable',
      logs
    };
  }
  if (!apiKey) {
    return {
      status: 'error',
      content: `Image model API key is missing: ${input.input.model}`,
      error: 'image_model_not_configured',
      logs
    };
  }

  let args: Record<string, unknown>;
  try {
    args = await resolveImageInputArguments(input.input.arguments, input.projectRoot, entry, input.remoteUrlLookup);
  } catch (error) {
    return {
      status: 'error',
      content: errorMessage(error),
      error: 'invalid_image_input',
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
    requestTimeoutMs: input.requestTimeoutMs ?? input.input.timeoutMs ?? DEFAULT_IMAGE_REQUEST_TIMEOUT_MS,
    wanPollMaxAttempts: input.wanPollMaxAttempts ?? DEFAULT_WAN_POLL_ATTEMPTS,
    vydraPollMaxAttempts: input.vydraPollMaxAttempts ?? DEFAULT_VYDRA_POLL_ATTEMPTS,
    ...(input.remoteUrlLookup ? { remoteUrlLookup: input.remoteUrlLookup } : {}),
    ...(input.remoteHttpTransport ? { remoteHttpTransport: input.remoteHttpTransport } : {}),
    ...(input.signal ? { signal: input.signal } : {})
  };
  log(state, 'resolve_model', {
    model: entry.debruteModelId,
    requestModelId: state.requestModelId,
    configured: true
  });

  try {
    const result = await executeImageRequest(state);
    if (result.status === 'error') {
      return result;
    }
    const artifacts = await storeArtifacts(state, result.images, result.output);
    log(state, 'store_artifacts', { count: artifacts.length });
    return {
      status: 'ok',
      content: `Generated ${artifacts.length} image artifact(s).`,
      artifacts,
      logs
    };
  } catch (error) {
    const message = redactModelRunMessage(state, errorMessage(error));
    log(state, 'error', { message });
    return {
      status: 'error',
      content: `Image request failed: ${message}`,
      error: 'image_request_failed',
      logs
    };
  }
}

async function executeImageRequest(
  state: RequestState
): Promise<ModelImageResult> {
  switch (state.entry.debruteModelId) {
    case 'gemini-3.1-flash-image-preview':
    case 'gemini-3.1-flash-image':
    case 'gemini-3-pro-image-preview':
      return executeGemini(state, { compactModelRun: true });
    case 'gpt-image-1':
    case 'gpt-image-2':
      return executeOpenAI(state);
    case 'doubao-seedream-5-0-lite-260128':
      return executeDoubao(state);
    case 'wan2.7-image':
      return executeWan(state);
    case 'fal-ai/flux/dev':
    case 'fal-ai/flux/dev/image-to-image':
      return executeFal(state);
    case 'image-01':
      return executeMinimax(state);
    case 'grok-imagine':
      return executeVydra(state);
    default:
      return failure(state, 'image_model_not_supported', { model: state.entry.debruteModelId });
  }
}

async function executeOpenAI(state: RequestState) {
  const args = stripOutputArgs(state.args);
  const outputMimeType = openAIOutputMimeType(args.output_format);
  const body: Record<string, unknown> = { model: state.requestModelId, ...args };
  const hasInputImages = hasNonEmptyInputImages(args.image);
  delete body.image;
  delete body.mask;

  if (hasInputImages) {
    return executeOpenAIEdit(state, body, outputMimeType);
  }

  const url = joinUrl(state.baseUrl, 'images/generations');
  log(state, 'build_request', { url, body });
  const response = await postJson(state, url, authorizationHeaders(state), body);
  if (!response.ok) {
    return response.result;
  }
  const parsed = await openAIImagesFromPayload(state, response.payload, outputMimeType);
  compactGptImage2ModelRunInPlace(state, outputMimeType);
  return { status: 'ok' as const, images: parsed.images, output: parsed.revisedPrompts.length > 0 ? { revised_prompts: parsed.revisedPrompts } : null };
}

function hasNonEmptyInputImages(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

async function executeOpenAIEdit(state: RequestState, body: Record<string, unknown>, outputMimeType: string) {
  const inputImages = imageInputArray(state.args.image);
  const mask = imageInputArray(state.args.mask)[0];
  const url = joinUrl(state.baseUrl, 'images/edits');
  if (canUseOpenAIJsonEdit(inputImages, mask)) {
    const jsonBody: Record<string, unknown> = {
      ...body,
      images: inputImages.map((image) => ({ image_url: image.image_url }))
    };
    if (mask?.image_url) {
      jsonBody.mask = { image_url: mask.image_url };
    }
    log(state, 'build_request', { url, body: jsonBody });
    const response = await postJson(state, url, authorizationHeaders(state), jsonBody);
    if (!response.ok) {
      return response.result;
    }
    const parsed = await openAIImagesFromPayload(state, response.payload, outputMimeType);
    compactGptImage2ModelRunInPlace(state, outputMimeType);
    return { status: 'ok' as const, images: parsed.images, output: parsed.revisedPrompts.length > 0 ? { revised_prompts: parsed.revisedPrompts } : null };
  }

  const form = new FormData();
  const multipartBody = createMultipartRequestBodyLog();
  for (const [key, value] of Object.entries(body)) {
    const fieldValue = formValue(value);
    form.set(key, fieldValue);
    multipartBody.fields[key] = fieldValue;
  }
  for (const [index, image] of inputImages.entries()) {
    const payload = await inlineImageBytes(state, image);
    const filename = `image-${index}.${extensionForMimeType(payload.mimeType)}`;
    form.append('image[]', new Blob([arrayBufferFor(payload.data)], { type: payload.mimeType }), filename);
    multipartBody.files.push(multipartFileLog('image[]', filename, payload));
  }
  if (mask) {
    const payload = await inlineImageBytes(state, mask);
    const filename = `mask.${extensionForMimeType(payload.mimeType)}`;
    form.append('mask', new Blob([arrayBufferFor(payload.data)], { type: payload.mimeType }), filename);
    multipartBody.files.push(multipartFileLog('mask', filename, payload));
  }
  log(state, 'build_request', { url, body: multipartBody });
  recordModelRequest(state, {
    method: 'POST',
    url,
    headers: authorizationHeaders(state),
    body: multipartBody
  });
  const response = await fetchWithTimeout(state, url, { method: 'POST', headers: authorizationHeaders(state), body: form });
  const parsedResponse = await parseModelResponse(state, response);
  if (!parsedResponse.ok) {
    return parsedResponse.result;
  }
  const parsed = await openAIImagesFromPayload(state, parsedResponse.payload, outputMimeType);
  compactGptImage2ModelRunInPlace(state, outputMimeType);
  return { status: 'ok' as const, images: parsed.images, output: parsed.revisedPrompts.length > 0 ? { revised_prompts: parsed.revisedPrompts } : null };
}

async function executeDoubao(state: RequestState) {
  const args = stripOutputArgs(state.args);
  const body: Record<string, unknown> = { model: state.requestModelId, ...args };
  if (args.image !== undefined) {
    const images = imageInputArray(args.image).map(toImageUrlOrDataUrl);
    body.image = images.length === 1 ? images[0] : images;
  }
  const url = joinUrl(state.baseUrl, 'images/generations');
  log(state, 'build_request', { url, body });
  const response = await postJson(state, url, authorizationHeaders(state), body);
  if (!response.ok) {
    return response.result;
  }
  const urls = payloadArray(response.payload.data).flatMap((item) => typeof item.url === 'string' ? [item.url] : []);
  const images = await downloadAll(state, urls);
  log(state, 'parse_response', { imageCount: images.length, urlCount: urls.length });
  return { status: 'ok' as const, images, output: urls.length > 0 ? { image_urls: urls } : null };
}

async function executeWan(state: RequestState) {
  const args = stripOutputArgs(state.args);
  const prompt = args.prompt;
  delete args.prompt;
  const inputImages = args.image;
  delete args.image;
  const content: Array<Record<string, unknown>> = [];
  for (const image of imageInputArray(inputImages)) {
    content.push({ image: toImageUrlOrDataUrl(image) });
  }
  if (typeof prompt === 'string') {
    content.push({ text: prompt });
  }
  const body = {
    model: state.requestModelId,
    input: { messages: [{ role: 'user', content }] },
    parameters: args
  };
  const submitUrl = joinUrl(state.baseUrl, 'services/aigc/image-generation/generation');
  log(state, 'build_request', { url: submitUrl, parameterKeys: Object.keys(args).sort() });
  const submit = await postJson(state, submitUrl, { ...authorizationHeaders(state), 'X-DashScope-Async': 'enable' }, body);
  if (!submit.ok) {
    return submit.result;
  }
  const taskId = objectAt(submit.payload.output)?.task_id;
  if (typeof taskId !== 'string' || !taskId) {
    return failure(state, 'response_parse_failed', { reason: 'missing_task_id', payload: submit.payload });
  }
  const pollUrl = joinUrl(state.baseUrl, `tasks/${taskId}`);
  for (let attempt = 0; attempt < state.wanPollMaxAttempts; attempt += 1) {
    const poll = await getJson(state, pollUrl, authorizationHeaders(state));
    if (!poll.ok) {
      return poll.result;
    }
    const output = objectAt(poll.payload.output);
    const status = output?.task_status;
    log(state, 'execute_request', { phase: 'poll', taskStatus: status ?? null });
    if (status === 'SUCCEEDED') {
      const urls = extractWanImageUrls(output);
      const images = await downloadAll(state, urls);
      log(state, 'parse_response', { imageCount: images.length });
      return { status: 'ok' as const, images, output: null };
    }
    if (status === 'FAILED' || status === 'CANCELED') {
      return failure(state, 'response_parse_failed', { reason: `task_${String(status).toLowerCase()}` });
    }
    await delay(state.pollIntervalMs, state.signal);
  }
  return failure(state, 'response_parse_failed', { reason: 'timeout', taskId });
}

async function executeGemini(state: RequestState, options: { compactModelRun?: boolean } = {}) {
  const args = stripOutputArgs(state.args);
  const prompt = args.prompt;
  const aspectRatio = args.aspect_ratio;
  const imageSize = args.image_size;
  const contents = args.contents;
  delete args.prompt;
  delete args.contents;
  delete args.aspect_ratio;
  delete args.image_size;
  const requestContents = buildGeminiRequestContents(contents, prompt);
  const imageConfig: Record<string, unknown> = {};
  if (aspectRatio !== undefined) {
    imageConfig.aspectRatio = aspectRatio;
  }
  if (imageSize !== undefined) {
    imageConfig.imageSize = imageSize;
  }
  const generationConfig: Record<string, unknown> = {
    responseModalities: ['TEXT', 'IMAGE']
  };
  if (Object.keys(imageConfig).length > 0) {
    generationConfig.responseFormat = { image: imageConfig };
  }
  const body = {
    contents: requestContents,
    generationConfig,
    ...args
  };
  const url = new URL(joinUrl(state.baseUrl, `models/${state.requestModelId}:generateContent`));
  url.searchParams.set('key', state.apiKey);
  log(state, 'build_request', { url: url.toString(), imageConfig });
  const response = await postJson(state, url.toString(), { 'content-type': 'application/json' }, body);
  if (!response.ok) {
    return response.result;
  }
  const images = extractGeminiImages(response.payload);
  if (options.compactModelRun) {
    compactGemini31ModelRunInPlace(state);
  }
  log(state, 'parse_response', { imageCount: images.length });
  return { status: 'ok' as const, images, output: null };
}

async function executeFal(state: RequestState) {
  const args = stripOutputArgs(state.args);
  if (imageInputFieldsForCatalogEntry(state.entry).includes('image_url') && args.image_url !== undefined) {
    args.image_url = toImageUrlOrDataUrl(imageInputArray(args.image_url)[0]!);
  }
  const url = joinUrl(state.baseUrl, state.requestModelId);
  log(state, 'build_request', { url, body: args });
  const response = await postJson(state, url, { authorization: `Key ${state.apiKey}`, 'content-type': 'application/json' }, args);
  if (!response.ok) {
    return response.result;
  }
  const urls = payloadArray(response.payload.images).flatMap((item) => typeof item.url === 'string' ? [item.url] : []);
  const images = await downloadAll(state, urls);
  log(state, 'parse_response', { imageCount: images.length, urlCount: urls.length });
  return { status: 'ok' as const, images, output: { image_urls: urls, seed: response.payload.seed ?? null } };
}

async function executeMinimax(state: RequestState) {
  const args = stripOutputArgs(state.args);
  if (args.subject_reference !== undefined) {
    args.subject_reference = imageInputArray(args.subject_reference).map((image) => ({
      type: image.type ?? 'character',
      image_file: image.image_file ?? toImageUrlOrDataUrl(image)
    }));
  }
  const body = { model: state.requestModelId, ...args };
  const url = joinUrl(state.baseUrl, 'v1/image_generation');
  log(state, 'build_request', { url, body });
  const response = await postJson(state, url, authorizationHeaders(state), body);
  if (!response.ok) {
    return response.result;
  }
  const baseResp = objectAt(response.payload.base_resp);
  if (typeof baseResp?.status_code === 'number' && baseResp.status_code !== 0) {
    return failure(state, 'response_parse_failed', { reason: 'minimax_business_error' });
  }
  const base64Images = Array.isArray(objectAt(response.payload.data)?.image_base64)
    ? objectAt(response.payload.data)?.image_base64 as unknown[]
    : [];
  const images = base64Images
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((value) => ({ data: Buffer.from(value, 'base64'), mimeType: 'image/png' }));
  log(state, 'parse_response', { imageCount: images.length });
  return { status: 'ok' as const, images, output: null };
}

async function executeVydra(state: RequestState) {
  const args = stripOutputArgs(state.args);
  const body = { ...args, model: 'text-to-image' };
  const submitUrl = joinUrl(state.baseUrl, `models/${state.requestModelId}`);
  log(state, 'build_request', { url: submitUrl, body });
  const submit = await postJson(state, submitUrl, authorizationHeaders(state), body);
  if (!submit.ok) {
    return submit.result;
  }
  const jobId = submit.payload.jobId ?? submit.payload.id;
  if (typeof jobId !== 'string' || !jobId) {
    return failure(state, 'response_parse_failed', { reason: 'missing_job_id' });
  }
  const pollUrl = joinUrl(state.baseUrl, `jobs/${jobId}`);
  for (let attempt = 0; attempt < state.vydraPollMaxAttempts; attempt += 1) {
    const poll = await getJson(state, pollUrl, authorizationHeaders(state));
    if (!poll.ok) {
      return poll.result;
    }
    const status = String(poll.payload.status ?? '').toLowerCase();
    log(state, 'execute_request', { phase: 'poll', status });
    if (status === 'completed') {
      const url = extractVydraImageUrl(poll.payload);
      if (!url) {
        return failure(state, 'response_parse_failed', { reason: 'missing_url' });
      }
      const images = await downloadAll(state, [url]);
      log(state, 'parse_response', { imageCount: images.length });
      return { status: 'ok' as const, images, output: { job_id: jobId, image_url: url } };
    }
    if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) {
      return failure(state, 'response_parse_failed', { reason: `job_${status}` });
    }
    await delay(state.pollIntervalMs, state.signal);
  }
  return failure(state, 'response_parse_failed', { reason: 'timeout', jobId });
}

async function postJson(
  state: RequestState,
  url: string,
  headers: Record<string, string>,
  body: unknown
): Promise<{ ok: true; payload: Record<string, unknown> } | { ok: false; result: ImageRequestError }> {
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

async function getJson(
  state: RequestState,
  url: string,
  headers: Record<string, string>
): Promise<{ ok: true; payload: Record<string, unknown> } | { ok: false; result: ImageRequestError }> {
  recordModelRequest(state, {
    method: 'GET',
    url,
    headers
  });
  const response = await fetchWithTimeout(state, url, { method: 'GET', headers });
  return parseModelResponse(state, response);
}

async function fetchWithTimeout(state: RequestState, url: string, init: RequestInit): Promise<Response> {
  return fetchWithRequestTimeout(state.fetch, url, init, {
    signal: state.signal,
    timeoutMs: state.requestTimeoutMs,
    timeoutMessage: `Image request timed out after ${state.requestTimeoutMs}ms`,
    abortMessage: 'Image request aborted.'
  });
}

function recordModelRequest(state: RequestState, request: unknown): void {
  if (state.modelRun.request === undefined) {
    state.modelRun.request = redactModelRunValue(state, request);
  }
}

async function parseModelResponse(
  state: RequestState,
  response: Response
): Promise<{ ok: true; payload: Record<string, unknown> } | { ok: false; result: ImageRequestError }> {
  const rawBody = await readResponseTextWithTimeout(state, response);
  let payload: Record<string, unknown>;
  try {
    payload = parseJsonObject(rawBody);
  } catch (error) {
    const endpointResponse = {
      status: response.status,
      body: redactModelRunValue(state, rawBody.trim() ? { raw: truncateString(rawBody) } : { raw: '' })
    };
    state.modelRun.responses.push({
      status: response.status,
      headers: redactModelRunValue(state, Object.fromEntries(response.headers.entries())) as Record<string, string>,
      body: endpointResponse.body
    });
    log(state, 'execute_request', { status: response.status, payloadShape: summarizeJsonShape(endpointResponse.body) });
    return { ok: false, result: failure(state, 'response_parse_failed', { reason: redactModelRunMessage(state, errorMessage(error)), status: response.status, endpointResponse }) };
  }
  const endpointResponse = {
    status: response.status,
    body: redactModelRunValue(state, payload)
  };
  state.modelRun.responses.push({
    status: response.status,
    headers: redactModelRunValue(state, Object.fromEntries(response.headers.entries())) as Record<string, string>,
    body: endpointResponse.body
  });
  log(state, 'execute_request', { status: response.status, payloadShape: summarizeJsonShape(endpointResponse.body) });
  if (!response.ok) {
    return {
      ok: false,
      result: failure(
        state,
        'request_failed',
        { status: response.status, payloadShape: summarizeJsonShape(endpointResponse.body), endpointResponse },
        `Image request failed: model endpoint responded with HTTP ${response.status}.`
      )
    };
  }
  return { ok: true, payload };
}

async function openAIImagesFromPayload(
  state: RequestState,
  payload: Record<string, unknown>,
  mimeType: string
): Promise<{ images: ImagePayload[]; revisedPrompts: string[] }> {
  const images: ImagePayload[] = [];
  const revisedPrompts: string[] = [];
  let b64JsonCount = 0;
  let urlCount = 0;
  for (const entry of openAIDataItems(payload)) {
    if (typeof entry.b64_json === 'string' && entry.b64_json) {
      images.push({ data: Buffer.from(entry.b64_json, 'base64'), mimeType });
      b64JsonCount += 1;
    } else if (typeof entry.url === 'string' && entry.url) {
      images.push(await downloadImage(state, entry.url));
      urlCount += 1;
    }
    if (typeof entry.revised_prompt === 'string' && entry.revised_prompt) {
      revisedPrompts.push(entry.revised_prompt);
    }
  }
  log(state, 'parse_response', { imageCount: images.length, b64JsonCount, urlCount });
  return { images, revisedPrompts };
}

async function storeArtifacts(
  state: RequestState,
  images: ImagePayload[],
  output: Record<string, unknown> | null
): Promise<ImageModelRequestArtifact[]> {
  if (images.length === 0) {
    throw new Error('Image response did not include image output.');
  }
  const artifacts: ImageModelRequestArtifact[] = [];
  for (let index = 0; index < images.length; index += 1) {
    artifacts.push(await storeImagePayload(state, images[index]!, index, output));
  }
  return artifacts;
}

async function storeImagePayload(
  state: RequestState,
  payload: ImagePayload,
  index: number,
  output: Record<string, unknown> | null
): Promise<ImageModelRequestArtifact> {
  const artifactId = randomUUID();
  const extension = extensionForMimeType(payload.mimeType);
  const outputPath = stringArg(state.args, 'output_path');
  const outputDirectory = stringArg(state.args, 'output_directory') ?? `generated/${state.invocationId}`;
  const projectRelativePath = outputPath && index === 0
    ? outputPath
    : `${outputDirectory.replace(/\/$/, '')}/${artifactId}.${extension}`;
  const normalizedPath = await writeProjectFile(
    state.projectRoot,
    projectRelativePath,
    payload.data,
    state.signal ? { signal: state.signal } : undefined
  );
  const [width, height] = detectDimensions(Buffer.from(payload.data), payload.mimeType);
  const modelRun: ImageGeneratedAssetRecorderInput['modelRun'] = {
    request: redactModelRunValue(state, state.modelRun.request ?? null),
    output: redactModelRunValue(state, {
      responses: [...state.modelRun.responses],
      parsed: output,
      artifactIndex: index
    })
  };
  await state.recordGeneratedAsset?.({
    projectRelativePath: normalizedPath,
    modelRun
  });
  return {
    artifactId,
    title: basename(normalizedPath),
    projectRelativePath: normalizedPath,
    mimeType: payload.mimeType,
    width,
    height
  };
}

async function resolveImageInputArguments(
  args: Record<string, unknown>,
  projectRoot: string,
  entry: ImageModelCatalogEntry,
  remoteUrlLookup: PublicRemoteHostLookup | undefined
): Promise<Record<string, unknown>> {
  const next = { ...args };
  const imageInputFields = imageInputFieldsForCatalogEntry(entry);
  assertImageInputFieldsAreSupported(next, entry, imageInputFields);
  for (const field of imageInputFields) {
    if (next[field] === undefined) {
      continue;
    }
    const values = imageInputValuesForField(next[field], entry, field);
    if (entry.debruteModelId === 'wan2.7-image' && field === 'image' && values.length > 9) {
      throw new Error('wan2.7-image supports at most 9 reference images.');
    }
    const resolvedInputs = isGptImage2Model(entry.debruteModelId)
      ? await resolveGptImage2ImageInputs(values, projectRoot, entry, field, remoteUrlLookup)
      : await resolveImageInputs(values, projectRoot, entry, field, remoteUrlLookup);
    next[field] = imageInputFieldAcceptsMultiple(entry, field) ? resolvedInputs : resolvedInputs[0];
  }
  if (isGemini31ImageModel(entry.debruteModelId) && next.contents !== undefined) {
    next.contents = await normalizeGeminiContents(next.contents, projectRoot, remoteUrlLookup);
  }
  assertImageInputFieldCombinations(next);
  return next;
}

function buildGeminiRequestContents(contents: unknown, prompt: unknown): Array<Record<string, unknown>> {
  const normalizedContents = Array.isArray(contents)
    ? contents as Array<Record<string, unknown>>
    : [];
  const promptText = typeof prompt === 'string' && prompt.trim() ? prompt : '';
  if (!promptText) {
    return normalizedContents.length > 0 ? normalizedContents : [{ role: 'user', parts: [] }];
  }
  if (normalizedContents.length === 0) {
    return [{ role: 'user', parts: [{ text: promptText }] }];
  }
  const [first, ...rest] = normalizedContents;
  return [{
    ...first,
    parts: [{ text: promptText }, ...payloadArray(first?.parts)]
  }, ...rest];
}

async function normalizeGeminiContents(
  contents: unknown,
  projectRoot: string,
  remoteUrlLookup: PublicRemoteHostLookup | undefined
): Promise<Array<Record<string, unknown>>> {
  if (!Array.isArray(contents)) {
    throw new Error('Gemini contents must be an array.');
  }
  const normalized: Array<Record<string, unknown>> = [];
  for (const content of contents) {
    const item = objectAt(content);
    if (!item) {
      throw new Error('Gemini contents entries must be objects.');
    }
    if (!Array.isArray(item.parts)) {
      throw new Error('Gemini contents entries must include a parts array.');
    }
    const parts: Array<Record<string, unknown>> = [];
    for (const part of item.parts) {
      parts.push(await normalizeGeminiPart(part, projectRoot, remoteUrlLookup));
    }
    normalized.push({ ...item, parts });
  }
  return normalized;
}

async function normalizeGeminiPart(
  part: unknown,
  projectRoot: string,
  remoteUrlLookup: PublicRemoteHostLookup | undefined
): Promise<Record<string, unknown>> {
  const item = objectAt(part);
  if (!item) {
    throw new Error('Gemini content parts must be objects.');
  }
  const fileData = objectAt(item.fileData);
  if (!fileData) {
    return item;
  }
  const fileUri = stringValueAt(fileData, 'fileUri');
  if (!fileUri) {
    throw new Error('Gemini fileData parts must include fileUri.');
  }
  if (/^https?:\/\//.test(fileUri)) {
    await assertPublicHttpUrl(fileUri, 'Remote image URLs', { lookup: remoteUrlLookup });
    return item;
  }
  if (fileUri.startsWith('data:image/')) {
    return { inlineData: inlineDataFromDataImageUrl(fileUri, stringValueAt(fileData, 'mimeType')) };
  }
  const bytes = await readImageInputProjectFileBytes(projectRoot, fileUri);
  const content = bufferForBytes(bytes);
  return {
    inlineData: {
      mimeType: stringValueAt(fileData, 'mimeType') ?? detectMimeType(content, fileUri),
      data: content.toString('base64')
    }
  };
}

function inlineDataFromDataImageUrl(value: string, fallbackMimeType: string | undefined): Record<string, string> {
  const [header, payload] = value.split(',', 2);
  if (!payload) {
    throw new Error('Gemini data:image fileUri must include a base64 payload.');
  }
  return {
    mimeType: header?.replace(/^data:/, '').split(';', 1)[0] || fallbackMimeType || 'image/png',
    data: payload
  };
}

function assertImageInputFieldsAreSupported(args: Record<string, unknown>, entry: ImageModelCatalogEntry, imageInputFields: string[]): void {
  const supportedFields = new Set(imageInputFields);
  for (const field of CATALOG_IMAGE_INPUT_FIELDS) {
    if (!supportedFields.has(field) && args[field] !== undefined) {
      throw new Error(`Image input field "${field}" is not supported by model "${entry.debruteModelId}".`);
    }
  }
}

function assertImageInputFieldCombinations(args: Record<string, unknown>): void {
  if (args.mask !== undefined && (!Array.isArray(args.image) || args.image.length === 0)) {
    throw new Error('Image input field "mask" requires non-empty "image".');
  }
}

function imageInputValuesForField(value: unknown, entry: ImageModelCatalogEntry, field: string): unknown[] {
  if (value === null) {
    throw new Error(`Image input field "${field}" must not be null.`);
  }
  const acceptsMultiple = imageInputFieldAcceptsMultiple(entry, field);
  if (Array.isArray(value)) {
    if (!acceptsMultiple) {
      throw new Error(`Image input field "${field}" must be a single string or object.`);
    }
    if (value.length === 0) {
      throw new Error(`Image input field "${field}" must not be empty.`);
    }
    return value;
  }
  if (acceptsMultiple) {
    throw new Error(`Image input field "${field}" must be an array of strings or objects.`);
  }
  return [value];
}

function imageInputFieldAcceptsMultiple(entry: ImageModelCatalogEntry, field: string): boolean {
  const properties = objectAt(entry.argumentsSchema.properties);
  const schema = objectAt(properties?.[field]);
  return schema?.debruteImageInput === true && schema.type === 'array';
}

async function resolveImageInputs(
  inputs: unknown[],
  projectRoot: string,
  entry: ImageModelCatalogEntry,
  field: string,
  remoteUrlLookup: PublicRemoteHostLookup | undefined
): Promise<Array<Record<string, unknown>>> {
  const resolved: Array<Record<string, unknown>> = [];
  const modelSpecificObjectKind = modelSpecificImageObjectKindForCatalogEntry(entry, field);
  for (const input of inputs) {
    if (typeof input !== 'string') {
      if (input && typeof input === 'object') {
        const imageInput = input as Record<string, unknown>;
        if (!modelSpecificObjectKind || !isSupportedModelSpecificImageInputObject(imageInput, modelSpecificObjectKind)) {
          throw new Error(`Unsupported model-specific image input object for field "${field}".`);
        }
        await assertModelSpecificImageInputUrlsArePublic(imageInput, remoteUrlLookup);
        resolved.push(imageInput);
        continue;
      }
      throw new Error('Image input values must be strings or objects.');
    }
    if (/^https?:\/\//.test(input)) {
      await assertPublicHttpUrl(input, 'Remote image URLs', { lookup: remoteUrlLookup });
      resolved.push({ image_url: input, mime_type: mimeTypeFromPath(input) });
      continue;
    }
    if (input.startsWith('data:image/')) {
      resolved.push({ image_url: input, mime_type: mimeTypeFromPath(input) });
      continue;
    }
    const bytes = await readImageInputProjectFileBytes(projectRoot, input);
    resolved.push({ data: Buffer.from(bytes).toString('base64'), mime_type: detectMimeType(Buffer.from(bytes), input) });
  }
  return resolved;
}

async function resolveGptImage2ImageInputs(
  inputs: unknown[],
  projectRoot: string,
  entry: ImageModelCatalogEntry,
  field: string,
  remoteUrlLookup: PublicRemoteHostLookup | undefined
): Promise<Array<Record<string, unknown>>> {
  const resolved: Array<Record<string, unknown>> = [];
  const modelSpecificObjectKind = modelSpecificImageObjectKindForCatalogEntry(entry, field);
  for (const input of inputs) {
    if (typeof input !== 'string') {
      if (input && typeof input === 'object') {
        const imageInput = input as Record<string, unknown>;
        if (!modelSpecificObjectKind || !isSupportedModelSpecificImageInputObject(imageInput, modelSpecificObjectKind)) {
          throw new Error(`Unsupported model-specific image input object for field "${field}".`);
        }
        await assertModelSpecificImageInputUrlsArePublic(imageInput, remoteUrlLookup);
        resolved.push(imageInput);
        continue;
      }
      throw new Error('Image input values must be strings or objects.');
    }
    if (/^https?:\/\//.test(input)) {
      await assertPublicHttpUrl(input, 'Remote image URLs', { lookup: remoteUrlLookup });
      resolved.push({ image_url: input, mime_type: mimeTypeFromPath(input) });
      continue;
    }
    if (input.startsWith('data:image/')) {
      resolved.push({ image_url: input, mime_type: mimeTypeFromPath(input) });
      continue;
    }
    const bytes = await readImageInputProjectFileBytes(projectRoot, input);
    const content = bufferForBytes(bytes);
    resolved.push({
      bytes,
      mime_type: detectMimeType(content, input),
      source_kind: 'project-file',
      project_relative_path: input.replaceAll('\\', '/').replace(/^\.\//, '')
    });
  }
  return resolved;
}

async function readImageInputProjectFileBytes(projectRoot: string, input: string): Promise<Uint8Array> {
  try {
    return await readProjectFileBytes(projectRoot, input);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      throw new Error(`Image input not found in project: ${input}`);
    }
    throw error;
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT');
}

async function downloadAll(state: RequestState, urls: string[]): Promise<ImagePayload[]> {
  const images: ImagePayload[] = [];
  for (const url of urls) {
    images.push(await downloadImage(state, url));
  }
  return images;
}

async function downloadImage(state: RequestState, url: string): Promise<ImagePayload> {
  const response = await fetchRemoteImage(state, url);
  const bytes = new Uint8Array(await readResponseArrayBufferWithTimeout(state, response));
  if (!response.ok) {
    throw new Error(`Image download failed: ${response.status}`);
  }
  return {
    data: bytes,
    mimeType: detectMimeType(Buffer.from(bytes), url, response.headers)
  };
}

async function fetchRemoteImage(state: RequestState, url: string, redirectCount = 0): Promise<Response> {
  const response = await fetchRemoteHttpUrl(state, url, 'Remote image URLs');
  if (!isHttpRedirect(response.status)) {
    return response;
  }
  if (redirectCount >= 5) {
    throw new Error('Remote image URLs redirected too many times.');
  }
  const redirectUrl = resolveHttpRedirectUrl(url, response.headers.get('location'), 'Remote image URLs');
  return fetchRemoteImage(state, redirectUrl, redirectCount + 1);
}

async function fetchRemoteHttpUrl(state: RequestState, url: string, label: string): Promise<Response> {
  return fetchWithRequestTimeout(
    (requestUrl, init) => fetchPublicHttpUrl(requestUrl, label, init, {
      lookup: state.remoteUrlLookup,
      transport: state.remoteHttpTransport
    }),
    url,
    { method: 'GET' },
    {
      signal: state.signal,
      timeoutMs: state.requestTimeoutMs,
      timeoutMessage: `Image request timed out after ${state.requestTimeoutMs}ms`,
      abortMessage: 'Image request aborted.'
    }
  );
}

function isHttpRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

async function readResponseTextWithTimeout(state: RequestState, response: Response): Promise<string> {
  return readResponseTextBodyWithTimeout(response, {
    signal: state.signal,
    timeoutMs: state.requestTimeoutMs,
    timeoutMessage: `Image response body timed out after ${state.requestTimeoutMs}ms`,
    abortMessage: 'Image request aborted.'
  });
}

async function readResponseArrayBufferWithTimeout(state: RequestState, response: Response): Promise<ArrayBuffer> {
  return readResponseArrayBufferBodyWithTimeout(response, {
    signal: state.signal,
    timeoutMs: state.requestTimeoutMs,
    timeoutMessage: `Image response body timed out after ${state.requestTimeoutMs}ms`,
    abortMessage: 'Image request aborted.'
  });
}

function createMultipartRequestBodyLog(): {
  fields: Record<string, string>;
  files: Array<Record<string, unknown>>;
} {
  return { fields: {}, files: [] };
}

function multipartFileLog(field: string, filename: string, payload: ImagePayload): Record<string, unknown> {
  return {
    field,
    filename,
    mimeType: payload.mimeType,
    source: payload.source ?? {
      kind: 'inline-bytes',
      bytes: payload.data.byteLength
    }
  };
}

function extractGeminiImages(payload: Record<string, unknown>): ImagePayload[] {
  const images: ImagePayload[] = [];
  for (const candidate of payloadArray(payload.candidates)) {
    const content = objectAt(candidate.content);
    for (const part of payloadArray(content?.parts)) {
      const inline = objectAt(part.inlineData) ?? objectAt(part.inline_data);
      if (typeof inline?.data === 'string') {
        images.push({
          data: Buffer.from(inline.data, 'base64'),
          mimeType: typeof inline.mimeType === 'string'
            ? inline.mimeType
            : typeof inline.mime_type === 'string'
              ? inline.mime_type
              : 'image/png'
        });
      }
    }
  }
  return images;
}

function extractWanImageUrls(output: Record<string, unknown> | undefined): string[] {
  const urls: string[] = [];
  for (const choice of payloadArray(output?.choices)) {
    const message = objectAt(choice.message);
    for (const item of payloadArray(message?.content)) {
      if (typeof item.image === 'string') {
        urls.push(item.image);
      }
    }
  }
  return urls;
}

function extractVydraImageUrl(payload: Record<string, unknown>): string | null {
  for (const container of [payload, objectAt(payload.output), objectAt(payload.result)]) {
    if (!container) {
      continue;
    }
    if (typeof container.url === 'string') {
      return container.url;
    }
    if (typeof container.imageUrl === 'string') {
      return container.imageUrl;
    }
  }
  return null;
}

function imageInputArray(value: unknown): Array<Record<string, unknown>> {
  if (value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    if (!value.every((item) => Boolean(item) && typeof item === 'object')) {
      throw new Error('Resolved image inputs must be objects.');
    }
    return value as Array<Record<string, unknown>>;
  }
  if (typeof value === 'object') {
    return [value as Record<string, unknown>];
  }
  throw new Error('Resolved image input must be an object or an array of objects.');
}

function toImageUrlOrDataUrl(image: Record<string, unknown>): string {
  const imageUrl = stringValueAt(image, 'image_url');
  const data = stringValueAt(image, 'data');
  const imageFile = stringValueAt(image, 'image_file');
  const mimeType = stringValueAt(image, 'mime_type') || 'image/png';
  if (imageUrl) {
    return imageUrl;
  }
  if (data) {
    return `data:${mimeType};base64,${data}`;
  }
  if (imageFile) {
    return imageFile;
  }
  throw new Error('Image input object must include image_url, data, or image_file.');
}

async function inlineImageBytes(state: RequestState, image: Record<string, unknown>): Promise<ImagePayload> {
  const bytes = image.bytes;
  const mimeType = stringValueAt(image, 'mime_type') || 'image/png';
  if (bytes instanceof Uint8Array) {
    return {
      data: bytes,
      mimeType,
      ...(stringValueAt(image, 'source_kind') === 'project-file' ? {
        source: {
          kind: 'project-file' as const,
          projectRelativePath: stringValueAt(image, 'project_relative_path') ?? '',
          bytes: bytes.byteLength
        }
      } : {})
    };
  }
  const data = stringValueAt(image, 'data');
  const imageUrl = stringValueAt(image, 'image_url');
  if (data) {
    return { data: Buffer.from(data, 'base64'), mimeType };
  }
  if (imageUrl?.startsWith('data:')) {
    const [header, payload] = imageUrl.split(',', 2);
    const dataUrlMimeType = header?.replace(/^data:/, '').split(';')[0] || 'image/png';
    const decoded = Buffer.from(payload ?? '', 'base64');
    return {
      data: decoded,
      mimeType: dataUrlMimeType,
      source: {
        kind: 'data-url',
        bytes: decoded.byteLength
      }
    };
  }
  if (imageUrl && /^https?:\/\//.test(imageUrl)) {
    return downloadImage(state, imageUrl);
  }
  throw new Error('Edit image input must include inline image data or an http(s) image URL.');
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

function openAIOutputMimeType(outputFormat: unknown): string {
  if (outputFormat === 'jpeg') {
    return 'image/jpeg';
  }
  if (outputFormat === 'webp') {
    return 'image/webp';
  }
  return 'image/png';
}

function openAIDataItems(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  if (Array.isArray(payload.data)) {
    return payload.data.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object');
  }
  if (typeof payload.b64_json === 'string') {
    return [payload];
  }
  return [];
}

function parseJsonObject(text: string): Record<string, unknown> {
  if (!text.trim()) {
    throw new Error('Model response must be a non-empty JSON object.');
  }
  const parsed = JSON.parse(text) as unknown;
  const record = objectAt(parsed);
  if (!record) {
    throw new Error('Model response must be a JSON object.');
  }
  return record;
}

function summarizeJsonShape(value: unknown): unknown {
  if (Array.isArray(value)) {
    return { type: 'array', length: value.length };
  }
  const record = objectAt(value);
  if (record) {
    return { type: 'object', keys: Object.keys(record).slice(0, 20) };
  }
  return { type: typeof value };
}

function truncateString(value: string): string {
  return value.length > 2_000 ? `${value.slice(0, 2_000)}...[truncated]` : value;
}

function detectMimeType(content: Buffer, sourceName: string, headers?: Headers): string {
  const headerMime = headers?.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (headerMime?.startsWith('image/')) {
    return headerMime;
  }
  const fromPath = mimeTypeFromPath(sourceName);
  if (fromPath !== 'application/octet-stream') {
    return fromPath;
  }
  if (content.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return 'image/png';
  }
  if (content.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) {
    return 'image/jpeg';
  }
  if (content.subarray(0, 4).toString('ascii') === 'RIFF' && content.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  if (content.subarray(0, 2).toString('ascii') === 'BM') {
    return 'image/bmp';
  }
  return 'application/octet-stream';
}

function mimeTypeFromPath(path: string): string {
  if (path.startsWith('data:')) {
    return path.replace(/^data:/, '').split(';', 1)[0] || 'application/octet-stream';
  }
  const extension = extname(path).toLowerCase();
  if (extension === '.png') {
    return 'image/png';
  }
  if (extension === '.jpg' || extension === '.jpeg') {
    return 'image/jpeg';
  }
  if (extension === '.webp') {
    return 'image/webp';
  }
  if (extension === '.bmp') {
    return 'image/bmp';
  }
  return 'application/octet-stream';
}

function detectDimensions(content: Buffer, mimeType: string): [number, number] {
  if (mimeType === 'image/png' && content.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) && content.length >= 24) {
    return [content.readUInt32BE(16), content.readUInt32BE(20)];
  }
  if (mimeType === 'image/jpeg' && content.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) {
    return detectJpegDimensions(content);
  }
  if (mimeType === 'image/webp' && content.subarray(0, 4).toString('ascii') === 'RIFF' && content.subarray(8, 12).toString('ascii') === 'WEBP') {
    return detectWebpDimensions(content);
  }
  return [0, 0];
}

function detectJpegDimensions(content: Buffer): [number, number] {
  let index = 2;
  while (index + 9 < content.length) {
    if (content[index] !== 0xff) {
      index += 1;
      continue;
    }
    const marker = content[index + 1];
    if (marker !== undefined && [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return [content.readUInt16BE(index + 7), content.readUInt16BE(index + 5)];
    }
    const segmentLength = content.readUInt16BE(index + 2);
    index += 2 + segmentLength;
  }
  return [0, 0];
}

function detectWebpDimensions(content: Buffer): [number, number] {
  if (content.subarray(12, 16).toString('ascii') === 'VP8X' && content.length >= 30) {
    return [1 + content.readUIntLE(24, 3), 1 + content.readUIntLE(27, 3)];
  }
  return [0, 0];
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType === 'image/jpeg') {
    return 'jpg';
  }
  if (mimeType === 'image/webp') {
    return 'webp';
  }
  if (mimeType === 'image/png') {
    return 'png';
  }
  if (mimeType === 'image/bmp') {
    return 'bmp';
  }
  return 'bin';
}

function joinUrl(base: string, path: string): string {
  return new URL(path.replace(/^\//, ''), base.replace(/\/?$/, '/')).toString();
}

function payloadArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    : [];
}

function objectAt(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValueAt(value: Record<string, unknown>, key: string): string | undefined {
  const item = value[key];
  return typeof item === 'string' && item ? item : undefined;
}

function bufferForBytes(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
}

function formValue(value: unknown): string {
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return String(value);
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function arrayBufferFor(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function isGptImage2Model(model: string): boolean {
  return model === 'gpt-image-2';
}

function canUseOpenAIJsonEdit(inputImages: Array<Record<string, unknown>>, mask: Record<string, unknown> | undefined): boolean {
  return inputImages.every(isJsonImageUrlInput)
    && (mask === undefined || isJsonImageUrlInput(mask));
}

function isJsonImageUrlInput(image: Record<string, unknown>): boolean {
  const imageUrl = stringValueAt(image, 'image_url');
  return imageUrl !== undefined && !imageUrl.startsWith('data:');
}

function isGemini31ImageModel(model: string): boolean {
  return model === 'gemini-3.1-flash-image-preview'
    || model === 'gemini-3.1-flash-image'
    || model === 'gemini-3-pro-image-preview';
}

function isSupportedModelSpecificImageInputObject(image: Record<string, unknown>, kind: ModelSpecificImageObjectKind): boolean {
  if (kind === 'openai-image') {
    return hasOnlyKeys(image, ['image_url', 'data', 'mime_type'])
      && (!('mime_type' in image) || typeof image.mime_type === 'string')
      && (!('image_url' in image) || hasHttpOrDataImageStringPayload(image, 'image_url'))
      && (!('data' in image) || hasStringImagePayload(image, ['data']))
      && (hasHttpOrDataImageStringPayload(image, 'image_url') || hasStringImagePayload(image, ['data']));
  }
  return hasOnlyKeys(image, ['type', 'image_file'])
    && stringValueAt(image, 'type') === 'character'
    && hasHttpOrDataImageStringPayload(image, 'image_file');
}

async function assertModelSpecificImageInputUrlsArePublic(
  image: Record<string, unknown>,
  remoteUrlLookup: PublicRemoteHostLookup | undefined
): Promise<void> {
  for (const key of ['image_url', 'image_file']) {
    const value = stringValueAt(image, key);
    if (value && /^https?:\/\//.test(value)) {
      await assertPublicHttpUrl(value, 'Remote image URLs', { lookup: remoteUrlLookup });
    }
  }
}

function hasOnlyKeys(image: Record<string, unknown>, allowedKeys: string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(image).every((key) => allowed.has(key));
}

function hasStringImagePayload(image: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => stringValueAt(image, key) !== undefined);
}

function hasHttpOrDataImageStringPayload(image: Record<string, unknown>, key: string): boolean {
  const value = stringValueAt(image, key);
  return value !== undefined && (/^https?:\/\//.test(value) || value.startsWith('data:image/'));
}

function compactGptImage2ModelRunInPlace(state: RequestState, mimeType: string): void {
  if (!isGptImage2Model(state.entry.debruteModelId)) {
    return;
  }
  if (state.modelRun.request !== undefined) {
    state.modelRun.request = compactGptImage2Value(state.modelRun.request, mimeType);
  }
  state.modelRun.responses = state.modelRun.responses.map((response) => ({
    ...response,
    body: compactGptImage2Value(response.body, mimeType)
  }));
}

function compactGptImage2Value(value: unknown, mimeType: string, key = ''): unknown {
  if (typeof value === 'string') {
    if ((key === 'b64_json' || key === 'base64') && value.length > 0) {
      return omittedBase64Image(value, mimeType);
    }
    if (value.startsWith('data:image/')) {
      return omittedDataUrlImage(value);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => compactGptImage2Value(item, mimeType));
  }
  const record = objectAt(value);
  if (!record) {
    return value;
  }
  return Object.fromEntries(Object.entries(record).map(([childKey, childValue]) => [
    childKey,
    compactGptImage2Value(childValue, mimeType, childKey)
  ]));
}

function compactGemini31ModelRunInPlace(state: RequestState): void {
  if (!isGemini31ImageModel(state.entry.debruteModelId)) {
    return;
  }
  if (state.modelRun.request !== undefined) {
    state.modelRun.request = compactGemini31Value(state.modelRun.request);
  }
  state.modelRun.responses = state.modelRun.responses.map((response) => ({
    ...response,
    body: compactGemini31Value(response.body)
  }));
}

function compactGemini31Value(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(compactGemini31Value);
  }
  const record = objectAt(value);
  if (!record) {
    return value;
  }
  return Object.fromEntries(Object.entries(record).map(([key, childValue]) => {
    if ((key === 'inlineData' || key === 'inline_data') && objectAt(childValue)) {
      return [key, compactGemini31InlineData(childValue as Record<string, unknown>)];
    }
    return [key, compactGemini31Value(childValue)];
  }));
}

function compactGemini31InlineData(value: Record<string, unknown>): Record<string, unknown> {
  const mimeType = stringValueAt(value, 'mimeType') ?? stringValueAt(value, 'mime_type') ?? 'image/png';
  return Object.fromEntries(Object.entries(value).map(([key, childValue]) => [
    key,
    key === 'data' && typeof childValue === 'string'
      ? omittedBase64Image(childValue, mimeType)
      : compactGemini31Value(childValue)
  ]));
}

function omittedBase64Image(value: string, mimeType: string): Record<string, unknown> {
  return {
    omitted: 'base64_image',
    encoding: 'base64',
    chars: value.length,
    estimatedBytes: Buffer.byteLength(value, 'base64'),
    mimeType
  };
}

function omittedDataUrlImage(value: string): Record<string, unknown> {
  const [header, payload = ''] = value.split(',', 2);
  const mimeType = header?.replace(/^data:/, '').split(';')[0] || 'image/png';
  return omittedBase64Image(payload, mimeType);
}

function failure(
  state: Pick<RequestState, 'apiKey' | 'logs'>,
  error: string,
  raw?: Record<string, unknown>,
  content = `Image request failed: ${error}`
): ImageRequestError {
  const details = raw ? redactModelRunValue(state, raw) as Record<string, unknown> : undefined;
  if (raw) {
    state.logs.push({ stage: 'error', ...sanitizeLog(details) });
  }
  return {
    status: 'error',
    content,
    error,
    logs: state.logs,
    ...(details ? { details } : {})
  };
}

function log(state: Pick<RequestState, 'logs'>, stage: string, value: Record<string, unknown>): void {
  state.logs.push({ stage, ...sanitizeLog(value) });
}

function sanitizeLog(value: unknown): Record<string, unknown> {
  const sanitized = sanitizeValue(value);
  return objectAt(sanitized) ?? { value: sanitized };
}

function redactModelRunValue(state: Pick<RequestState, 'apiKey'>, value: unknown): unknown {
  return redactRuntimeSecrets(value, { secrets: [state.apiKey] });
}

function redactModelRunMessage(state: Pick<RequestState, 'apiKey'>, value: string): string {
  return redactRuntimeSecretString(value, { secrets: [state.apiKey] });
}

function sanitizeValue(value: unknown, key = ''): unknown {
  if (typeof value === 'string') {
    if (/authorization|api[_-]?key|token|secret|key/i.test(key)) {
      return '[redacted]';
    }
    if (/^https?:\/\//i.test(value)) {
      return sanitizeUrl(value);
    }
    if (/^data:image\//i.test(value)) {
      return value.replace(/;base64,.+$/i, ';base64,[redacted]');
    }
    if (/(b64|base64|image_file|data)/i.test(key) && value.length > 40) {
      return '[image]';
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, key));
  }
  const record = objectAt(value);
  if (!record) {
    return value;
  }
  return Object.fromEntries(Object.entries(record).map(([childKey, childValue]) => [
    childKey,
    sanitizeValue(childValue, childKey)
  ]));
}

function sanitizeUrl(value: string): string {
  const url = new URL(value);
  for (const key of [...url.searchParams.keys()]) {
    if (/key|token|secret/i.test(key)) {
      url.searchParams.set(key, '[redacted]');
    }
  }
  return url.toString();
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new Error('Image request aborted.'));
  }
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
      reject(signal?.reason ?? new Error('Image request aborted.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
