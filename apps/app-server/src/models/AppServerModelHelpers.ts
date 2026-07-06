import { projectArtifactPointers } from '@debrute/capability-core';
import type {
  AudioModelCatalogEntry,
  AudioModelDetailEntry,
  AudioModelKind,
  AudioModelOfficialDescription,
  ExecuteImageModelRequestResult,
  ImageModelOfficialDescription,
  ImageModelCatalogEntry,
  ImageModelDetailEntry,
  VideoModelCatalogEntry,
  VideoModelDetailEntry,
  VideoModelOfficialDescription
} from '@debrute/capability-runtime';
import type {
  AudioModelSettingRecord,
  ImageModelSettingRecord,
  VideoModelSettingRecord
} from '@debrute/app-protocol';
import type { ImageModelBatchExecutionResult } from './ImageModelBatchService.js';

export interface CliModelSummary {
  id: string;
  summary: string;
  apiKeySet: boolean;
  requestModelIdOverride: string | null;
}

export interface CliImageModelListEntry {
  id: string;
  parameters: Record<string, string>;
}

export interface CliVideoModelListEntry {
  id: string;
  parameters: Record<string, string>;
}

export interface CliAudioModelListEntry {
  id: string;
  kind: AudioModelKind;
  parameters: Record<string, string>;
}

export interface CliModelDetail extends CliModelSummary {
  capabilities: Record<string, unknown>;
  argumentsSchema: Record<string, unknown>;
  usageNotes: string;
}

export interface CliImageModelDetail extends CliModelSummary {
  capabilities: Record<string, unknown>;
  argumentsSchema: Record<string, unknown>;
  officialDocUrls: string[];
  officialSnapshotPath: string;
  officialCapturedAt: string;
  descriptionMarkdown: string;
}

export interface CliVideoModelDetail extends CliModelSummary {
  capabilities: Record<string, unknown>;
  argumentsSchema: Record<string, unknown>;
  officialDocUrls: string[];
  officialSnapshotPath: string;
  officialCapturedAt: string;
  descriptionMarkdown: string;
}

export interface CliAudioModelDetail extends CliModelSummary {
  kind: AudioModelKind;
  capabilities: Record<string, unknown>;
  argumentsSchema: Record<string, unknown>;
  officialDocUrls: string[];
  officialSnapshotPath: string;
  officialCapturedAt: string;
  descriptionMarkdown: string;
}

export interface CliRuntimeDiagnostic {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
}

export interface CliRuntimeStatus {
  ok: true;
  imageModels: number;
  availableImageModels: number;
  videoModels: number;
  availableVideoModels: number;
  audioModels: number;
  availableAudioModels: number;
  diagnostics: number;
}

export interface ModelReadinessFailure {
  code: string;
  message: string;
  stage: string;
}

export function cliModelSummary(model: ImageModelSettingRecord | VideoModelSettingRecord | AudioModelSettingRecord): CliModelSummary {
  return {
    id: model.debruteModelId,
    summary: model.summary,
    apiKeySet: model.apiKeySet,
    requestModelIdOverride: model.requestModelIdOverride
  };
}

export function cliImageModelListEntry(entry: ImageModelCatalogEntry): CliImageModelListEntry {
  return {
    id: entry.debruteModelId,
    parameters: { ...entry.listParameters }
  };
}

export function cliVideoModelListEntry(entry: VideoModelCatalogEntry): CliVideoModelListEntry {
  return {
    id: entry.debruteModelId,
    parameters: { ...entry.listParameters }
  };
}

export function cliAudioModelListEntry(entry: AudioModelCatalogEntry): CliAudioModelListEntry {
  return {
    id: entry.debruteModelId,
    kind: entry.kind,
    parameters: { ...entry.listParameters }
  };
}

export function cliImageModelDetail(
  model: ImageModelSettingRecord,
  detail: ImageModelDetailEntry,
  officialDescription: ImageModelOfficialDescription
): CliImageModelDetail {
  return {
    ...cliModelSummary(model),
    capabilities: detail.capabilities,
    argumentsSchema: detail.argumentsSchema,
    officialDocUrls: officialDescription.sourceUrls,
    officialSnapshotPath: officialDescription.snapshotPath,
    officialCapturedAt: officialDescription.capturedAt,
    descriptionMarkdown: officialDescription.descriptionMarkdown
  };
}

export function cliVideoModelDetail(
  model: VideoModelSettingRecord,
  detail: VideoModelDetailEntry,
  officialDescription: VideoModelOfficialDescription
): CliVideoModelDetail {
  return {
    ...cliModelSummary(model),
    capabilities: detail.capabilities,
    argumentsSchema: detail.argumentsSchema,
    officialDocUrls: officialDescription.sourceUrls,
    officialSnapshotPath: officialDescription.snapshotPath,
    officialCapturedAt: officialDescription.capturedAt,
    descriptionMarkdown: officialDescription.descriptionMarkdown
  };
}

export function cliAudioModelDetail(
  model: AudioModelSettingRecord,
  detail: AudioModelDetailEntry,
  officialDescription: AudioModelOfficialDescription
): CliAudioModelDetail {
  return {
    ...cliModelSummary(model),
    kind: detail.kind,
    capabilities: detail.capabilities,
    argumentsSchema: detail.argumentsSchema,
    officialDocUrls: officialDescription.sourceUrls,
    officialSnapshotPath: officialDescription.snapshotPath,
    officialCapturedAt: officialDescription.capturedAt,
    descriptionMarkdown: officialDescription.descriptionMarkdown
  };
}

export function imageModelReadinessFailure(modelId: string, models: ImageModelSettingRecord[]): ModelReadinessFailure | undefined {
  const model = models.find((item) => item.debruteModelId === modelId);
  if (!model) {
    return {
      code: 'model_unavailable',
      message: `Image model is unavailable: ${modelId}`,
      stage: 'resolve_model'
    };
  }
  if (!model.apiKeySet) {
    return {
      code: 'image_model_not_configured',
      message: `Image model API key is missing: ${modelId}`,
      stage: 'resolve_model_auth'
    };
  }
  return undefined;
}

export function audioModelReadinessFailure(modelId: string, models: AudioModelSettingRecord[]): ModelReadinessFailure | undefined {
  const model = models.find((item) => item.debruteModelId === modelId);
  if (!model) {
    return {
      code: 'audio_model_unavailable',
      message: `Audio model is unavailable: ${modelId}`,
      stage: 'resolve_model'
    };
  }
  if (!model.apiKeySet) {
    return {
      code: 'audio_model_not_configured',
      message: `Audio model API key is missing: ${modelId}`,
      stage: 'resolve_model_auth'
    };
  }
  return undefined;
}

export function imageModelBatchResultFromExecution(result: ExecuteImageModelRequestResult): ImageModelBatchExecutionResult {
  if (result.status === 'ok') {
    return {
      status: 'ok',
      artifacts: projectArtifactPointers(result.artifacts)
    };
  }
  return {
    status: 'failed',
    error: {
      code: result.error,
      message: result.content,
      ...(result.details ? { details: result.details } : {})
    }
  };
}
