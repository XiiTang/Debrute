import { projectArtifactPointers } from '@debrute/capability-core';
import type {
  ExecuteImageModelRequestResult,
  ImageModelOfficialDescription,
  ImageModelCatalogEntry,
  ImageModelDetailEntry,
  VideoModelDetailEntry
} from '@debrute/capability-runtime';
import type {
  ImageModelSettingRecord,
  VideoModelSettingRecord
} from '@debrute/app-protocol';
import type { ImageModelBatchExecutionResult } from './ImageModelBatchService.js';

export interface CliModelSummary {
  id: string;
  summary: string;
  apiKeySet: boolean;
  baseUrlOverride: string | null;
  requestModelIdOverride: string | null;
}

export interface CliImageModelListEntry {
  id: string;
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
  availableLlmModels: number;
  diagnostics: number;
}

export interface ModelReadinessFailure {
  code: string;
  message: string;
  stage: string;
}

export function cliModelSummary(model: ImageModelSettingRecord | VideoModelSettingRecord): CliModelSummary {
  return {
    id: model.debruteModelId,
    summary: model.summary,
    apiKeySet: model.apiKeySet,
    baseUrlOverride: model.baseUrlOverride,
    requestModelIdOverride: model.requestModelIdOverride
  };
}

export function cliImageModelListEntry(entry: ImageModelCatalogEntry): CliImageModelListEntry {
  return {
    id: entry.debruteModelId,
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

export function cliVideoModelDetail(model: VideoModelSettingRecord, detail: VideoModelDetailEntry): CliModelDetail {
  return {
    ...cliModelSummary(model),
    capabilities: detail.capabilities,
    argumentsSchema: detail.argumentsSchema,
    usageNotes: detail.usageNotes
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
      message: result.content
    }
  };
}
