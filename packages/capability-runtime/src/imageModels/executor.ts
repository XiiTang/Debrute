import { randomUUID } from 'node:crypto';
import { basename, extname } from 'node:path';
import { readProjectFileBytes, writeProjectFile } from '@axis/project-core';
import type { ImageModelsConfig, SecretsConfig } from '../config.js';
import {
  createImageModelCatalog,
  imageInputFieldsForCatalogEntry,
  providerReadyImageObjectKindForCatalogEntry,
  type ImageModelCatalogEntry,
  type ProviderReadyImageObjectKind
} from './catalog.js';

export type ImageProviderFetch = (url: string, init?: RequestInit) => Promise<Response>;

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

export interface ImageProviderRawOutput {
  responses: Array<{
    status: number;
    body: unknown;
  }>;
}

export interface ExecuteImageModelRequestInput {
  projectRoot: string;
  invocationId: string;
  input: ImageModelRequestInput;
  settings: ImageModelsConfig;
  secrets: Pick<SecretsConfig, 'imageModelApiKeys'>;
  fetch?: ImageProviderFetch;
  recordGeneratedAsset?: ImageGeneratedAssetRecorder;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  wanPollMaxAttempts?: number;
  vydraPollMaxAttempts?: number;
  signal?: AbortSignal;
}

export interface ImageGeneratedAssetRecorderInput {
  projectRelativePath: string;
  providerCall: {
    request: unknown;
    output: unknown;
  };
}

export type ImageGeneratedAssetRecorder = (input: ImageGeneratedAssetRecorderInput) => Promise<void>;

export type ExecuteImageModelRequestResult =
  | { status: 'ok'; content: string; artifacts: ImageModelRequestArtifact[]; logs: Array<Record<string, unknown>> }
  | { status: 'error'; content: string; error: string; logs: Array<Record<string, unknown>>; rawProviderOutput?: ImageProviderRawOutput };

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
  providerModelId: string;
  args: Record<string, unknown>;
  fetch: ImageProviderFetch;
  recordGeneratedAsset?: ImageGeneratedAssetRecorder;
  providerCall: ProviderCallLog;
  logs: Array<Record<string, unknown>>;
  pollIntervalMs: number;
  requestTimeoutMs: number;
  wanPollMaxAttempts: number;
  vydraPollMaxAttempts: number;
  signal?: AbortSignal;
}

interface ProviderCallLog {
  request?: unknown;
  responses: ProviderResponseLog[];
}

interface ProviderResponseLog {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

type ProviderImageSuccess = { status: 'ok'; images: ImagePayload[]; output: Record<string, unknown> | null };
type ImageRequestError = Extract<ExecuteImageModelRequestResult, { status: 'error' }>;
type ProviderImageResult = ProviderImageSuccess | ImageRequestError;

const DEFAULT_WAN_POLL_ATTEMPTS = 60;
const DEFAULT_VYDRA_POLL_ATTEMPTS = 60;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const CATALOG_IMAGE_INPUT_FIELDS = [...new Set(createImageModelCatalog().listAll().flatMap(imageInputFieldsForCatalogEntry))];

export async function executeImageModelRequest(input: ExecuteImageModelRequestInput): Promise<ExecuteImageModelRequestResult> {
  const logs: Array<Record<string, unknown>> = [];
  const catalog = createImageModelCatalog();
  const entry = catalog.get(input.input.model);
  const modelSettings = input.settings.imageModels.find((model) => model.axisModelId === input.input.model);
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
    args = await resolveImageInputArguments(input.input.arguments, input.projectRoot, entry);
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
    providerModelId: modelSettings?.providerModelIdOverride?.trim() || entry.defaultProviderModelId,
    args,
    fetch: input.fetch ?? fetch,
    ...(input.recordGeneratedAsset ? { recordGeneratedAsset: input.recordGeneratedAsset } : {}),
    providerCall: { responses: [] },
    logs,
    pollIntervalMs: input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    requestTimeoutMs: input.requestTimeoutMs ?? input.input.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    wanPollMaxAttempts: input.wanPollMaxAttempts ?? DEFAULT_WAN_POLL_ATTEMPTS,
    vydraPollMaxAttempts: input.vydraPollMaxAttempts ?? DEFAULT_VYDRA_POLL_ATTEMPTS,
    ...(input.signal ? { signal: input.signal } : {})
  };
  log(state, 'resolve_provider', {
    provider: entry.provider,
    model: entry.axisModelId,
    providerModelId: state.providerModelId,
    configured: true
  });

  try {
    const result = await executeProviderImageRequest(state);
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
    log(state, 'error', { message: errorMessage(error) });
    const rawProviderOutput = providerRawOutput(state);
    return {
      status: 'error',
      content: `Image request failed: ${errorMessage(error)}`,
      error: 'image_request_failed',
      logs,
      ...(rawProviderOutput ? { rawProviderOutput } : {})
    };
  }
}

async function executeProviderImageRequest(
  state: RequestState
): Promise<ProviderImageResult> {
  switch (state.entry.axisModelId) {
    case 'gemini-3.1-flash-image-preview':
      return executeGemini31FlashImagePreview(state);
    case 'gemini-3.1-flash-image':
      return executeGemini31FlashImage(state);
    case 'gemini-3-pro-image-preview':
      return executeGemini3ProImagePreview(state);
  }

  switch (state.entry.provider) {
    case 'openai':
      return executeOpenAI(state);
    case 'volcengine-ark':
      return executeDoubao(state);
    case 'dashscope':
      return executeWan(state);
    case 'google-gemini':
      return executeGemini(state);
    case 'fal':
      return executeFal(state);
    case 'minimax':
      return executeMinimax(state);
    case 'vydra':
      return executeVydra(state);
    default:
      return failure(state, 'image_provider_not_supported', { provider: state.entry.provider });
  }
}

async function executeOpenAI(state: RequestState) {
  const args = stripOutputArgs(state.args);
  const outputMimeType = openAIOutputMimeType(args.output_format);
  const body: Record<string, unknown> = { model: state.providerModelId, ...args };
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
  compactGptImage2ProviderCallInPlace(state, outputMimeType);
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
    compactGptImage2ProviderCallInPlace(state, outputMimeType);
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
  recordProviderRequest(state, {
    method: 'POST',
    url,
    headers: authorizationHeaders(state),
    body: multipartBody
  });
  const response = await fetchWithTimeout(state, url, { method: 'POST', headers: authorizationHeaders(state), body: form });
  const parsedResponse = await parseProviderResponse(state, response);
  if (!parsedResponse.ok) {
    return parsedResponse.result;
  }
  const parsed = await openAIImagesFromPayload(state, parsedResponse.payload, outputMimeType);
  compactGptImage2ProviderCallInPlace(state, outputMimeType);
  return { status: 'ok' as const, images: parsed.images, output: parsed.revisedPrompts.length > 0 ? { revised_prompts: parsed.revisedPrompts } : null };
}

async function executeDoubao(state: RequestState) {
  const args = stripOutputArgs(state.args);
  const body: Record<string, unknown> = { model: state.providerModelId, ...args };
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
    model: state.providerModelId,
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

async function executeGemini(state: RequestState) {
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
  const url = new URL(joinUrl(state.baseUrl, `models/${state.providerModelId}:generateContent`));
  url.searchParams.set('key', state.apiKey);
  log(state, 'build_request', { url: url.toString(), imageConfig });
  const response = await postJson(state, url.toString(), { 'content-type': 'application/json' }, body);
  if (!response.ok) {
    return response.result;
  }
  const images = extractGeminiImages(response.payload);
  log(state, 'parse_response', { imageCount: images.length });
  return { status: 'ok' as const, images, output: null };
}

async function executeGemini31FlashImagePreview(state: RequestState) {
  return executeGemini31ImageModel(state);
}

async function executeGemini31FlashImage(state: RequestState) {
  return executeGemini31ImageModel(state);
}

async function executeGemini3ProImagePreview(state: RequestState) {
  return executeGemini31ImageModel(state);
}

async function executeGemini31ImageModel(state: RequestState) {
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
  const url = new URL(joinUrl(state.baseUrl, `models/${state.providerModelId}:generateContent`));
  url.searchParams.set('key', state.apiKey);
  log(state, 'build_request', { url: url.toString(), imageConfig });
  const response = await postJson(state, url.toString(), { 'content-type': 'application/json' }, body);
  if (!response.ok) {
    return response.result;
  }
  const images = extractGeminiImages(response.payload);
  compactGemini31ProviderCallInPlace(state);
  log(state, 'parse_response', { imageCount: images.length });
  return { status: 'ok' as const, images, output: null };
}

async function executeFal(state: RequestState) {
  const args = stripOutputArgs(state.args);
  if (imageInputFieldsForCatalogEntry(state.entry).includes('image_url') && args.image_url !== undefined) {
    args.image_url = toImageUrlOrDataUrl(imageInputArray(args.image_url)[0]!);
  }
  const url = joinUrl(state.baseUrl, state.providerModelId);
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
  const body = { model: state.providerModelId, ...args };
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
  const submitUrl = joinUrl(state.baseUrl, `models/${state.providerModelId}`);
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
  recordProviderRequest(state, {
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
  return parseProviderResponse(state, response);
}

async function getJson(
  state: RequestState,
  url: string,
  headers: Record<string, string>
): Promise<{ ok: true; payload: Record<string, unknown> } | { ok: false; result: ImageRequestError }> {
  recordProviderRequest(state, {
    method: 'GET',
    url,
    headers
  });
  const response = await fetchWithTimeout(state, url, { method: 'GET', headers });
  return parseProviderResponse(state, response);
}

async function fetchWithTimeout(state: RequestState, url: string, init: RequestInit): Promise<Response> {
  if (state.signal?.aborted) {
    throw state.signal.reason ?? new Error('Image request aborted.');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Image request timed out after ${state.requestTimeoutMs}ms`)), state.requestTimeoutMs);
  const onAbort = () => controller.abort(state.signal?.reason ?? new Error('Image request aborted.'));
  state.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await state.fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    state.signal?.removeEventListener('abort', onAbort);
  }
}

function recordProviderRequest(state: RequestState, request: unknown): void {
  if (state.providerCall.request === undefined) {
    state.providerCall.request = request;
  }
}

async function parseProviderResponse(
  state: RequestState,
  response: Response
): Promise<{ ok: true; payload: Record<string, unknown> } | { ok: false; result: ImageRequestError }> {
  const rawBody = await readResponseTextWithTimeout(state, response);
  let payload: Record<string, unknown>;
  try {
    payload = parseJsonObject(rawBody);
  } catch (error) {
    const body = rawBody.trim() ? { raw: truncateString(rawBody) } : { raw: '' };
    state.providerCall.responses.push({
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body
    });
    log(state, 'execute_request', { status: response.status, payloadShape: summarizeJsonShape(body) });
    return { ok: false, result: failure(state, 'response_parse_failed', { reason: errorMessage(error), status: response.status }) };
  }
  state.providerCall.responses.push({
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: payload
  });
  log(state, 'execute_request', { status: response.status, payloadShape: summarizeJsonShape(payload) });
  if (!response.ok) {
    return { ok: false, result: failure(state, 'request_failed', { status: response.status, payloadShape: summarizeJsonShape(payload) }) };
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
  const normalizedPath = await writeProjectFile(state.projectRoot, projectRelativePath, payload.data);
  const [width, height] = detectDimensions(Buffer.from(payload.data), payload.mimeType);
  await state.recordGeneratedAsset?.({
    projectRelativePath: normalizedPath,
    providerCall: {
      request: state.providerCall.request ?? null,
      output: {
        responses: [...state.providerCall.responses],
        parsed: output,
        artifactIndex: index
      }
    }
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
  entry: ImageModelCatalogEntry
): Promise<Record<string, unknown>> {
  const next = { ...args };
  const imageInputFields = imageInputFieldsForCatalogEntry(entry);
  assertImageInputFieldsAreSupported(next, entry, imageInputFields);
  for (const field of imageInputFields) {
    if (next[field] === undefined) {
      continue;
    }
    const values = imageInputValuesForField(next[field], entry, field);
    const inputs = isGptImage2Model(entry.axisModelId)
      ? await resolveGptImage2ImageInputs(values, projectRoot, entry, field)
      : await resolveImageInputs(values, projectRoot, entry, field);
    next[field] = imageInputFieldAcceptsMultiple(entry, field) ? inputs : inputs[0];
  }
  if (isGemini31ImageModel(entry.axisModelId) && next.contents !== undefined) {
    next.contents = await normalizeGeminiContents(next.contents, projectRoot);
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

async function normalizeGeminiContents(contents: unknown, projectRoot: string): Promise<Array<Record<string, unknown>>> {
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
      parts.push(await normalizeGeminiPart(part, projectRoot));
    }
    normalized.push({ ...item, parts });
  }
  return normalized;
}

async function normalizeGeminiPart(part: unknown, projectRoot: string): Promise<Record<string, unknown>> {
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
      throw new Error(`Image input field "${field}" is not supported by model "${entry.axisModelId}".`);
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
  return schema?.axisImageInput === true && schema.type === 'array';
}

async function resolveImageInputs(
  inputs: unknown[],
  projectRoot: string,
  entry: ImageModelCatalogEntry,
  field: string
): Promise<Array<Record<string, unknown>>> {
  const resolved: Array<Record<string, unknown>> = [];
  const providerReadyObjectKind = providerReadyImageObjectKindForCatalogEntry(entry, field);
  for (const input of inputs) {
    if (typeof input !== 'string') {
      if (input && typeof input === 'object') {
        const imageInput = input as Record<string, unknown>;
        if (!providerReadyObjectKind || !isSupportedProviderReadyImageInputObject(imageInput, providerReadyObjectKind)) {
          throw new Error(`Unsupported provider-ready image input object for field "${field}".`);
        }
        resolved.push(imageInput);
        continue;
      }
      throw new Error('Image input values must be strings or objects.');
    }
    if (/^https?:\/\//.test(input) || input.startsWith('data:image/')) {
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
  field: string
): Promise<Array<Record<string, unknown>>> {
  const resolved: Array<Record<string, unknown>> = [];
  const providerReadyObjectKind = providerReadyImageObjectKindForCatalogEntry(entry, field);
  for (const input of inputs) {
    if (typeof input !== 'string') {
      if (input && typeof input === 'object') {
        const imageInput = input as Record<string, unknown>;
        if (!providerReadyObjectKind || !isSupportedProviderReadyImageInputObject(imageInput, providerReadyObjectKind)) {
          throw new Error(`Unsupported provider-ready image input object for field "${field}".`);
        }
        resolved.push(imageInput);
        continue;
      }
      throw new Error('Image input values must be strings or objects.');
    }
    if (/^https?:\/\//.test(input) || input.startsWith('data:image/')) {
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
  const response = await fetchWithTimeout(state, url, { method: 'GET' });
  const bytes = new Uint8Array(await readResponseArrayBufferWithTimeout(state, response));
  if (!response.ok) {
    throw new Error(`Image download failed: ${response.status}`);
  }
  return {
    data: bytes,
    mimeType: detectMimeType(Buffer.from(bytes), url, response.headers)
  };
}

async function readResponseTextWithTimeout(state: RequestState, response: Response): Promise<string> {
  return new TextDecoder().decode(await readResponseBytesWithTimeout(state, response));
}

async function readResponseArrayBufferWithTimeout(state: RequestState, response: Response): Promise<ArrayBuffer> {
  return arrayBufferFor(await readResponseBytesWithTimeout(state, response));
}

async function readResponseBytesWithTimeout(state: RequestState, response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    return new Uint8Array(await response.arrayBuffer());
  }
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  return await new Promise<Uint8Array>((resolve, reject) => {
    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      state.signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      void reader.cancel().catch(() => undefined);
      reject(error);
    };
    const succeed = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(concatBytes(chunks, totalLength));
    };
    const onAbort = () => fail(state.signal?.reason ?? new Error('Image request aborted.'));

    if (state.signal?.aborted) {
      onAbort();
      return;
    }
    state.signal?.addEventListener('abort', onAbort, { once: true });
    timeout = setTimeout(() => {
      fail(new Error(`Image response body timed out after ${state.requestTimeoutMs}ms`));
    }, state.requestTimeoutMs);

    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          if (value) {
            chunks.push(value);
            totalLength += value.byteLength;
          }
        }
        succeed();
      } catch (error) {
        fail(error);
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // The reader may already be released after cancellation.
        }
      }
    };
    void pump();
  });
}

function concatBytes(chunks: Uint8Array[], totalLength: number): Uint8Array {
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
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
  delete next.provider_model_id;
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
    throw new Error('Provider response must be a non-empty JSON object.');
  }
  const parsed = JSON.parse(text) as unknown;
  const record = objectAt(parsed);
  if (!record) {
    throw new Error('Provider response must be a JSON object.');
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

function isSupportedProviderReadyImageInputObject(image: Record<string, unknown>, kind: ProviderReadyImageObjectKind): boolean {
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

function compactGptImage2ProviderCallInPlace(state: RequestState, mimeType: string): void {
  if (!isGptImage2Model(state.entry.axisModelId)) {
    return;
  }
  if (state.providerCall.request !== undefined) {
    state.providerCall.request = compactGptImage2Value(state.providerCall.request, mimeType);
  }
  state.providerCall.responses = state.providerCall.responses.map((response) => ({
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

function compactGemini31ProviderCallInPlace(state: RequestState): void {
  if (!isGemini31ImageModel(state.entry.axisModelId)) {
    return;
  }
  if (state.providerCall.request !== undefined) {
    state.providerCall.request = compactGemini31Value(state.providerCall.request);
  }
  state.providerCall.responses = state.providerCall.responses.map((response) => ({
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

function providerRawOutput(state: Pick<RequestState, 'providerCall'>): ImageProviderRawOutput | undefined {
  if (state.providerCall.responses.length === 0) {
    return undefined;
  }
  return {
    responses: state.providerCall.responses.map((response) => ({
      status: response.status,
      body: response.body
    }))
  };
}

function failure(
  state: Pick<RequestState, 'entry' | 'logs' | 'providerCall'>,
  error: string,
  raw?: Record<string, unknown>
): ImageRequestError {
  if (raw) {
    state.logs.push({ stage: 'error', ...sanitizeLog(raw) });
  }
  const rawProviderOutput = providerRawOutput(state);
  return {
    status: 'error',
    content: `Image request failed: ${error}`,
    error,
    logs: state.logs,
    ...(rawProviderOutput ? { rawProviderOutput } : {})
  };
}

function log(state: Pick<RequestState, 'logs'>, stage: string, value: Record<string, unknown>): void {
  state.logs.push({ stage, ...sanitizeLog(value) });
}

function sanitizeLog(value: unknown): Record<string, unknown> {
  const sanitized = sanitizeValue(value);
  return objectAt(sanitized) ?? { value: sanitized };
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
