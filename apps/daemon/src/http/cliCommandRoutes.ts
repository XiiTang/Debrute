import { resolve } from 'node:path';
import type { DebruteAppServer, CliImageModelDetail, CliRuntimeDiagnostic, CliVideoModelDetail } from '@debrute/app-server';
import type {
  DaemonCliCommandRequest,
  DebruteAgentCommandResult,
  DebruteAgentFieldValue,
  ProjectSessionSnapshot,
  RunImageModelBatchInput
} from '@debrute/app-protocol';

export interface DaemonCliCommandServices {
  server: DebruteAppServer;
  onProgress?(command: string, fields: Record<string, DebruteAgentFieldValue>): void;
}

type DaemonCliCommandErrorCode =
  | 'invalid_command'
  | 'missing_argument'
  | 'invalid_input'
  | 'invalid_json_input';

export async function runDaemonCliCommand(
  request: DaemonCliCommandRequest,
  services: DaemonCliCommandServices
): Promise<DebruteAgentCommandResult> {
  try {
    return await runDaemonCliCommandUnsafe(request, services);
  } catch (error) {
    return errorResult(request.command, error, request.projectRoot);
  }
}

async function runDaemonCliCommandUnsafe(
  request: DaemonCliCommandRequest,
  services: DaemonCliCommandServices
): Promise<DebruteAgentCommandResult> {
  const server = services.server;
  if (request.command === 'runtime.status') {
    const status = await server.runtimeStatusForCli();
    return {
      status: 'ok',
      command: request.command,
      fields: {
        ok: status.ok,
        image_models: status.imageModels,
        available_image_models: status.availableImageModels,
        video_models: status.videoModels,
        available_video_models: status.availableVideoModels,
        llm_models: status.availableLlmModels,
        diagnostics: status.diagnostics
      }
    };
  }
  if (request.command === 'runtime.doctor') {
    const doctor = await server.runtimeDoctorForCli();
    return {
      status: 'ok',
      command: request.command,
      records: doctor.diagnostics.map((diagnostic) => ({
        name: 'diagnostic',
        fields: {
          code: diagnostic.code,
          severity: diagnostic.severity,
          message: diagnostic.message
        }
      })),
      fields: { diagnostics: doctor.diagnostics.length }
    };
  }
  if (request.command === 'models.image.list') {
    const models = await server.listImageModelsForCli();
    return {
      status: 'ok',
      command: request.command,
      records: models.map((model) => ({
        name: 'model',
        fields: {
          id: model.id,
          parameters: JSON.stringify(model.parameters)
        }
      })),
      fields: { count: models.length }
    };
  }
  if (request.command === 'models.video.list') {
    const models = await server.listVideoModelsForCli();
    return {
      status: 'ok',
      command: request.command,
      records: models.map((model) => ({
        name: 'model',
        fields: {
          id: model.id,
          parameters: JSON.stringify(model.parameters)
        }
      })),
      fields: { count: models.length }
    };
  }
  if (request.command === 'models.image.describe') {
    return imageModelDetailResult(request.command, await server.describeImageModelForCli(request.positional[0] ?? ''));
  }
  if (request.command === 'models.video.describe') {
    return videoModelDetailResult(request.command, await server.describeVideoModelForCli(request.positional[0] ?? ''));
  }
  if (request.command === 'llm.request') {
    return capabilityResult(request.command, await server.runLlmRequestForCli(jsonObjectOption(request, 'input-json')));
  }
  if (request.command === 'project.init') {
    return projectSnapshotResult(request.command, await server.initProjectForCli(requiredProjectRoot(request)));
  }
  if (request.command === 'project.status') {
    return projectSnapshotResult(request.command, await server.projectStatusForCli(requiredProjectRoot(request)));
  }
  if (request.command === 'project.validate') {
    const snapshot = await server.projectStatusForCli(requiredProjectRoot(request));
    if (snapshot.health.diagnosticCounts.errors > 0) {
      return {
        status: 'error',
        command: request.command,
        code: 'project_validation_failed',
        message: 'Project validation failed.',
        records: diagnosticRecords(snapshot),
        fields: diagnosticCountFields(snapshot)
      };
    }
    return {
      ...projectSnapshotResult(request.command, snapshot),
      records: diagnosticRecords(snapshot)
    };
  }
  if (request.command === 'canvas-map.publish') {
    const canvasId = request.positional[1] ?? '';
    await server.publishCanvasMapForProject(requiredProjectRoot(request), { canvasId });
    return { status: 'ok', command: request.command, fields: { canvas: canvasId } };
  }
  if (request.command === 'canvas.create') {
    await openCliProject(server, request);
    const result = await server.createCanvas();
    return canvasManagementResult(request.command, result.activeCanvasId);
  }
  if (request.command === 'canvas.rename') {
    await openCliProject(server, request);
    const result = await server.renameCanvas({
      canvasId: request.positional[1] ?? '',
      nextCanvasId: request.positional[2] ?? ''
    });
    return canvasManagementResult(request.command, result.activeCanvasId);
  }
  if (request.command === 'canvas.delete') {
    await openCliProject(server, request);
    const result = await server.deleteCanvas({ canvasId: request.positional[1] ?? '' });
    return canvasManagementResult(request.command, result.activeCanvasId);
  }
  if (request.command === 'canvas.reorder') {
    await openCliProject(server, request);
    await server.reorderCanvases({ canvasOrder: request.positional.slice(1) });
    return canvasManagementResult(request.command);
  }
  if (request.command === 'canvas.repair-index') {
    await openCliProject(server, request);
    const result = await server.repairCanvasIndex();
    return canvasManagementResult(request.command, result.activeCanvasId);
  }
  if (request.command === 'generated-asset.lookup') {
    const lookup = await server.lookupGeneratedAssetMetadataForCli(requiredProjectRoot(request), {
      projectRelativePath: request.options.path ?? ''
    });
    return {
      status: 'ok',
      command: request.command,
      fields: generatedAssetLookupFields(lookup)
    };
  }
  if (request.command === 'generate.image') {
    await openCliProject(server, request);
    return capabilityResult(request.command, await server.runImageModelRequestForCli(requestInput(request)));
  }
  if (request.command === 'generate.video') {
    await openCliProject(server, request);
    return capabilityResult(request.command, await server.runVideoModelRequestForCli(requestInput(request)));
  }
  if (request.command === 'generate.image-batch') {
    const input = imageBatchInputFromRequest(request);
    await openCliProject(server, request);
    const reportProgress = createImageBatchProgressReporter(input, (fields) => {
      services.onProgress?.(request.command, fields);
    });
    const summary = await server.runImageModelBatch(input, {
      onProgress: reportProgress
    });
    return {
      status: 'ok',
      command: request.command,
      fields: {
        total: summary.total,
        ok: summary.okCount,
        failed: summary.failedCount,
        skipped: summary.skippedCount,
        log: summary.logPath,
        concurrency: summary.concurrency,
        retries: summary.retries,
        duration_seconds: summary.durationSeconds,
        ...(summary.summaryPath ? { summary: summary.summaryPath } : {})
      }
    };
  }
  throw cliCommandError('invalid_command', `Unsupported daemon CLI command: ${request.command}`);
}

async function openCliProject(server: DebruteAppServer, request: DaemonCliCommandRequest): Promise<void> {
  await server.openProject(requiredProjectRoot(request), {
    initializeIfMissing: false,
    createDefaultCanvas: false,
    watchFiles: false
  });
}

function requiredProjectRoot(request: DaemonCliCommandRequest): string {
  if (!request.projectRoot) {
    throw cliCommandError('missing_argument', `${request.command} requires projectRoot.`);
  }
  return request.projectRoot;
}

function jsonObjectOption(request: DaemonCliCommandRequest, key: string): Record<string, unknown> {
  const raw = request.options[key];
  if (!raw) {
    throw cliCommandError('missing_argument', `--${key} is required.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw cliCommandError('invalid_json_input', `--${key} must be valid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw cliCommandError('invalid_json_input', `--${key} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function requestInput(request: DaemonCliCommandRequest): {
  model: string;
  arguments: Record<string, unknown>;
  timeoutMs?: number;
} {
  const input = jsonObjectOption(request, 'input-json');
  if (typeof input.model !== 'string' || !input.model.trim()) {
    throw cliCommandError('invalid_input', '--input-json requires string field "model".');
  }
  if (!input.arguments || typeof input.arguments !== 'object' || Array.isArray(input.arguments)) {
    throw cliCommandError('invalid_input', '--input-json requires object field "arguments".');
  }
  const timeoutMs = optionalPositiveIntegerOption(request, 'timeout-ms')
    ?? optionalPositiveIntegerValue(input.timeoutMs);
  return {
    model: input.model,
    arguments: input.arguments as Record<string, unknown>,
    ...(timeoutMs !== undefined ? { timeoutMs } : {})
  };
}

function imageBatchInputFromRequest(request: DaemonCliCommandRequest): RunImageModelBatchInput {
  const source = imageBatchSourceFromRequest(request);
  return {
    source,
    concurrency: positiveIntegerOption(request, 'concurrency', 4),
    retries: nonNegativeIntegerOption(request, 'retries', 0),
    timeoutMs: optionalPositiveIntegerOption(request, 'timeout-ms') ?? 900_000,
    logPath: resolve(requiredPathOption(request, 'log')),
    ...(request.options.summary ? { summaryPath: resolve(request.options.summary) } : {}),
    ...(request.options['overwrite-existing'] === 'true' ? { overwriteExisting: true } : {})
  };
}

function imageBatchSourceFromRequest(request: DaemonCliCommandRequest): RunImageModelBatchInput['source'] {
  const manifestPath = request.options.manifest;
  const inputJsonlPath = request.options['input-jsonl'];
  if (hasOptionValue(manifestPath)) {
    if (hasOptionValue(inputJsonlPath)) {
      throw cliCommandError('invalid_input', 'generate.image-batch requires exactly one of --manifest or --input-jsonl.');
    }
    return { kind: 'manifest', path: resolve(manifestPath) };
  }
  if (!hasOptionValue(inputJsonlPath)) {
    throw cliCommandError('invalid_input', 'generate.image-batch requires exactly one of --manifest or --input-jsonl.');
  }
  return { kind: 'jsonl', path: resolve(inputJsonlPath) };
}

function requiredPathOption(request: DaemonCliCommandRequest, key: string): string {
  const raw = request.options[key];
  if (!hasOptionValue(raw)) {
    throw cliCommandError('missing_argument', `--${key} is required.`);
  }
  return raw;
}

function hasOptionValue(raw: string | undefined): raw is string {
  return raw !== undefined && raw.length > 0;
}

function positiveIntegerOption(request: DaemonCliCommandRequest, key: string, fallback: number): number {
  return optionalPositiveIntegerOption(request, key) ?? fallback;
}

function optionalPositiveIntegerOption(request: DaemonCliCommandRequest, key: string): number | undefined {
  const raw = request.options[key];
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw cliCommandError('invalid_input', `--${key} must be a positive integer.`);
  }
  return value;
}

function optionalPositiveIntegerValue(raw: unknown): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw cliCommandError('invalid_input', 'input-json.timeoutMs must be a positive integer.');
  }
  return raw;
}

function nonNegativeIntegerOption(request: DaemonCliCommandRequest, key: string, fallback: number): number {
  const raw = request.options[key];
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw cliCommandError('invalid_input', `--${key} must be a non-negative integer.`);
  }
  return value;
}

function createImageBatchProgressReporter(
  input: RunImageModelBatchInput,
  emit: (fields: Record<string, DebruteAgentFieldValue>) => void
): (event: { type: string; snapshot: { total: number; done: number; active: number; okCount: number; skippedCount: number; failedCount: number; retryCount: number } }) => void {
  let nextBoundary = 10;
  return (event) => {
    const snapshot = event.snapshot;
    if (event.type === 'started') {
      emit(imageBatchProgressFields(input, event));
      return;
    }
    if (snapshot.total <= 0) {
      return;
    }
    const percent = Math.floor((snapshot.done / snapshot.total) * 100);
    if (percent < nextBoundary) {
      return;
    }
    while (nextBoundary <= percent) {
      nextBoundary += 10;
    }
    emit(imageBatchProgressFields(input, event));
  };
}

function imageBatchProgressFields(
  input: RunImageModelBatchInput,
  event: { type: string; snapshot: { total: number; done: number; active: number; okCount: number; skippedCount: number; failedCount: number; retryCount: number } }
): Record<string, DebruteAgentFieldValue> {
  const snapshot = event.snapshot;
  if (event.type !== 'started') {
    return {
      total: snapshot.total,
      done: snapshot.done,
      ok: snapshot.okCount,
      failed: snapshot.failedCount,
      skipped: snapshot.skippedCount,
      active: snapshot.active,
      retries: snapshot.retryCount
    };
  }
  return {
    total: snapshot.total,
    done: snapshot.done,
    ok: snapshot.okCount,
    failed: snapshot.failedCount,
    skipped: snapshot.skippedCount,
    active: snapshot.active,
    retries: input.retries,
    timeout_ms: input.timeoutMs ?? 900_000,
    log: input.logPath,
    concurrency: input.concurrency,
    ...(input.summaryPath ? { summary: input.summaryPath } : {})
  };
}

function projectSnapshotResult(command: string, snapshot: ProjectSessionSnapshot): DebruteAgentCommandResult {
  return {
    status: 'ok',
    command,
    fields: {
      project_root: snapshot.projectRoot,
      project_name: snapshot.health.projectName,
      canvases: snapshot.health.canvasCount,
      ...diagnosticCountFields(snapshot)
    }
  };
}

function diagnosticCountFields(snapshot: ProjectSessionSnapshot): Record<string, number> {
  return {
    errors: snapshot.health.diagnosticCounts.errors,
    warnings: snapshot.health.diagnosticCounts.warnings,
    infos: snapshot.health.diagnosticCounts.infos
  };
}

function diagnosticRecords(snapshot: ProjectSessionSnapshot) {
  return snapshot.diagnostics.map((diagnostic) => ({
    name: 'diagnostic',
    fields: {
      id: diagnostic.id,
      source: diagnostic.source,
      severity: diagnostic.severity,
      code: diagnostic.code,
      message: diagnostic.message,
      ...(diagnostic.filePath ? { path: diagnostic.filePath } : {})
    }
  }));
}

function canvasManagementResult(command: string, activeCanvasId?: string): DebruteAgentCommandResult {
  return {
    status: 'ok',
    command,
    fields: {
      ...(activeCanvasId ? { active_canvas: activeCanvasId } : {})
    }
  };
}

function capabilityResult(command: string, result: Awaited<ReturnType<DebruteAppServer['runImageModelRequestForCli']>>): DebruteAgentCommandResult {
  if (result.status === 'error') {
    return {
      status: 'error',
      command,
      code: normalizeServiceErrorCode(result.error.code),
      message: result.error.message,
      fields: primitiveFields(result.outputs ?? {})
    };
  }
  return {
    status: 'ok',
    command,
    records: (result.artifacts ?? []).map((artifact) => ({
      name: 'artifact',
      fields: {
        id: artifact.artifactId,
        path: artifact.projectRelativePath,
        ...(artifact.title !== undefined ? { title: artifact.title } : {}),
        ...(artifact.mimeType !== undefined ? { mime: artifact.mimeType } : {}),
        ...(artifact.width !== undefined ? { width: artifact.width } : {}),
        ...(artifact.height !== undefined ? { height: artifact.height } : {})
      }
    })),
    fields: {
      ...primitiveFields(result.outputs),
      artifacts: result.artifacts?.length ?? 0
    }
  };
}

function imageModelDetailResult(command: string, model: CliImageModelDetail): DebruteAgentCommandResult {
  return modelDetailResult(command, model);
}

function videoModelDetailResult(command: string, model: CliVideoModelDetail): DebruteAgentCommandResult {
  return modelDetailResult(command, model);
}

function modelDetailResult(command: string, model: CliImageModelDetail | CliVideoModelDetail): DebruteAgentCommandResult {
  return {
    status: 'ok',
    command,
    records: [
      { name: 'model', fields: { id: model.id } },
      {
        name: 'official_doc',
        fields: {
          urls: JSON.stringify(model.officialDocUrls),
          snapshot: model.officialSnapshotPath,
          captured_at: model.officialCapturedAt
        }
      }
    ],
    fields: {
      summary: model.summary,
      capabilities: JSON.stringify(model.capabilities),
      arguments_schema: JSON.stringify(model.argumentsSchema),
      description_markdown: model.descriptionMarkdown
    }
  };
}

function generatedAssetLookupFields(lookup: Awaited<ReturnType<DebruteAppServer['lookupGeneratedAssetMetadataForCli']>>) {
  if (lookup.status === 'unavailable') {
    return {
      status: lookup.status,
      reason: lookup.reason,
      message: lookup.message
    };
  }
  return {
    status: lookup.status,
    hash: lookup.fingerprint.hash,
    records: lookup.status === 'matched' ? lookup.records.length : 0,
    metadata: JSON.stringify(lookup)
  };
}

function errorResult(command: string, error: unknown, projectRoot?: string): DebruteAgentCommandResult {
  if (error instanceof DaemonCliCommandError) {
    return {
      status: 'error',
      command,
      code: error.code,
      message: error.message,
      fields: error.fields
    };
  }
  if (isNodeError(error) && error.code === 'ENOENT') {
    return {
      status: 'error',
      command,
      code: 'project_not_found',
      message: messageFromUnknown(error),
      fields: { ...(projectRoot ? { path: projectRoot } : {}) }
    };
  }
  const serviceCode = serviceErrorCode(error);
  if (serviceCode) {
    return {
      status: 'error',
      command,
      code: normalizeServiceErrorCode(serviceCode),
      message: messageFromUnknown(error),
      fields: primitiveFields((error as { fields?: unknown }).fields)
    };
  }
  return {
    status: 'error',
    command,
    code: projectRoot ? 'project_invalid' : 'internal_error',
    message: messageFromUnknown(error),
    fields: { ...(projectRoot ? { path: projectRoot } : {}) }
  };
}

function normalizeServiceErrorCode(code: string): string {
  if (
    code === 'no_llm_model_configured'
    || code === 'image_model_not_configured'
    || code === 'video_model_not_configured'
  ) {
    return 'model_not_configured';
  }
  if (code === 'llm_model_unavailable') {
    return 'model_unavailable';
  }
  if (code === 'image_model_official_doc_missing' || code === 'video_model_official_doc_missing') {
    return 'runtime_config_error';
  }
  if (
    code === 'llm_request_failed'
    || code === 'llm_request_timeout'
    || code === 'image_request_failed'
    || code === 'video_request_failed'
    || code === 'request_failed'
    || code === 'response_parse_failed'
  ) {
    return 'model_request_failed';
  }
  if (
    code === 'invalid_image_input'
    || code === 'llm_invalid_json'
    || code === 'video_argument_invalid'
    || code === 'video_reference_missing'
    || code === 'video_reference_type_unsupported'
    || code === 'video_reference_count_invalid'
    || code === 'video_reference_upload_unavailable'
  ) {
    return 'invalid_input';
  }
  return code;
}

function primitiveFields(fields: unknown): Record<string, DebruteAgentFieldValue> {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return {};
  }
  return Object.fromEntries(Object.entries(fields)
    .filter(([, value]) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null)) as Record<string, DebruteAgentFieldValue>;
}

function serviceErrorCode(error: unknown): string | undefined {
  return error instanceof Error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as unknown as { code: string }).code
    : undefined;
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cliCommandError(
  code: DaemonCliCommandErrorCode,
  message: string,
  fields: Record<string, DebruteAgentFieldValue> = {}
): DaemonCliCommandError {
  return new DaemonCliCommandError(code, message, fields);
}

class DaemonCliCommandError extends Error {
  constructor(
    readonly code: DaemonCliCommandErrorCode,
    message: string,
    readonly fields: Record<string, DebruteAgentFieldValue>
  ) {
    super(message);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as { code?: unknown }).code === 'string';
}
